import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isDebugAllowed } from '@/lib/debug/isDebugAllowed';

export async function handleWhoami(req: NextRequest) {
  if (!isDebugAllowed()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { supabase, response } = createSupabaseRouteClient(req);
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const authUserId = authData.user?.id ?? null;

  if (!authUserId) {
    const message = authError?.message || 'Unauthorized.';
    return applySupabaseCookies(NextResponse.json({ error: message }, { status: 401 }), response);
  }

  const { data: memberships, error: membershipError } = await supabaseAdmin
    .from('organization_memberships')
    .select('organization_id, role')
    .eq('auth_user_id', authUserId);

  if (membershipError) {
    return applySupabaseCookies(
      NextResponse.json({ error: membershipError.message }, { status: 500 }),
      response
    );
  }

  const { data: userRows, error: userRowsError } = await supabaseAdmin
    .from('users')
    .select('id, organization_id, email, real_email, role, auth_user_id')
    .eq('auth_user_id', authUserId);

  if (userRowsError) {
    return applySupabaseCookies(
      NextResponse.json({ error: userRowsError.message }, { status: 500 }),
      response
    );
  }

  return applySupabaseCookies(
    NextResponse.json({
      auth_user_id: authUserId,
      memberships: memberships ?? [],
      users: userRows ?? [],
    }),
    response
  );
}
