import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { jsonError } from '@/lib/apiResponses';
import { BILLING_ENABLED } from '@/lib/stripe/config';
import { stripe } from '@/lib/stripe/server';
import {
  getBillingAccountByAuthUserId,
  getOwnedOrganizationCount,
  getStripeCustomerIdForAuthUser,
  isActiveBillingStatus,
  refreshBillingAccountFromStripe,
  upsertBillingAccountFromSubscription,
} from '@/lib/billing/customer';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const BILLING_COOKIE_NAME = 'sf_billing_ok';
const BILLING_COOKIE_MAX_AGE_SECONDS = 3600;
const MANAGER_ROLE_VALUES = new Set(['admin', 'manager', 'owner', 'super_admin']);
const EMPLOYEE_ROLE_VALUES = new Set(['employee', 'worker', 'staff', 'team_member']);

function normalizeRole(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function sanitizeNextPath(value: string | null): string | null {
  if (!value) return null;
  const normalized = String(value).trim();
  if (!normalized.startsWith('/')) return null;
  if (normalized.startsWith('//')) return null;
  return normalized;
}

function setBillingCookie(response: NextResponse, isActive: boolean) {
  // NOTE: must NOT be httpOnly — authStore.ts manages this same cookie via document.cookie
  // (setBillingCookie / clearBillingCookie).  Making it httpOnly prevents JS from clearing
  // it on sign-out, which would leave a stale billing token across user sessions.
  if (isActive) {
    response.cookies.set(BILLING_COOKIE_NAME, 'active', {
      path: '/',
      maxAge: BILLING_COOKIE_MAX_AGE_SECONDS,
      sameSite: 'lax',
    });
    return;
  }

  response.cookies.set(BILLING_COOKIE_NAME, '', {
    path: '/',
    maxAge: 0,
    sameSite: 'lax',
  });
}

function applyCookiesAndBillingState(
  target: NextResponse,
  source: NextResponse,
  isActive: boolean,
) {
  const responseWithCookies = applySupabaseCookies(target, source);
  setBillingCookie(responseWithCookies, isActive);
  return responseWithCookies;
}

function buildSubscribeRedirectUrl(request: NextRequest, nextPath: string | null) {
  const subscribeUrl = new URL('/subscribe', request.url);
  if (!nextPath) return subscribeUrl;

  try {
    const nextUrl = new URL(nextPath, request.url);
    const intent = nextUrl.searchParams.get('intent');
    const canceled = nextUrl.searchParams.get('canceled');
    if (intent) subscribeUrl.searchParams.set('intent', intent);
    if (canceled) subscribeUrl.searchParams.set('canceled', canceled);
  } catch {
    // Ignore malformed nextPath here and fall back to plain /subscribe.
  }

  return subscribeUrl;
}

function responseForDisabledBilling() {
  return {
    billingEnabled: false,
    active: true,
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: null,
    subscription: null,
    owned_org_count: 0,
    required_quantity: 0,
    over_limit: false,
  };
}

async function trySelfHealFromStripe(authUserId: string) {
  const stripeCustomerId = await getStripeCustomerIdForAuthUser(authUserId, supabaseAdmin);
  if (!stripeCustomerId) {
    return null;
  }

  try {
    const list = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      limit: 10,
    });

    const ranked = [...list.data].sort((a, b) => b.created - a.created);
    const preferred =
      ranked.find((subscription) => isActiveBillingStatus(subscription.status)) ??
      ranked.find((subscription) => subscription.status !== 'canceled') ??
      ranked[0] ??
      null;

    if (!preferred) {
      return null;
    }

    await upsertBillingAccountFromSubscription(authUserId, preferred, supabaseAdmin);
    return preferred;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get('next'));
  const hasNextRedirect = Boolean(nextPath);

  if (!BILLING_ENABLED) {
    if (hasNextRedirect) {
      return NextResponse.redirect(new URL(nextPath ?? '/dashboard', request.url), { status: 302 });
    }
    return NextResponse.json(responseForDisabledBilling());
  }

  const { supabase, response } = createSupabaseRouteClient(request);
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const authUserId = authData.user?.id;
  if (!authUserId) {
    if (hasNextRedirect) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('next', nextPath ?? '/dashboard');
      return applySupabaseCookies(NextResponse.redirect(loginUrl, { status: 302 }), response);
    }
    const message =
      process.env.NODE_ENV === 'production'
        ? 'Not signed in. Please sign out/in again.'
        : authError?.message || 'Unauthorized.';
    return applySupabaseCookies(jsonError(message, 401), response);
  }

  const [{ data: profileRows }, { data: memberships, count: membershipCount, error: membershipError }] = await Promise.all([
    supabaseAdmin
      .from('users')
      .select('role')
      .eq('auth_user_id', authUserId)
      .limit(1),
    supabaseAdmin
      .from('organization_memberships')
      .select('role', { count: 'exact' })
      .eq('auth_user_id', authUserId),
  ]);

  if (membershipError) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Unable to verify organization access.' }, { status: 500 }),
      response,
    );
  }

  const ownedResult = await getOwnedOrganizationCount(authUserId, supabaseAdmin);
  if (ownedResult.error) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Unable to verify organization access.' }, { status: 500 }),
      response,
    );
  }

  const membershipRoles = (memberships ?? []).map((membership) => normalizeRole(membership.role));
  const roleCandidates = [
    normalizeRole(profileRows?.[0]?.role),
    normalizeRole(authData.user?.user_metadata?.role),
    ...membershipRoles,
  ].filter(Boolean);
  const hasManagerRole = roleCandidates.some((role) => MANAGER_ROLE_VALUES.has(role));
  const hasEmployeeRole = roleCandidates.some((role) => EMPLOYEE_ROLE_VALUES.has(role));

  const ownedOrgCount = ownedResult.count;
  const isManagerLike = hasManagerRole || ownedOrgCount > 0;
  const isNonOwnerMember = (membershipCount ?? 0) > 0 && ownedOrgCount === 0;
  const isEmployeeLike = !isManagerLike && (hasEmployeeRole || isNonOwnerMember);
  if (isNonOwnerMember) {
    if (hasNextRedirect) {
      return applyCookiesAndBillingState(
        NextResponse.redirect(new URL(nextPath ?? '/dashboard', request.url), { status: 302 }),
        response,
        true,
      );
    }

    return applyCookiesAndBillingState(
      NextResponse.json({
        billingEnabled: true,
        active: true,
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: null,
        subscription: null,
        owned_org_count: 0,
        required_quantity: 0,
        over_limit: false,
      }),
      response,
      true,
    );
  }

  let billingResult = await refreshBillingAccountFromStripe(authUserId, supabaseAdmin);
  if (billingResult.error) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Unable to check billing account.' }, { status: 500 }),
      response,
    );
  }

  if (!billingResult.data) {
    await trySelfHealFromStripe(authUserId);
    billingResult = await getBillingAccountByAuthUserId(authUserId, supabaseAdmin);
    if (billingResult.error) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Unable to check billing account.' }, { status: 500 }),
        response,
      );
    }
  }

  const account = billingResult.data;
  const status = String(account?.status ?? 'none').trim().toLowerCase();
  const quantity = Math.max(0, Number(account?.quantity ?? 0));
  const requiredQuantity = Math.max(1, ownedOrgCount);
  const baseActive = isActiveBillingStatus(status);
  const overLimit = baseActive && quantity < requiredQuantity;
  const active = baseActive && !overLimit;

  if (hasNextRedirect) {
    if (isEmployeeLike && !isManagerLike) {
      return applyCookiesAndBillingState(
        NextResponse.redirect(new URL(nextPath ?? '/dashboard', request.url), { status: 302 }),
        response,
        true,
      );
    }

    if (active) {
      return applyCookiesAndBillingState(
        NextResponse.redirect(new URL(nextPath ?? '/dashboard', request.url), { status: 302 }),
        response,
        true,
      );
    }

    if (isManagerLike) {
      return applyCookiesAndBillingState(
        NextResponse.redirect(buildSubscribeRedirectUrl(request, nextPath), { status: 302 }),
        response,
        false,
      );
    }

    return applyCookiesAndBillingState(
      NextResponse.redirect(new URL(nextPath ?? '/dashboard', request.url), { status: 302 }),
      response,
      true,
    );
  }

  return applyCookiesAndBillingState(
    NextResponse.json({
      billingEnabled: true,
      active,
      status,
      cancel_at_period_end: Boolean(account?.cancel_at_period_end),
      current_period_end: account?.current_period_end ?? null,
      subscription: account
        ? {
            status,
            stripe_subscription_id: account.stripe_subscription_id,
            stripe_price_id: account.stripe_price_id,
            quantity,
            current_period_end: account.current_period_end,
            cancel_at_period_end: Boolean(account.cancel_at_period_end),
          }
        : null,
      owned_org_count: ownedOrgCount,
      required_quantity: requiredQuantity,
      over_limit: overLimit,
    }),
    response,
    active,
  );
}
