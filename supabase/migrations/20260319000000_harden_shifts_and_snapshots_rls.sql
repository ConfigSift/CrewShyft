-- ============================================================
-- Security hardening: shifts + schedule_publish_snapshots RLS
-- ============================================================
-- Context:
--   * Live verification confirmed that unauthenticated (anon-key) requests
--     can read at least one row from `shifts`.
--   * The `schedule_publish_snapshots` and `schedule_publish_snapshot_shifts`
--     tables were created in migration 20260302000000 with NO RLS and NO
--     policies, leaving them fully open to the anon role.
--   * All fixes below are idempotent and non-breaking for authenticated
--     employee / manager access patterns.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. shifts: belt-and-suspenders against anon access
-- ────────────────────────────────────────────────────────────

-- Ensure RLS is enabled (safe to repeat; no-op if already on).
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

-- Revoke all direct table privileges from anon at the grant level.
-- This blocks unauthenticated Supabase-client queries even if RLS is
-- accidentally disabled in the Supabase dashboard in the future.
-- Authenticated org members still reach shifts via RLS policies using the
-- `authenticated` role — those grants are untouched.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.shifts FROM anon;

-- ────────────────────────────────────────────────────────────
-- 2. schedule_publish_snapshots: add missing RLS + policies
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.schedule_publish_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.schedule_publish_snapshots FROM anon;

-- Org members can read snapshots for their organisation.
DROP POLICY IF EXISTS snapshots_select ON public.schedule_publish_snapshots;
CREATE POLICY snapshots_select
  ON public.schedule_publish_snapshots
  FOR SELECT
  USING (public.is_org_member(schedule_publish_snapshots.organization_id));

-- Only managers may create / update / delete snapshots.
DROP POLICY IF EXISTS snapshots_write ON public.schedule_publish_snapshots;
CREATE POLICY snapshots_write
  ON public.schedule_publish_snapshots
  FOR ALL
  USING (public.is_org_manager(schedule_publish_snapshots.organization_id))
  WITH CHECK (public.is_org_manager(schedule_publish_snapshots.organization_id));

-- ────────────────────────────────────────────────────────────
-- 3. schedule_publish_snapshot_shifts: add missing RLS + policies
-- ────────────────────────────────────────────────────────────
-- Note: this table has no organization_id column; gate via parent snapshot.

ALTER TABLE public.schedule_publish_snapshot_shifts ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.schedule_publish_snapshot_shifts FROM anon;

-- Org members can read snapshot rows whose parent belongs to their org.
DROP POLICY IF EXISTS snapshot_shifts_select ON public.schedule_publish_snapshot_shifts;
CREATE POLICY snapshot_shifts_select
  ON public.schedule_publish_snapshot_shifts
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.schedule_publish_snapshots s
      WHERE s.id = schedule_publish_snapshot_shifts.snapshot_id
        AND public.is_org_member(s.organization_id)
    )
  );

-- Only managers may write snapshot rows.
DROP POLICY IF EXISTS snapshot_shifts_write ON public.schedule_publish_snapshot_shifts;
CREATE POLICY snapshot_shifts_write
  ON public.schedule_publish_snapshot_shifts
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.schedule_publish_snapshots s
      WHERE s.id = schedule_publish_snapshot_shifts.snapshot_id
        AND public.is_org_manager(s.organization_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.schedule_publish_snapshots s
      WHERE s.id = schedule_publish_snapshot_shifts.snapshot_id
        AND public.is_org_manager(s.organization_id)
    )
  );
