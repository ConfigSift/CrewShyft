import { getAdminSupabase } from '@/lib/admin/supabase';

// ---------------------------------------------------------------------------
// Types — scoped to restaurant detail
// ---------------------------------------------------------------------------

export type OrgProfile = {
  id: string;
  name: string;
  restaurantCode: string;
  createdAt: string;
};

export type MembershipRow = {
  id: string;
  authUserId: string;
  userId: string | null;
  role: string;
  fullName: string | null;
  email: string | null;
};

export type LocationRow = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
};

export type EmployeeRow = {
  id: string;
  authUserId: string | null;
  displayName: string | null;
  isOwner: boolean;
  role: string;
  position: string | null;
  isActive: boolean | null;
  employeeNumber: string | null;
  pinReady: boolean;
  email: string | null;
  phone: string | null;
  source: 'users' | 'membership';
};

export type RestaurantEmployeesResult = {
  expectedEmployeesCount: number;
  employees: EmployeeRow[];
  resolvedOrgFkColumn: string;
};

export type UsageCounts = {
  shifts: number;
  timeOffRequests: number;
  shiftExchangeRequests: number;
  blockedDayRequests: number;
};

export type SubscriptionDetail = {
  id: string;
  status: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  stripePriceId: string;
  quantity: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
} | null;

export type BillingAccountDetail = {
  authUserId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  status: string;
  quantity: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
} | null;

export type BillingOverrideDetail = {
  active: boolean;
  type: string | null;
  reason: string | null;
  expiresAt: string | null;
  setBy: string | null;
} | null;

export type ProvisioningIntent = {
  id: string;
  authUserId: string;
  restaurantName: string;
  status: string;
  desiredQuantity: number;
  organizationId: string | null;
  lastError: unknown;
  createdAt: string;
  updatedAt: string;
};

export type RestaurantOverviewData = {
  org: OrgProfile;
  memberships: MembershipRow[];
};

// ---------------------------------------------------------------------------
// 1. Overview: org profile + memberships
// ---------------------------------------------------------------------------

export async function getRestaurantOverview(
  orgId: string,
): Promise<RestaurantOverviewData | null> {
  const db = getAdminSupabase();

  const [orgRes, membershipsRes] = await Promise.all([
    db
      .from('organizations')
      .select('id, name, restaurant_code, created_at')
      .eq('id', orgId)
      .maybeSingle(),
    db
      .from('organization_memberships')
      .select('id, auth_user_id, user_id, role, users(full_name, real_email, email)')
      .eq('organization_id', orgId)
      .order('role', { ascending: true }),
  ]);

  if (!orgRes.data) return null;

  const org: OrgProfile = {
    id: orgRes.data.id,
    name: orgRes.data.name,
    restaurantCode: orgRes.data.restaurant_code,
    createdAt: orgRes.data.created_at,
  };

  type MemberRaw = {
    id: string;
    auth_user_id: string;
    user_id: string | null;
    role: string;
    users: { full_name: string; real_email: string | null; email: string | null }
      | { full_name: string; real_email: string | null; email: string | null }[]
      | null;
  };

  const memberships: MembershipRow[] = (
    (membershipsRes.data ?? []) as MemberRaw[]
  ).map((m) => {
    const u = Array.isArray(m.users) ? m.users[0] : m.users;
    return {
      id: m.id,
      authUserId: m.auth_user_id,
      userId: m.user_id,
      role: m.role,
      fullName: u?.full_name || null,
      email: u?.real_email || u?.email || null,
    };
  });

  return { org, memberships };
}

// ---------------------------------------------------------------------------
// 2. Locations
// ---------------------------------------------------------------------------

export async function getRestaurantLocations(
  orgId: string,
): Promise<LocationRow[]> {
  const db = getAdminSupabase();
  const { data } = await db
    .from('locations')
    .select('id, name, sort_order, created_at')
    .eq('organization_id', orgId)
    .order('sort_order', { ascending: true });

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    sortOrder: Number(r.sort_order ?? 0),
    createdAt: String(r.created_at ?? ''),
  }));
}

// ---------------------------------------------------------------------------
// 3. Employees
// ---------------------------------------------------------------------------

export async function getRestaurantEmployees(
  orgId: string,
): Promise<RestaurantEmployeesResult> {
  const db = getAdminSupabase();
  const { column: orgFkColumn, expectedCount } = await resolveUsersOrgFkColumn(orgId);
  const [usersRows, ownerMembership] = await Promise.all([
    fetchUsersForOrganization(orgId, orgFkColumn),
    fetchOwnerMembership(orgId),
  ]);

  const ownerAuthUserId = String(ownerMembership?.auth_user_id ?? '').trim() || null;
  const authUserIds = usersRows
    .map((row) => normalizeNullableText(row.auth_user_id))
    .filter((id): id is string => Boolean(id));
  const profileNameByAuthUserId = await fetchProfileNamesByAuthUserIds(authUserIds);
  const ownerProfileName = ownerAuthUserId
    ? profileNameByAuthUserId.get(ownerAuthUserId) ?? null
    : null;

  const employees: EmployeeRow[] = usersRows.map((r) => {
    const authUserId = normalizeNullableText(r.auth_user_id);
    const role = normalizeRole(r.role, r.account_type);
    const employeeNumber = r.employee_number != null ? String(r.employee_number) : null;
    const id = String(r.id ?? '');

    return {
      id,
      authUserId,
      displayName: resolveDisplayName({
        row: r,
        profileName: authUserId ? profileNameByAuthUserId.get(authUserId) ?? null : null,
        employeeNumber,
        rowId: id,
      }),
      isOwner: false,
      role,
      position: normalizeNullableText(r.position),
      isActive: r.is_active === null || r.is_active === undefined ? null : Boolean(r.is_active),
      employeeNumber,
      pinReady: Boolean(r.pin_hash),
      email: normalizeNullableText(r.real_email) ?? normalizeNullableText(r.email),
      phone: normalizeNullableText(r.phone),
      source: 'users',
    };
  });

  let ownerAlreadyInUsers = false;
  if (ownerAuthUserId) {
    const hasAuthUserIdSignal = employees.some((row) => Boolean(row.authUserId));

    if (hasAuthUserIdSignal) {
      const ownerRow = employees.find((row) => row.authUserId === ownerAuthUserId);
      if (ownerRow) {
        ownerRow.isOwner = true;
        ownerAlreadyInUsers = true;
      }
    } else {
      // TODO: Prefer auth_user_id matching for reliable owner dedupe when available.
      const ownerRoleRow = employees.find((row) => {
        const role = String(row.role ?? '').trim().toLowerCase();
        return role === 'owner' || role === 'admin';
      });
      if (ownerRoleRow) {
        ownerRoleRow.isOwner = true;
        ownerAlreadyInUsers = true;
      }
    }
  }

  if (ownerAuthUserId && !ownerAlreadyInUsers) {
    employees.push({
      id: ownerAuthUserId,
      authUserId: ownerAuthUserId,
      displayName: ownerProfileName ?? `Owner (${ownerAuthUserId.slice(0, 8)})`,
      isOwner: true,
      role: 'owner',
      position: null,
      isActive: null,
      employeeNumber: null,
      pinReady: false,
      email: null,
      phone: null,
      source: 'membership',
    });
  }

  return {
    expectedEmployeesCount: expectedCount,
    employees,
    resolvedOrgFkColumn: orgFkColumn,
  };
}

const USERS_ORG_FK_CANDIDATES = [
  'organization_id',
  'organizationId',
  'org_id',
  'organization',
  'restaurant_id',
] as const;

type PostgrestLikeError = {
  message?: string;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
};

async function resolveUsersOrgFkColumn(
  orgId: string,
): Promise<{ column: string; expectedCount: number }> {
  const db = getAdminSupabase();

  for (const candidate of USERS_ORG_FK_CANDIDATES) {
    const probe = await db
      .from('users')
      .select('id', { head: true, count: 'exact' })
      .eq(candidate, orgId);

    if (!probe.error) {
      return { column: candidate, expectedCount: probe.count ?? 0 };
    }

    if (isMissingColumnError(probe.error, candidate)) {
      continue;
    }

    throw toEmployeesQueryError(
      `Failed probing users FK column '${candidate}'.`,
      probe.error,
    );
  }

  throw toEmployeesQueryError(
    `Could not resolve users org FK column (tried ${USERS_ORG_FK_CANDIDATES.join(', ')})`,
    {
      code: 'USERS_ORG_FK_NOT_FOUND',
      details: `orgId=${orgId}`,
    },
  );
}

async function fetchUsersForOrganization(
  orgId: string,
  orgFkColumn: string,
): Promise<Record<string, unknown>[]> {
  const db = getAdminSupabase();
  // Keep select list conservative for production schema compatibility.
  const selectCandidates = [
    'id, auth_user_id, full_name, name, first_name, last_name, role, position, is_active, employee_number, pin_hash, real_email, email, phone',
    'id, auth_user_id, full_name, role, position, is_active, employee_number, pin_hash, real_email, email, phone',
    'id, auth_user_id, full_name, role, is_active, employee_number, pin_hash, real_email, email, phone',
    'id, role, is_active, employee_number, pin_hash',
  ];

  for (const select of selectCandidates) {
    const result = await db
      .from('users')
      .select(select)
      .eq(orgFkColumn, orgId)
      .order('id', { ascending: true });

    if (!result.error) {
      return (result.data ?? []) as unknown as Record<string, unknown>[];
    }

    if (isMissingColumnError(result.error)) {
      continue;
    }

    throw toEmployeesQueryError(
      `Failed loading employees from users using FK '${orgFkColumn}'.`,
      result.error,
    );
  }

  throw toEmployeesQueryError(
    'Could not select required employees columns from users table.',
    { code: 'USERS_EMPLOYEE_COLUMNS_NOT_FOUND' },
  );
}

async function fetchOwnerMembership(
  orgId: string,
): Promise<{ auth_user_id: string | null } | null> {
  const db = getAdminSupabase();
  const ownerRes = await db
    .from('organization_memberships')
    .select('auth_user_id')
    .eq('organization_id', orgId)
    .ilike('role', 'owner')
    .limit(1)
    .maybeSingle();

  if (ownerRes.error) {
    throw new Error(ownerRes.error.message || 'Unable to load owner membership.');
  }

  if (ownerRes.data?.auth_user_id) return ownerRes.data;

  // Some production data uses admin for the owner seat.
  const adminRes = await db
    .from('organization_memberships')
    .select('auth_user_id')
    .eq('organization_id', orgId)
    .ilike('role', 'admin')
    .limit(1)
    .maybeSingle();

  if (adminRes.error) {
    throw new Error(adminRes.error.message || 'Unable to load fallback owner membership.');
  }

  return adminRes.data ?? null;
}

async function fetchProfileNamesByAuthUserIds(
  authUserIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(authUserIds)].filter(Boolean);
  const out = new Map<string, string>();
  if (uniqueIds.length === 0) return out;

  const db = getAdminSupabase();
  const { data, error } = await db
    .from('account_profiles')
    .select('auth_user_id, owner_name')
    .in('auth_user_id', uniqueIds);

  if (error) {
    throw toEmployeesQueryError('Failed to load account profile names for employees.', error);
  }

  for (const row of (data ?? []) as { auth_user_id: string | null; owner_name: string | null }[]) {
    const authUserId = String(row.auth_user_id ?? '').trim();
    const ownerName = normalizeNullableText(row.owner_name);
    if (authUserId && ownerName) out.set(authUserId, ownerName);
  }

  return out;
}

function resolveDisplayName(input: {
  row: Record<string, unknown>;
  profileName: string | null;
  employeeNumber: string | null;
  rowId: string;
}): string {
  const { row, profileName, employeeNumber, rowId } = input;

  const fullName =
    normalizeNullableText(row.full_name)
    ?? normalizeNullableText(row.name)
    ?? joinNameParts(normalizeNullableText(row.first_name), normalizeNullableText(row.last_name));
  if (fullName) return fullName;
  if (profileName) return profileName;
  if (employeeNumber) return `Employee #${employeeNumber}`;

  const shortId = String(rowId ?? '').trim().slice(0, 8);
  return shortId ? `User ${shortId}` : 'User';
}

function joinNameParts(first: string | null, last: string | null): string | null {
  const combined = [first, last].filter(Boolean).join(' ').trim();
  return combined || null;
}

function isMissingColumnError(error: PostgrestLikeError, column?: string): boolean {
  const code = String(error.code ?? '').trim();
  const message = `${String(error.message ?? '')} ${String(error.details ?? '')}`.toLowerCase();
  if (code === '42703') return true;
  if (!message.includes('does not exist') || !message.includes('column')) return false;
  return column ? message.includes(String(column).toLowerCase()) : true;
}

function toEmployeesQueryError(message: string, error?: PostgrestLikeError): Error {
  const out = new Error(message) as Error & {
    code?: string;
    hint?: string;
    details?: string;
    cause?: unknown;
  };
  if (error?.code) out.code = String(error.code);
  if (error?.hint) out.hint = String(error.hint);
  if (error?.details) out.details = String(error.details);
  if (error) out.cause = error;
  return out;
}

function normalizeNullableText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function normalizeRole(role: unknown, accountType: unknown): string {
  const raw = String(role ?? accountType ?? 'employee').trim().toLowerCase();
  return raw || 'employee';
}

// ---------------------------------------------------------------------------
// 4. Usage counts
// ---------------------------------------------------------------------------

export async function getRestaurantUsage(
  orgId: string,
  days: number,
): Promise<UsageCounts> {
  const db = getAdminSupabase();
  const since = new Date(
    Date.now() - days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [shifts, timeOff, exchange, blocked] = await Promise.all([
    db
      .from('shifts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', since),
    db
      .from('time_off_requests')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', since),
    db
      .from('shift_exchange_requests')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', since),
    db
      .from('blocked_day_requests')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('created_at', since),
  ]);

  return {
    shifts: shifts.count ?? 0,
    timeOffRequests: timeOff.count ?? 0,
    shiftExchangeRequests: exchange.count ?? 0,
    blockedDayRequests: blocked.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 5. Subscription + billing account
// ---------------------------------------------------------------------------

export async function getRestaurantSubscription(orgId: string): Promise<{
  subscription: SubscriptionDetail;
  billingAccount: BillingAccountDetail;
  billingOverride: BillingOverrideDetail;
}> {
  const db = getAdminSupabase();

  // Get subscription for this org
  const { data: subRow } = await db
    .from('subscriptions')
    .select(
      'id, status, stripe_subscription_id, stripe_customer_id, stripe_price_id, quantity, current_period_start, current_period_end, cancel_at_period_end',
    )
    .eq('organization_id', orgId)
    .maybeSingle();

  const subscription: SubscriptionDetail = subRow
    ? {
        id: subRow.id,
        status: subRow.status,
        stripeSubscriptionId: subRow.stripe_subscription_id,
        stripeCustomerId: subRow.stripe_customer_id,
        stripePriceId: subRow.stripe_price_id,
        quantity: subRow.quantity,
        currentPeriodStart: subRow.current_period_start,
        currentPeriodEnd: subRow.current_period_end,
        cancelAtPeriodEnd: subRow.cancel_at_period_end,
      }
    : null;

  const { data: orgRow } = await db
    .from('organizations')
    .select('billing_override_active,billing_override_type,billing_override_reason,billing_override_expires_at,billing_override_set_by')
    .eq('id', orgId)
    .maybeSingle();

  const billingOverride: BillingOverrideDetail = orgRow
    ? {
        active: Boolean(orgRow.billing_override_active),
        type: typeof orgRow.billing_override_type === 'string' ? orgRow.billing_override_type : null,
        reason: typeof orgRow.billing_override_reason === 'string' ? orgRow.billing_override_reason : null,
        expiresAt: typeof orgRow.billing_override_expires_at === 'string' ? orgRow.billing_override_expires_at : null,
        setBy: typeof orgRow.billing_override_set_by === 'string' ? orgRow.billing_override_set_by : null,
      }
    : null;

  // Find the owner's billing_accounts via the admin membership
  let billingAccount: BillingAccountDetail = null;

  const { data: adminMembership } = await db
    .from('organization_memberships')
    .select('auth_user_id')
    .eq('organization_id', orgId)
    .eq('role', 'admin')
    .limit(1)
    .maybeSingle();

  if (adminMembership?.auth_user_id) {
    const { data: billing } = await db
      .from('billing_accounts')
      .select(
        'auth_user_id, stripe_customer_id, stripe_subscription_id, status, quantity, cancel_at_period_end, current_period_end',
      )
      .eq('auth_user_id', adminMembership.auth_user_id)
      .maybeSingle();

    if (billing) {
      billingAccount = {
        authUserId: billing.auth_user_id,
        stripeCustomerId: billing.stripe_customer_id,
        stripeSubscriptionId: billing.stripe_subscription_id,
        status: billing.status,
        quantity: billing.quantity,
        cancelAtPeriodEnd: billing.cancel_at_period_end,
        currentPeriodEnd: billing.current_period_end,
      };
    }
  }

  return { subscription, billingAccount, billingOverride };
}

// ---------------------------------------------------------------------------
// 6. Provisioning intents
// ---------------------------------------------------------------------------

export async function getRestaurantProvisioning(
  orgId: string,
): Promise<ProvisioningIntent[]> {
  const db = getAdminSupabase();

  // Intents directly linked to this org
  const { data: directIntents } = await db
    .from('organization_create_intents')
    .select(
      'id, auth_user_id, restaurant_name, status, desired_quantity, organization_id, last_error, created_at, updated_at',
    )
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(20);

  // Also find intents by the owner's auth_user_id (may include other orgs)
  const { data: adminMembership } = await db
    .from('organization_memberships')
    .select('auth_user_id')
    .eq('organization_id', orgId)
    .eq('role', 'admin')
    .limit(1)
    .maybeSingle();

  let ownerIntents: Record<string, unknown>[] = [];
  if (adminMembership?.auth_user_id) {
    const { data } = await db
      .from('organization_create_intents')
      .select(
        'id, auth_user_id, restaurant_name, status, desired_quantity, organization_id, last_error, created_at, updated_at',
      )
      .eq('auth_user_id', adminMembership.auth_user_id)
      .order('created_at', { ascending: false })
      .limit(20);
    ownerIntents = (data ?? []) as Record<string, unknown>[];
  }

  // Merge and de-duplicate
  const allRaw = [
    ...((directIntents ?? []) as Record<string, unknown>[]),
    ...ownerIntents,
  ];
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const r of allRaw) {
    const id = String(r.id);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(r);
  }

  // Sort descending by created_at
  unique.sort(
    (a, b) =>
      new Date(String(b.created_at)).getTime() -
      new Date(String(a.created_at)).getTime(),
  );

  return unique.map((r) => ({
    id: String(r.id),
    authUserId: String(r.auth_user_id),
    restaurantName: String(r.restaurant_name ?? ''),
    status: String(r.status ?? ''),
    desiredQuantity: Number(r.desired_quantity ?? 1),
    organizationId: r.organization_id ? String(r.organization_id) : null,
    lastError: r.last_error ?? null,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }));
}
