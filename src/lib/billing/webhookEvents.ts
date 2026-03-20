import type Stripe from 'stripe';
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

const BILLING_WEBHOOK_EVENTS_TABLE = 'billing_webhook_events';
const STALE_PROCESSING_WINDOW_MS = 15 * 60 * 1000;

type WebhookEventStatus = 'processing' | 'completed' | 'failed';

type WebhookEventRow = {
  stripe_event_id: string;
  status: string | null;
  processing_started_at: string | null;
};

export type BeginWebhookEventResult =
  | { kind: 'acquired'; persistence: 'table' | 'none'; reason?: 'missing-table' }
  | { kind: 'duplicate'; status: 'processing' | 'completed' };

function normalizeStatus(value: unknown): WebhookEventStatus | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'processing' || normalized === 'completed' || normalized === 'failed') {
    return normalized;
  }
  return null;
}

function isMissingWebhookEventsTable(error: PostgrestError | null | undefined) {
  const message = String(error?.message ?? '').toLowerCase();
  const code = String(error?.code ?? '').toUpperCase();
  return code === 'PGRST205' || message.includes('could not find the table');
}

function isDuplicateKeyError(error: PostgrestError | null | undefined) {
  const message = String(error?.message ?? '').toLowerCase();
  return error?.code === '23505' || message.includes('duplicate key');
}

function isStaleProcessing(processingStartedAt: string | null) {
  if (!processingStartedAt) return false;
  const parsed = Date.parse(processingStartedAt);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed >= STALE_PROCESSING_WINDOW_MS;
}

async function getWebhookEventRow(supabaseClient: SupabaseClient, eventId: string) {
  const { data, error } = await supabaseClient
    .from(BILLING_WEBHOOK_EVENTS_TABLE)
    .select('stripe_event_id,status,processing_started_at')
    .eq('stripe_event_id', eventId)
    .maybeSingle();

  if (error) {
    if (isMissingWebhookEventsTable(error)) {
      return { data: null as WebhookEventRow | null, missingTable: true };
    }
    throw error;
  }

  return {
    data: (data as WebhookEventRow | null) ?? null,
    missingTable: false,
  };
}

export async function beginBillingWebhookEvent(
  supabaseClient: SupabaseClient,
  event: Stripe.Event,
): Promise<BeginWebhookEventResult> {
  const now = new Date().toISOString();
  const { error } = await supabaseClient.from(BILLING_WEBHOOK_EVENTS_TABLE).insert({
    stripe_event_id: event.id,
    event_type: event.type,
    status: 'processing',
    received_at: now,
    processing_started_at: now,
    processed_at: null,
    last_error: null,
    updated_at: now,
  });

  if (!error) {
    return { kind: 'acquired', persistence: 'table' };
  }

  if (isMissingWebhookEventsTable(error)) {
    return { kind: 'acquired', persistence: 'none', reason: 'missing-table' };
  }

  if (!isDuplicateKeyError(error)) {
    throw error;
  }

  const existing = await getWebhookEventRow(supabaseClient, event.id);
  if (existing.missingTable) {
    return { kind: 'acquired', persistence: 'none', reason: 'missing-table' };
  }

  const existingStatus = normalizeStatus(existing.data?.status);
  if (existingStatus === 'completed') {
    return { kind: 'duplicate', status: 'completed' };
  }

  if (
    existingStatus === 'processing' &&
    !isStaleProcessing(existing.data?.processing_started_at ?? null)
  ) {
    return { kind: 'duplicate', status: 'processing' };
  }

  if (existingStatus === 'failed' || existingStatus === 'processing') {
    const { data, error: reclaimError } = await supabaseClient
      .from(BILLING_WEBHOOK_EVENTS_TABLE)
      .update({
        event_type: event.type,
        status: 'processing',
        processing_started_at: now,
        processed_at: null,
        last_error: null,
        updated_at: now,
      })
      .eq('stripe_event_id', event.id)
      .eq('status', existingStatus)
      .select('stripe_event_id')
      .maybeSingle();

    if (reclaimError) {
      if (isMissingWebhookEventsTable(reclaimError)) {
        return { kind: 'acquired', persistence: 'none', reason: 'missing-table' };
      }
      throw reclaimError;
    }

    if (data?.stripe_event_id) {
      return { kind: 'acquired', persistence: 'table' };
    }
  }

  // By this point existingStatus is not 'completed' (that path returns early above).
  return { kind: 'duplicate', status: 'processing' };
}

export async function markBillingWebhookEventCompleted(
  supabaseClient: SupabaseClient,
  event: Stripe.Event,
) {
  const now = new Date().toISOString();
  const { error } = await supabaseClient
    .from(BILLING_WEBHOOK_EVENTS_TABLE)
    .update({
      event_type: event.type,
      status: 'completed',
      processed_at: now,
      last_error: null,
      updated_at: now,
    })
    .eq('stripe_event_id', event.id);

  if (error && !isMissingWebhookEventsTable(error)) {
    throw error;
  }
}

export async function markBillingWebhookEventFailed(
  supabaseClient: SupabaseClient,
  event: Stripe.Event,
  failure: unknown,
) {
  const now = new Date().toISOString();
  const message = failure instanceof Error ? failure.message : String(failure);
  const { error } = await supabaseClient
    .from(BILLING_WEBHOOK_EVENTS_TABLE)
    .update({
      event_type: event.type,
      status: 'failed',
      last_error: message,
      updated_at: now,
    })
    .eq('stripe_event_id', event.id);

  if (error && !isMissingWebhookEventsTable(error)) {
    throw error;
  }
}
