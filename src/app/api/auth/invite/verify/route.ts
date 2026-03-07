import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';

type VerifyInvitePayload = {
  token_hash?: string;
};

export async function POST(request: NextRequest) {
  let payload: VerifyInvitePayload;

  try {
    payload = (await request.json()) as VerifyInvitePayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_request_body' },
      { status: 400 },
    );
  }

  const tokenHash = payload.token_hash?.trim();

  if (!tokenHash) {
    return NextResponse.json(
      { ok: false, error: 'missing_token_hash' },
      { status: 400 },
    );
  }

  try {
    const { supabase, response } = createSupabaseRouteClient(request);
    const { error } = await supabase.auth.verifyOtp({
      type: 'invite',
      token_hash: tokenHash,
    });

    if (error) {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: 'otp_invalid_or_expired' },
          { status: 400 },
        ),
        response,
      );
    }

    response.cookies.set('cs_invite_required', '1', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });

    return applySupabaseCookies(
      NextResponse.json({ ok: true }),
      response,
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: 'otp_invalid_or_expired' },
      { status: 400 },
    );
  }
}
