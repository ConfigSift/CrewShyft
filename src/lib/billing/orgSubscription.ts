/**
 * Per-organization subscription helpers.
 *
 * These functions query the `subscriptions` table (per-org) rather than
 * `billing_accounts` (per-user). During the transition from bundled to
 * per-org billing, both tables may contain relevant data.
 */
import { type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isActiveBillingStatus } from '@/lib/billing/customer';
import { getOrganizationBillingOverride, getOrganizationBillingOverrides, type ActiveBillingOverride } from '@/lib/billing/override';

export type OrgSubscriptionRow = {
  id: string;
  organization_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  stripe_price_id: string;
  status: string;
  quantity: number;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  owner_auth_user_id: string | null;
  billing_mode: string;
  created_at: string;
  updated_at: string;
};

/**
 * Fetch the subscription row for a specific organization.
 */
export async function getOrgSubscription(
  organizationId: string,
  supabaseClient: SupabaseClient = supabaseAdmin,
): Promise<{ data: OrgSubscriptionRow | null; error: PostgrestError | null }> {
  const { data, error } = await supabaseClient
    .from('subscriptions')
    .select('*')
    .eq('organization_id', organizationId)
    .maybeSingle();

  return { data: data as OrgSubscriptionRow | null, error };
}

/**
 * Check whether a specific organization has an active subscription
 * (either per-org or legacy mirror).
 */
export async function isOrgSubscriptionActive(
  organizationId: string,
  supabaseClient: SupabaseClient = supabaseAdmin,
): Promise<{
  active: boolean;
  subscription: OrgSubscriptionRow | null;
  billingOverride: ActiveBillingOverride | null;
  error: PostgrestError | null;
}> {
  const [subscriptionResult, overrideResult] = await Promise.all([
    getOrgSubscription(organizationId, supabaseClient),
    getOrganizationBillingOverride(organizationId, supabaseClient),
  ]);

  if (subscriptionResult.error) {
    return { active: false, subscription: null, billingOverride: null, error: subscriptionResult.error };
  }
  if (overrideResult.error) {
    return { active: false, subscription: null, billingOverride: null, error: overrideResult.error };
  }

  const active = Boolean(overrideResult.data) || Boolean(
    subscriptionResult.data && isActiveBillingStatus(subscriptionResult.data.status),
  );

  return {
    active,
    subscription: subscriptionResult.data,
    billingOverride: overrideResult.data,
    error: null as PostgrestError | null,
  };
}

/**
 * Fetch all subscriptions owned by a specific auth user.
 * Returns both per-org and legacy mirror rows.
 */
export async function getSubscriptionsForOwner(
  authUserId: string,
  supabaseClient: SupabaseClient = supabaseAdmin,
): Promise<{ data: OrgSubscriptionRow[]; error: PostgrestError | null }> {
  const { data, error } = await supabaseClient
    .from('subscriptions')
    .select('*')
    .eq('owner_auth_user_id', authUserId);

  return { data: (data as OrgSubscriptionRow[] | null) ?? [], error };
}

/**
 * Given a list of organization IDs, check which have active subscriptions.
 * Returns { coveredOrgIds, uncoveredOrgIds, subscriptions }.
 */
export async function checkOrgsCoverage(
  organizationIds: string[],
  supabaseClient: SupabaseClient = supabaseAdmin,
): Promise<{
  coveredOrgIds: string[];
  uncoveredOrgIds: string[];
  subscriptions: OrgSubscriptionRow[];
  billingOverrides: ActiveBillingOverride[];
  error: PostgrestError | null;
}> {
  if (organizationIds.length === 0) {
    return { coveredOrgIds: [], uncoveredOrgIds: [], subscriptions: [], billingOverrides: [], error: null };
  }

  const [{ data, error }, overrideResult] = await Promise.all([
    supabaseClient
      .from('subscriptions')
      .select('*')
      .in('organization_id', organizationIds),
    getOrganizationBillingOverrides(organizationIds, supabaseClient),
  ]);

  if (error) {
    return { coveredOrgIds: [], uncoveredOrgIds: organizationIds, subscriptions: [], billingOverrides: [], error };
  }

  if (overrideResult.error) {
    return { coveredOrgIds: [], uncoveredOrgIds: organizationIds, subscriptions: [], billingOverrides: [], error: overrideResult.error };
  }

  const rows = (data as OrgSubscriptionRow[] | null) ?? [];
  const subscriptionCoveredOrgIds = rows
    .filter((row) => isActiveBillingStatus(row.status))
    .map((row) => row.organization_id);
  const overrideCoveredOrgIds = overrideResult.data.map((override) => override.organization_id);
  const coveredOrgIds = Array.from(new Set([...subscriptionCoveredOrgIds, ...overrideCoveredOrgIds]));
  const coveredSet = new Set(coveredOrgIds);
  const uncoveredOrgIds = organizationIds.filter((id) => !coveredSet.has(id));

  return {
    coveredOrgIds,
    uncoveredOrgIds,
    subscriptions: rows,
    billingOverrides: overrideResult.data,
    error: null,
  };
}
