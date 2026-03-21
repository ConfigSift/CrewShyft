import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError } from '@/lib/apiResponses';
import { isActiveBillingStatus } from '@/lib/billing/customer';
import { normalizeBillingOverrideType } from '@/lib/billing/override';
import { stripe } from '@/lib/stripe/server';
import { requireAdmin } from '@/lib/admin/auth';

type OverridePayload = {
  active?: boolean;
  type?: string | null;
  reason?: string | null;
  expiresAt?: string | null;
};

type StripeOverrideAction =
  | { action: 'none'; currentPeriodEnd: string | null }
  | { action: 'already_canceling'; currentPeriodEnd: string | null }
  | { action: 'cancel_at_period_end'; currentPeriodEnd: string | null };

function parseExpiresAt(value: string | null | undefined) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function isMissingOverrideSchemaError(message: string) {
  const lowered = message.toLowerCase();
  return lowered.includes('billing_override');
}

async function scheduleStripeSubscriptionCancellation(
  organizationId: string,
): Promise<{ result: StripeOverrideAction | null; error: string | null }> {
  const { data: orgSub, error: orgSubError } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_subscription_id,status,cancel_at_period_end,current_period_end')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (orgSubError) {
    return { result: null, error: orgSubError.message || 'Unable to load restaurant subscription.' };
  }

  const subscriptionRow = (orgSub as {
    stripe_subscription_id?: string | null;
    status?: string | null;
    cancel_at_period_end?: boolean | null;
    current_period_end?: string | null;
  } | null) ?? null;

  const stripeSubscriptionId = String(subscriptionRow?.stripe_subscription_id ?? '').trim();
  const isActiveStripeSubscription = isActiveBillingStatus(subscriptionRow?.status);
  const currentPeriodEnd = String(subscriptionRow?.current_period_end ?? '').trim() || null;

  if (!stripeSubscriptionId || !isActiveStripeSubscription) {
    return {
      result: {
        action: 'none',
        currentPeriodEnd,
      },
      error: null,
    };
  }

  if (Boolean(subscriptionRow?.cancel_at_period_end)) {
    return {
      result: {
        action: 'already_canceling',
        currentPeriodEnd,
      },
      error: null,
    };
  }

  try {
    const updatedSubscription = await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    const updatedCurrentPeriodEnd =
      typeof updatedSubscription.current_period_end === 'number'
        ? new Date(updatedSubscription.current_period_end * 1000).toISOString()
        : currentPeriodEnd;

    const { error: syncError } = await supabaseAdmin
      .from('subscriptions')
      .update({
        status: updatedSubscription.status,
        cancel_at_period_end: Boolean(updatedSubscription.cancel_at_period_end),
        current_period_end: updatedCurrentPeriodEnd,
        canceled_at: new Date().toISOString(),
      })
      .eq('organization_id', organizationId);

    if (syncError) {
      return {
        result: null,
        error: syncError.message || 'Stripe renewal was updated, but the local subscription record could not be synced.',
      };
    }

    return {
      result: {
        action: 'cancel_at_period_end',
        currentPeriodEnd: updatedCurrentPeriodEnd,
      },
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : 'Unable to update the Stripe subscription.',
    };
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ organizationId: string }> },
) {
  const { organizationId } = await context.params;
  const adminResult = await requireAdmin(request);
  if (!adminResult.ok) return adminResult.error;
  const { ctx, response } = adminResult;

  let payload: OverridePayload;
  try {
    payload = (await request.json()) as OverridePayload;
  } catch {
    return applySupabaseCookies(jsonError('Invalid JSON body.', 400), response);
  }

  const active = Boolean(payload.active);
  const overrideType = normalizeBillingOverrideType(payload.type);
  const reason = String(payload.reason ?? '').trim() || null;
  const expiresAt = parseExpiresAt(payload.expiresAt);

  if (active && !overrideType) {
    return applySupabaseCookies(jsonError('A valid billing override type is required.', 400), response);
  }

  if (String(payload.expiresAt ?? '').trim() && !expiresAt) {
    return applySupabaseCookies(jsonError('Invalid billing override expiration date.', 400), response);
  }

  let stripeAction: StripeOverrideAction | null = null;
  if (active) {
    const stripeCancellation = await scheduleStripeSubscriptionCancellation(organizationId);
    if (stripeCancellation.error) {
      return applySupabaseCookies(jsonError(stripeCancellation.error, 500), response);
    }
    stripeAction = stripeCancellation.result;
  }

  const updatePayload = active
    ? {
        billing_override_active: true,
        billing_override_type: overrideType,
        billing_override_reason: reason,
        billing_override_expires_at: expiresAt,
        billing_override_set_by: ctx.authUserId,
      }
    : {
        billing_override_active: false,
        billing_override_type: null,
        billing_override_reason: null,
        billing_override_expires_at: null,
        billing_override_set_by: null,
      };

  const { error } = await supabaseAdmin
    .from('organizations')
    .update(updatePayload)
    .eq('id', organizationId);

  if (error) {
    if (isMissingOverrideSchemaError(error.message)) {
      return applySupabaseCookies(
        jsonError('Billing override fields are not available yet. Run the latest migration first.', 503),
        response,
      );
    }
    return applySupabaseCookies(
      jsonError(error.message || 'Unable to update billing override.', 400),
      response,
    );
  }

  return applySupabaseCookies(
    NextResponse.json({
      ok: true,
      organizationId,
      stripeAction,
      billingOverride: active
        ? {
            active: true,
            type: overrideType,
            reason,
            expiresAt,
            setBy: ctx.authUserId,
          }
        : {
            active: false,
          },
    }),
    response,
  );
}
