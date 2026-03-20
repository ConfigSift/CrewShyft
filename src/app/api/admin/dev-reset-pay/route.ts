import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { isDebugAllowed } from '@/lib/debug/isDebugAllowed';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type ResetPayload = {
  emails: string[];
};

export async function POST(request: NextRequest) {
  if (!isDebugAllowed()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { supabase, response } = createSupabaseRouteClient(request);
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (!authData.user?.id) {
    const message = authError?.message ?? 'Unauthorized.';
    return applySupabaseCookies(NextResponse.json({ error: message }, { status: 401 }), response);
  }

  const payload = (await request.json()) as ResetPayload;
  const emails = Array.isArray(payload.emails)
    ? payload.emails.map((email) => String(email).trim()).filter(Boolean)
    : [];

  if (emails.length === 0) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Provide at least one email.' }, { status: 400 }),
      response
    );
  }

  const { data: users, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, email')
    .in('email', emails);

  if (userError) {
    return applySupabaseCookies(
      NextResponse.json({ error: userError.message }, { status: 400 }),
      response
    );
  }

  const userIds = (users ?? []).map((user) => user.id);

  const { error: updateError } = await supabaseAdmin
    .from('users')
    .update({ job_pay: {}, hourly_pay: null })
    .in('email', emails);

  if (updateError) {
    return applySupabaseCookies(
      NextResponse.json({ error: updateError.message }, { status: 400 }),
      response
    );
  }

  return applySupabaseCookies(
    NextResponse.json({ success: true, updatedCount: emails.length, userIds }),
    response
  );
}
