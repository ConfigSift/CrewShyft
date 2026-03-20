-- Stripe billing webhook idempotency scaffold.
--
-- The current billing webhook writes to both `billing_accounts` and legacy
-- `subscriptions` rows through separate Supabase requests, so this does not
-- create a true cross-table transaction. Instead, the app keeps a durable
-- per-event processing record and only marks an event `completed` after all
-- intended writes succeed. Failed events stay retryable.

create table if not exists public.billing_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  status text not null check (status in ('processing', 'completed', 'failed')),
  received_at timestamptz not null default timezone('utc', now()),
  processing_started_at timestamptz,
  processed_at timestamptz,
  last_error text,
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists billing_webhook_events_status_idx
  on public.billing_webhook_events (status, updated_at desc);
