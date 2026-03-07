import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getSiteUrl } from '@/lib/site-url';
import { getUserRole, isManagerRole } from '@/utils/role';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getInviteRedirect() {
  return `${getSiteUrl()}/auth/invite?next=/set-password`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ staffId: string }> },
) {
  const { supabase, response } = createSupabaseRouteClient(request);

  try {
    const { staffId } = await params;

    if (!UUID_RE.test(staffId)) {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: 'Invalid staff ID.', code: 'INVALID_STAFF_ID' },
          { status: 400 },
        ),
        response,
      );
    }

    const { data: authData, error: authError } = await supabase.auth.getUser();
    const requesterAuthUserId = authData.user?.id;

    if (!requesterAuthUserId) {
      const message =
        process.env.NODE_ENV === 'production'
          ? 'Not signed in. Please sign out/in again.'
          : authError?.message || 'Unauthorized.';
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: message, code: 'UNAUTHORIZED' },
          { status: 401 },
        ),
        response,
      );
    }

    const { data: targetRow, error: targetError } = await supabaseAdmin
      .from('users')
      .select('id, organization_id, auth_user_id, email, real_email, role')
      .eq('id', staffId)
      .maybeSingle();

    if (targetError) {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: targetError.message, code: 'TARGET_LOOKUP_FAILED' },
          { status: 400 },
        ),
        response,
      );
    }

    if (!targetRow) {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: 'Staff member not found.', code: 'TARGET_NOT_FOUND' },
          { status: 404 },
        ),
        response,
      );
    }

    const organizationId = String(targetRow.organization_id ?? '').trim();
    if (!organizationId) {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: 'Staff member is missing an organization.', code: 'TARGET_NOT_FOUND' },
          { status: 404 },
        ),
        response,
      );
    }

    const { data: requesterMembership, error: requesterMembershipError } = await supabase
      .from('organization_memberships')
      .select('role')
      .eq('auth_user_id', requesterAuthUserId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (requesterMembershipError || !requesterMembership) {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: 'You do not have permission for that action.', code: 'FORBIDDEN' },
          { status: 403 },
        ),
        response,
      );
    }

    const requesterRole = String(requesterMembership.role ?? '').trim().toUpperCase();
    if (!isManagerRole(requesterRole)) {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: 'You do not have permission for that action.', code: 'FORBIDDEN' },
          { status: 403 },
        ),
        response,
      );
    }

    const targetRole = getUserRole(targetRow.role ?? 'EMPLOYEE');
    if (requesterRole === 'MANAGER' && targetRole === 'ADMIN') {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: 'You do not have permission for that action.', code: 'FORBIDDEN' },
          { status: 403 },
        ),
        response,
      );
    }

    const loginEmail = String(targetRow.real_email ?? targetRow.email ?? '').trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(loginEmail)) {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: 'Staff member does not have a valid login email.', code: 'INVALID_EMAIL' },
          { status: 400 },
        ),
        response,
      );
    }

    const { error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(loginEmail, {
      redirectTo: getInviteRedirect(),
    });

    if (inviteError) {
      return applySupabaseCookies(
        NextResponse.json(
          { ok: false, error: inviteError.message || 'Unable to send invite email.', code: 'INVITE_FAILED' },
          { status: 400 },
        ),
        response,
      );
    }

    console.info('[resend-invite] branch=pending_user_invite_resent', {
      staffId,
      organizationId,
      email: loginEmail,
    });

    return applySupabaseCookies(
      NextResponse.json({ ok: true }),
      response,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    return applySupabaseCookies(
      NextResponse.json(
        { ok: false, error: message, code: 'UNEXPECTED_ERROR' },
        { status: 500 },
      ),
      response,
    );
  }
}
