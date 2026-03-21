import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { BILLING_ENABLED } from '@/lib/stripe/config';
import { isActiveBillingStatus } from '@/lib/billing/customer';
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

  const { data: profileRows } = await supabaseAdmin
    .from('users')
    .select('persona')
    .eq('auth_user_id', userId)
    .limit(1);

  const profile = profileRows?.[0] ?? null;
  const persona = normalizePersona(profile?.persona) ?? normalizePersona(authPersona);

  if (!persona) {
    redirect('/persona');
  }

  const { data: memberships } = await supabaseAdmin
    .from('organization_memberships')
    .select('organization_id, role')
    .eq('auth_user_id', userId);

  const membershipList = memberships ?? [];
  if (membershipList.length === 0) {
    redirect(persona === 'manager' ? '/onboarding' : '/join');
  }

  if (BILLING_ENABLED) {
    const ownedOrgIds = membershipList
      .filter((membership) => {
        const role = String(membership.role ?? '').trim().toLowerCase();
        return role === 'admin' || role === 'owner';
      })
      .map((membership) => membership.organization_id as string);

    if (ownedOrgIds.length > 0) {
      // Per-org billing: each restaurant has its own row in the subscriptions table.
      const { data: orgSubs } = await supabaseAdmin
        .from('subscriptions')
        .select('organization_id, status')
        .in('organization_id', ownedOrgIds);

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
