import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getUserRole } from '@/utils/role';
import { isDebugAllowed } from '@/lib/debug/isDebugAllowed';

// DEV ONLY: promote membership roles. Do not enable in prod.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Payload = {
  authUserId: string;
  organizationId: string;
  role?: string;
};

export async function POST(req: NextRequest) {
  if (!isDebugAllowed()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { supabase, response } = createSupabaseRouteClient(req);
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const requesterAuthId = authData.user?.id;

  if (!requesterAuthId) {
    const message = authError?.message || 'Unauthorized.';
    return applySupabaseCookies(NextResponse.json({ error: message }, { status: 401 }), response);
  }

  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }),
      response
    );
  }

  if (!payload?.authUserId || !payload?.organizationId) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'authUserId and organizationId are required.' }, { status: 400 }),
      response
    );
  }

  const { data: requesterMembership, error: requesterMembershipError } = await supabase
    .from('organization_memberships')
    .select('role')
    .eq('auth_user_id', requesterAuthId)
    .eq('organization_id', payload.organizationId)
    .maybeSingle();

  if (requesterMembershipError || !requesterMembership) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Insufficient permissions.' }, { status: 403 }),
      response
    );
  }

  const requesterRole = String(requesterMembership.role ?? '').trim().toLowerCase();
  if (requesterRole !== 'admin') {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Only admins can promote membership roles.' }, { status: 403 }),
      response
    );
  }

  const targetRole = getUserRole(payload.role ?? 'ADMIN');
  const { error: promoteError } = await supabaseAdmin
    .from('organization_memberships')
    .upsert(
      {
        organization_id: payload.organizationId,
        auth_user_id: payload.authUserId,
        role: String(targetRole).toLowerCase(),
      },
      { onConflict: 'organization_id,auth_user_id' }
    );

  if (promoteError) {
    return applySupabaseCookies(
      NextResponse.json({ error: promoteError.message }, { status: 400 }),
      response
    );
  }

  return applySupabaseCookies(
    NextResponse.json({ ok: true, role: String(targetRole).toLowerCase() }),
    response
  );
}
