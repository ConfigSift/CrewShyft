/**
 * @deprecated LEGACY — no longer called by any in-repo code.
 * The active checkout finalization flow uses /api/billing/finalize-checkout instead,
 * which also writes to billing_accounts (auth-user-scoped) and handles incomplete
 * subscription status.  This route only writes to the org-level subscriptions table
 * and is kept for external/historical call compatibility only.
 *
 * If you are adding a new integration, use /api/billing/finalize-checkout.
 */
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError } from '@/lib/apiResponses';
import { stripe } from '@/lib/stripe/server';
import { toIsoFromUnixTimestamp } from '@/lib/billing/customer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SyncAfterCheckoutPayload = {
  session_id?: string;
};

function getSubscriptionId(value: string | Stripe.Subscription | null) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function getCustomerId(subscription: Stripe.Subscription) {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id;

  return customerId ?? null;
}

export async function POST(request: NextRequest) {
  let payload: SyncAfterCheckoutPayload;
  try {
    payload = (await request.json()) as SyncAfterCheckoutPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const sessionId = payload.session_id?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: 'session_id is required.' }, { status: 400 });
  }

  const { supabase, response } = createSupabaseRouteClient(request);
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const authUserId = authData.user?.id;
  if (!authUserId) {
    const message =
      process.env.NODE_ENV === 'production'
        ? 'Not signed in. Please sign out/in again.'
        : authError?.message || 'Unauthorized.';
    return applySupabaseCookies(jsonError(message, 401), response);
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });

    // Ownership check: verify the session belongs to the authenticated user.
    const sessionAuthUserId = String(checkoutSession.metadata?.auth_user_id ?? '').trim() || null;
    if (sessionAuthUserId && sessionAuthUserId !== authUserId) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Checkout session does not belong to this user.' }, { status: 403 }),
        response,
      );
    }

    const subscriptionId = getSubscriptionId(checkoutSession.subscription as string | Stripe.Subscription | null);
    if (!subscriptionId) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Missing subscription on checkout session.' }, { status: 400 }),
        response,
      );
    }

    const subscription =
      typeof checkoutSession.subscription === 'string' || !checkoutSession.subscription
        ? await stripe.subscriptions.retrieve(subscriptionId)
        : (checkoutSession.subscription as Stripe.Subscription);

    const organizationId =
      subscription.metadata?.organization_id ??
      checkoutSession.metadata?.organization_id ??
      null;
    if (!organizationId) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Missing organization_id in subscription/session metadata.' }, { status: 400 }),
        response,
      );
    }

    const customerId = getCustomerId(subscription);
    if (!customerId) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Missing customer on subscription.' }, { status: 400 }),
        response,
      );
    }

    const stripePriceId = subscription.items.data[0]?.price?.id ?? null;
    if (!stripePriceId) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Missing price on subscription.' }, { status: 400 }),
        response,
      );
    }

    const quantity = subscription.items.data[0]?.quantity ?? 1;
    const currentPeriodStart = toIsoFromUnixTimestamp(subscription.current_period_start);
    const currentPeriodEnd = toIsoFromUnixTimestamp(subscription.current_period_end);

    const { error: upsertError } = await supabaseAdmin
      .from('subscriptions')
      .upsert(
        {
          organization_id: organizationId,
          status: subscription.status,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscription.id,
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
          cancel_at_period_end: subscription.cancel_at_period_end,
          stripe_price_id: stripePriceId,
          quantity,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id' },
      );

    if (upsertError) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Failed to write subscription row.' }, { status: 500 }),
        response,
      );
    }

    return applySupabaseCookies(
      NextResponse.json({
        ok: true,
        status: subscription.status,
        organization_id: organizationId,
      }),
      response,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return applySupabaseCookies(
      NextResponse.json({ error: message || 'Unable to sync checkout session.' }, { status: 500 }),
      response,
    );
  }
}
