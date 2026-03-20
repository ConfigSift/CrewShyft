import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { stripe } from '@/lib/stripe/server';
import {
  toIsoFromUnixTimestamp,
  upsertBillingAccountFromSubscription,
} from '@/lib/billing/customer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type FinalizeCheckoutPayload = {
  session_id?: string;
  intent_id?: string;
};

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function isStatusActiveForGating(
  subscription: Stripe.Subscription,
  latestInvoice: Stripe.Invoice | null,
) {
  const status = String(subscription.status ?? '').trim().toLowerCase();
  if (status === 'active' || status === 'trialing') {
    return true;
  }
  if (status !== 'incomplete') {
    return false;
  }

  const invoicePaid = latestInvoice?.paid === true || latestInvoice?.status === 'paid';
  const paymentIntentStatus = (() => {
    const paymentIntent = latestInvoice?.payment_intent;
    if (!paymentIntent) return '';
    if (typeof paymentIntent === 'string') return '';
    return String(paymentIntent.status ?? '').trim().toLowerCase();
  })();
  return invoicePaid || paymentIntentStatus === 'succeeded';
}

function getSubscriptionId(value: string | Stripe.Subscription | null) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function pickIntentId(
  checkoutSession: Stripe.Checkout.Session,
  subscription: Stripe.Subscription,
  fallbackIntentId?: string | null,
) {
  const subIntentId = String(subscription.metadata?.intent_id ?? '').trim();
  if (subIntentId) return subIntentId;
  const sessionIntentId = String(checkoutSession.metadata?.intent_id ?? '').trim();
  if (sessionIntentId) return sessionIntentId;
  return String(fallbackIntentId ?? '').trim() || null;
}

function pickOrganizationId(
  checkoutSession: Stripe.Checkout.Session,
  subscription: Stripe.Subscription,
) {
  const fromSubscription = String(subscription.metadata?.organization_id ?? '').trim();
  if (fromSubscription) return fromSubscription;
  const fromSession = String(checkoutSession.metadata?.organization_id ?? '').trim();
  return fromSession || null;
}

async function finalizeCheckout(
  request: NextRequest,
  sessionIdInput?: string | null,
  fallbackIntentId?: string | null,
) {
  const sessionId = String(sessionIdInput ?? '').trim();
  if (!sessionId) {
    return jsonNoStore({ error: 'session_id is required.' }, { status: 400 });
  }

  const { supabase, response } = createSupabaseRouteClient(request);
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const authUserId = authData.user?.id;

  if (!authUserId) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[billing:finalize] unauthorized', {
        reason: authError?.message ?? null,
      });
    }
    return applySupabaseCookies(
      jsonNoStore({ error: 'UNAUTHORIZED' }, { status: 401 }),
      response,
    );
  }

  let checkoutSession: Stripe.Checkout.Session;
  try {
    checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return applySupabaseCookies(
      jsonNoStore({ error: message || 'Unable to load checkout session.' }, { status: 400 }),
      response,
    );
  }

  const subscriptionId = getSubscriptionId(
    checkoutSession.subscription as string | Stripe.Subscription | null,
  );
  if (!subscriptionId) {
    return applySupabaseCookies(
      jsonNoStore({ error: 'Checkout session is missing a subscription.' }, { status: 400 }),
      response,
    );
  }

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.payment_intent', 'items.data.price'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return applySupabaseCookies(
      jsonNoStore({ error: message || 'Unable to load subscription.' }, { status: 400 }),
      response,
    );
  }

  const metadataAuthUserId =
    String(subscription.metadata?.auth_user_id ?? checkoutSession.metadata?.auth_user_id ?? '').trim() ||
    null;
  if (metadataAuthUserId && metadataAuthUserId !== authUserId) {
    return applySupabaseCookies(
      jsonNoStore({ error: 'Checkout does not belong to this user.' }, { status: 403 }),
      response,
    );
  }

  // Per-org subscriptions skip billing_accounts writes to avoid overwriting
  // a bundled subscription that may cover other orgs.
  const isPerOrgSub = String(subscription.metadata?.billing_mode ?? '').trim() === 'per_org';

  if (!isPerOrgSub) {
    const upsertResult = await upsertBillingAccountFromSubscription(
      authUserId,
      subscription,
      supabaseAdmin,
    );

    if (upsertResult.error) {
      return applySupabaseCookies(
        jsonNoStore({ error: 'Failed to persist billing account status.' }, { status: 500 }),
        response,
      );
    }
  }

  const stripeCustomerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id ?? null;
  if (stripeCustomerId) {
    await supabaseAdmin
      .from('stripe_customers')
      .upsert(
        {
          auth_user_id: authUserId,
          stripe_customer_id: stripeCustomerId,
        },
        { onConflict: 'auth_user_id' },
      );
  }

  const intentId = pickIntentId(checkoutSession, subscription, fallbackIntentId);
  const organizationId = pickOrganizationId(checkoutSession, subscription);
  const currentPeriodEnd = toIsoFromUnixTimestamp(subscription.current_period_end);
  const quantity = subscription.items.data[0]?.quantity ?? 1;
  const latestInvoice =
    typeof subscription.latest_invoice === 'object' && subscription.latest_invoice
      ? (subscription.latest_invoice as Stripe.Invoice)
      : null;
  const active = isStatusActiveForGating(subscription, latestInvoice);
  if (active && String(subscription.status ?? '').trim().toLowerCase() === 'incomplete' && !isPerOrgSub) {
    await supabaseAdmin
      .from('billing_accounts')
      .update({
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('auth_user_id', authUserId);
  }

  // Keep org-level subscription row when metadata includes organization_id.
  if (organizationId) {
    const orgStripeCustomerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id ?? null;
    const billingMode = String(subscription.metadata?.billing_mode ?? '').trim() || 'legacy';

    if (orgStripeCustomerId) {
      await supabaseAdmin
        .from('subscriptions')
        .upsert(
          {
            organization_id: organizationId,
            status: active ? 'active' : subscription.status,
            stripe_customer_id: orgStripeCustomerId,
            stripe_subscription_id: subscription.id,
            current_period_start: toIsoFromUnixTimestamp(subscription.current_period_start),
            current_period_end: currentPeriodEnd,
            cancel_at_period_end: subscription.cancel_at_period_end,
            stripe_price_id: subscription.items.data[0]?.price?.id ?? null,
            quantity,
            updated_at: new Date().toISOString(),
            owner_auth_user_id: authUserId,
            billing_mode: billingMode === 'per_org' ? 'per_org' : 'legacy',
          },
          { onConflict: 'organization_id' },
        );
    }
  }

  return applySupabaseCookies(
    jsonNoStore({
      ok: true,
      organizationId,
      organization_id: organizationId,
      stripeSubscriptionId: subscription.id,
      stripe_subscription_id: subscription.id,
      stripeCustomerId: stripeCustomerId ?? null,
      stripe_customer_id: stripeCustomerId ?? null,
      status: active ? 'active' : subscription.status,
      active,
      quantity,
      cancel_at_period_end: subscription.cancel_at_period_end,
      current_period_end: currentPeriodEnd,
      intent_id: intentId,
    }),
    response,
  );
}

export async function GET(request: NextRequest) {
  return finalizeCheckout(
    request,
    request.nextUrl.searchParams.get('session_id'),
    request.nextUrl.searchParams.get('intent_id'),
  );
}

export async function POST(request: NextRequest) {
  const querySessionId = request.nextUrl.searchParams.get('session_id');
  const queryIntentId = request.nextUrl.searchParams.get('intent_id');
  if (querySessionId?.trim()) {
    return finalizeCheckout(request, querySessionId, queryIntentId);
  }

  let payload: FinalizeCheckoutPayload;
  try {
    payload = (await request.json()) as FinalizeCheckoutPayload;
  } catch {
    return jsonNoStore({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  return finalizeCheckout(request, payload.session_id, payload.intent_id);
}
