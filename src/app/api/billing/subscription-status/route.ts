import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { jsonError } from '@/lib/apiResponses';
import { BILLING_ENABLED } from '@/lib/stripe/config';
import { stripe } from '@/lib/stripe/server';
import {
  BILLING_COOKIE_MAX_AGE_SECONDS,
  BILLING_COOKIE_NAME,
  getEarliestBillingOverrideExpiry,
  serializeBillingCookie,
} from '@/lib/billing/cookie';
import {
  getBillingAccountByAuthUserId,
  getOwnedOrganizationCount,
  getStripeCustomerIdForAuthUser,
  isActiveBillingStatus,
  refreshBillingAccountFromStripe,
  upsertBillingAccountFromSubscription,
} from '@/lib/billing/customer';
import { normalizeBillingOverrideType } from '@/lib/billing/override';
import { checkOrgsCoverage, isOrgSubscriptionActive, type OrgSubscriptionRow } from '@/lib/billing/orgSubscription';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
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

function setBillingCookie(response: NextResponse, isActive: boolean, validUntil: string | null = null) {
  // NOTE: must NOT be httpOnly — authStore.ts manages this same cookie via document.cookie
  // (setBillingCookie / clearBillingCookie).  Making it httpOnly prevents JS from clearing
  // it on sign-out, which would leave a stale billing token across user sessions.
  if (isActive) {
    const cookie = serializeBillingCookie({ status: 'active', validUntil });
    response.cookies.set(BILLING_COOKIE_NAME, cookie.value, {
      path: '/',
      maxAge: cookie.maxAge,
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
  validUntil: string | null = null,
) {
  const responseWithCookies = applySupabaseCookies(target, source);
  setBillingCookie(responseWithCookies, isActive, validUntil);
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

function buildOrgCoverageSummary(params: {
  organizationId: string;
  organizationName: string;
  subscription?: OrgSubscriptionRow | null;
  billingOverride?: {
    billing_override_type: string;
    billing_override_reason: string | null;
    billing_override_expires_at: string | null;
  } | null;
}) {
  const { organizationId, organizationName, subscription, billingOverride } = params;
  const overrideType = normalizeBillingOverrideType(billingOverride?.billing_override_type);
  if (overrideType) {
    return {
      organization_id: organizationId,
      organization_name: organizationName,
      status: 'active',
      stripe_subscription_id: subscription?.stripe_subscription_id ?? null,
      stripe_price_id: subscription?.stripe_price_id ?? null,
      quantity: 0,
      current_period_end: subscription?.current_period_end ?? null,
      cancel_at_period_end: Boolean(subscription?.cancel_at_period_end),
      billing_mode: subscription?.billing_mode ?? 'managed',
      billing_management_mode: 'platform',
    };
  }

  if (!subscription) return null;

  return {
    organization_id: organizationId,
    organization_name: organizationName,
    status: subscription.status,
    stripe_subscription_id: subscription.stripe_subscription_id,
    stripe_price_id: subscription.stripe_price_id,
    quantity: subscription.quantity,
    current_period_end: subscription.current_period_end,
    cancel_at_period_end: subscription.cancel_at_period_end,
    billing_mode: subscription.billing_mode,
    billing_management_mode: 'customer',
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

  // ── Restaurant-scoped fast path ──
  // When organizationId is provided (from the billing page scoped to a restaurant),
  // return data only for that specific org rather than all user-owned orgs.
  const organizationId = String(request.nextUrl.searchParams.get('organizationId') ?? '').trim() || null;
  if (organizationId) {
    const { data: membership } = await supabaseAdmin
      .from('organization_memberships')
      .select('role')
      .eq('auth_user_id', authUserId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const memberRole = normalizeRole(membership?.role);
    if (!membership || !MANAGER_ROLE_VALUES.has(memberRole)) {
      return applySupabaseCookies(jsonError('Access denied.', 403), response);
    }

    const [orgCoverageResult, { data: orgRow }] = await Promise.all([
      isOrgSubscriptionActive(organizationId, supabaseAdmin),
      supabaseAdmin
        .from('organizations')
        .select('name,restaurant_code')
        .eq('id', organizationId)
        .maybeSingle(),
    ]);

    if (orgCoverageResult.error) {
      return applySupabaseCookies(jsonError('Unable to check organization subscription.', 500), response);
    }

    const sub = orgCoverageResult.subscription as OrgSubscriptionRow | null;
    const override = orgCoverageResult.billingOverride;
    const orgName = (orgRow as { name?: string } | null)?.name ?? 'Restaurant';
    const isActive = orgCoverageResult.active;
    const orgSummary = buildOrgCoverageSummary({
      organizationId,
      organizationName: orgName,
      subscription: sub,
      billingOverride: override,
    });
    const orgSubscriptions = orgSummary ? [orgSummary] : [];
    const billingCookieExpiresAt = override?.billing_override_expires_at ?? null;

    const uncoveredOrgs = !isActive
      ? [{ organization_id: organizationId, organization_name: orgName }]
      : [];

    if (hasNextRedirect) {
      if (isActive) {
        return applyCookiesAndBillingState(
          NextResponse.redirect(new URL(nextPath ?? '/dashboard', request.url), { status: 302 }),
          response,
          true,
          billingCookieExpiresAt,
        );
      }
      return applyCookiesAndBillingState(
        NextResponse.redirect(buildSubscribeRedirectUrl(request, nextPath), { status: 302 }),
        response,
        false,
      );
    }

    return applyCookiesAndBillingState(
        NextResponse.json({
          billingEnabled: true,
          active: isActive,
        status: override ? 'active' : sub?.status ?? 'none',
        cancel_at_period_end: sub?.cancel_at_period_end ?? false,
        current_period_end: override?.billing_override_expires_at ?? sub?.current_period_end ?? null,
        subscription: null,
        owned_org_count: 1,
        required_quantity: 1,
        over_limit: false,
        org_subscriptions: orgSubscriptions,
        has_per_org_billing: Boolean(sub),
          covered_org_count: isActive ? 1 : 0,
          uncovered_org_count: isActive ? 0 : 1,
          uncovered_orgs: uncoveredOrgs,
          billing_cookie_expires_at: billingCookieExpiresAt,
        }),
        response,
        isActive,
        billingCookieExpiresAt,
      );
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

  // ── Fetch org names for the response ──
  let orgNamesMap: Record<string, string> = {};
  if (ownedResult.ids.length > 0) {
    const { data: orgRows } = await supabaseAdmin
      .from('organizations')
      .select('id,name')
      .in('id', ownedResult.ids);
    if (orgRows) {
      orgNamesMap = Object.fromEntries(orgRows.map((r: { id: string; name: string }) => [r.id, r.name]));
    }
  }

  // ── Dual-read: per-org subscriptions first, billing_accounts fallback ──
  // Check if owned orgs have per-org subscriptions in the subscriptions table.
  const orgCoverage = await checkOrgsCoverage(ownedResult.ids, supabaseAdmin);
  const allOrgsCovered = ownedOrgCount > 0 && orgCoverage.coveredOrgIds.length >= ownedOrgCount;
  const hasAnyPerOrgSub = orgCoverage.subscriptions.some(
    (sub) => sub.billing_mode === 'per_org' && isActiveBillingStatus(sub.status),
  );

  // If all orgs are covered by per-org subscriptions, skip billing_accounts entirely.
  let active: boolean;
  let status: string;
  let overLimit: boolean;
  let account: Awaited<ReturnType<typeof getBillingAccountByAuthUserId>>['data'] = null;
  const billableOwnedOrgCount = Math.max(0, ownedOrgCount - orgCoverage.billingOverrides.length);
  const requiredQuantity = billableOwnedOrgCount === 0 ? 0 : Math.max(1, billableOwnedOrgCount);

  if (allOrgsCovered) {
    // All orgs have active subscriptions — user is fully covered.
    active = true;
    status = 'active';
    overLimit = false;
  } else {
    // Fall back to billing_accounts (legacy bundled path).
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

    account = billingResult.data;
    status = String(account?.status ?? 'none').trim().toLowerCase();
    const quantity = Math.max(0, Number(account?.quantity ?? 0));
    const baseActive = isActiveBillingStatus(status);

    // For the billing_accounts path, count orgs NOT covered by per-org subs.
    // The bundled subscription only needs to cover the uncovered remainder.
    const uncoveredCount = orgCoverage.uncoveredOrgIds.length;
    overLimit = baseActive && quantity < uncoveredCount;
    active = baseActive && !overLimit;

    // If some orgs have per-org subs and the rest are covered by bundled, user is active.
    if (orgCoverage.coveredOrgIds.length > 0 && uncoveredCount === 0) {
      active = true;
      overLimit = false;
    }
  }

  // Build per-org subscription summary for the response.
  const overrideByOrgId = new Map(
    orgCoverage.billingOverrides.map((override) => [override.organization_id, override] as const),
  );
  const stripeOrgSubscriptions = orgCoverage.subscriptions
    .map((sub) => buildOrgCoverageSummary({
      organizationId: sub.organization_id,
      organizationName: orgNamesMap[sub.organization_id] ?? 'Restaurant',
      subscription: sub,
      billingOverride: overrideByOrgId.get(sub.organization_id) ?? null,
    }))
    .filter(Boolean);
  const overrideOrgSubscriptions = orgCoverage.billingOverrides
    .filter((override) => !orgCoverage.subscriptions.some((sub) => sub.organization_id === override.organization_id))
    .map((override) => buildOrgCoverageSummary({
      organizationId: override.organization_id,
      organizationName: override.organization_name ?? orgNamesMap[override.organization_id] ?? 'Restaurant',
      billingOverride: override,
    }))
    .filter(Boolean);
  const allOrgSubscriptions = [...stripeOrgSubscriptions, ...overrideOrgSubscriptions];
  const billingCookieExpiresAt = getEarliestBillingOverrideExpiry(
    orgCoverage.billingOverrides.map((override) => override.billing_override_expires_at),
  );

  // Build list of uncovered orgs (no active subscription).
  const uncoveredOrgs = orgCoverage.uncoveredOrgIds.map((id) => ({
    organization_id: id,
    organization_name: orgNamesMap[id] ?? 'Restaurant',
  }));

  if (hasNextRedirect) {
    if (isEmployeeLike && !isManagerLike) {
        return applyCookiesAndBillingState(
          NextResponse.redirect(new URL(nextPath ?? '/dashboard', request.url), { status: 302 }),
          response,
          true,
          billingCookieExpiresAt,
        );
      }

      if (active) {
        return applyCookiesAndBillingState(
          NextResponse.redirect(new URL(nextPath ?? '/dashboard', request.url), { status: 302 }),
          response,
          true,
          billingCookieExpiresAt,
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
            quantity: Math.max(0, Number(account.quantity ?? 0)),
            current_period_end: account.current_period_end,
            cancel_at_period_end: Boolean(account.cancel_at_period_end),
          }
        : null,
      owned_org_count: ownedOrgCount,
      required_quantity: requiredQuantity,
      over_limit: overLimit,
      // Per-org billing data
      org_subscriptions: allOrgSubscriptions,
      has_per_org_billing: hasAnyPerOrgSub,
      covered_org_count: orgCoverage.coveredOrgIds.length,
      uncovered_org_count: orgCoverage.uncoveredOrgIds.length,
      uncovered_orgs: uncoveredOrgs,
      billing_cookie_expires_at: billingCookieExpiresAt,
    }),
    response,
    active,
    billingCookieExpiresAt,
  );
}
