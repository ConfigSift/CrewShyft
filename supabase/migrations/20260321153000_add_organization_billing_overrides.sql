ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS billing_override_active BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS billing_override_type TEXT;

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS billing_override_reason TEXT;

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS billing_override_expires_at TIMESTAMPTZ;

ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS billing_override_set_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_billing_override_type_check'
  ) THEN
    ALTER TABLE organizations
    ADD CONSTRAINT organizations_billing_override_type_check
    CHECK (
      billing_override_type IS NULL
      OR billing_override_type IN ('comped', 'manual_exception')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_organizations_billing_override_active
ON organizations (billing_override_active, billing_override_expires_at);
