import { getAdminSupabase } from '@/lib/admin/supabase';
import { ACTIVATION_THRESHOLD } from '@/lib/admin/constants';
import type { ActivationStage, RestaurantRow } from '@/lib/admin/types';

export type RestaurantFilters = {
  search?: string;
  subscriptionStatus?: string;
  activationStage?: ActivationStage;
  createdAfter?: string;
  createdBefore?: string;
};

export type RestaurantSort = {
  column: string;
  direction: 'asc' | 'desc';
};

export type RestaurantListResult = {
  data: RestaurantRow[];
  total: number;
  page: number;
  pageSize: number;
};

type OrgBaseRow = {
  id: string;
  name: string | null;
  restaurant_code: string | null;
  timezone?: string | null;
  billing_override_type?: string | null;
  created_at: string;
};

type SubscriptionRow = {
  organization_id: string;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  stripe_price_id: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

type MembershipRow = {
  organization_id: string;
  auth_user_id: string;
  role: string | null;
  created_at: string | null;
};

type AccountProfileRow = {
  auth_user_id: string;
  owner_name: string | null;
};

const ORG_DB_SORT_COLUMNS = new Set(['created_at', 'name', 'restaurant_code']);

export async function getRestaurantsList(
  filters: RestaurantFilters = {},
  page = 1,
  pageSize = 25,
  sort: RestaurantSort = { column: 'created_at', direction: 'desc' },
): Promise<RestaurantListResult> {
  const db = getAdminSupabase();
  const safePage = Math.max(1, Number.isFinite(page) ? page : 1);
  const safePageSize = Math.min(100, Math.max(1, Number.isFinite(pageSize) ? pageSize : 25));
  const normalizedSort = normalizeSort(sort);

  const orgResult = await fetchOrganizationsPage(
    filters,
    safePage,
    safePageSize,
    normalizedSort,
  );

  if (orgResult.error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[admin/restaurants:query] organizations fetch failed', orgResult.error);
    }
    return { data: [], total: 0, page: safePage, pageSize: safePageSize };
  }

  const orgs = orgResult.data;
  const total = orgResult.total;
  if (orgs.length === 0) {
    return { data: [], total, page: safePage, pageSize: safePageSize };
  }

  const orgIds = orgs.map((org) => org.id);
  const now = Date.now();
  const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Query B
  const subscriptionsRows = await safeRows<SubscriptionRow>(
    db
      .from('subscriptions')
      .select('organization_id, status, current_period_end, cancel_at_period_end, stripe_price_id, updated_at, created_at')
      .in('organization_id', orgIds),
    'subscriptions',
  );

  // Query C
  const locationRows = await safeRows<Record<string, unknown>>(
    db.from('locations').select('organization_id').in('organization_id', orgIds),
    'locations',
  );

  // Query D
  const userRows = await safeRows<Record<string, unknown>>(
    db.from('users').select('organization_id').in('organization_id', orgIds),
    'users',
  );
  const activeUserRows = await safeRows<Record<string, unknown>>(
    db.from('users').select('organization_id').in('organization_id', orgIds).eq('is_active', true),
    'users_active',
  );

  // Query E
  const shifts7dRows = await safeRows<Record<string, unknown>>(
    db.from('shifts').select('organization_id').in('organization_id', orgIds).gte('created_at', d7),
    'shifts_7d',
  );
  const shifts30dRows = await safeRows<Record<string, unknown>>(
    db.from('shifts').select('organization_id').in('organization_id', orgIds).gte('created_at', d30),
    'shifts_30d',
  );

  // Query F
  const timeOff30dRows = await safeRows<Record<string, unknown>>(
    db.from('time_off_requests').select('organization_id').in('organization_id', orgIds).gte('created_at', d30),
    'time_off_30d',
  );

  // Query G
  const exchange30dRows = await safeRows<Record<string, unknown>>(
    db.from('shift_exchange_requests').select('organization_id').in('organization_id', orgIds).gte('created_at', d30),
    'exchange_30d',
  );

  // Query H
  const ownerMembershipRows = await safeRows<MembershipRow>(
    db
      .from('organization_memberships')
      .select('organization_id, auth_user_id, role, created_at')
      .in('organization_id', orgIds)
      .in('role', ['owner', 'admin'])
      .order('organization_id', { ascending: true })
      .order('created_at', { ascending: true }),
    'owner_memberships',
  );

  const ownerIds = [...new Set(ownerMembershipRows.map((row) => row.auth_user_id).filter(Boolean))];
  const ownerProfileRows = ownerIds.length
    ? await safeRows<AccountProfileRow>(
        db
          .from('account_profiles')
          .select('auth_user_id, owner_name')
          .in('auth_user_id', ownerIds),
        'owner_profiles',
      )
    : [];

  const locationsMap = countByOrg(locationRows);
  const employeesMap = countByOrg(userRows);
  const activeEmployeesMap = activeUserRows.length > 0 ? countByOrg(activeUserRows) : employeesMap;
  const shifts7dMap = countByOrg(shifts7dRows);
  const shifts30dMap = countByOrg(shifts30dRows);
  const timeOff30dMap = countByOrg(timeOff30dRows);
  const exchange30dMap = countByOrg(exchange30dRows);

  const subscriptionMap = new Map<string, SubscriptionRow>();
  for (const row of subscriptionsRows) {
    const orgId = String(row.organization_id ?? '');
    if (!orgId) continue;
    const current = subscriptionMap.get(orgId);
    if (!current) {
      subscriptionMap.set(orgId, row);
      continue;
    }
    const currentStamp = String(current.updated_at ?? current.created_at ?? '');
    const nextStamp = String(row.updated_at ?? row.created_at ?? '');
    if (nextStamp > currentStamp) {
      subscriptionMap.set(orgId, row);
    }
  }

  const ownerProfileMap = new Map<string, string | null>();
  for (const row of ownerProfileRows) {
    ownerProfileMap.set(row.auth_user_id, row.owner_name ?? null);
  }

  const ownerMap = new Map<string, { authUserId: string; ownerName: string | null }>();
  for (const row of ownerMembershipRows) {
    const orgId = String(row.organization_id ?? '');
    if (!orgId) continue;
    const candidate = {
      authUserId: row.auth_user_id,
      ownerName: ownerProfileMap.get(row.auth_user_id) ?? null,
    };
    const existing = ownerMap.get(orgId);
    if (!existing) {
      ownerMap.set(orgId, candidate);
      continue;
    }
    const existingRole = String(
      ownerMembershipRows.find((membership) => membership.organization_id === orgId && membership.auth_user_id === existing.authUserId)?.role ?? '',
    ).toLowerCase();
    const nextRole = String(row.role ?? '').toLowerCase();
    if (existingRole !== 'owner' && nextRole === 'owner') {
      ownerMap.set(orgId, candidate);
    }
  }

  let rows: RestaurantRow[] = orgs.map((org) => {
    const orgId = org.id;
    const sub = subscriptionMap.get(orgId) ?? null;
    const owner = ownerMap.get(orgId) ?? null;
    const employeesCount = employeesMap.get(orgId) ?? 0;
    const shifts7d = shifts7dMap.get(orgId) ?? 0;
    const shifts30d = shifts30dMap.get(orgId) ?? 0;

    return {
      orgId,
      name: String(org.name ?? ''),
      restaurantCode: String(org.restaurant_code ?? ''),
      timezone: String(org.timezone ?? ''),
      ownerAuthUserId: owner?.authUserId ?? null,
      ownerName: owner?.ownerName ?? null,
      subscriptionStatus: sub?.status ?? null,
      billingOverrideType: String(org.billing_override_type ?? '').trim() || null,
      currentPeriodEnd: sub?.current_period_end ?? null,
      cancelAtPeriodEnd: sub?.cancel_at_period_end ?? null,
      priceId: sub?.stripe_price_id ?? null,
      locationsCount: locationsMap.get(orgId) ?? 0,
      employeesCount,
      activeEmployeesCount: activeEmployeesMap.get(orgId) ?? 0,
      shifts7d,
      shifts30d,
      timeOff30d: timeOff30dMap.get(orgId) ?? 0,
      exchange30d: exchange30dMap.get(orgId) ?? 0,
      activationStage: computeActivationStage(
        employeesCount,
        shifts7d,
        shifts30d,
        sub?.status ?? null,
      ),
    };
  });

  if (filters.subscriptionStatus) {
    const target = filters.subscriptionStatus;
    rows = rows.filter((row) =>
      target === 'none' ? row.subscriptionStatus === null : row.subscriptionStatus === target,
    );
  }

  if (filters.activationStage !== undefined) {
    rows = rows.filter((row) => row.activationStage === filters.activationStage);
  }

  if (!ORG_DB_SORT_COLUMNS.has(normalizedSort.column)) {
    rows = sortRows(rows, normalizedSort);
  }

  return {
    data: rows,
    total,
    page: safePage,
    pageSize: safePageSize,
  };
}

async function fetchOrganizationsPage(
  filters: RestaurantFilters,
  page: number,
  pageSize: number,
  sort: RestaurantSort,
): Promise<{ data: OrgBaseRow[]; total: number; error: string | null }> {
  let withTimezone = true;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let query = getAdminSupabase()
      .from('organizations')
      .select(
        withTimezone
          ? 'id, name, restaurant_code, timezone, billing_override_type, created_at'
          : 'id, name, restaurant_code, billing_override_type, created_at',
        { count: 'exact' },
      );

    if (filters.search) {
      const term = `%${filters.search.trim()}%`;
      query = query.or(`name.ilike.${term},restaurant_code.ilike.${term}`);
    }
    if (filters.createdAfter) query = query.gte('created_at', filters.createdAfter);
    if (filters.createdBefore) query = query.lte('created_at', filters.createdBefore);

    if (ORG_DB_SORT_COLUMNS.has(sort.column)) {
      query = query.order(sort.column, { ascending: sort.direction === 'asc' });
    } else {
      query = query.order('created_at', { ascending: false });
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    query = query.range(from, to);

    const { data, count, error } = await query;
    if (!error) {
      const rows = (data ?? []) as unknown as OrgBaseRow[];
      return {
        data: rows,
        total: count ?? 0,
        error: null,
      };
    }

    const message = String(error.message ?? '').toLowerCase();
    if (withTimezone && message.includes('timezone') && message.includes('column')) {
      withTimezone = false;
      continue;
    }

    return { data: [], total: 0, error: error.message || 'Unable to load organizations.' };
  }

  return { data: [], total: 0, error: 'Unable to load organizations.' };
}

async function safeRows<T>(
  queryPromise: PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
  label: string,
): Promise<T[]> {
  const { data, error } = await queryPromise;
  if (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[admin/restaurants:query] ${label} failed`, error.message);
    }
    return [];
  }
  return data ?? [];
}

function countByOrg(rows: Record<string, unknown>[] | null | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows ?? []) {
    const orgId = String(row.organization_id ?? '');
    if (!orgId) continue;
    map.set(orgId, (map.get(orgId) ?? 0) + 1);
  }
  return map;
}

function normalizeSort(sort: RestaurantSort): RestaurantSort {
  const direction = sort.direction === 'asc' ? 'asc' : 'desc';
  const columnMap: Record<string, string> = {
    created_at: 'created_at',
    name: 'name',
    restaurant_code: 'restaurant_code',
    restaurantCode: 'restaurant_code',
    locationsCount: 'locationsCount',
    activeEmployeesCount: 'activeEmployeesCount',
    shifts7d: 'shifts7d',
    shifts30d: 'shifts30d',
    activationStage: 'activationStage',
    employeesCount: 'employeesCount',
  };
  return {
    column: columnMap[sort.column] ?? 'created_at',
    direction,
  };
}

function sortRows(rows: RestaurantRow[], sort: RestaurantSort): RestaurantRow[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  const key = sort.column as keyof RestaurantRow;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return -1 * dir;
    if (bv === null || bv === undefined) return 1 * dir;
    return av < bv ? -1 * dir : 1 * dir;
  });
}

function computeActivationStage(
  employeesCount: number,
  shifts7d: number,
  shifts30d: number,
  subscriptionStatus: string | null,
): ActivationStage {
  if (employeesCount === 0) return 0;
  if (shifts30d === 0) return 1;
  const isActive = shifts7d >= ACTIVATION_THRESHOLD;
  const hasSubscription = subscriptionStatus === 'active' || subscriptionStatus === 'trialing';
  if (isActive && hasSubscription) return 4;
  if (isActive) return 3;
  return 2;
}
