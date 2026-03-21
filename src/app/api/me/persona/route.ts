import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';

type Persona = 'manager' | 'employee';

type SyncIssue = {
  target: 'auth_metadata' | 'users_table';
  message: string;
};

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
  const existingMetadata = (authData.user?.user_metadata ?? {}) as Record<string, unknown>;

  if (!authUserId) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Unauthorized.' }, { status: 401 }),
      response,
    );
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    console.error('[/api/me/persona] request.json() failed:', message);
    return applySupabaseCookies(
      NextResponse.json({ error: `Invalid request body: ${message}` }, { status: 400 }),
      response,
    );
  }

  const persona = normalizePersona(body?.persona);
  if (!persona) {
    console.error('[/api/me/persona] invalid persona value:', JSON.stringify(body));
    return applySupabaseCookies(
      NextResponse.json({ error: `persona must be "manager" or "employee". Received: ${JSON.stringify(body?.persona)}` }, { status: 400 }),
      response,
    );
  }

  const syncIssues: SyncIssue[] = [];

  // Update auth user_metadata first so routing can proceed even if the users table
  // is temporarily behind a migration or the PostgREST schema cache is stale.
  const { error: metadataError } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
    user_metadata: {
      ...existingMetadata,
      persona,
    },
  });

  if (metadataError) {
    console.error('[/api/me/persona] auth.admin.updateUserById error:', metadataError.message);
    syncIssues.push({
      target: 'auth_metadata',
      message: metadataError.message,
    });
  }

  // Sync the users row via admin client (bypasses RLS). Missing rows are tolerated
  // because auth metadata is the durable fallback during onboarding.
  const updateResult = await supabaseAdmin
    .from('users')
    .update({ persona })
    .eq('auth_user_id', authUserId)
    .select('auth_user_id')
    .limit(1);

  if (updateResult.error) {
    console.error('[/api/me/persona] users.update error:', updateResult.error.message, updateResult.error.code);
    syncIssues.push({
      target: 'users_table',
      message: updateResult.error.message,
    });
  } else if ((updateResult.data?.length ?? 0) === 0) {
    console.warn('[/api/me/persona] users.update matched no rows for auth_user_id:', authUserId);
  }

  const metadataSaved = !metadataError;
  const profileSynced = !updateResult.error && (updateResult.data?.length ?? 0) > 0;

  if (!metadataSaved && !profileSynced) {
    const message = syncIssues.map((issue) => `${issue.target}: ${issue.message}`).join(' | ');
    return applySupabaseCookies(
      NextResponse.json({ error: `Persona save failed: ${message}` }, { status: 500 }),
      response,
    );
  }

  return applySupabaseCookies(
    NextResponse.json({
      ok: true,
      persona,
      metadataSaved,
      profileSynced,
      warning: syncIssues.length > 0 ? syncIssues.map((issue) => issue.message).join(' | ') : null,
    }),
    response,
  );
}
