import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getUserRole } from '@/utils/role';
import { normalizeJobs } from '@/utils/jobs';
import { splitFullName } from '@/utils/userMapper';
import { normalizeEmployeeNumber, validateEmployeeNumber } from '@/utils/employeeAuth';
import { getAdminAuthApi } from '@/lib/supabase/adminAuth';
import { getSiteUrl } from '@/lib/site-url';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type CreatePayload = {
  organizationId: string;
  fullName: string;
  phone?: string;
  email: string;
  employeeNumber?: number;
  accountType: string;
  jobs: string[];
  passcode?: string;
  pinCode?: string;
  hourlyPay?: number;
  jobPay?: Record<string, number>;
};

type CreateResponse = {
  created: boolean;
  invited: boolean;
  already_member: boolean;
  alreadySent?: boolean;
  reactivated?: boolean;
  action?: 'CREATED' | 'ADDED_EXISTING_AUTH' | 'INVITED' | 'ALREADY_MEMBER';
  error?: string;
  code?: string;
  message?: string;
};

type PostgrestErrorShape = {
  message?: string | null;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
};

function isEmployeeNumberConflict(error: { code?: string | null; message?: string | null; details?: string | null }) {
  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();
  const details = (error.details ?? '').toLowerCase();
  const combined = `${message} ${details}`;
  if (code === '23505' || code === 'P2002') {
    return combined.includes('users_org_employee_number_unique');
  }
  if (combined.includes('duplicate key value') && combined.includes('users_org_employee_number_unique')) {
    return true;
  }
  if (combined.includes('p2002') && combined.includes('employee_number')) {
    return true;
  }
  return false;
}

function isRealEmailConflict(error: { code?: string | null; message?: string | null; details?: string | null }) {
  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();
  const details = (error.details ?? '').toLowerCase();
  const combined = `${message} ${details}`;
  if (code === '23505' || code === 'P2002') {
    return combined.includes('users_org_real_email_unique') || (combined.includes('real_email') && combined.includes('organization_id'));
  }
  if (combined.includes('duplicate key value') && combined.includes('real_email')) {
    return true;
  }
  return combined.includes('users_org_real_email_unique');
}

function sanitizeJobs(jobs: string[]) {
  return normalizeJobs(jobs);
}

async function findAuthUserIdByEmail(normalizedEmail: string): Promise<string | null> {
  const adminAuth = getAdminAuthApi();
  if (typeof adminAuth.getUserByEmail === 'function') {
    const { data, error } = await adminAuth.getUserByEmail(normalizedEmail);
    if (!error && data?.user?.id) return data.user.id;
  }

  if (typeof adminAuth.listUsers !== 'function') {
    return null;
  }

  const perPage = 200;
  let page = 1;
  while (true) {
    const { data: listData, error: listErr } = await adminAuth.listUsers({ page, perPage });
    if (listErr) {
       
      console.warn('[create-user] listUsers failed', listErr.message);
      return null;
    }
    const users = listData?.users ?? [];
    const match = users.find((user) => String(user.email ?? '').toLowerCase() === normalizedEmail);
    if (match?.id) return match.id;
    if (users.length < perPage) break;
    page += 1;
  }

  return null;
}

async function getInvitationColumns(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from('information_schema.columns')
    .select('column_name')
    .eq('table_schema', 'public')
    .eq('table_name', 'organization_invitations');
  if (error || !data) {
    if (process.env.NODE_ENV !== 'production') {
       
      console.warn('[create-user] unable to inspect organization_invitations columns', error?.message);
    }
    return new Set();
  }
  return new Set(data.map((row: { column_name: string }) => row.column_name));
}

function toPostgrestErrorShape(error: PostgrestErrorShape | null | undefined) {
  if (!error) return undefined;
  return {
    message: error.message ?? 'Unknown error.',
    details: error.details ?? null,
    hint: error.hint ?? null,
    code: error.code ?? null,
  };
}

function isExistingAuthUserError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('already been registered') ||
    normalized.includes('already registered') ||
    normalized.includes('already exists')
  );
}

function getStaffInviteRedirect() {
  return `${getSiteUrl()}/auth/invite?next=/set-password`;
}

export async function POST(request: NextRequest) {
  const { supabase, response } = createSupabaseRouteClient(request);
  const hasRefreshToken = request.cookies.getAll().some(
    (cookie) => cookie.name === 'sb-refresh-token' || cookie.name.endsWith('-refresh-token')
  );
  const respond = (res: NextResponse) => (hasRefreshToken ? applySupabaseCookies(res, response) : res);
  const toResponse = (payload: CreateResponse, status = 200) => {
    const { error, message, code, ...rest } = payload;
    const responseBody: Record<string, unknown> = { ...rest };
    if (error) responseBody.error = error;
    if (message) responseBody.message = message;
    if (code) responseBody.code = code;
    return respond(NextResponse.json(responseBody, { status }));
  };
  const toPostgrestErrorResponse = (error: PostgrestErrorShape | null | undefined, status = 400) =>
    respond(NextResponse.json({ error: toPostgrestErrorShape(error) }, { status }));

  try {
    const payload = (await request.json()) as CreatePayload;
    const allowAdminCreation = process.env.ENABLE_ADMIN_CREATION === 'true';
    const isUuid = (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

    if (!payload.organizationId || !payload.fullName || !payload.email) {
      return toResponse(
        { created: false, invited: false, already_member: false, error: 'Missing required fields.' },
        400
      );
    }
    if (!isUuid(String(payload.organizationId))) {
      return toResponse(
        { created: false, invited: false, already_member: false, error: 'Invalid organizationId.', code: 'INVALID_UUID' },
        422
      );
    }

    if (!validateEmployeeNumber(payload.employeeNumber)) {
      return toResponse(
        {
          created: false,
          invited: false,
          already_member: false,
          error: 'Employee number must be between 0001 and 9999.',
        },
        400
      );
    }

    const { data: authData, error: authError } = await supabase.auth.getUser();
    const authUserId = authData.user?.id;

    if (!authUserId) {
      const message =
        process.env.NODE_ENV === 'production'
          ? 'Not signed in. Please sign out/in again.'
          : authError?.message || 'Unauthorized.';
      return toResponse(
        { created: false, invited: false, already_member: false, error: message },
        401
      );
    }

    const { data: requesterMembership, error: requesterMembershipError } = await supabase
      .from('organization_memberships')
      .select('role')
      .eq('auth_user_id', authUserId)
      .eq('organization_id', payload.organizationId)
      .maybeSingle();

    if (requesterMembershipError || !requesterMembership) {
      return toResponse(
        { created: false, invited: false, already_member: false, error: 'Insufficient permissions.' },
        403
      );
    }

    const requesterMembershipRole = String(requesterMembership.role ?? '').trim().toLowerCase();
    if (requesterMembershipRole !== 'admin' && requesterMembershipRole !== 'manager') {
      return toResponse(
        { created: false, invited: false, already_member: false, error: 'Insufficient permissions.' },
        403
      );
    }

    const rawRole = String(payload.accountType ?? '').trim();
    const targetRole = getUserRole(rawRole);
    if (!rawRole || !['ADMIN', 'MANAGER', 'EMPLOYEE', 'STAFF'].includes(rawRole.toUpperCase())) {
      return toResponse(
        { created: false, invited: false, already_member: false, error: 'Invalid account type.' },
        400
      );
    }
    if (requesterMembershipRole === 'manager' && targetRole === 'ADMIN') {
      return toResponse(
        { created: false, invited: false, already_member: false, error: 'Managers cannot create admins.' },
        403
      );
    }
    if (targetRole === 'ADMIN' && !allowAdminCreation) {
      return toResponse(
        { created: false, invited: false, already_member: false, error: 'Admin creation is disabled.' },
        403
      );
    }

    const normalizedJobs = sanitizeJobs(payload.jobs ?? []);
    if ((targetRole === 'EMPLOYEE' || targetRole === 'MANAGER') && normalizedJobs.length === 0) {
      return toResponse(
        {
          created: false,
          invited: false,
          already_member: false,
          error: 'Managers and employees must have at least one job.',
        },
        400
      );
    }

    const employeeNumber = normalizeEmployeeNumber(payload.employeeNumber);
    if (!employeeNumber) {
      return toResponse(
        { created: false, invited: false, already_member: false, error: 'Invalid employee number.' },
        400
      );
    }

    const normalizedEmail = String(payload.email ?? '').trim().toLowerCase();
    if (!normalizedEmail) {
      return toResponse(
        { created: false, invited: false, already_member: false, error: 'Email is required.' },
        400
      );
    }
    if (normalizedEmail.startsWith('emp_') || normalizedEmail.endsWith('@pin.crewshyft.local')) {
      return toResponse(
        {
          created: false,
          invited: false,
          already_member: false,
          error: 'Synthetic auth emails are not allowed.',
        },
        400
      );
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return toResponse(
        {
          created: false,
          invited: false,
          already_member: false,
          error: 'Please enter a valid email address.',
        },
        400
      );
    }

    const existingAuthUserId = await findAuthUserIdByEmail(normalizedEmail);
    let membershipOrgIds: string[] = [];
    let hasMembershipInThisOrg = false;
    let hasMembershipInOtherOrg = false;

    if (existingAuthUserId) {
      const { data: membershipRows, error: membershipRowsError } = await supabaseAdmin
        .from('organization_memberships')
        .select('organization_id')
        .eq('auth_user_id', existingAuthUserId);
      if (membershipRowsError) {
        return toResponse(
          {
            created: false,
            invited: false,
            already_member: false,
            error: membershipRowsError.message,
          },
          400
        );
      }
      membershipOrgIds = (membershipRows ?? []).map((row: { organization_id?: string }) => String(row.organization_id ?? ''));
      hasMembershipInThisOrg = membershipOrgIds.includes(payload.organizationId);
      hasMembershipInOtherOrg = membershipOrgIds.some((id) => id !== payload.organizationId);
    }

    const { data: existingEmailRows, error: existingEmailError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('organization_id', payload.organizationId)
      .or(`real_email.eq.${normalizedEmail},email.eq.${normalizedEmail}`)
      .limit(1);

    if (existingEmailError) {
      return toResponse(
        {
          created: false,
          invited: false,
          already_member: false,
          error: existingEmailError.message,
        },
        400
      );
    }

    if ((existingEmailRows ?? []).length > 0) {
      return toResponse(
        {
          created: false,
          invited: false,
          action: 'ALREADY_MEMBER',
          already_member: true,
          code: 'ALREADY_MEMBER',
          message: 'User already belongs to this restaurant.',
        },
        409
      );
    }

    if (existingAuthUserId && hasMembershipInThisOrg) {
      return toResponse(
        {
          created: false,
          invited: false,
          already_member: true,
          action: 'ALREADY_MEMBER',
          code: 'ALREADY_MEMBER',
          message: 'User already belongs to this restaurant.',
        },
        409
      );
    }

    let authUserIdToUse = existingAuthUserId;
    let invited = false;
    let action: CreateResponse['action'] = 'CREATED';
    const inviteRedirectTo = getStaffInviteRedirect();

    if (!authUserIdToUse) {
      const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        normalizedEmail,
        { redirectTo: inviteRedirectTo }
      );

      if (inviteError) {
        if (isExistingAuthUserError(inviteError.message ?? '')) {
          const fallbackAuthUserId = await findAuthUserIdByEmail(normalizedEmail);
          if (!fallbackAuthUserId) {
            return toResponse(
              {
                created: false,
                invited: false,
                already_member: false,
                code: 'AUTH_USER_LOOKUP_FAILED',
                error: 'User account exists but could not be linked. Please try again.',
              },
              409
            );
          }
          authUserIdToUse = fallbackAuthUserId;
        } else {
          return toResponse(
            {
              created: false,
              invited: false,
              already_member: false,
              code: 'AUTH_INVITE_FAILED',
              error: inviteError.message ?? 'Unable to send onboarding email.',
            },
            400
          );
        }
      } else {
        authUserIdToUse = inviteData?.user?.id ?? (await findAuthUserIdByEmail(normalizedEmail));
      }

      if (!authUserIdToUse) {
        return toResponse(
          {
            created: false,
            invited: false,
            already_member: false,
            code: 'MISSING_AUTH_ID',
            error: 'Unable to create auth user for this email.',
          },
          409
        );
      }

      action = 'CREATED';
    } else {
      const { error: recoveryError } = await supabaseAdmin.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: inviteRedirectTo,
      });
      if (recoveryError) {
        return toResponse(
          {
            created: false,
            invited: false,
            already_member: false,
            code: 'AUTH_RECOVERY_FAILED',
            error: recoveryError.message ?? 'Unable to send onboarding email.',
          },
          400
        );
      }

      if (hasMembershipInOtherOrg) {
        invited = true;
        action = 'INVITED';
      } else {
        action = 'ADDED_EXISTING_AUTH';
      }
    }

    const membershipRole = targetRole.toLowerCase();

    if (invited) {
      const inviteColumns = await getInvitationColumns();
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const requesterProfileId = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('organization_id', payload.organizationId)
        .eq('auth_user_id', authUserId)
        .maybeSingle()
        .then((res) => res.data?.id ?? null);

      const baseInvitePayload: Record<string, unknown> = {
        organization_id: payload.organizationId,
        email: normalizedEmail,
        role: membershipRole,
        status: 'pending',
        invited_by_auth_user_id: authUserId,
      };

      if (inviteColumns.has('created_at')) baseInvitePayload.created_at = nowIso;
      if (inviteColumns.has('updated_at')) baseInvitePayload.updated_at = nowIso;
      if (inviteColumns.has('expires_at')) baseInvitePayload.expires_at = expiresIso;
      if (inviteColumns.has('created_by_auth_user_id')) baseInvitePayload.created_by_auth_user_id = authUserId;
      if (inviteColumns.has('invited_by_user_id')) baseInvitePayload.invited_by_user_id = requesterProfileId ?? authUserId;
      if (inviteColumns.has('created_by_user_id')) baseInvitePayload.created_by_user_id = requesterProfileId ?? authUserId;
      if (inviteColumns.has('invited_by')) baseInvitePayload.invited_by = requesterProfileId ?? authUserId;
      if (inviteColumns.has('invited_by_email')) baseInvitePayload.invited_by_email = authData.user?.email ?? null;

      if (inviteColumns.has('token')) baseInvitePayload.token = crypto.randomUUID();
      if (inviteColumns.has('invite_token')) baseInvitePayload.invite_token = crypto.randomUUID();
      if (inviteColumns.has('invitation_token')) baseInvitePayload.invitation_token = crypto.randomUUID();

      const { data: existingInvite } = await supabaseAdmin
        .from('organization_invitations')
        .select('id,status')
        .eq('organization_id', payload.organizationId)
        .eq('email', normalizedEmail)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingInvite?.id) {
        const status = String(existingInvite.status ?? '').trim().toLowerCase();
        const activeStatuses = new Set(['pending', 'sent']);
        if (activeStatuses.has(status)) {
          return toResponse({
            created: false,
            invited: true,
            already_member: false,
            alreadySent: true,
            action,
            code: 'INVITE_ALREADY_SENT',
            message: 'Invite already sent.',
          });
        }

        const updatePayload: Record<string, unknown> = {
          status: 'pending',
          invited_by_auth_user_id: authUserId,
        };
        if (inviteColumns.has('updated_at')) updatePayload.updated_at = nowIso;
        if (inviteColumns.has('role')) updatePayload.role = membershipRole;
        if (inviteColumns.has('expires_at')) updatePayload.expires_at = expiresIso;
        if (inviteColumns.has('created_by_auth_user_id')) updatePayload.created_by_auth_user_id = authUserId;
        if (inviteColumns.has('invited_by_user_id')) updatePayload.invited_by_user_id = requesterProfileId ?? authUserId;
        if (inviteColumns.has('created_by_user_id')) updatePayload.created_by_user_id = requesterProfileId ?? authUserId;
        if (inviteColumns.has('invited_by')) updatePayload.invited_by = requesterProfileId ?? authUserId;
        if (inviteColumns.has('invited_by_email')) updatePayload.invited_by_email = authData.user?.email ?? null;

        const { error: inviteUpdateError } = await supabaseAdmin
          .from('organization_invitations')
          .update(updatePayload)
          .eq('id', existingInvite.id);
        if (inviteUpdateError) {
          if (process.env.NODE_ENV !== 'production') {
             
            console.error('[create-user] invite update failed', inviteUpdateError);
          }
          return toPostgrestErrorResponse(inviteUpdateError, 400);
        }

        return toResponse({ created: false, invited: true, already_member: false, reactivated: true, action });
      }

      const { error: inviteInsertError } = await supabaseAdmin
        .from('organization_invitations')
        .insert(baseInvitePayload);

      if (inviteInsertError) {
        if (process.env.NODE_ENV !== 'production') {
           
          console.error('[create-user] invite insert failed', inviteInsertError);
        }
        return toPostgrestErrorResponse(inviteInsertError, 400);
      }

      return toResponse({ created: false, invited: true, already_member: false, action });
    }

    // Sanitize jobPay: ensure it's a valid Record<string, number> with no NaN values
    const sanitizedJobPay: Record<string, number> = {};
    const jobPayProvided = payload.jobPay !== undefined && payload.jobPay !== null && typeof payload.jobPay === 'object';
    if (jobPayProvided) {
      for (const [job, rate] of Object.entries(payload.jobPay as Record<string, number>)) {
        const numRate = Number(rate);
        if (Number.isFinite(numRate) && numRate >= 0) {
          sanitizedJobPay[job] = numRate;
        }
      }
    }
    const payValues = Object.values(sanitizedJobPay);
    const hourlyPayValue = jobPayProvided
      ? (payValues.length > 0
          ? Math.round((payValues.reduce((sum, v) => sum + v, 0) / payValues.length) * 100) / 100
          : 0)
      : payload.hourlyPay ?? 0;

    const insertPayload: Record<string, unknown> = {
      auth_user_id: authUserIdToUse ?? null,
      organization_id: payload.organizationId,
      full_name: payload.fullName,
      phone: payload.phone ?? '',
      email: normalizedEmail,
      real_email: normalizedEmail,
      employee_number: employeeNumber,
      role: targetRole,
      jobs: normalizedJobs,
      hourly_pay: hourlyPayValue,
    };
    if (jobPayProvided) {
      insertPayload.job_pay = sanitizedJobPay;
    }

    const insertResult = await supabaseAdmin.from('users').insert(insertPayload);

    if (insertResult.error) {
      if (isRealEmailConflict(insertResult.error)) {
        return toResponse(
          {
            created: false,
            invited: false,
            already_member: false,
            code: 'EMAIL_TAKEN_ORG',
            message: 'Email is already used by another account.',
          },
          409
        );
      }
      if (isEmployeeNumberConflict(insertResult.error)) {
        return toResponse(
          {
            created: false,
            invited: false,
            already_member: false,
            code: 'EMPLOYEE_ID_TAKEN',
            message: 'Employee ID already exists.',
          },
          409
        );
      }
      const message = insertResult.error.message?.toLowerCase() ?? '';
      if (message.includes('hourly_pay')) {
        const withoutPay = { ...insertPayload };
        delete withoutPay.hourly_pay;
        const pinFallbackResult = await supabaseAdmin.from('users').insert(withoutPay);
        if (pinFallbackResult.error) {
          return toResponse(
            {
              created: false,
              invited: false,
              already_member: false,
              error: pinFallbackResult.error.message,
            },
            400
          );
        }
      } else if (message.includes('full_name')) {
        const { firstName, lastName } = splitFullName(payload.fullName);
        const legacyPayload: Record<string, unknown> = {
          auth_user_id: authUserIdToUse ?? null,
          organization_id: payload.organizationId,
          first_name: firstName,
          last_name: lastName,
          phone: payload.phone ?? '',
          email: normalizedEmail,
          real_email: normalizedEmail,
          employee_number: employeeNumber,
          role: targetRole,
          jobs: normalizedJobs,
          hourly_pay: hourlyPayValue,
        };
        if (jobPayProvided) {
          legacyPayload.job_pay = sanitizedJobPay;
        }
        const legacyResult = await supabaseAdmin.from('users').insert(legacyPayload);
        if (legacyResult.error) {
          if (isRealEmailConflict(legacyResult.error)) {
            return toResponse(
              {
                created: false,
                invited: false,
                already_member: false,
                code: 'EMAIL_TAKEN_ORG',
                message: 'Email is already used by another account.',
              },
              409
            );
          }
          if (isEmployeeNumberConflict(legacyResult.error)) {
            return toResponse(
              {
                created: false,
                invited: false,
                already_member: false,
                code: 'EMPLOYEE_ID_TAKEN',
                message: 'Employee ID already exists.',
              },
              409
            );
          }
          if (legacyResult.error.message?.toLowerCase().includes('hourly_pay')) {
            const legacyNoPay = { ...legacyPayload };
            delete legacyNoPay.hourly_pay;
            const secondLegacy = await supabaseAdmin.from('users').insert(legacyNoPay);
            if (secondLegacy.error) {
              if (isRealEmailConflict(secondLegacy.error)) {
                return toResponse(
                  {
                    created: false,
                    invited: false,
                    already_member: false,
                    code: 'EMAIL_TAKEN_ORG',
                    message: 'Email is already used by another account.',
                  },
                  409
                );
              }
              if (isEmployeeNumberConflict(secondLegacy.error)) {
                return toResponse(
                  {
                    created: false,
                    invited: false,
                    already_member: false,
                    code: 'EMPLOYEE_ID_TAKEN',
                    message: 'Employee ID already exists.',
                  },
                  409
                );
              }
              return toResponse(
                {
                  created: false,
                  invited: false,
                  already_member: false,
                  error: secondLegacy.error.message,
                },
                400
              );
            }
          } else {
            return toResponse(
              { created: false, invited: false, already_member: false, error: legacyResult.error.message },
              400
            );
          }
        }
      } else {
        return toResponse(
          { created: false, invited: false, already_member: false, error: insertResult.error.message },
          400
        );
      }
    }

    const { error: membershipError } = await supabaseAdmin
      .from('organization_memberships')
      .upsert(
        {
          organization_id: payload.organizationId,
          auth_user_id: authUserIdToUse,
          role: membershipRole,
        },
        { onConflict: 'organization_id,auth_user_id' }
      );

    if (membershipError) {
      await supabaseAdmin
        .from('users')
        .delete()
        .eq('organization_id', payload.organizationId)
        .eq('auth_user_id', authUserIdToUse);
      if (action === 'CREATED' && authUserIdToUse) {
        await supabaseAdmin.auth.admin.deleteUser(authUserIdToUse);
      }
      return toResponse(
        { created: false, invited: false, already_member: false, error: membershipError.message },
        400
      );
    }

    return toResponse({ created: true, invited: false, already_member: false, action });
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    const message = err.message ?? 'Unknown error.';
    return toResponse(
      { created: false, invited: false, already_member: false, error: message },
      500
    );
  }
}
