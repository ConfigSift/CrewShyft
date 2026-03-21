import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError } from '@/lib/apiResponses';
import { stripe } from '@/lib/stripe/server';
import { BILLING_ENABLED } from '@/lib/stripe/config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MANAGER_ROLE_VALUES = new Set(['admin', 'manager', 'owner', 'super_admin']);

type RequestBody = { organizationId?: string };

export async function POST(request: NextRequest) {
  if (!BILLING_ENABLED) {
    return NextResponse.json({ ok: true, billing_disabled: true });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const organizationId = String(body.organizationId ?? '').trim() || null;
  if (!organizationId) {
    return NextResponse.json({ error: 'organizationId is required.' }, { status: 400 });
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

  const { data: membership } = await supabaseAdmin
    .from('organization_memberships')
    .select('role')
    .eq('auth_user_id', authUserId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  const memberRole = String(membership?.role ?? '').trim().toLowerCase();
  if (!membership || !MANAGER_ROLE_VALUES.has(memberRole)) {
    return applySupabaseCookies(jsonError('Access denied.', 403), response);
  }

  const { data: orgSub } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_subscription_id, status, cancel_at_period_end')
    .eq('organization_id', organizationId)
    .maybeSingle();

  const stripeSubscriptionId =
    (orgSub as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id ?? null;

  if (!stripeSubscriptionId) {
    return applySupabaseCookies(
      NextResponse.json(
        { error: 'No active subscription found for this restaurant.' },
        { status: 404 },
      ),
      response,
    );
  }

  try {
    await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return applySupabaseCookies(
      NextResponse.json({ error: message || 'Unable to cancel subscription.' }, { status: 500 }),
      response,
    );
  }

  await supabaseAdmin
    .from('subscriptions')
    .update({ cancel_at_period_end: true, canceled_at: new Date().toISOString() })
    .eq('organization_id', organizationId);

  return applySupabaseCookies(
    NextResponse.json({ ok: true, cancel_at_period_end: true }),
    response,
  );
}
