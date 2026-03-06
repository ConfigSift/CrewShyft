import { NextRequest, NextResponse } from 'next/server';
import { applySupabaseCookies, createSupabaseRouteClient } from '@/lib/supabase/route';
import { jsonError } from '@/lib/apiResponses';
import { BILLING_ENABLED } from '@/lib/stripe/config';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  cancelStripeSubscriptionIfNeeded,
  countOwnedOrganizations,
  getBillingAccountForUser,
} from '@/lib/billing/lifecycle';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type DeletePayload = {
  confirm?: string;
};

type SupabaseErrorLike = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

type RemainingReferenceValue = number | string | string[] | null;
type RemainingReferenceMap = Record<string, RemainingReferenceValue>;
type CleanupStepResult = {
  error: SupabaseErrorLike | null;
  count?: number | null;
};
type CleanupSummary = Record<string, number | 'skipped' | null>;

const CANCELLATION_REQUIRED_STATUSES = new Set(['active', 'trialing', 'past_due']);

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function isMissingDbObject(message: string | null | undefined) {
  const normalized = String(message ?? '').toLowerCase();
  return (
    (normalized.includes('relation') && normalized.includes('does not exist')) ||
    (normalized.includes('column') && normalized.includes('does not exist')) ||
    normalized.includes('could not find the table')
  );
}

function stringifyForLog(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return JSON.stringify(
      { fallback: String(value), stringifyError: error instanceof Error ? error.message : String(error) },
      null,
      2,
    );
  }
}

function formatDeleteFailure(
  fallbackMessage: string,
  error: SupabaseErrorLike | null | undefined,
  extras?: Record<string, unknown>,
) {
  const code = String(error?.code ?? '').trim() || undefined;
  const details = String(error?.details ?? '').trim() || undefined;
  const hint = String(error?.hint ?? '').trim() || undefined;
  const rawMessage = String(error?.message ?? '').trim();
  const message = code ? `${fallbackMessage} (${code})` : fallbackMessage;

  return {
    error: rawMessage || fallbackMessage,
    message,
    code,
    details,
    hint,
    ...extras,
  };
}

async function getCountIfExists(
  label: string,
  query: PromiseLike<{ count: number | null; error: SupabaseErrorLike | null }>,
): Promise<[string, RemainingReferenceValue]> {
  try {
    const { count, error } = await query;
    if (error) {
      return isMissingDbObject(error.message)
        ? [label, null]
        : [label, `error:${error.code ?? 'unknown'}:${error.message ?? 'unknown'}`];
    }
    return [label, count ?? 0];
  } catch (error) {
    return [label, `error:exception:${error instanceof Error ? error.message : String(error)}`];
  }
}

async function collectRemainingAccountReferences(authUserId: string): Promise<RemainingReferenceMap> {
  const remaining: RemainingReferenceMap = {};

  const { data: userRows, error: userRowsError, count: userCount } = await supabaseAdmin
    .from('users')
    .select('id', { count: 'exact' })
    .eq('auth_user_id', authUserId);

  const userIds = (userRows ?? [])
    .map((row) => String((row as { id?: string | null }).id ?? '').trim())
    .filter(Boolean);

  if (userRowsError) {
    remaining.users = isMissingDbObject(userRowsError.message)
      ? null
      : `error:${userRowsError.code ?? 'unknown'}:${userRowsError.message ?? 'unknown'}`;
  } else {
    remaining.users = userCount ?? userIds.length;
  }
  remaining.user_ids = userIds;

  const countTasks: Array<Promise<[string, RemainingReferenceValue]>> = [
    getCountIfExists(
      'organization_memberships',
      supabaseAdmin
        .from('organization_memberships')
        .select('id', { count: 'exact', head: true })
        .eq('auth_user_id', authUserId),
    ),
    getCountIfExists(
      'account_profiles',
      supabaseAdmin
        .from('account_profiles')
        .select('auth_user_id', { count: 'exact', head: true })
        .eq('auth_user_id', authUserId),
    ),
    getCountIfExists(
      'billing_accounts',
      supabaseAdmin
        .from('billing_accounts')
        .select('auth_user_id', { count: 'exact', head: true })
        .eq('auth_user_id', authUserId),
    ),
    getCountIfExists(
      'organization_create_intents',
      supabaseAdmin
        .from('organization_create_intents')
        .select('id', { count: 'exact', head: true })
        .eq('auth_user_id', authUserId),
    ),
    getCountIfExists(
      'stripe_customers',
      supabaseAdmin
        .from('stripe_customers')
        .select('id', { count: 'exact', head: true })
        .eq('auth_user_id', authUserId),
    ),
    getCountIfExists(
      'chat_rooms',
      supabaseAdmin
        .from('chat_rooms')
        .select('id', { count: 'exact', head: true })
        .eq('created_by_auth_user_id', authUserId),
    ),
    getCountIfExists(
      'chat_messages',
      supabaseAdmin
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('author_auth_user_id', authUserId),
    ),
    getCountIfExists(
      'blocked_day_requests_by_auth_user_id',
      supabaseAdmin
        .from('blocked_day_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requested_by_auth_user_id', authUserId),
    ),
    getCountIfExists(
      'blocked_day_requests_reviewer_auth_user_id',
      supabaseAdmin
        .from('blocked_day_requests')
        .select('id', { count: 'exact', head: true })
        .eq('reviewed_by_auth_user_id', authUserId),
    ),
    getCountIfExists(
      'time_off_requests_requester_auth_user_id',
      supabaseAdmin
        .from('time_off_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requester_auth_user_id', authUserId),
    ),
    getCountIfExists(
      'time_off_requests_auth_user_id',
      supabaseAdmin
        .from('time_off_requests')
        .select('id', { count: 'exact', head: true })
        .eq('auth_user_id', authUserId),
    ),
    getCountIfExists(
      'shift_exchange_requests_requested_by_auth_user_id',
      supabaseAdmin
        .from('shift_exchange_requests')
        .select('id', { count: 'exact', head: true })
        .eq('requested_by_auth_user_id', authUserId),
    ),
    getCountIfExists(
      'shift_exchange_requests_claimed_by_auth_user_id',
      supabaseAdmin
        .from('shift_exchange_requests')
        .select('id', { count: 'exact', head: true })
        .eq('claimed_by_auth_user_id', authUserId),
    ),
    getCountIfExists(
      'schedule_publish_snapshots_created_by_auth_user_id',
      supabaseAdmin
        .from('schedule_publish_snapshots')
        .select('id', { count: 'exact', head: true })
        .eq('created_by_auth_user_id', authUserId),
    ),
    getCountIfExists(
      'organization_invitations_invited_by_auth_user_id',
      supabaseAdmin
        .from('organization_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('invited_by_auth_user_id', authUserId),
    ),
  ];

  if (userIds.length > 0) {
    const userIdList = userIds.join(',');
    countTasks.push(
      getCountIfExists(
        'shifts_by_user_id',
        supabaseAdmin
          .from('shifts')
          .select('id', { count: 'exact', head: true })
          .in('user_id', userIds),
      ),
      getCountIfExists(
        'schedule_publish_snapshot_shifts_by_user_id',
        supabaseAdmin
          .from('schedule_publish_snapshot_shifts')
          .select('shift_id', { count: 'exact', head: true })
          .in('user_id', userIds),
      ),
      getCountIfExists(
        'blocked_day_requests_by_user_id',
        supabaseAdmin
          .from('blocked_day_requests')
          .select('id', { count: 'exact', head: true })
          .in('user_id', userIds),
      ),
      getCountIfExists(
        'time_off_requests_by_user_id',
        supabaseAdmin
          .from('time_off_requests')
          .select('id', { count: 'exact', head: true })
          .in('user_id', userIds),
      ),
      getCountIfExists(
        'time_off_requests_by_requester_user_id',
        supabaseAdmin
          .from('time_off_requests')
          .select('id', { count: 'exact', head: true })
          .in('requester_user_id', userIds),
      ),
      getCountIfExists(
        'time_off_requests_reviewed_by_user_id',
        supabaseAdmin
          .from('time_off_requests')
          .select('id', { count: 'exact', head: true })
          .in('reviewed_by', userIds),
      ),
      getCountIfExists(
        'schedule_versions_created_by_user_id',
        supabaseAdmin
          .from('schedule_versions')
          .select('id', { count: 'exact', head: true })
          .in('created_by', userIds),
      ),
    );
    remaining.user_id_csv = userIdList;
  }

  const countedEntries = await Promise.all(countTasks);
  for (const [label, value] of countedEntries) {
    remaining[label] = value;
  }

  return remaining;
}

async function runCleanupStep(
  step: string,
  authUserId: string,
  summary: CleanupSummary,
  action: () => PromiseLike<CleanupStepResult>,
) {
  const result = await action();
  const error = result.error;
  if (error && !isMissingDbObject(error.message)) {
    console.error(`[account:delete] ${step} failed`, {
      authUserId,
      error: stringifyForLog(error),
    });
    return formatDeleteFailure(`Failed during account cleanup (${step}).`, error, {
      step,
    });
  }

  summary[step] = error ? 'skipped' : result.count ?? null;
  return null;
}

export async function POST(request: NextRequest) {
  let payload: DeletePayload;
  try {
    payload = (await request.json()) as DeletePayload;
  } catch {
    return jsonNoStore({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (String(payload.confirm ?? '') !== 'DELETE') {
    return jsonNoStore({ error: 'confirm must equal DELETE.' }, { status: 400 });
  }

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

  console.log('[account:delete] request', { authUserId });

  let billingAccount: Awaited<ReturnType<typeof getBillingAccountForUser>>;
  try {
    billingAccount = await getBillingAccountForUser(authUserId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[account:delete] billing lookup failed', {
      authUserId,
      error: message,
    });
    return applySupabaseCookies(
      jsonNoStore({ error: 'Unable to load billing account.' }, { status: 500 }),
      response,
    );
  }

  const { data: membershipRows, error: membershipLookupError } = await supabaseAdmin
    .from('organization_memberships')
    .select('organization_id,role')
    .eq('auth_user_id', authUserId);

  if (membershipLookupError) {
    console.error('[account:delete] membership lookup failed', {
      authUserId,
      error: membershipLookupError.message,
    });
    return applySupabaseCookies(
      jsonNoStore({ error: 'Unable to verify memberships.' }, { status: 500 }),
      response,
    );
  }

  const hasAdminMembership = (membershipRows ?? []).some((row) => {
    const role = String(row.role ?? '').trim().toLowerCase();
    return role === 'admin' || role === 'owner';
  });

  if (BILLING_ENABLED && !billingAccount && (membershipRows?.length ?? 0) > 0) {
    return applySupabaseCookies(
      jsonNoStore({ error: 'Only the primary billing account owner can delete this account.' }, { status: 403 }),
      response,
    );
  }

  if (!billingAccount && (membershipRows?.length ?? 0) > 0 && !hasAdminMembership) {
    return applySupabaseCookies(
      jsonNoStore({ error: 'Only the primary account admin can delete this account.' }, { status: 403 }),
      response,
    );
  }

  let owned: Awaited<ReturnType<typeof countOwnedOrganizations>>;
  try {
    owned = await countOwnedOrganizations(authUserId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[account:delete] owned org count failed', {
      authUserId,
      error: message,
    });
    return applySupabaseCookies(
      jsonNoStore({ error: 'Unable to verify restaurants.' }, { status: 500 }),
      response,
    );
  }

  console.log('[account:delete] owned organizations', {
    authUserId,
    ownedCount: owned.count,
  });

  if (owned.count > 0) {
    return applySupabaseCookies(
      jsonNoStore(
        {
          error: 'RESTAURANTS_REMAIN',
          count: owned.count,
          organizations: owned.organizations,
        },
        { status: 409 },
      ),
      response,
    );
  }

  const remainingMembershipCount = membershipRows?.length ?? 0;
  if (remainingMembershipCount > 0) {
    return applySupabaseCookies(
      jsonNoStore(
        {
          error: 'MEMBERSHIPS_REMAIN',
          count: remainingMembershipCount,
        },
        { status: 409 },
      ),
      response,
    );
  }

  const billingStatus = String(billingAccount?.status ?? '').trim().toLowerCase();
  if (BILLING_ENABLED && billingAccount) {
    const cancelResult = await cancelStripeSubscriptionIfNeeded(authUserId);
    const statusAfterCancelAttempt = String(cancelResult.status ?? '').trim().toLowerCase();
    console.log('[account:delete] subscription cancel check', {
      authUserId,
      statusBefore: billingStatus || 'none',
      statusAfter: statusAfterCancelAttempt || 'none',
      canceled: cancelResult.canceled,
      ok: cancelResult.ok,
    });

    const stillBlocking =
      CANCELLATION_REQUIRED_STATUSES.has(statusAfterCancelAttempt) && !cancelResult.canceled;

    if (!cancelResult.ok || stillBlocking) {
      return applySupabaseCookies(
        jsonNoStore(
          {
            error: 'SUBSCRIPTION_ACTIVE',
            message:
              'Your subscription is still active. Cancel it in Billing Portal, then delete your account.',
            manageBillingUrl: cancelResult.manageBillingUrl,
          },
          { status: 409 },
        ),
        response,
      );
    }
  }

  const cleanupSummary: CleanupSummary = {};
  const { data: userRows, error: userLookupError } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId);

  if (userLookupError && !isMissingDbObject(userLookupError.message)) {
    console.error('[account:delete] user lookup failed', {
      authUserId,
      error: stringifyForLog(userLookupError),
    });
    return applySupabaseCookies(
      jsonNoStore(
        formatDeleteFailure('Failed loading account records before delete.', userLookupError),
        { status: 500 },
      ),
      response,
    );
  }

  const userIds = (userRows ?? [])
    .map((row) => String((row as { id?: string | null }).id ?? '').trim())
    .filter(Boolean);

  const runCleanup = async (
    step: string,
    action: () => PromiseLike<CleanupStepResult>,
  ) => {
    const failureBody = await runCleanupStep(step, authUserId, cleanupSummary, action);
    if (!failureBody) return null;
    return applySupabaseCookies(
      jsonNoStore(failureBody, { status: 500 }),
      response,
    );
  };

  const cleanupPlan: Array<[string, () => PromiseLike<CleanupStepResult>]> = [
    [
      'organization_invitations',
      () =>
        supabaseAdmin
          .from('organization_invitations')
          .update({ invited_by_auth_user_id: null }, { count: 'exact' })
          .eq('invited_by_auth_user_id', authUserId),
    ],
    [
      'organization_create_intents',
      () =>
        supabaseAdmin
          .from('organization_create_intents')
          .delete({ count: 'exact' })
          .eq('auth_user_id', authUserId),
    ],
    [
      'chat_messages',
      () =>
        supabaseAdmin
          .from('chat_messages')
          .delete({ count: 'exact' })
          .eq('author_auth_user_id', authUserId),
    ],
    [
      'chat_rooms',
      () =>
        supabaseAdmin
          .from('chat_rooms')
          .delete({ count: 'exact' })
          .eq('created_by_auth_user_id', authUserId),
    ],
    [
      'shift_exchange_requests_requested',
      () =>
        supabaseAdmin
          .from('shift_exchange_requests')
          .delete({ count: 'exact' })
          .eq('requested_by_auth_user_id', authUserId),
    ],
    [
      'shift_exchange_requests_claimed',
      () =>
        supabaseAdmin
          .from('shift_exchange_requests')
          .delete({ count: 'exact' })
          .eq('claimed_by_auth_user_id', authUserId),
    ],
    [
      'blocked_day_requests_reviewer',
      () =>
        supabaseAdmin
          .from('blocked_day_requests')
          .update({ reviewed_by_auth_user_id: null }, { count: 'exact' })
          .eq('reviewed_by_auth_user_id', authUserId),
    ],
    [
      'blocked_day_requests_requested',
      () =>
        supabaseAdmin
          .from('blocked_day_requests')
          .delete({ count: 'exact' })
          .eq('requested_by_auth_user_id', authUserId),
    ],
    [
      'time_off_requests_requester_auth',
      () =>
        supabaseAdmin
          .from('time_off_requests')
          .delete({ count: 'exact' })
          .eq('requester_auth_user_id', authUserId),
    ],
    [
      'time_off_requests_auth',
      () =>
        supabaseAdmin
          .from('time_off_requests')
          .delete({ count: 'exact' })
          .eq('auth_user_id', authUserId),
    ],
    [
      'schedule_publish_snapshots_created_by',
      () =>
        supabaseAdmin
          .from('schedule_publish_snapshots')
          .update({ created_by_auth_user_id: null }, { count: 'exact' })
          .eq('created_by_auth_user_id', authUserId),
    ],
  ];

  const stripeCustomerId = String(billingAccount?.stripe_customer_id ?? '').trim();
  if (stripeCustomerId) {
    cleanupPlan.splice(1, 0, [
      'subscriptions',
      () =>
        supabaseAdmin
          .from('subscriptions')
          .delete({ count: 'exact' })
          .eq('stripe_customer_id', stripeCustomerId),
    ]);
  }

  if (userIds.length > 0) {
    cleanupPlan.push(
      [
        'blocked_day_requests_user',
        () =>
          supabaseAdmin
            .from('blocked_day_requests')
            .delete({ count: 'exact' })
            .in('user_id', userIds),
      ],
      [
        'time_off_requests_reviewed_by',
        () =>
          supabaseAdmin
            .from('time_off_requests')
            .update({ reviewed_by: null }, { count: 'exact' })
            .in('reviewed_by', userIds),
      ],
      [
        'time_off_requests_user',
        () =>
          supabaseAdmin
            .from('time_off_requests')
            .delete({ count: 'exact' })
            .in('user_id', userIds),
      ],
      [
        'time_off_requests_requester_user',
        () =>
          supabaseAdmin
            .from('time_off_requests')
            .delete({ count: 'exact' })
            .in('requester_user_id', userIds),
      ],
      [
        'schedule_publish_snapshot_shifts',
        () =>
          supabaseAdmin
            .from('schedule_publish_snapshot_shifts')
            .delete({ count: 'exact' })
            .in('user_id', userIds),
      ],
      [
        'shifts',
        () =>
          supabaseAdmin
            .from('shifts')
            .delete({ count: 'exact' })
            .in('user_id', userIds),
      ],
      [
        'schedule_versions_created_by',
        () =>
          supabaseAdmin
            .from('schedule_versions')
            .update({ created_by: null }, { count: 'exact' })
            .in('created_by', userIds),
      ],
    );
  }

  cleanupPlan.push(
    [
      'organization_memberships',
      () =>
        supabaseAdmin
          .from('organization_memberships')
          .delete({ count: 'exact' })
          .eq('auth_user_id', authUserId),
    ],
    [
      'account_profiles',
      () =>
        supabaseAdmin
          .from('account_profiles')
          .delete({ count: 'exact' })
          .eq('auth_user_id', authUserId),
    ],
    [
      'billing_accounts',
      () =>
        supabaseAdmin
          .from('billing_accounts')
          .delete({ count: 'exact' })
          .eq('auth_user_id', authUserId),
    ],
    [
      'stripe_customers',
      () =>
        supabaseAdmin
          .from('stripe_customers')
          .delete({ count: 'exact' })
          .eq('auth_user_id', authUserId),
    ],
    [
      'users',
      () =>
        supabaseAdmin
          .from('users')
          .delete({ count: 'exact' })
          .eq('auth_user_id', authUserId),
    ],
  );

  for (const [step, action] of cleanupPlan) {
    const cleanupResponse = await runCleanup(step, action);
    if (cleanupResponse) {
      return cleanupResponse;
    }
  }

  console.log('[account:delete] cleanup completed', {
    authUserId,
    cleanupSummary,
    userIds,
  });

  const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
  if (authDeleteError) {
    const remainingReferences = await collectRemainingAccountReferences(authUserId);
    console.error('[account:delete] auth delete failed', {
      authUserId,
      error: stringifyForLog(authDeleteError),
      remainingReferences,
    });
    return applySupabaseCookies(
      jsonNoStore(
        formatDeleteFailure('Failed deleting auth user.', authDeleteError, {
          remainingReferences,
        }),
        { status: 500 },
      ),
      response,
    );
  }

  console.log('[account:delete] completed', {
    authUserId,
    deletedAuthUser: true,
  });

  return applySupabaseCookies(
    jsonNoStore({
      ok: true,
      deletedAuthUser: true,
    }),
    response,
  );
}
