# Security Hardening Checklist

Generated: 2026-03-19
Scope: billing / debug / auth areas
Status: post-automated-sweep — **manual items remain**

---

## Done (automated, in-repo)

| Area | Change | File |
|------|--------|------|
| `dev-reset-pay` | Added authenticated-user gate — callers must be signed in; destructive op was env-flag-only before | `src/app/api/admin/dev-reset-pay/route.ts` |
| `billing/debug` | Removed raw Stripe account ID (`acct_…`) from HTTP response; replaced with `hasStripeAccount: bool` | `src/app/api/billing/debug/route.ts` |
| Earlier sweep | Extracted debug guard to `isDebugAllowed()` (non-prod + `DEBUG_API_ENABLED=true`) | `src/lib/debug/isDebugAllowed.ts` |
| Earlier sweep | Extracted `authAudit`, `authByEmail` logic into `src/lib/debug/` helpers | `src/lib/debug/` |
| Earlier sweep | Hardened webhook handler — Stripe signature verification, no raw errors in responses | `src/app/api/billing/webhook/route.ts` |
| Earlier sweep | Deleted `debug-user-links` endpoint | `src/app/api/debug-user-links/route.ts` |

---

## Requires manual action (live/infra)

### 1. Rotate secrets if any were ever exposed
- **Who:** DevOps / lead
- **What:** If `.env` or any secret file was ever accidentally committed, rotate: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, and any JWT secrets.
- **Verified:** `.env` / `.env.bak` were **not** found in git history — rotation is precautionary if you have any doubt about prior exposure.

### 2. Confirm `DEBUG_API_ENABLED` is absent from staging/prod
- **Who:** DevOps
- **What:** Verify `DEBUG_API_ENABLED` is not set in Vercel / Railway / Fly env vars for any non-local environment.
- **Risk if missed:** All `/api/debug-*` and `/api/billing/debug` endpoints become accessible.

### 3. Confirm `NODE_ENV=production` is set in all prod/staging deployments
- **Who:** DevOps
- **What:** `isDebugAllowed()` relies on `NODE_ENV !== 'production'` as the outer guard.

### 4. Stripe webhook secret: use the live webhook secret in prod, not test
- **Who:** Lead / billing owner
- **What:** `STRIPE_WEBHOOK_SECRET` must match the secret for the live webhook endpoint in the Stripe dashboard.
- **How to verify:** Hit `/api/billing/debug` in dev; confirm `mode: 'live'` and `hasWebhookSecret: true` before going live.

### 5. Confirm `ADMIN_AUTH_USER_IDS` in prod only contains intended platform admins
- **Who:** Lead
- **What:** This env var gates `/admin/*`. Audit who is listed before any public launch.

---

## Live-verification steps (after deployment)

Run these against the production URL to confirm debug endpoints are locked:

```bash
# All should return 404 or non-200 (never real data)
curl -s -o /dev/null -w "%{http_code}" https://<PROD_URL>/api/debug-echo
curl -s -o /dev/null -w "%{http_code}" https://<PROD_URL>/api/debug-token
curl -s -o /dev/null -w "%{http_code}" https://<PROD_URL>/api/debug-auth-audit
curl -s -o /dev/null -w "%{http_code}" https://<PROD_URL>/api/billing/debug
curl -s -o /dev/null -w "%{http_code}" https://<PROD_URL>/api/admin/dev-reset-pay
```

Expected: all return `404`.

---

## Optional / product-decision-driven

These are real risks but require deliberate product choices — do not change without agreement:

| Item | Risk | Decision needed |
|------|------|-----------------|
| Delete all `/api/debug-*` routes for production builds | Debug endpoints exist only for dev convenience; zero reason for them in prod code path | Delete the routes entirely vs keep behind env guard (current approach is acceptable) |
| `debug-promote-membership`: restrict target to org members only | Currently lets any admin upsert any `auth_user_id` into their org | Add membership pre-check before upsert — small change but changes invite flow behavior |
| `debug-auth-audit`: add row-level pagination cap | Returns up to 10,000 user rows; could be slow | Product call: is this endpoint still needed at all? |
| `billing/debug`: remove `priceIdSuffixes` from response | Unnecessary exposure of price ID tails | Low risk since already dev-only |
| Add rate limiting to debug endpoints | `/debug-token`, `/debug-auth-by-email` have no rate limit | Requires adding a rate-limit primitive (Redis / upstash) — infra decision |
| Audit trail for destructive debug ops | `dev-reset-pay` logs nothing server-side when it runs | Add a `console.warn` or structured log line — trivial but was not done to avoid scope creep |

---

## Not an issue (confirmed)

- `.env` / `.env.bak` — not present in git history; no secrets were committed.
- Webhook handler — uses cryptographic Stripe signature, not debug flag. Correct.
- Middleware auth — multi-layer (session + role + `ADMIN_AUTH_USER_IDS`). No changes needed.
- `employeeAuth.ts` — pure validation helpers, no security decisions.
