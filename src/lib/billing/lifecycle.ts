import type Stripe from 'stripe';
import { type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { BILLING_ENABLED } from '@/lib/stripe/config';
import { stripe } from '@/lib/stripe/server';
import { getSiteUrl } from '@/lib/site-url';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  getBillingAccountByAuthUserId,
  getOwnedOrganizationCount,
  getStripeCustomerIdForAuthUser,
  isMissingTableError,
  toIsoFromUnixTimestamp,
  upsertBillingAccountFromSubscription,
} from '@/lib/billing/customer';

type DeleteStep = {
  table: string;
  column: string;
};

const SCHEDULE_VERSION_CHILD_STEPS: DeleteStep[] = [
  { table: 'shifts', column: 'schedule_version_id' },
];

const ORG_DELETE_STEPS: DeleteStep[] = [
  { table: 'shift_exchange_requests', column: 'organization_id' },
  { table: 'time_off_requests', column: 'organization_id' },
  { table: 'blocked_day_requests', column: 'organization_id' },
  { table: 'shifts', column: 'organization_id' },
  { table: 'schedule_versions', column: 'organization_id' },
  { table: 'schedule_view_settings', column: 'organization_id' },
  { table: 'business_hour_ranges', column: 'organization_id' },
  { table: 'business_hours', column: 'organization_id' },
  { table: 'locations', column: 'organization_id' },
  { table: 'organization_invitations', column: 'organization_id' },
  { table: 'subscriptions', column: 'organization_id' },
  { table: 'organization_memberships', column: 'organization_id' },
  { table: 'users', column: 'organization_id' },
];

const CANCELLABLE_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'incomplete',
  'unpaid',
]);

export type DeleteStepFailure = {
  table: string;
  column: string;
  message: string;
  code: string | null;
  details: string | null;
  hint: string | null;
};

export type DeleteOrganizationDataResult =
  | { ok: true }
  | { ok: false; failure: DeleteStepFailure };

export type BillingAccountInfo = {
  auth_user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  stripe_price_id: string | null;
  status: string;
  quantity: number;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  updated_at: string;
};

export type OwnedOrganizationSummary = {
  id: string;
  name: string;
  restaurantCode: string | null;
};

export type OwnedOrganizationCountResult = {
  count: number;
  ids: string[];
  organizations: OwnedOrganizationSummary[];
};

export type SyncQuantityResult = {
  ok: boolean;
  quantitySynced: boolean;
  changed: boolean;
  canceled: boolean;
  ownedRestaurantCount: number;
  newQuantity: number;
  subscriptionStatus: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  syncError?: string;
};

export type CancelSubscriptionResult = {
  ok: boolean;
  canceled: boolean;
  status: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  manageBillingUrl: string;
  error?: string;
};

function normalize(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function isMissingSchemaError(error: PostgrestError | null | undefined) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    (message.includes('relation') && message.includes('does not exist')) ||
    (message.includes('column') && message.includes('does not exist'))
  );
}

function toDeleteFailure(table: string, column: string, error: PostgrestError): DeleteStepFailure {
  return {
    table,
    column,
    message: String(error.message ?? 'Unknown database error'),
    code: error.code ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  };
}

function chunk(values: string[], size = 500) {
  const out: string[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

function pickSubscription(subscriptions: Stripe.Subscription[]) {
  if (subscriptions.length === 0) return null;
  const sorted = [...subscriptions].sort((a, b) => b.created - a.created);
  return (
    sorted.find((sub) => {
      const status = normalize(sub.status);
      return status === 'active' || status === 'trialing';
    }) ??
    sorted.find((sub) => normalize(sub.status) !== 'canceled') ??
    sorted[0]
  );
}

async function resolveStripeSubscription(
  authUserId: string,
  supabaseClient: SupabaseClient,
  billingAccount: BillingAccountInfo | null,
) {
  let stripeCustomerId = String(billingAccount?.stripe_customer_id ?? '').trim() || null;
  const stripeSubscriptionId =
    String(billingAccount?.stripe_subscription_id ?? '').trim() || null;

  if (!stripeCustomerId) {
    stripeCustomerId = await getStripeCustomerIdForAuthUser(authUserId, supabaseClient);
  }

  if (!stripeCustomerId) {
    return {
      subscription: null as Stripe.Subscription | null,
      stripeCustomerId: null,
    };
  }

  let subscription: Stripe.Subscription | null = null;
  if (stripeSubscriptionId) {
    try {
      subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
        expand: ['items.data.price'],
      });
    } catch (error) {
      console.warn('[billing:quantity] failed to retrieve stored subscription', {
        authUserId,
        stripeSubscriptionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!subscription) {
    const list = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      limit: 10,
    });
    const candidate = pickSubscription(list.data);
    if (candidate) {
      subscription = await stripe.subscriptions.retrieve(candidate.id, {
        expand: ['items.data.price'],
      });
    }
  }

  return {
    subscription,
    stripeCustomerId,
  };
}

async function upsertLegacySubscriptionsForOwnedOrganizations(
  organizationIds: string[],
  subscription: Stripe.Subscription,
  supabaseClient: SupabaseClient,
  ownerAuthUserId?: string,
) {
  if (organizationIds.length === 0) return;

  const stripeCustomerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id ?? null;
  if (!stripeCustomerId) return;

  const quantity = Math.max(0, Number(subscription.items.data[0]?.quantity ?? 0));
  const payload = organizationIds.map((organizationId) => ({
    organization_id: organizationId,
    status: subscription.status,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    current_period_start: toIsoFromUnixTimestamp(subscription.current_period_start),
    current_period_end: toIsoFromUnixTimestamp(subscription.current_period_end),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    stripe_price_id: subscription.items.data[0]?.price?.id ?? null,
    quantity,
    updated_at: new Date().toISOString(),
    owner_auth_user_id: ownerAuthUserId ?? null,
    billing_mode: 'legacy' as const,
  }));

  const { error } = await supabaseClient
    .from('subscriptions')
    .upsert(payload, { onConflict: 'organization_id' });

  if (error && !isMissingSchemaError(error) && !isMissingTableError(error)) {
    console.warn('[billing:quantity] failed upserting legacy subscriptions', {
      error: error.message,
      code: error.code ?? null,
      details: error.details ?? null,
      hint: error.hint ?? null,
    });
  }
}

export async function getBillingAccountForUser(
  authUserId: string,
  supabaseClient: SupabaseClient = supabaseAdmin,
) {
  const result = await getBillingAccountByAuthUserId(authUserId, supabaseClient);
  if (result.error) {
    throw new Error(result.error.message);
  }
  return result.data as BillingAccountInfo | null;
}

export async function countOwnedOrganizations(
  authUserId: string,
  supabaseClient: SupabaseClient = supabaseAdmin,
): Promise<OwnedOrganizationCountResult> {
  const result = await getOwnedOrganizationCount(authUserId, supabaseClient);
  if (result.error) {
    throw new Error(result.error.message);
  }

  const ids = result.ids;
  let organizations: OwnedOrganizationSummary[] = [];
  if (ids.length > 0) {
    const { data, error } = await supabaseClient
      .from('organizations')
      .select('id,name,restaurant_code')
      .in('id', ids);

    if (!error && data) {
      organizations = (data ?? []).map((row) => ({
        id: String(row.id ?? '').trim(),
        name: String((row as { name?: unknown }).name ?? '').trim(),
        restaurantCode: String((row as { restaurant_code?: unknown }).restaurant_code ?? '').trim() || null,
      })).filter((row) => Boolean(row.id));
    }
  }

  return {
    count: result.count,
    ids,
    organizations,
  };
}

export async function cancelStripeSubscriptionIfNeeded(
  authUserId: string,
  supabaseClient: SupabaseClient = supabaseAdmin,
): Promise<CancelSubscriptionResult> {
  const manageBillingUrl = `${getSiteUrl()}/billing`;

  if (!BILLING_ENABLED) {
    return {
      ok: true,
      canceled: false,
      status: 'none',
      stripeSubscriptionId: null,
      stripeCustomerId: null,
      manageBillingUrl,
    };
  }

  const billingAccount = await getBillingAccountForUser(authUserId, supabaseClient);
  const { subscription, stripeCustomerId } = await resolveStripeSubscription(
    authUserId,
    supabaseClient,
    billingAccount,
  );

  const existingStatus = normalize(subscription?.status ?? billingAccount?.status ?? 'none');
  if (!subscription) {
    return {
      ok: true,
      canceled: false,
      status: existingStatus,
      stripeSubscriptionId: null,
      stripeCustomerId,
      manageBillingUrl,
    };
  }

  if (!CANCELLABLE_SUBSCRIPTION_STATUSES.has(existingStatus)) {
    return {
      ok: true,
      canceled: existingStatus === 'canceled',
      status: existingStatus,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId:
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id ?? stripeCustomerId,
      manageBillingUrl,
    };
  }

  try {
    const canceledSubscription = await stripe.subscriptions.cancel(subscription.id);
    const upsertResult = await upsertBillingAccountFromSubscription(
      authUserId,
      canceledSubscription,
      supabaseClient,
    );

    if (upsertResult.error) {
      throw new Error(upsertResult.error.message);
    }

    await supabaseClient
      .from('billing_accounts')
      .update({
        status: 'canceled',
        quantity: 0,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString(),
      })
      .eq('auth_user_id', authUserId);

    return {
      ok: true,
      canceled: true,
      status: 'canceled',
      stripeSubscriptionId: canceledSubscription.id,
      stripeCustomerId:
        typeof canceledSubscription.customer === 'string'
          ? canceledSubscription.customer
          : canceledSubscription.customer?.id ?? stripeCustomerId,
      manageBillingUrl,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      canceled: false,
      status: existingStatus,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId:
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id ?? stripeCustomerId,
      manageBillingUrl,
      error: message,
    };
  }
}

export async function syncStripeQuantityToOwnedOrgCount(
  authUserId: string,
  supabaseClient: SupabaseClient = supabaseAdmin,
): Promise<SyncQuantityResult> {
  const owned = await countOwnedOrganizations(authUserId, supabaseClient);
  const desiredCount = Math.max(0, owned.count);

  if (!BILLING_ENABLED) {
    return {
      ok: true,
      quantitySynced: true,
      changed: false,
      canceled: false,
      ownedRestaurantCount: owned.count,
      newQuantity: desiredCount,
      subscriptionStatus: 'active',
      stripeSubscriptionId: null,
      stripeCustomerId: null,
    };
  }

  const billingAccount = await getBillingAccountForUser(authUserId, supabaseClient);
  const { subscription, stripeCustomerId } = await resolveStripeSubscription(
    authUserId,
    supabaseClient,
    billingAccount,
  );

  if (!subscription) {
    if (billingAccount) {
      await supabaseClient
        .from('billing_accounts')
        .update({
          quantity: desiredCount,
          updated_at: new Date().toISOString(),
        })
        .eq('auth_user_id', authUserId);
    }
    return {
      ok: true,
      quantitySynced: true,
      changed: false,
      canceled: false,
      ownedRestaurantCount: owned.count,
      newQuantity: desiredCount,
      subscriptionStatus: normalize(billingAccount?.status ?? 'none'),
      stripeSubscriptionId: null,
      stripeCustomerId,
    };
  }

  if (desiredCount === 0) {
    const cancelResult = await cancelStripeSubscriptionIfNeeded(authUserId, supabaseClient);
    if (!cancelResult.ok) {
      return {
        ok: false,
        quantitySynced: false,
        changed: false,
        canceled: false,
        ownedRestaurantCount: owned.count,
        newQuantity: 0,
        subscriptionStatus: cancelResult.status,
        stripeSubscriptionId: cancelResult.stripeSubscriptionId,
        stripeCustomerId: cancelResult.stripeCustomerId,
        syncError: cancelResult.error ?? 'Unable to cancel subscription.',
      };
    }

    return {
      ok: true,
      quantitySynced: true,
      changed: true,
      canceled: true,
      ownedRestaurantCount: owned.count,
      newQuantity: 0,
      subscriptionStatus: cancelResult.status,
      stripeSubscriptionId: cancelResult.stripeSubscriptionId,
      stripeCustomerId: cancelResult.stripeCustomerId,
    };
  }

  const currentQuantity = Math.max(1, Number(subscription.items.data[0]?.quantity ?? 1));
  const subscriptionItemId = String(subscription.items.data[0]?.id ?? '').trim() || null;
  let effectiveSubscription = subscription;
  let changed = false;

  if (desiredCount < currentQuantity && subscriptionItemId) {
    effectiveSubscription = await stripe.subscriptions.update(subscription.id, {
      items: [{ id: subscriptionItemId, quantity: desiredCount }],
      proration_behavior: 'none',
      expand: ['items.data.price'],
    });
    changed = true;
  }

  const upsertResult = await upsertBillingAccountFromSubscription(
    authUserId,
    effectiveSubscription,
    supabaseClient,
  );
  if (upsertResult.error) {
    return {
      ok: false,
      quantitySynced: false,
      changed,
      canceled: false,
      ownedRestaurantCount: owned.count,
      newQuantity: currentQuantity,
      subscriptionStatus: normalize(effectiveSubscription.status),
      stripeSubscriptionId: effectiveSubscription.id,
      stripeCustomerId:
        typeof effectiveSubscription.customer === 'string'
          ? effectiveSubscription.customer
          : effectiveSubscription.customer?.id ?? stripeCustomerId,
      syncError: upsertResult.error.message,
    };
  }

  await upsertLegacySubscriptionsForOwnedOrganizations(
    owned.ids,
    effectiveSubscription,
    supabaseClient,
    authUserId,
  );

  return {
    ok: true,
    quantitySynced: true,
    changed,
    canceled: false,
    ownedRestaurantCount: owned.count,
    newQuantity: Math.max(1, Number(effectiveSubscription.items.data[0]?.quantity ?? desiredCount)),
    subscriptionStatus: normalize(effectiveSubscription.status),
    stripeSubscriptionId: effectiveSubscription.id,
    stripeCustomerId:
      typeof effectiveSubscription.customer === 'string'
        ? effectiveSubscription.customer
        : effectiveSubscription.customer?.id ?? stripeCustomerId,
  };
}

export async function deleteOrganizationData(
  organizationId: string,
  supabaseClient: SupabaseClient = supabaseAdmin,
): Promise<DeleteOrganizationDataResult> {
  let scheduleVersionIds: string[] = [];

  const { data: scheduleVersions, error: scheduleLookupError } = await supabaseClient
    .from('schedule_versions')
    .select('id')
    .eq('organization_id', organizationId);

  if (scheduleLookupError) {
    if (!isMissingSchemaError(scheduleLookupError) && !isMissingTableError(scheduleLookupError)) {
      return {
        ok: false,
        failure: toDeleteFailure('schedule_versions', 'organization_id', scheduleLookupError),
      };
    }
  } else {
    scheduleVersionIds = (scheduleVersions ?? [])
      .map((row) => String((row as { id?: unknown }).id ?? '').trim())
      .filter(Boolean);
  }

  for (const step of SCHEDULE_VERSION_CHILD_STEPS) {
    if (scheduleVersionIds.length === 0) continue;
    for (const values of chunk(scheduleVersionIds)) {
      const { error } = await supabaseClient
        .from(step.table)
        .delete()
        .in(step.column, values);

      if (!error) continue;
      if (isMissingSchemaError(error) || isMissingTableError(error)) {
        break;
      }
      return {
        ok: false,
        failure: toDeleteFailure(step.table, step.column, error),
      };
    }
  }

  const { data: roomRows, error: roomsLookupError } = await supabaseClient
    .from('chat_rooms')
    .select('id')
    .eq('organization_id', organizationId);

  if (roomsLookupError && !isMissingSchemaError(roomsLookupError) && !isMissingTableError(roomsLookupError)) {
    return {
      ok: false,
      failure: toDeleteFailure('chat_rooms', 'organization_id', roomsLookupError),
    };
  }

  const roomIds = (roomRows ?? [])
    .map((row) => String((row as { id?: unknown }).id ?? '').trim())
    .filter(Boolean);

  if (roomIds.length > 0) {
    for (const values of chunk(roomIds)) {
      const { error } = await supabaseClient
        .from('chat_messages')
        .delete()
        .in('room_id', values);

      if (!error) continue;
      if (isMissingSchemaError(error) || isMissingTableError(error)) {
        break;
      }
      return {
        ok: false,
        failure: toDeleteFailure('chat_messages', 'room_id', error),
      };
    }
  }

  const { error: chatRoomsDeleteError } = await supabaseClient
    .from('chat_rooms')
    .delete()
    .eq('organization_id', organizationId);

  if (chatRoomsDeleteError && !isMissingSchemaError(chatRoomsDeleteError) && !isMissingTableError(chatRoomsDeleteError)) {
    return {
      ok: false,
      failure: toDeleteFailure('chat_rooms', 'organization_id', chatRoomsDeleteError),
    };
  }

  for (const step of ORG_DELETE_STEPS) {
    const { error } = await supabaseClient
      .from(step.table)
      .delete()
      .eq(step.column, organizationId);

    if (!error) continue;
    if (isMissingSchemaError(error) || isMissingTableError(error)) {
      if (step.table === 'schedule_versions' && isMissingTableError(error)) {
        console.warn('[org-delete] skipping missing table schedule_versions (PGRST205)', {
          organizationId,
          code: error.code ?? null,
          error: error.message,
        });
      }
      continue;
    }

    return {
      ok: false,
      failure: toDeleteFailure(step.table, step.column, error),
    };
  }

  const { error: orgDeleteError } = await supabaseClient
    .from('organizations')
    .delete()
    .eq('id', organizationId);

  if (orgDeleteError) {
    return {
      ok: false,
      failure: toDeleteFailure('organizations', 'id', orgDeleteError),
    };
  }

  return { ok: true };
}
