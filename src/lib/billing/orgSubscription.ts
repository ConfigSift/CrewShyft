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
): Promise<{ active: boolean; subscription: OrgSubscriptionRow | null; error: PostgrestError | null }> {
  const result = await getOrgSubscription(organizationId, supabaseClient);
  if (result.error) {
    return { active: false, subscription: null, error: result.error };
  }
  if (!result.data) {
    return { active: false, subscription: null, error: null };
  }
  return {
    active: isActiveBillingStatus(result.data.status),
    subscription: result.data,
    error: null,
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
  error: PostgrestError | null;
}> {
  if (organizationIds.length === 0) {
    return { coveredOrgIds: [], uncoveredOrgIds: [], subscriptions: [], error: null };
  }

  const { data, error } = await supabaseClient
    .from('subscriptions')
    .select('*')
    .in('organization_id', organizationIds);

  if (error) {
    return { coveredOrgIds: [], uncoveredOrgIds: organizationIds, subscriptions: [], error };
  }

  const rows = (data as OrgSubscriptionRow[] | null) ?? [];
  const coveredOrgIds = rows
    .filter((row) => isActiveBillingStatus(row.status))
    .map((row) => row.organization_id);
  const coveredSet = new Set(coveredOrgIds);
  const uncoveredOrgIds = organizationIds.filter((id) => !coveredSet.has(id));

  return { coveredOrgIds, uncoveredOrgIds, subscriptions: rows, error: null };
}
