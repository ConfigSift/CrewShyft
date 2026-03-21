import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { BILLING_ENABLED } from '@/lib/stripe/config';
import { getBillingAccountByAuthUserId, isActiveBillingStatus } from '@/lib/billing/customer';
import { normalizePersona } from '@/lib/persona';

export const dynamic = 'force-dynamic';

export default async function StartPage() {
  const supabase = await createSupabaseServerClient();

  let userId: string | null = null;
  let authPersona: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
    authPersona = String(data.user?.user_metadata?.persona ?? '').trim().toLowerCase() || null;
  } catch {
    // ignore auth errors
  }

  if (!userId) {
    redirect('/signup?next=/join');
  }

  const { data: memberships } = await supabaseAdmin
    .from('organization_memberships')
    .select('organization_id, role')
    .eq('auth_user_id', userId);

  const membershipList = memberships ?? [];
  if (membershipList.length > 0) {
    if (BILLING_ENABLED) {
      const ownedOrgIds = membershipList
        .filter((membership) => {
          const role = String(membership.role ?? '').trim().toLowerCase();
          return role === 'admin' || role === 'owner';
        })
        .map((membership) => membership.organization_id as string);

      if (ownedOrgIds.length > 0) {
        const [{ data: orgSubs }, billingAccountResult] = await Promise.all([
          supabaseAdmin
            .from('subscriptions')
            .select('organization_id, status')
            .in('organization_id', ownedOrgIds),
          getBillingAccountByAuthUserId(userId, supabaseAdmin),
        ]);

        const orgSubIds = new Set(
          (orgSubs ?? []).map((sub) => String(sub.organization_id ?? '').trim()).filter(Boolean),
        );
        const hasActiveBundledCoverage = isActiveBillingStatus(
          String(billingAccountResult.data?.status ?? '').trim().toLowerCase(),
        );
        const hasResumableOwnedOrg = !hasActiveBundledCoverage && ownedOrgIds.some((orgId) => !orgSubIds.has(orgId));

        if (hasResumableOwnedOrg) {
          redirect('/restaurants');
        }

        const activeOrgIds = new Set(
          (orgSubs ?? [])
            .filter((sub) => isActiveBillingStatus(String(sub.status ?? '').trim().toLowerCase()))
            .map((sub) => sub.organization_id as string),
        );

        if (activeOrgIds.size < ownedOrgIds.length) {
          // Some or all owned orgs lack an active subscription.
          redirect(activeOrgIds.size === 0 ? '/subscribe' : '/billing?upgrade=1');
        }
      }
    }

    redirect('/dashboard');
  }

  const { data: profileRows, error: profileError } = await supabaseAdmin
    .from('users')
    .select('persona')
    .eq('auth_user_id', userId)
    .limit(1);

  if (profileError) {
    console.warn('[/start] users.persona lookup failed:', profileError.message, profileError.code);
  }

  const profile = profileRows?.[0] ?? null;
  const persona = normalizePersona(profile?.persona) ?? normalizePersona(authPersona);
  const { data: accountProfile } = await supabaseAdmin
    .from('account_profiles')
    .select('owner_name')
    .eq('auth_user_id', userId)
    .maybeSingle();
  const hasCompletedRestaurantSetup = Boolean(String(accountProfile?.owner_name ?? '').trim());

  if (!persona) {
    redirect('/persona?next=/start');
  }

  if (persona === 'manager' && hasCompletedRestaurantSetup) {
    redirect('/restaurants');
  }

  redirect(persona === 'manager' ? '/onboarding' : '/join');
}
