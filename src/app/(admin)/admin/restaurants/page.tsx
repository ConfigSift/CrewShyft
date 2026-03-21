'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Search,
  ChevronUp,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Download,
} from 'lucide-react';
import type { RestaurantRow, ActivationStage } from '@/lib/admin/types';
import { AdminFetchError } from '@/components/admin/AdminFetchError';
import { TableSkeleton } from '@/components/admin/AdminSkeletons';
import {
  ACTIVATION_STAGE_LABELS,
  ACTIVATION_STAGE_COLORS,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_LABELS,
  SUBSCRIPTION_STATUS_COLORS,
  type SubscriptionStatusOption,
} from '@/lib/admin/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortDir = 'asc' | 'desc';

type ApiResponse = {
  data: RestaurantRow[];
  total: number;
  page: number;
  pageSize: number;
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const COLUMNS: {
  key: string;
  label: string;
  sortable: boolean;
  className?: string;
}[] = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'restaurantCode', label: 'Code', sortable: true, className: 'hidden sm:table-cell' },
  { key: 'ownerName', label: 'Owner', sortable: false, className: 'hidden md:table-cell' },
  { key: 'subscriptionStatus', label: 'Sub Status', sortable: false },
  { key: 'currentPeriodEnd', label: 'Period End', sortable: false, className: 'hidden lg:table-cell' },
  { key: 'locationsCount', label: 'Locations', sortable: true, className: 'hidden lg:table-cell text-right' },
  { key: 'activeEmployeesCount', label: 'Active Emp.', sortable: true, className: 'text-right' },
  { key: 'shifts7d', label: 'Shifts 7d', sortable: true, className: 'text-right' },
  { key: 'activationStage', label: 'Stage', sortable: true },
];

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function AdminRestaurantsPage() {
  const [rows, setRows] = useState<RestaurantRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [subStatus, setSubStatus] = useState('');
  const [stageFilter, setStageFilter] = useState('');

  // Sort
  const [sortColumn, setSortColumn] = useState('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Export
  const [exporting, setExporting] = useState(false);

  // Debounce ref for search
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const fetchData = useCallback(
    async (searchVal: string) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (searchVal) params.set('search', searchVal);
      if (subStatus) params.set('subscriptionStatus', subStatus);
      if (stageFilter) params.set('activationStage', stageFilter);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      params.set('sortColumn', sortColumn);
      params.set('sortDirection', sortDir);

      try {
        const res = await fetch(`/api/admin/restaurants?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (res.ok) {
          const json: ApiResponse = await res.json();
          setRows(json.data);
          setTotal(json.total);
          setError(null);
        } else {
          const body = await res.json().catch(() => null);
          setError(body?.error ?? `Request failed (${res.status})`);
        }
      } catch {
        setError('Network error — could not reach the server.');
      } finally {
        setLoading(false);
      }
    },
    [subStatus, stageFilter, page, pageSize, sortColumn, sortDir],
  );

  // Fetch on mount and when deps change
  useEffect(() => {
    fetchData(search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData]);

  // Debounced search
  const handleSearch = (val: string) => {
    setSearch(val);
    setPage(1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchData(val), 300);
  };

  const handleSort = (col: string) => {
    if (sortColumn === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(col);
      setSortDir('asc');
    }
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/admin/export/restaurants.csv', {
        credentials: 'include',
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ??
        'crewshyft-restaurants.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-900">Restaurants</h2>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1"
        >
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Export CSV
        </button>
      </div>

      {/* Toolbar: search + filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search name or code…"
            aria-label="Search restaurants by name or code"
            className="w-full rounded-md border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        {/* Subscription status filter */}
        <select
          value={subStatus}
          onChange={(e) => { setSubStatus(e.target.value); setPage(1); }}
          aria-label="Filter by subscription status"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
        >
          <option value="">All statuses</option>
          <option value="none">No subscription</option>
          {SUBSCRIPTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SUBSCRIPTION_STATUS_LABELS[s]}
            </option>
          ))}
        </select>

        {/* Activation stage filter */}
        <select
          value={stageFilter}
          onChange={(e) => { setStageFilter(e.target.value); setPage(1); }}
          aria-label="Filter by activation stage"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
        >
          <option value="">All stages</option>
          {([0, 1, 2, 3, 4] as ActivationStage[]).map((s) => (
            <option key={s} value={s}>
              {ACTIVATION_STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {/* Error state */}
      {error && !loading && (
        <AdminFetchError
          message="Failed to load restaurants"
          detail={error}
          onRetry={() => fetchData(search)}
        />
      )}

      {/* Loading skeleton on initial load */}
      {loading && rows.length === 0 && !error && (
        <TableSkeleton rows={8} columns={COLUMNS.length} />
      )}

      {/* Table */}
      {!error && !(loading && rows.length === 0) && (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-100 bg-zinc-50">
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    className={`whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 ${col.className ?? ''} ${col.sortable ? 'cursor-pointer select-none hover:text-zinc-700' : ''}`}
                    onClick={col.sortable ? () => handleSort(col.key) : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {col.sortable && sortColumn === col.key && (
                        sortDir === 'asc'
                          ? <ChevronUp className="h-3 w-3" />
                          : <ChevronDown className="h-3 w-3" />
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-50">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="py-12 text-center text-sm text-zinc-400">
                    {search || subStatus || stageFilter
                      ? 'No organizations match your filters.'
                      : 'No organizations have been created yet.'}
                  </td>
                </tr>
              ) : (
                rows.map((row) => <RestaurantTableRow key={row.orgId} row={row} />)
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-zinc-500">
        <span>
          {total === 0
            ? 'No results'
            : `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
        </span>
        <div className="flex items-center gap-1">
          <PaginationBtn onClick={() => setPage(1)} disabled={page <= 1}>
            <ChevronsLeft className="h-4 w-4" />
          </PaginationBtn>
          <PaginationBtn onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            <ChevronLeft className="h-4 w-4" />
          </PaginationBtn>
          <span className="px-3 text-zinc-700 font-medium">
            {page} / {totalPages}
          </span>
          <PaginationBtn onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
            <ChevronRight className="h-4 w-4" />
          </PaginationBtn>
          <PaginationBtn onClick={() => setPage(totalPages)} disabled={page >= totalPages}>
            <ChevronsRight className="h-4 w-4" />
          </PaginationBtn>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

function RestaurantTableRow({ row }: { row: RestaurantRow }) {
  return (
    <tr className="transition-colors hover:bg-zinc-50">
      <td className="px-4 py-3">
        <Link
          href={`/admin/restaurants/${row.orgId}`}
          className="font-medium text-indigo-600 hover:underline"
        >
          {row.name}
        </Link>
      </td>
      <td className="hidden sm:table-cell px-4 py-3 font-mono text-xs text-zinc-500">
        {row.restaurantCode}
      </td>
      <td className="hidden md:table-cell px-4 py-3 text-zinc-600">
        {row.ownerName ?? <span className="text-zinc-300">—</span>}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <SubStatusBadge status={row.subscriptionStatus} />
          {row.billingOverrideType && (
            <span className="inline-block rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">
              {row.billingOverrideType === 'comped' ? 'Comped' : 'Exception'}
            </span>
          )}
        </div>
      </td>
      <td className="hidden lg:table-cell px-4 py-3 text-xs text-zinc-500">
        {row.currentPeriodEnd
          ? new Date(row.currentPeriodEnd).toLocaleDateString()
          : '—'}
      </td>
      <td className="hidden lg:table-cell px-4 py-3 text-right tabular-nums text-zinc-600">
        {row.locationsCount}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-600">
        {row.activeEmployeesCount}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-zinc-600">
        {row.shifts7d}
      </td>
      <td className="px-4 py-3">
        <StageBadge stage={row.activationStage} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

function SubStatusBadge({ status }: { status: string | null }) {
  if (!status) {
    return (
      <span className="inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-400" role="status" aria-label="Subscription status: None">
        None
      </span>
    );
  }
  const colors =
    SUBSCRIPTION_STATUS_COLORS[status as SubscriptionStatusOption] ??
    'bg-zinc-100 text-zinc-600';
  const label =
    SUBSCRIPTION_STATUS_LABELS[status as SubscriptionStatusOption] ?? status;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors}`} role="status" aria-label={`Subscription status: ${label}`}>
      {label}
    </span>
  );
}

function StageBadge({ stage }: { stage: ActivationStage }) {
  const label = ACTIVATION_STAGE_LABELS[stage];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ACTIVATION_STAGE_COLORS[stage]}`} role="status" aria-label={`Activation stage: ${label}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Pagination button
// ---------------------------------------------------------------------------

function PaginationBtn({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1"
    >
      {children}
    </button>
  );
}
