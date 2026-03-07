import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getUserRole, isManagerRole } from '@/utils/role';
import { normalizeJobs, serializeJobsForStorage } from '@/utils/jobs';
import { normalizeUserRow, splitFullName } from '@/utils/userMapper';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type UpdatePayload = {
  userId: string;
  organizationId: string;
  fullName: string;
  email?: string;
  phone?: string;
  employeeNumber?: number;
  accountType?: string;
  jobs?: string[];
  passcode?: string;
  hourlyPay?: number;
  jobPay?: Record<string, number>;
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

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export async function POST(request: NextRequest) {
  const payload = (await request.json()) as UpdatePayload;
  const allowAdminCreation = process.env.ENABLE_ADMIN_CREATION === 'true';
  const emailInput = payload.email !== undefined ? String(payload.email ?? '').trim() : undefined;
  const normalizedEmail = emailInput ? emailInput.toLowerCase() : undefined;

  if (!payload.userId || !payload.organizationId || !payload.fullName) {
    return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
  }
  if (!isUuid(payload.userId) || !isUuid(payload.organizationId)) {
    return NextResponse.json(
      { error: 'Invalid userId or organizationId.', code: 'INVALID_UUID' },
      { status: 422 }
    );
  }

  const { supabase, response } = createSupabaseRouteClient(request);
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const authUserId = authData.user?.id;

  if (!authUserId) {
    const message =
      process.env.NODE_ENV === 'production'
        ? 'Not signed in. Please sign out/in again.'
        : authError?.message || 'Unauthorized.';
    return applySupabaseCookies(NextResponse.json({ error: message }, { status: 401 }), response);
  }

  const { data: requesterMembership, error: requesterMembershipError } = await supabase
    .from('organization_memberships')
    .select('role')
    .eq('auth_user_id', authUserId)
    .eq('organization_id', payload.organizationId)
    .maybeSingle();

  if (requesterMembershipError || !requesterMembership) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
      response
    );
  }

  const requesterRole = String(requesterMembership.role ?? '').trim().toUpperCase();

  const { data: targetRow, error: targetError } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', payload.userId)
    .eq('organization_id', payload.organizationId)
    .maybeSingle();

  if (targetError) {
    return applySupabaseCookies(
      NextResponse.json({ error: targetError.message }, { status: 400 }),
      response
    );
  }
  if (!targetRow) {
    return applySupabaseCookies(
      NextResponse.json(
        {
          error: 'Target user not found.',
          code: 'TARGET_NOT_FOUND',
          expected: 'userId (public.users.id) scoped by organizationId',
        },
        { status: 404 }
      ),
      response
    );
  }

  const targetAuthUserId = targetRow.auth_user_id ?? null;

  let targetMembershipRole = getUserRole(targetRow.role ?? 'EMPLOYEE');
  if (targetAuthUserId) {
    const { data: targetMembership } = await supabaseAdmin
      .from('organization_memberships')
      .select('role')
      .eq('organization_id', payload.organizationId)
      .eq('auth_user_id', targetAuthUserId)
      .maybeSingle();
    if (targetMembership?.role) {
      targetMembershipRole = getUserRole(targetMembership.role);
    }
  }

  const isSelfUpdate = Boolean(targetAuthUserId && targetAuthUserId === authUserId);

  if (!isManagerRole(requesterRole) && !isSelfUpdate) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
      response
    );
  }

  // Employees doing self-updates can only change name/phone here.
  if (isSelfUpdate && !isManagerRole(requesterRole)) {
    if (payload.accountType || payload.jobs || payload.hourlyPay !== undefined || payload.jobPay) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
        response
      );
    }
  }

  const rawRole = payload.accountType ?? targetMembershipRole;
  const targetRole = getUserRole(rawRole);
  if (payload.accountType && !['ADMIN', 'MANAGER', 'EMPLOYEE', 'STAFF'].includes(String(payload.accountType).toUpperCase())) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Invalid account type.' }, { status: 400 }),
      response
    );
  }

  if (requesterRole === 'MANAGER' && targetMembershipRole === 'ADMIN') {
    return applySupabaseCookies(
      NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
      response
    );
  }

  if (requesterRole === 'MANAGER' && targetRole === 'ADMIN') {
    return applySupabaseCookies(
      NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
      response
    );
  }

  if (requesterRole === 'MANAGER' && targetRole !== 'MANAGER' && targetRole !== 'EMPLOYEE') {
    return applySupabaseCookies(
      NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
      response
    );
  }

  if (payload.accountType && targetRole === 'ADMIN' && !allowAdminCreation) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
      response
    );
  }

  if (requesterRole === 'ADMIN' && targetAuthUserId === authUserId && targetRole !== 'ADMIN') {
    return applySupabaseCookies(
      NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
      response
    );
  }

  if (targetAuthUserId === authUserId && payload.accountType && targetRole !== targetMembershipRole) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
      response
    );
  }

  if (payload.email !== undefined) {
    if (requesterRole !== 'ADMIN') {
      return applySupabaseCookies(
        NextResponse.json({ error: 'You dont have permission for that action.' }, { status: 403 }),
        response
      );
    }
    if (!normalizedEmail) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Email is required.' }, { status: 400 }),
        response
      );
    }
    if (normalizedEmail.startsWith('emp_') || normalizedEmail.endsWith('@pin.crewshyft.local')) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 }),
        response
      );
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 }),
        response
      );
    }

    const { data: existingEmailRows, error: existingEmailError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('organization_id', payload.organizationId)
      .neq('id', payload.userId)
      .or(`real_email.eq.${normalizedEmail},email.eq.${normalizedEmail}`)
      .limit(1);
    if (existingEmailError) {
      return applySupabaseCookies(
        NextResponse.json({ error: existingEmailError.message }, { status: 400 }),
        response
      );
    }
    if ((existingEmailRows ?? []).length > 0) {
      return applySupabaseCookies(
        NextResponse.json(
          { code: 'EMAIL_TAKEN_ORG', message: 'Email is already used by another account.' },
          { status: 409 }
        ),
        response
      );
    }
  }

  if (payload.employeeNumber !== undefined) {
    const num = Number(payload.employeeNumber);
    if (!Number.isInteger(num) || num < 1 || num > 9999) {
      return applySupabaseCookies(
        NextResponse.json({ error: 'Employee number must be between 0001 and 9999.' }, { status: 400 }),
        response
      );
    }
  }

  const normalizedJobs = payload.jobs ? normalizeJobs(payload.jobs) : normalizeJobs(targetRow.jobs);
  if ((targetRole === 'EMPLOYEE' || targetRole === 'MANAGER') && normalizedJobs.length === 0) {
    return applySupabaseCookies(
      NextResponse.json({ error: 'Managers and employees must have at least one job.' }, { status: 400 }),
      response
    );
  }

  // Detect removed jobs and check for future shifts
  const currentJobs = normalizeJobs(targetRow.jobs);
  const removedJobs = currentJobs.filter((job) => !normalizedJobs.includes(job));
  if (removedJobs.length > 0) {
    const today = new Date().toISOString().split('T')[0];
    const { data: futureShifts, error: shiftError } = await supabaseAdmin
      .from('shifts')
      .select('id, shift_date, job')
      .eq('user_id', targetRow.id)
      .gt('shift_date', today)
      .in('job', removedJobs)
      .order('shift_date', { ascending: true })
      .limit(10);

    if (!shiftError && futureShifts && futureShifts.length > 0) {
      const { count } = await supabaseAdmin
        .from('shifts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', targetRow.id)
        .gt('shift_date', today)
        .in('job', removedJobs);

      const jobsInUse = [...new Set(futureShifts.map((s) => s.job))];
      const exampleDates = [...new Set(futureShifts.slice(0, 5).map((s) => s.shift_date))];
      const earliestDate = futureShifts.reduce<string | null>((earliest, shift) => {
        if (!shift.shift_date) return earliest;
        if (!earliest || shift.shift_date < earliest) return shift.shift_date;
        return earliest;
      }, null);

      return applySupabaseCookies(
        NextResponse.json({
          error: `Cannot remove job(s): ${jobsInUse.join(', ')}. Employee is scheduled for ${count ?? futureShifts.length} future shift(s) with those job roles. Remove/reassign those shifts first.`,
          code: 'JOB_IN_USE',
          removedJobs: jobsInUse,
          count: count ?? futureShifts.length,
          exampleDates,
          earliestDate,
        }, { status: 400 }),
        response
      );
    }
  }

  if (payload.accountType && targetAuthUserId) {
    const membershipRoleValue = String(targetRole).toLowerCase();
    const { error: membershipUpdateError } = await supabaseAdmin
      .from('organization_memberships')
      .update({ role: membershipRoleValue })
      .eq('organization_id', payload.organizationId)
      .eq('auth_user_id', targetAuthUserId);
    if (membershipUpdateError) {
      if (process.env.NODE_ENV !== 'production') {
         
        console.error('[update-user] membership update failed', {
          organizationId: payload.organizationId,
          authUserId: targetAuthUserId,
          role: membershipRoleValue,
          error: membershipUpdateError,
        });
      }
      return applySupabaseCookies(
        NextResponse.json({ error: membershipUpdateError.message }, { status: 400 }),
        response
      );
    }
  }

  const jobsPayload = serializeJobsForStorage(targetRow.jobs, normalizedJobs);

  // Sanitize jobPay: ensure it's a valid Record<string, number> with no NaN values
  let sanitizedJobPay: Record<string, number> = {};
  const jobPayProvided = payload.jobPay !== undefined && payload.jobPay !== null && typeof payload.jobPay === 'object';
  if (jobPayProvided) {
    for (const [job, rate] of Object.entries(payload.jobPay as Record<string, number>)) {
      const numRate = Number(rate);
      if (Number.isFinite(numRate) && numRate >= 0) {
        sanitizedJobPay[job] = numRate;
      }
    }
  } else {
    sanitizedJobPay = {};
  }
  const payValues = Object.values(sanitizedJobPay);
  const hourlyPayValue = jobPayProvided
    ? (payValues.length > 0
        ? Math.round((payValues.reduce((sum, v) => sum + v, 0) / payValues.length) * 100) / 100
        : 0)
    : payload.hourlyPay ?? targetRow.hourly_pay ?? 0;

  const baseUpdatePayload: Record<string, unknown> = {
    full_name: payload.fullName,
    phone: payload.phone ?? '',
    role: targetRole,
    jobs: jobsPayload,
    hourly_pay: hourlyPayValue,
  };
  if (normalizedEmail !== undefined) {
    baseUpdatePayload.email = normalizedEmail;
    baseUpdatePayload.real_email = normalizedEmail;
  }
  if (payload.employeeNumber !== undefined) {
    baseUpdatePayload.employee_number = payload.employeeNumber;
  }
  if (jobPayProvided) {
    baseUpdatePayload.job_pay = sanitizedJobPay;
  }

  const updateResult = await supabaseAdmin
    .from('users')
    .update(baseUpdatePayload)
    .eq('organization_id', payload.organizationId)
    .eq('id', payload.userId);

  if (updateResult.error) {
    if (isEmployeeNumberConflict(updateResult.error)) {
      return applySupabaseCookies(
        NextResponse.json(
          {
            code: 'EMPLOYEE_ID_TAKEN',
            message: 'Employee ID already exists.',
          },
          { status: 409 }
        ),
        response
      );
    }
    if (isRealEmailConflict(updateResult.error)) {
      return applySupabaseCookies(
        NextResponse.json(
          { code: 'EMAIL_TAKEN_ORG', message: 'Email is already used by another account.' },
          { status: 409 }
        ),
        response
      );
    }
    const message = updateResult.error.message?.toLowerCase() ?? '';
    if (message.includes('full_name') || message.includes('hourly_pay')) {
      const safeHourlyPay = message.includes('hourly_pay') ? undefined : hourlyPayValue;
      const { firstName, lastName } = splitFullName(payload.fullName);
      const legacyResult = await supabaseAdmin
        .from('users')
        .update({
          first_name: firstName,
          last_name: lastName,
          phone: payload.phone ?? '',
          role: targetRole,
          jobs: jobsPayload,
          ...(safeHourlyPay === undefined ? {} : { hourly_pay: safeHourlyPay }),
          ...(normalizedEmail !== undefined ? { email: normalizedEmail, real_email: normalizedEmail } : {}),
          ...(payload.employeeNumber !== undefined ? { employee_number: payload.employeeNumber } : {}),
          ...(jobPayProvided ? { job_pay: sanitizedJobPay } : {}),
        })
        .eq('organization_id', payload.organizationId)
        .eq('id', payload.userId);
      if (legacyResult.error) {
        if (isEmployeeNumberConflict(legacyResult.error)) {
          return applySupabaseCookies(
            NextResponse.json(
              {
                code: 'EMPLOYEE_ID_TAKEN',
                message: 'Employee ID already exists.',
              },
              { status: 409 }
            ),
            response
          );
        }
        if (isRealEmailConflict(legacyResult.error)) {
          return applySupabaseCookies(
            NextResponse.json(
              { code: 'EMAIL_TAKEN_ORG', message: 'Email is already used by another account.' },
              { status: 409 }
            ),
            response
          );
        }
        return applySupabaseCookies(
          NextResponse.json({ error: legacyResult.error.message }, { status: 400 }),
          response
        );
      }
    } else {
      return applySupabaseCookies(
        NextResponse.json({ error: updateResult.error.message }, { status: 400 }),
        response
      );
    }
  }

  const { data: updatedRow, error: fetchError } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('organization_id', payload.organizationId)
    .eq('id', payload.userId)
    .single();

  if (fetchError || !updatedRow) {
    return applySupabaseCookies(NextResponse.json({ success: true }), response);
  }

  return applySupabaseCookies(
    NextResponse.json({ success: true, user: normalizeUserRow(updatedRow) }),
    response
  );
}
