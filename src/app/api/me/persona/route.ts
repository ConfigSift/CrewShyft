import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';

type Persona = 'manager' | 'employee';

function normalizePersona(value: unknown): Persona | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'manager' || text === 'employee') return text;
  return null;
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: NextRequest) {
  const { supabase, response } = createSupabaseRouteClient(request);
  const { data: authData } = await supabase.auth.getUser();
  const authUserId = authData.user?.id ?? null;

  if (!authUserId) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Unauthorized.' }, { status: 401 }),
      response,
    );
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const persona = normalizePersona(body?.persona);
  if (!persona) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'persona must be "manager" or "employee".' }, { status: 400 }),
      response,
    );
  }

  // Update users table via admin client (bypasses RLS — new users may have no row yet,
  // and the user-session client's RLS policies don't cover NULL organization_id rows).
  // A 0-row update is acceptable: the auth user_metadata write below is the reliable fallback.
  const updateResult = await supabaseAdmin
    .from('users')
    .update({ persona })
    .eq('auth_user_id', authUserId);

  if (updateResult.error) {
    console.error('[/api/me/persona] users.update error:', updateResult.error.message);
    return applySupabaseCookies(
      NextResponse.json({ error: updateResult.error.message }, { status: 400 }),
      response,
    );
  }

  // Update auth user_metadata via admin client (avoids session-state issues with SSR clients).
  const { error: metadataError } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
    user_metadata: { persona },
  });

  if (metadataError) {
    console.error('[/api/me/persona] auth.admin.updateUserById error:', metadataError.message);
    return applySupabaseCookies(
      NextResponse.json({ error: metadataError.message }, { status: 400 }),
      response,
    );
  }

  return applySupabaseCookies(
    NextResponse.json({ ok: true, persona }),
    response,
  );
}
