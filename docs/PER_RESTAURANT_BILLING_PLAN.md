# Per-Restaurant Billing — Architecture Plan

_Written 2026-03-19. Do not implement without reviewing migration steps carefully._

---

## Current State

Billing is **per-user (account-centric)**:

```
auth_user
  └─ stripe_customers (1:1) → stripe_customer_id
  └─ billing_accounts (1:1) → one Stripe subscription
       quantity = # of owned organizations
```

The `subscriptions` table exists per-org but is a **mirror** written by webhooks, not an independent source of truth. If the user has 2 orgs and a subscription of quantity=2, both orgs share the same Stripe `sub_xxx`.

**Desired state:**
```
organization
  └─ subscriptions (1:1) → own Stripe subscription (independent)
       stripe_customer_id = the owner's Stripe customer (shared per user)
       quantity = # of locations in that org
```

Each restaurant has its own Stripe subscription. Adding/canceling a restaurant creates/cancels only that restaurant's subscription without touching other restaurants.

---

## Required Changes

### 1. Stripe Model

| Today | After |
|---|---|
| 1 subscription per user, quantity = org count | 1 subscription per org, quantity = location count |
| Proration: adding org → update quantity | Proration: adding org → new subscription |
| Canceling all orgs → cancel subscription | Canceling org → cancel that org's subscription |

**Customer strategy**: Keep 1 Stripe Customer per user (owner). Each org's subscription is attached to the owner's customer. This avoids customer proliferation and simplifies payment method management.

### 2. Schema Changes

#### 2a. `subscriptions` table — promote to source of truth

No column changes needed. The table already has the right shape:
```sql
organization_id  uuid (unique fk)
stripe_subscription_id  text (unique)
stripe_customer_id  text
stripe_price_id  text
status  text
quantity  int   -- now = location count, not org count
current_period_start/end  timestamptz
cancel_at_period_end  boolean
```

Action: Remove the assumption that this is a mirror. It becomes the canonical record.

#### 2b. `billing_accounts` table — deprecate or repurpose

Today `billing_accounts` stores the single user subscription. After migration:
- Option A: Remove it. All billing state lives in `subscriptions` per-org.
- Option B: Keep it as a read-only rollup cache (sum of all org subscription statuses). Useful for the billing page header.

**Recommendation**: Keep temporarily with a `deprecated_at` column; query `subscriptions` for all billing decisions. Remove `billing_accounts` in a follow-up migration once everything is switched.

#### 2c. New migration (safe to land now as prep)

```sql
-- Add owner tracking to subscriptions so we know whose Stripe customer to use
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS owner_auth_user_id uuid REFERENCES auth.users(id);

-- Index for webhook lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id
  ON subscriptions(stripe_subscription_id);
```

This is safe to land now; it doesn't break anything.

### 3. Checkout Flow Changes

**Current** (`create-checkout-session`):
- Creates one checkout session for the user
- `quantity` = total owned org count
- Metadata: `auth_user_id`, `organization_id` (optional), `desired_quantity`

**After**:
- Each org triggers its own checkout session
- `quantity` = 1 (one org; location count is managed separately via `sync-quantity`)
- Metadata: `auth_user_id`, `organization_id` (required), no `desired_quantity`
- On success: `finalize-checkout` creates/updates only the target org's `subscriptions` row

### 4. Webhook Changes

**Current** (`webhook/route.ts`):
- Writes to both `billing_accounts` AND `subscriptions`
- Resolves `organization_id` from metadata

**After**:
- Write only to `subscriptions` (using `organization_id` from metadata)
- Update `billing_accounts` only as a cache/rollup (or skip entirely)
- If `organization_id` is missing from metadata, log and skip (no fallback to user-level)

The key risk: if an existing subscription webhook fires without `organization_id` in metadata (pre-migration subscriptions), the write will be skipped. Handle by:
1. After migration, update Stripe subscription metadata for all existing subs via a one-time script.
2. Keep old `billing_accounts` write path alive for 30 days behind a feature flag.

### 5. Subscription Status Changes

**Current** (`subscription-status`):
- Checks `billing_accounts` (user level)
- Returns one status for all orgs

**After**:
- Takes `organizationId` (required, not optional)
- Checks `subscriptions` for that org
- Returns status scoped to that restaurant

**Billing page**: Must be shown per-restaurant context. A user with 3 restaurants sees each restaurant's billing status independently.

### 6. Portal Session Changes

**Current**:
- Opens Stripe portal for the user's single subscription

**After**:
- Same portal URL works (portal shows all subscriptions under the customer)
- Optionally: pass `subscription` param to Stripe portal to deep-link to a specific org's subscription

### 7. `billing_accounts` Gate in Middleware

The middleware currently checks `sf_billing_ok` cookie, which is set by `subscription-status`. After migration, the cookie should reflect: "at least one org the user owns is active." Logic stays the same; only the underlying query changes.

---

## Migration Steps (Production)

> Sequence is critical. The goal is zero-downtime migration with a rollback path.

### Phase 0 — Prep ✅ (completed 2026-03-19)
- [x] Add `owner_auth_user_id` column to `subscriptions`
- [x] Add `billing_mode` column to `subscriptions` (`'legacy'` | `'per_org'`)
- [x] Add indexes on `owner_auth_user_id` and `billing_mode`
- [x] Add constraint: `billing_mode IN ('legacy', 'per_org')`

### Phase 1 — Dual-write + per-org checkout ✅ (completed 2026-03-19)
- [x] Webhook writes `owner_auth_user_id` and `billing_mode` on every subscription upsert
- [x] Webhook skips `billing_accounts` writes for `per_org` subscriptions (avoids overwriting bundled sub)
- [x] `finalize-checkout` writes `owner_auth_user_id` and `billing_mode`
- [x] `lifecycle.ts` passes `owner_auth_user_id` on legacy subscription upserts
- [x] New checkout creates per-org subscriptions (`quantity=1`, `billing_mode: 'per_org'` in metadata)
- [x] Checkout checks org-level subscription status before creating (prevents duplicate subs)
- [x] Checkout falls back to `billing_accounts` for legacy bundled coverage detection
- [x] New `orgSubscription.ts` helper module with `getOrgSubscription`, `isOrgSubscriptionActive`, `checkOrgsCoverage`

### Phase 1.5 — Dual-read subscription-status ✅ (completed 2026-03-19)
- [x] `subscription-status` checks per-org subscriptions first via `checkOrgsCoverage`
- [x] Falls back to `billing_accounts` for orgs not covered by per-org subs
- [x] Response includes `org_subscriptions`, `has_per_org_billing`, `covered_org_count`, `uncovered_org_count`
- [x] Billing gate correctly handles mixed coverage (some per-org, some bundled)

### Phase 2 — Backfill existing subscriptions (TODO)
Write a one-time script (run against production with service role):
```typescript
// For each organization with an existing subscriptions row where billing_mode = 'legacy':
// 1. If stripe_subscription_id is not null, verify it in Stripe
// 2. If the sub has quantity > 1 (bundled), either:
//    a. Split into N separate subscriptions (one per org), OR
//    b. Keep the bundled sub for existing orgs, only per-org for new
// 3. Update Stripe subscription metadata: { organization_id, billing_mode: 'per_org' }
// 4. Set owner_auth_user_id and billing_mode='per_org' on the subscriptions row
```

**Splitting option A** is cleanest but means a billing event (proration). Alert users before doing this.

**Keeping bundled (option B)** avoids billing surprises but leaves legacy subs that need an eventual migration window.

### Phase 3 — Switch billing UI (TODO)
- Update billing page to show per-org subscription cards
- Each org card has its own "Manage Billing" → Stripe portal deep-link with `subscription` param
- Show per-org invoice history (filter by org's `stripe_subscription_id`)
- Use `org_subscriptions` from subscription-status response

### Phase 4 — Deprecate billing_accounts (TODO)
- Once all orgs have migrated to per-org subscriptions:
- Drop writes to `billing_accounts` in webhook
- Remove fallback reads from `subscription-status` and checkout
- Keep the table for one billing cycle as a safety net
- Add migration to drop or archive it

---

## Risks

| Risk | Mitigation |
|---|---|
| Existing bundled subscription users get split mid-cycle → unexpected charges | Communicate before Phase 2; run split at renewal boundary |
| Webhook fires for org-less subscription (metadata missing) | Keep legacy `billing_accounts` path for 30 days |
| Portal shows all subs for the user — confusing for multi-org owners | Use Stripe portal `subscription` param to deep-link to specific org |
| `billing_accounts` gate becomes stale after split | Phase 3 migration updates the gate; keep both checks in parallel during transition |

---

## Implementation History

### Phase 1 UI refresh (2026-03-19)
- **New API route**: `GET /api/billing/invoices` — fetches invoice list from Stripe
- **Redesigned billing page** (`BillingClient.tsx`): plan summary, in-app invoice history + receipt modal

### Phase 2A: Per-org billing foundation (2026-03-19)
- **Migration**: `20260319020000_per_org_billing_prep.sql` — adds `owner_auth_user_id` and `billing_mode` to subscriptions
- **New module**: `src/lib/billing/orgSubscription.ts` — per-org subscription queries (`getOrgSubscription`, `isOrgSubscriptionActive`, `checkOrgsCoverage`)
- **Checkout**: Creates per-org Stripe subscriptions (quantity=1, `billing_mode: 'per_org'` in metadata). Checks org-level subscription status. Falls back to billing_accounts for legacy bundled detection.
- **Webhook**: Writes `owner_auth_user_id` and `billing_mode` on all subscription upserts. Skips `billing_accounts` writes for per-org subscriptions.
- **Finalize-checkout**: Writes `owner_auth_user_id` and `billing_mode`.
- **Lifecycle**: Passes `owner_auth_user_id` on legacy subscription upserts.
- **subscription-status**: Dual-read — checks per-org subscriptions first, falls back to billing_accounts. Response includes `org_subscriptions`, `has_per_org_billing`, `covered_org_count`, `uncovered_org_count`.

## Exact Next Steps

1. **Decide** on split vs. keep-bundled strategy for existing bundled subscribers (business decision)
2. **Backfill** existing subscription metadata in Stripe + update `billing_mode` to `per_org` (Phase 2)
3. **Redesign** billing UI to show per-org subscription cards using `org_subscriptions` response field (Phase 3)
4. **Deprecate** `billing_accounts` after all orgs have per-org subscriptions (Phase 4)
