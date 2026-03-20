-- ============================================================
-- Security hardening: organizations + subscriptions RLS
-- ============================================================
-- Context / root-cause summary
-- ─────────────────────────────
-- Live verification found:
--   1. Unauthenticated (anon-key) requests could read rows from `organizations`.
--   2. Unauthenticated (anon-key) requests could read rows from `subscriptions`.
--   3. Authenticated employee requests to `subscriptions` returned cross-tenant rows.
--
-- Root causes (repo-side):
--   A. Supabase's default bootstrap grants ALL table privileges on every public-schema
--      table to the `anon` and `authenticated` roles.  Neither `organizations` nor
--      `subscriptions` had those grants revoked (unlike `shifts`, which was hardened in
--      migration 20260319000000).  A sufficiently-broad or mis-evaluated RLS policy is
--      therefore a one-layer defence; the anon role can still *attempt* queries.
--
--   B. The `is_org_member` / `is_org_manager` helper functions (SECURITY DEFINER)
--      do the right thing when auth.uid() is NULL — the WHERE clause
--      `m.auth_user_id = auth.uid()` evaluates to UNKNOWN, so EXISTS() returns FALSE.
--      However there is no *explicit* NULL guard inside the policy USING clause.
--      Adding `auth.uid() IS NOT NULL` as the first condition provides a hard fence
--      that cannot be bypassed by unexpected NULL-propagation edge cases.
--
--   C. `has_manager()` (defined and granted in migration 20260122000000) is executable
--      by the `anon` role.  The function probes `organization_memberships` globally
--      (no org_id filter, no auth_user_id filter) and returns TRUE if *any* manager
--      exists anywhere in the system.  This is a data-existence oracle for anonymous
--      callers and is not needed by unauthenticated code paths.
--
--   D. `subscriptions` DML (INSERT / UPDATE / DELETE) is reachable by the
--      `authenticated` role at the grant level.  All subscription mutations are
--      performed server-side via `service_role` (Stripe webhooks, Edge Functions).
--      Revoking DML from `authenticated` eliminates a grant-level attack surface that
--      the RLS `subscriptions_admin` policy already guards at the policy layer — belt
--      AND suspenders.
--
-- All changes are idempotent and non-breaking for expected access patterns.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. Revoke anon grants at the grant level (belt-and-suspenders)
--    Mirrors the pattern used for shifts in migration 20260319000000.
-- ────────────────────────────────────────────────────────────

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.organizations FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.subscriptions  FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.stripe_customers FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.billing_accounts FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.organization_create_intents FROM anon;

-- ────────────────────────────────────────────────────────────
-- 2. Revoke DML from authenticated on subscriptions + related
--    billing tables — mutations must go through service_role only.
--    Authenticated users still need SELECT (to display plan status in the UI).
-- ────────────────────────────────────────────────────────────

REVOKE INSERT, UPDATE, DELETE ON public.subscriptions     FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.stripe_customers  FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.billing_accounts  FROM authenticated;

-- ────────────────────────────────────────────────────────────
-- 3. Revoke execute on has_manager() from anon
--    This function returns TRUE if *any* manager exists in *any* org
--    (no org_id or auth_user_id filter).  There is no legitimate reason
--    for unauthenticated callers to invoke it.
-- ────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.has_manager() FROM anon;

-- ────────────────────────────────────────────────────────────
-- 4. Re-affirm RLS is enabled (idempotent; no-op if already on)
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.organizations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_customers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_create_intents ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- 5. Harden organizations SELECT policy
--    Add explicit auth.uid() IS NOT NULL guard so the policy
--    short-circuits immediately for any unauthenticated caller,
--    independent of the is_org_member() function's NULL handling.
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Organizations readable by members" ON public.organizations;
CREATE POLICY "Organizations readable by members"
  ON public.organizations
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND public.is_org_member(organizations.id)
  );

-- ────────────────────────────────────────────────────────────
-- 6. Harden subscriptions policies
--    Same auth.uid() IS NOT NULL guard applied to both policies.
--    subscriptions_admin covers ALL (SELECT + DML) for managers;
--    subscriptions_select covers SELECT for all org members.
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS subscriptions_select ON public.subscriptions;
CREATE POLICY subscriptions_select ON public.subscriptions
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND public.is_org_member(organization_id)
  );

DROP POLICY IF EXISTS subscriptions_admin ON public.subscriptions;
CREATE POLICY subscriptions_admin ON public.subscriptions
  FOR ALL
  USING (
    auth.uid() IS NOT NULL
    AND public.is_org_manager(organization_id)
  )
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND public.is_org_manager(organization_id)
  );

-- ────────────────────────────────────────────────────────────
-- 7. Harden stripe_customers and billing_accounts own-row policies
--    Existing policies already use auth_user_id = auth.uid() which
--    evaluates to NULL = NULL (UNKNOWN → FALSE) for anon, but
--    adding the explicit guard makes the intent unambiguous.
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS stripe_customers_own_select ON public.stripe_customers;
CREATE POLICY stripe_customers_own_select ON public.stripe_customers
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND auth_user_id = auth.uid()
  );

DROP POLICY IF EXISTS billing_accounts_own_select ON public.billing_accounts;
CREATE POLICY billing_accounts_own_select ON public.billing_accounts
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND auth_user_id = auth.uid()
  );

DROP POLICY IF EXISTS organization_create_intents_own_select ON public.organization_create_intents;
CREATE POLICY organization_create_intents_own_select ON public.organization_create_intents
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND auth_user_id = auth.uid()
  );
