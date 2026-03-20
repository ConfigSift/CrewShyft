-- Per-organization billing preparation
-- Adds owner tracking and billing mode to subscriptions table.
-- Safe additive migration: no existing data is modified.

-- Track which auth user owns each org's subscription (for webhook resolution + portal)
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS owner_auth_user_id uuid REFERENCES auth.users(id);

-- Distinguish per-org subscriptions from legacy bundled mirrors.
-- 'legacy' = mirror row written by bundled user-level subscription
-- 'per_org' = independent subscription owned by this organization
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'legacy';

-- Index for lookups by owner (e.g., "all subscriptions owned by this user")
CREATE INDEX IF NOT EXISTS idx_subscriptions_owner_auth_user_id
  ON public.subscriptions (owner_auth_user_id);

-- Index for filtering by billing mode
CREATE INDEX IF NOT EXISTS idx_subscriptions_billing_mode
  ON public.subscriptions (billing_mode);

-- Constraint: billing_mode must be a known value
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_billing_mode_check'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_billing_mode_check
      CHECK (billing_mode IN ('legacy', 'per_org'));
  END IF;
END $$;
