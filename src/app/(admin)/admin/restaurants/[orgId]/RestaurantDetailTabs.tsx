'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import {
  Users,
  MapPin,
  BarChart3,
  CreditCard,
  PackagePlus,
  LayoutDashboard,
  Loader2,
  Check,
  X,
  AlertTriangle,
} from 'lucide-react';
import type { MembershipRow } from '@/lib/admin/queries/restaurant-detail';
import { AdminFetchError } from '@/components/admin/AdminFetchError';
import { AdminBanner } from '@/components/admin/AdminBanner';

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'locations', label: 'Locations', icon: MapPin },
  { key: 'employees', label: 'Employees', icon: Users },
  { key: 'usage', label: 'Usage', icon: BarChart3 },
  { key: 'subscription', label: 'Subscription', icon: CreditCard },
  { key: 'provisioning', label: 'Provisioning', icon: PackagePlus },
] as const;

type TabKey = (typeof TABS)[number]['key'];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  orgId: string;
  initialMemberships: MembershipRow[];
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RestaurantDetailTabs({ orgId, initialMemberships }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  return (
    <>
      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-200" role="tablist" aria-label="Restaurant detail sections">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeTab === key}
            onClick={() => setActiveTab(key)}
            className={`flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${
              activeTab === key
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-zinc-500 hover:text-zinc-700'
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <Suspense fallback={<TabSpinner />}>
        <div className="min-h-[300px]" role="tabpanel" aria-label={`${activeTab} tab content`}>
          {activeTab === 'overview' && (
            <OverviewTab memberships={initialMemberships} />
          )}
          {activeTab === 'locations' && <LocationsTab orgId={orgId} />}
          {activeTab === 'employees' && <EmployeesTab orgId={orgId} />}
          {activeTab === 'usage' && <UsageTab orgId={orgId} />}
          {activeTab === 'subscription' && <SubscriptionTab orgId={orgId} />}
          {activeTab === 'provisioning' && <ProvisioningTab orgId={orgId} />}
        </div>
      </Suspense>
    </>
  );
}

// ---------------------------------------------------------------------------
// Generic fetch hook
// ---------------------------------------------------------------------------

function useTabData<T>(orgId: string, tab: string, extra = '') {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorInfo, setErrorInfo] = useState<Record<string, unknown> | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorInfo(null);
    try {
      const res = await fetch(
        `/api/admin/restaurants/${orgId}?tab=${tab}${extra}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (res.ok) {
        setData(await res.json());
      } else {
        const body = await res.json().catch(() => null) as Record<string, unknown> | null;
        const message = typeof body?.error === 'string'
          ? body.error
          : `Failed to load ${tab} data (${res.status})`;
        setError(message);
        setErrorInfo({ status: res.status, ...(body ?? {}) });
      }
    } catch {
      setError('Network error - could not reach the server.');
      setErrorInfo({ error: 'Network error - could not reach the server.' });
    } finally {
      setLoading(false);
    }
  }, [orgId, tab, extra]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, errorInfo, retry: fetchData };
}

function TabSpinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="py-12 text-center text-sm text-zinc-400">{text}</p>
  );
}

// ---------------------------------------------------------------------------
// Card wrapper
// ---------------------------------------------------------------------------

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-100 px-5 py-3">
        <h3 className="text-sm font-semibold text-zinc-700">{title}</h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({ memberships }: { memberships: MembershipRow[] }) {
  return (
    <div className="space-y-6">
      <Card title="Memberships">
        {memberships.length === 0 ? (
          <EmptyState text="No memberships found." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                <th scope="col" className="pb-2 pr-4">Role</th>
                <th scope="col" className="pb-2 pr-4">Name</th>
                <th scope="col" className="pb-2 pr-4">Email</th>
                <th scope="col" className="pb-2 font-mono">auth_user_id</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              {memberships.map((m) => (
                <tr key={m.id}>
                  <td className="py-2 pr-4">
                    <RoleBadge role={m.role} />
                  </td>
                  <td className="py-2 pr-4 text-zinc-700">
                    {m.fullName ?? <span className="text-zinc-300">—</span>}
                  </td>
                  <td className="py-2 pr-4 text-zinc-500">{m.email ?? '—'}</td>
                  <td className="py-2 font-mono text-xs text-zinc-400">
                    {m.authUserId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const colors =
    role === 'owner'
      ? 'bg-violet-100 text-violet-700'
      : role === 'admin'
      ? 'bg-indigo-100 text-indigo-700'
      : role === 'manager'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-zinc-100 text-zinc-600';
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${colors}`}
      role="status"
      aria-label={`Role: ${role}`}
    >
      {role}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 2. Locations tab
// ---------------------------------------------------------------------------

type LocationsPayload = {
  locations: { id: string; name: string; sortOrder: number; createdAt: string }[];
};

function LocationsTab({ orgId }: { orgId: string }) {
  const { data, loading, error, retry } = useTabData<LocationsPayload>(orgId, 'locations');
  if (loading) return <TabSpinner />;
  if (error) return <AdminFetchError message="Failed to load locations" detail={error} onRetry={retry} />;
  const locations = data?.locations ?? [];

  return (
    <Card title={`Locations (${locations.length})`}>
      {locations.length === 0 ? (
        <EmptyState text="No locations have been added to this organization yet." />
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
              <th scope="col" className="pb-2 pr-4">Name</th>
              <th scope="col" className="pb-2 pr-4 text-right">Sort Order</th>
              <th scope="col" className="pb-2">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-50">
            {locations.map((l) => (
              <tr key={l.id}>
                <td className="py-2 pr-4 text-zinc-700">{l.name}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-zinc-500">
                  {l.sortOrder}
                </td>
                <td className="py-2 text-xs text-zinc-400">
                  {new Date(l.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3. Employees tab
// ---------------------------------------------------------------------------

type EmployeesPayload = {
  expectedEmployeesCount?: number;
  employees: {
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
  }[];
};

function EmployeesTab({ orgId }: { orgId: string }) {
  const { data, loading, error, errorInfo, retry } = useTabData<EmployeesPayload>(orgId, 'employees');
  const [copied, setCopied] = useState(false);
  if (loading) return <TabSpinner />;
  if (error) {
    const requestId = typeof errorInfo?.requestId === 'string' ? errorInfo.requestId : null;
    const payload = {
      error,
      requestId,
      ...(errorInfo ?? {}),
    };

    const copyError = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        setCopied(false);
      }
    };

    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">Failed to load employees</p>
          <p className="mt-1 text-sm text-red-700">{error}</p>
          {requestId && (
            <p className="mt-1 text-xs text-red-600">requestId: <span className="font-mono">{requestId}</span></p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={copyError}
              className="rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
            >
              Copy error
            </button>
            {copied && <span className="text-xs text-red-600">Copied</span>}
          </div>
        </div>
        <AdminFetchError message="Failed to load employees data" detail={error} onRetry={retry} />
      </div>
    );
  }
  const employees = data?.employees ?? [];
  const expectedEmployeesCount = data?.expectedEmployeesCount ?? employees.length;
  const activeCount = employees.filter((e) => e.isActive === true).length;
  const inactiveCount = employees.filter((e) => e.isActive === false).length;
  const showMismatchBanner = expectedEmployeesCount > 0 && employees.length === 0;

  return (
    <div className="space-y-4">
      {showMismatchBanner && (
        <AdminBanner
          variant="warning"
          message="Employee count mismatch — check users.organization_id mapping."
        />
      )}

      {/* Summary */}
      <div className="flex gap-4 text-sm">
        <span className="rounded-md bg-zinc-100 px-3 py-1 text-zinc-600">
          Total: <strong>{employees.length}</strong>
        </span>
        <span className="rounded-md bg-emerald-50 px-3 py-1 text-emerald-700">
          Active: <strong>{activeCount}</strong>
        </span>
        <span className="rounded-md bg-zinc-50 px-3 py-1 text-zinc-400">
          Inactive: <strong>{inactiveCount}</strong>
        </span>
      </div>

      <Card title="Employees">
        {employees.length === 0 ? (
          <EmptyState text="No employees have been added yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                  <th scope="col" className="pb-2 pr-4">Name</th>
                  <th scope="col" className="pb-2 pr-4">Role</th>
                  <th scope="col" className="pb-2 pr-4">Source</th>
                  <th scope="col" className="pb-2 pr-4 text-center">Active</th>
                  <th scope="col" className="pb-2 pr-4 text-right">Emp #</th>
                  <th scope="col" className="pb-2 text-center">PIN</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {employees.map((e) => (
                  <tr
                    key={e.id}
                    className={e.isActive === false ? 'opacity-50' : ''}
                  >
                    <td className="py-2 pr-4 text-zinc-700">
                      <div className="flex items-center gap-2">
                        <span>{e.displayName ?? 'User'}</span>
                        {e.isOwner && (
                          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                            Owner
                          </span>
                        )}
                        {e.source === 'membership' && (
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
                            Membership-only
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <RoleBadge role={e.role.toLowerCase()} />
                    </td>
                    <td className="py-2 pr-4 text-xs text-zinc-500">
                      {e.source === 'membership' ? 'Owner membership' : 'User profile'}
                    </td>
                    <td className="py-2 pr-4 text-center">
                      {e.isActive === true ? (
                        <Check className="mx-auto h-4 w-4 text-emerald-500" />
                      ) : e.isActive === false ? (
                        <X className="mx-auto h-4 w-4 text-zinc-300" />
                      ) : (
                        <span className="text-zinc-300">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-zinc-500">
                      {e.employeeNumber ?? '—'}
                    </td>
                    <td className="py-2 text-center">
                      {e.pinReady ? (
                        <Check className="mx-auto h-4 w-4 text-emerald-500" />
                      ) : (
                        <X className="mx-auto h-4 w-4 text-zinc-300" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Usage tab
// ---------------------------------------------------------------------------

type UsagePayload = {
  days: number;
  usage: {
    shifts: number;
    timeOffRequests: number;
    shiftExchangeRequests: number;
    blockedDayRequests: number;
  };
};

function UsageTab({ orgId }: { orgId: string }) {
  const [days, setDays] = useState(7);
  const { data, loading, error, retry } = useTabData<UsagePayload>(
    orgId,
    'usage',
    `&days=${days}`,
  );

  const usage = data?.usage;

  return (
    <div className="space-y-4">
      {/* Day range toggle */}
      <div className="flex gap-1">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            aria-label={`Show ${d} day usage`}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 ${
              days === d
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      {loading ? (
        <TabSpinner />
      ) : error ? (
        <AdminFetchError message="Failed to load usage data" detail={error} onRetry={retry} />
      ) : usage ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <UsageCard label="Shifts" value={usage.shifts} />
          <UsageCard label="Time-Off Requests" value={usage.timeOffRequests} />
          <UsageCard label="Shift Exchanges" value={usage.shiftExchangeRequests} />
          <UsageCard label="Blocked Days" value={usage.blockedDayRequests} />
        </div>
      ) : (
        <EmptyState text="No usage data available for this period." />
      )}
    </div>
  );
}

function UsageCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
      <p className="text-2xl font-bold text-zinc-900">{value.toLocaleString()}</p>
      <p className="mt-1 text-xs text-zinc-500">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Subscription tab
// ---------------------------------------------------------------------------

type SubscriptionPayload = {
  subscription: {
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
  billingAccount: {
    authUserId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string | null;
    status: string;
    quantity: number;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  } | null;
  billingOverride: {
    active: boolean;
    type: string | null;
    reason: string | null;
    expiresAt: string | null;
    setBy: string | null;
  } | null;
};

function SubscriptionTab({ orgId }: { orgId: string }) {
  const { data, loading, error, retry } = useTabData<SubscriptionPayload>(
    orgId,
    'subscription',
  );
  const [overrideType, setOverrideType] = useState<'comped' | 'manual_exception'>('comped');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideExpiresAt, setOverrideExpiresAt] = useState('');
  const [overrideSubmitting, setOverrideSubmitting] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const sub = data?.subscription;
  const billing = data?.billingAccount;
  const billingOverride = data?.billingOverride ?? null;

  useEffect(() => {
    if (!billingOverride?.active) {
      setOverrideType('comped');
      setOverrideReason('');
      setOverrideExpiresAt('');
      return;
    }
    setOverrideType(billingOverride.type === 'manual_exception' ? 'manual_exception' : 'comped');
    setOverrideReason(billingOverride.reason ?? '');
    setOverrideExpiresAt(toDateTimeLocalValue(billingOverride.expiresAt));
  }, [billingOverride]);

  if (loading) return <TabSpinner />;
  if (error) return <AdminFetchError message="Failed to load subscription" detail={error} onRetry={retry} />;

  const saveOverride = async () => {
    setOverrideSubmitting(true);
    setOverrideError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing-override`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          active: true,
          type: overrideType,
          reason: overrideReason.trim() || null,
          expiresAt: overrideExpiresAt || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setOverrideError(body?.error ?? `Request failed (${res.status})`);
        return;
      }
      await retry();
    } catch {
      setOverrideError('Network error — could not save billing override.');
    } finally {
      setOverrideSubmitting(false);
    }
  };

  const removeOverride = async () => {
    setOverrideSubmitting(true);
    setOverrideError(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing-override`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setOverrideError(body?.error ?? `Request failed (${res.status})`);
        return;
      }
      await retry();
    } catch {
      setOverrideError('Network error — could not remove billing override.');
    } finally {
      setOverrideSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card title="Organization Subscription">
        {!sub ? (
          <>
            <AdminBanner
              variant="warning"
              message="This organization has no linked subscription — it may not have completed onboarding."
            />
            <EmptyState text="No subscription record found for this organization." />
          </>
        ) : (
          <dl className="space-y-3 text-sm">
            <DetailRow label="Status" value={<SubBadge status={sub.status} />} />
            <DetailRow label="Stripe Sub ID" value={sub.stripeSubscriptionId} mono />
            <DetailRow label="Stripe Customer ID" value={sub.stripeCustomerId} mono />
            <DetailRow label="Price ID" value={sub.stripePriceId} mono />
            <DetailRow label="Quantity" value={String(sub.quantity)} />
            <DetailRow
              label="Period"
              value={`${fmtDate(sub.currentPeriodStart)} — ${fmtDate(sub.currentPeriodEnd)}`}
            />
            <DetailRow
              label="Cancel at Period End"
              value={
                sub.cancelAtPeriodEnd ? (
                  <span className="font-medium text-amber-600">Yes</span>
                ) : (
                  'No'
                )
              }
            />
          </dl>
        )}
      </Card>

      <Card title="Billing Account (Owner)">
        {!billing ? (
          <EmptyState text="No billing account linked to this organization's admin." />
        ) : (
          <dl className="space-y-3 text-sm">
            <DetailRow label="Auth User ID" value={billing.authUserId} mono />
            <DetailRow label="Status" value={<SubBadge status={billing.status} />} />
            <DetailRow label="Stripe Customer ID" value={billing.stripeCustomerId} mono />
            <DetailRow
              label="Stripe Sub ID"
              value={billing.stripeSubscriptionId ?? '—'}
              mono
            />
            <DetailRow label="Quantity" value={String(billing.quantity)} />
            <DetailRow
              label="Cancel at Period End"
              value={
                billing.cancelAtPeriodEnd ? (
                  <span className="font-medium text-amber-600">Yes</span>
                ) : (
                  'No'
                )
              }
            />
            <DetailRow label="Period End" value={fmtDate(billing.currentPeriodEnd)} />
          </dl>
        )}
      </Card>

      <Card title="Billing Exception">
        <div className="space-y-4">
          <AdminBanner
            variant="info"
            message={billingOverride?.active
              ? 'This restaurant is currently using an internal billing exception.'
              : 'Grant CrewShyft-managed access without requiring customer-managed Stripe billing.'}
          />

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Type</label>
            <select
              value={overrideType}
              onChange={(e) => setOverrideType(e.target.value === 'manual_exception' ? 'manual_exception' : 'comped')}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            >
              <option value="comped">Comped</option>
              <option value="manual_exception">Billing Exception</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Reason</label>
            <textarea
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              placeholder="Explain why this restaurant should bypass normal billing."
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Expires At</label>
            <input
              type="datetime-local"
              value={overrideExpiresAt}
              onChange={(e) => setOverrideExpiresAt(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
            <p className="text-xs text-zinc-500">Leave blank to keep the override active until removed.</p>
          </div>

          {billingOverride?.active && (
            <dl className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
              <DetailRow
                label="Current Status"
                value={billingOverride.type === 'comped' ? 'Comped' : 'Billing Exception'}
              />
              <DetailRow label="Reason" value={billingOverride.reason || '—'} />
              <DetailRow label="Expires" value={fmtDateTime(billingOverride.expiresAt)} />
              <DetailRow label="Set By" value={billingOverride.setBy || '—'} mono />
            </dl>
          )}

          {overrideError && (
            <p className="text-sm text-red-600">{overrideError}</p>
          )}

          <div className="flex items-center justify-end gap-3">
            {billingOverride?.active && (
              <button
                type="button"
                onClick={removeOverride}
                disabled={overrideSubmitting}
                className="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
              >
                {overrideSubmitting ? 'Removing...' : 'Remove exception'}
              </button>
            )}
            <button
              type="button"
              onClick={saveOverride}
              disabled={overrideSubmitting}
              className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {overrideSubmitting ? 'Saving...' : billingOverride?.active ? 'Update exception' : 'Save exception'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-zinc-500">{label}</dt>
      <dd className={`text-right text-zinc-800 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

function SubBadge({ status }: { status: string }) {
  const colors =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'trialing'
        ? 'bg-blue-100 text-blue-700'
        : status === 'past_due'
          ? 'bg-amber-100 text-amber-700'
          : status === 'canceled'
            ? 'bg-zinc-100 text-zinc-600'
            : 'bg-red-100 text-red-700';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors}`} role="status" aria-label={`Subscription status: ${status}`}>
      {status}
    </span>
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function toDateTimeLocalValue(iso: string | null | undefined) {
  const normalized = String(iso ?? '').trim();
  if (!normalized) return '';
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return '';
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
// 6. Provisioning tab
// ---------------------------------------------------------------------------

type ProvisioningPayload = {
  intents: {
    id: string;
    authUserId: string;
    restaurantName: string;
    status: string;
    desiredQuantity: number;
    organizationId: string | null;
    lastError: unknown;
    createdAt: string;
    updatedAt: string;
  }[];
};

function ProvisioningTab({ orgId }: { orgId: string }) {
  const { data, loading, error, retry } = useTabData<ProvisioningPayload>(
    orgId,
    'provisioning',
  );
  if (loading) return <TabSpinner />;
  if (error) return <AdminFetchError message="Failed to load provisioning data" detail={error} onRetry={retry} />;
  const intents = data?.intents ?? [];

  return (
    <Card title={`Create Intents (${intents.length})`}>
      {intents.length === 0 ? (
        <EmptyState text="No provisioning history available." />
      ) : (
        <div className="space-y-4">
          {intents.map((intent) => (
            <IntentCard key={intent.id} intent={intent} />
          ))}
        </div>
      )}
    </Card>
  );
}

function IntentCard({
  intent,
}: {
  intent: ProvisioningPayload['intents'][number];
}) {
  const hasError = intent.lastError != null;
  const statusColors =
    intent.status === 'completed'
      ? 'bg-emerald-100 text-emerald-700'
      : intent.status === 'failed'
        ? 'bg-red-100 text-red-700'
        : intent.status === 'canceled'
          ? 'bg-zinc-100 text-zinc-600'
          : 'bg-blue-100 text-blue-700';

  return (
    <div
      className={`rounded-lg border p-4 ${hasError ? 'border-red-200 bg-red-50/50' : 'border-zinc-200 bg-zinc-50/50'}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusColors}`}
          role="status"
          aria-label={`Intent status: ${intent.status}`}
        >
          {intent.status}
        </span>
        <span className="text-sm font-medium text-zinc-700">
          {intent.restaurantName}
        </span>
        <span className="text-xs text-zinc-400">
          qty: {intent.desiredQuantity}
        </span>
        <span className="ml-auto text-xs text-zinc-400">
          {new Date(intent.createdAt).toLocaleString()}
        </span>
      </div>

      <div className="mt-2 space-y-1 text-xs text-zinc-500">
        <p>
          <span className="text-zinc-400">auth_user_id:</span>{' '}
          <span className="font-mono">{intent.authUserId}</span>
        </p>
        {intent.organizationId && (
          <p>
            <span className="text-zinc-400">org_id:</span>{' '}
            <span className="font-mono">{intent.organizationId}</span>
          </p>
        )}
      </div>

      {hasError && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-red-100 p-3 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <pre className="whitespace-pre-wrap break-all">
            {typeof intent.lastError === 'string'
              ? intent.lastError
              : JSON.stringify(intent.lastError, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
