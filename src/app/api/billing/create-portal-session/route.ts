import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError } from '@/lib/apiResponses';
import { stripe } from '@/lib/stripe/server';
import {
  getBillingAccountByAuthUserId,
  getStripeCustomerIdForAuthUser,
  upsertBillingAccountFromSubscription,
} from '@/lib/billing/customer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type PortalPayload = {
  organizationId?: string;
};

export async function POST(request: NextRequest) {
  let payload: PortalPayload;
  try {
    payload = (await request.json()) as PortalPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const organizationId = String(payload.organizationId ?? '').trim() || null;

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

  const MANAGER_ROLE_VALUES = new Set(['admin', 'manager', 'owner', 'super_admin']);

  if (organizationId) {
    const { data: membership } = await supabaseAdmin
      .from('organization_memberships')
      .select('role')
      .eq('auth_user_id', authUserId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const role = String(membership?.role ?? '').trim().toLowerCase();
    if (!membership || !MANAGER_ROLE_VALUES.has(role)) {
      return applySupabaseCookies(
        jsonError('Only admins can manage billing.', 403),
        response,
      );
    }

    // Prefer the org-level stripe_customer_id from the subscriptions table.
    const { data: orgSub } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('organization_id', organizationId)
      .maybeSingle();

    const orgStripeCustomerId =
      (orgSub as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null;

    if (orgStripeCustomerId) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
      try {
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: orgStripeCustomerId,
          return_url: `${appUrl}/billing?portal=1&organizationId=${organizationId}`,
        });
        return applySupabaseCookies(NextResponse.json({ url: portalSession.url }), response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[billing:portal] stripe.billingPortal.sessions.create failed:', {
          organizationId,
          stripeCustomerId: orgStripeCustomerId,
          error: message,
        });
        return applySupabaseCookies(
          NextResponse.json({ error: message || 'Unable to create billing portal session.' }, { status: 500 }),
          response,
        );
      }
    }

    console.warn('[billing:portal] no stripe_customer_id found for org:', organizationId, '— falling back to legacy path');
  }

  const billingResult = await getBillingAccountByAuthUserId(authUserId, supabaseAdmin);
  if (billingResult.error) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Unable to load billing account.' }, { status: 500 }),
      response,
    );
  }

  let stripeCustomerId = billingResult.data?.stripe_customer_id ?? null;
  const stripeSubscriptionId = billingResult.data?.stripe_subscription_id ?? null;

  if (!stripeCustomerId) {
    stripeCustomerId = await getStripeCustomerIdForAuthUser(authUserId, supabaseAdmin);
  }

  if (!stripeCustomerId && stripeSubscriptionId) {
    const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    await upsertBillingAccountFromSubscription(authUserId, stripeSubscription, supabaseAdmin);
    stripeCustomerId =
      typeof stripeSubscription.customer === 'string'
        ? stripeSubscription.customer
        : stripeSubscription.customer?.id ?? null;
  }

  if (!stripeCustomerId) {
    console.error('[billing:portal] no stripe_customer_id found for user:', authUserId, 'organizationId:', organizationId);
    return applySupabaseCookies(
      NextResponse.json(
        { error: 'No Stripe billing account found. Please complete checkout first.' },
        { status: 400 },
      ),
      response,
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  try {
    const query = new URLSearchParams({ portal: '1' });
    if (organizationId) {
      query.set('organizationId', organizationId);
    }
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${appUrl}/billing?${query.toString()}`,
    });

    return applySupabaseCookies(
      NextResponse.json({ url: portalSession.url }),
      response,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return applySupabaseCookies(
      NextResponse.json({ error: message || 'Unable to create billing portal session.' }, { status: 500 }),
      response,
    );
  }
}
