import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { jsonError } from '@/lib/apiResponses';
import { stripe } from '@/lib/stripe/server';
import { getLocationCount } from '@/lib/stripe/helpers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SyncPayload = {
  organizationId: string;
};

export async function POST(request: NextRequest) {
  let payload: SyncPayload;
  try {
    payload = (await request.json()) as SyncPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { organizationId } = payload;

  if (!organizationId) {
    return NextResponse.json({ error: 'organizationId is required.' }, { status: 400 });
  }

  // Authenticate
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

  // Verify user is admin of this org
  const { data: membership } = await supabaseAdmin
    .from('organization_memberships')
    .select('role')
    .eq('auth_user_id', authUserId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (!membership || membership.role !== 'admin') {
    return applySupabaseCookies(
      jsonError('Only admins can manage billing.', 403),
      response,
    );
  }

  // Look up subscription
  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_subscription_id, quantity')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (!sub?.stripe_subscription_id) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'No active subscription found.' }, { status: 404 }),
      response,
    );
  }

  // Count current locations
  const newQuantity = await getLocationCount(organizationId);

  // Skip Stripe call if quantity hasn't changed
  if (newQuantity === sub.quantity) {
    return applySupabaseCookies(
      NextResponse.json({ quantity: newQuantity, changed: false }),
      response,
    );
  }

  try {
    // Fetch subscription to get the item ID
    const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const itemId = stripeSubscription.items.data[0]?.id;

    if (!itemId) {
      console.error('[billing:sync-quantity] No subscription item found');
      return applySupabaseCookies(
        NextResponse.json({ error: 'Subscription item not found.' }, { status: 500 }),
        response,
      );
    }

    // Update quantity on Stripe
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: itemId, quantity: newQuantity }],
      proration_behavior: 'create_prorations',
    });

    // Update local record
    await supabaseAdmin
      .from('subscriptions')
      .update({ quantity: newQuantity, updated_at: new Date().toISOString() })
      .eq('stripe_subscription_id', sub.stripe_subscription_id);

    return applySupabaseCookies(
      NextResponse.json({ quantity: newQuantity, changed: true }),
      response,
    );
  } catch (err) {
    console.error('[billing:sync-quantity] Stripe quantity update failed:', err);
    return applySupabaseCookies(
      NextResponse.json({ error: 'Unable to update subscription quantity.' }, { status: 500 }),
      response,
    );
  }
}
