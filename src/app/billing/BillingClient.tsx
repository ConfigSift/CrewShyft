'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Crown,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Receipt,
  Settings,
  X,
  XCircle,
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { apiFetch } from '../../lib/apiClient';
import type { InvoiceSummary } from '../api/billing/invoices/route';

const BILLING_ENABLED = process.env.NEXT_PUBLIC_BILLING_ENABLED === 'true';
const BILLING_PORTAL_ERROR_MESSAGE =
  'We could not open the billing portal. Please try again in a moment.';

type SubscriptionStatusSnapshot = {
  billingEnabled?: boolean;
  active?: boolean;
  status?: string;
  cancel_at_period_end?: boolean;
  current_period_end?: string | null;
  owned_org_count?: number;
  required_quantity?: number;
  subscription?: {
    quantity?: number;
    stripe_price_id?: string | null;
    stripe_subscription_id?: string | null;
    current_period_end?: string | null;
    cancel_at_period_end?: boolean;
    status?: string;
  } | null;
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatCurrency(amountCents: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amountCents / 100);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateLong(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingBillingAccountError(message: string) {
  const lowered = message.toLowerCase();
  return (
    lowered.includes('no billing account found') ||
    lowered.includes('no stripe billing identifiers found') ||
    lowered.includes('unable to resolve stripe customer id')
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function StatusBadge({ status }: { status: string }) {
  if (status === 'active' || status === 'trialing') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-500 ring-1 ring-emerald-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        {status === 'trialing' ? 'Trial' : 'Active'}
      </span>
    );
  }
  if (status === 'past_due') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-500 ring-1 ring-amber-500/20">
        <AlertTriangle className="w-3 h-3" /> Past Due
      </span>
    );
  }
  if (status === 'canceled') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-red-500/10 text-red-400 ring-1 ring-red-500/20">
        <XCircle className="w-3 h-3" /> Canceled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20">
      {status}
    </span>
  );
}

function InvoiceStatusChip({ status }: { status: string | null }) {
  if (status === 'paid') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">
        <Check className="w-3 h-3" />
        Paid
      </span>
    );
  }
  if (status === 'open') {
    return (
      <span className="text-[11px] font-semibold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full">
        Open
      </span>
    );
  }
  if (status === 'void' || status === 'uncollectible') {
    return (
      <span className="text-[11px] font-semibold text-zinc-400 bg-zinc-500/10 px-2 py-0.5 rounded-full">
        {status === 'void' ? 'Void' : 'Uncollectible'}
      </span>
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Receipt Modal                                                     */
/* ------------------------------------------------------------------ */

function ReceiptModal({
  invoice,
  onClose,
}: {
  invoice: InvoiceSummary;
  onClose: () => void;
}) {
  const [viewMode, setViewMode] = useState<'details' | 'hosted'>('details');
  const [iframeLoading, setIframeLoading] = useState(true);
  const amountDisplay = formatCurrency(
    invoice.status === 'paid' ? invoice.amount_paid : invoice.amount_due,
    invoice.currency,
  );

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onEsc);
      document.body.style.overflow = 'unset';
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        className="relative z-[1001] h-[100dvh] w-full sm:h-auto sm:max-h-[90vh] sm:w-full sm:mx-4 sm:max-w-lg rounded-none sm:rounded-2xl bg-theme-secondary shadow-2xl border-0 sm:border border-theme-primary motion-safe:animate-slide-in overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-primary shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center shrink-0">
              <Receipt className="w-4.5 h-4.5 text-amber-500" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-theme-primary text-sm truncate">
                {invoice.number ?? 'Invoice'}
              </p>
              <p className="text-xs text-theme-tertiary">{formatDate(invoice.created)}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 -mr-1 rounded-lg hover:bg-theme-hover text-theme-tertiary hover:text-theme-primary transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab bar */}
        {invoice.hosted_invoice_url && (
          <div className="flex border-b border-theme-primary shrink-0">
            <button
              onClick={() => setViewMode('details')}
              className={`flex-1 text-xs font-medium py-2.5 text-center transition-colors ${
                viewMode === 'details'
                  ? 'text-amber-500 border-b-2 border-amber-500'
                  : 'text-theme-tertiary hover:text-theme-secondary'
              }`}
            >
              Summary
            </button>
            <button
              onClick={() => {
                setViewMode('hosted');
                setIframeLoading(true);
              }}
              className={`flex-1 text-xs font-medium py-2.5 text-center transition-colors ${
                viewMode === 'hosted'
                  ? 'text-amber-500 border-b-2 border-amber-500'
                  : 'text-theme-tertiary hover:text-theme-secondary'
              }`}
            >
              Full Receipt
            </button>
          </div>
        )}

        {/* Body */}
        {viewMode === 'details' ? (
          <div className="overflow-y-auto flex-1 overscroll-contain">
            {/* Amount hero */}
            <div className="px-5 pt-6 pb-4 text-center">
              <p className="text-3xl font-bold text-theme-primary tracking-tight">
                {amountDisplay}
              </p>
              <div className="mt-2">
                <InvoiceStatusChip status={invoice.status} />
              </div>
            </div>

            {/* Details */}
            <div className="px-5 pb-5 space-y-4">
              {/* Billing period */}
              {invoice.period_start && invoice.period_end && (
                <div className="flex items-center justify-between py-2.5 border-b border-theme-primary">
                  <span className="text-xs text-theme-tertiary">Billing period</span>
                  <span className="text-xs text-theme-primary font-medium">
                    {formatDate(invoice.period_start)} &ndash; {formatDate(invoice.period_end)}
                  </span>
                </div>
              )}

              {/* Line items */}
              {invoice.lines.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold text-theme-tertiary uppercase tracking-wider mb-2">
                    Items
                  </p>
                  <div className="rounded-xl border border-theme-primary overflow-hidden">
                    {invoice.lines.map((line, idx) => (
                      <div
                        key={line.id}
                        className={`flex items-start justify-between px-4 py-3 ${
                          idx > 0 ? 'border-t border-theme-primary' : ''
                        }`}
                      >
                        <div className="flex-1 min-w-0 pr-3">
                          <p className="text-sm text-theme-primary leading-snug">
                            {line.description ?? 'Subscription'}
                          </p>
                          {line.quantity != null && line.quantity > 1 && (
                            <p className="text-xs text-theme-tertiary mt-0.5">
                              Qty {line.quantity}
                            </p>
                          )}
                        </div>
                        <span className="text-sm font-medium text-theme-primary whitespace-nowrap">
                          {formatCurrency(line.amount, line.currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Total */}
              <div className="flex items-center justify-between pt-2">
                <span className="text-sm font-semibold text-theme-primary">Total</span>
                <span className="text-sm font-bold text-theme-primary">{amountDisplay}</span>
              </div>
            </div>
          </div>
        ) : (
          /* Hosted invoice iframe */
          <div className="flex-1 relative bg-white">
            {iframeLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-theme-secondary">
                <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              </div>
            )}
            <iframe
              src={invoice.hosted_invoice_url!}
              title="Invoice receipt"
              className="w-full h-full border-0"
              onLoad={() => setIframeLoading(false)}
              style={{ minHeight: '60vh' }}
            />
          </div>
        )}

        {/* Footer actions */}
        <div className="px-5 py-4 border-t border-theme-primary flex gap-3 shrink-0">
          {invoice.invoice_pdf && (
            <a
              href={invoice.invoice_pdf}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-theme-primary text-sm font-medium text-theme-secondary hover:bg-theme-hover transition-colors"
            >
              <Download className="w-4 h-4" />
              Download PDF
            </a>
          )}
          {invoice.hosted_invoice_url && (
            <a
              href={invoice.hosted_invoice_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-theme-primary text-sm font-medium text-theme-secondary hover:bg-theme-hover transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              View in Stripe
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Billing Client                                               */
/* ------------------------------------------------------------------ */

export default function BillingClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const noticeParam = searchParams.get('notice');
  const {
    currentUser,
    activeRestaurantId,
    isInitialized,
    init,
    subscriptionStatus,
    subscriptionDetails,
  } = useAuthStore();

  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [statusSnapshot, setStatusSnapshot] = useState<SubscriptionStatusSnapshot | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [fixingBillingLink, setFixingBillingLink] = useState(false);
  const [error, setError] = useState('');

  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceSummary | null>(null);

  const reconcileAttemptedRef = useRef(false);

  /* ---- data loading ---- */

  useEffect(() => {
    if (!isInitialized) {
      void init();
    }
  }, [isInitialized, init]);

  const loadSubscriptionSnapshot = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent) setSnapshotLoading(true);

      const result = await apiFetch<SubscriptionStatusSnapshot>(
        activeRestaurantId
          ? `/api/billing/subscription-status?organizationId=${activeRestaurantId}`
          : '/api/billing/subscription-status',
        { cache: 'no-store' },
      );

      if (result.ok && result.data) {
        setStatusSnapshot(result.data);
      } else if (!silent) {
        setStatusSnapshot(null);
      }

      if (!silent) setSnapshotLoading(false);
      return result.ok ? result.data ?? null : null;
    },
    [activeRestaurantId],
  );

  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    const result = await apiFetch<{ invoices: InvoiceSummary[] }>('/api/billing/invoices', {
      cache: 'no-store',
    });
    if (result.ok && result.data?.invoices) {
      setInvoices(result.data.invoices);
    }
    setInvoicesLoading(false);
  }, []);

  const refreshSnapshotAndRouter = useCallback(async () => {
    const snapshot = await loadSubscriptionSnapshot();
    if (snapshot) router.refresh();
  }, [loadSubscriptionSnapshot, router]);

  useEffect(() => {
    if (!isInitialized) return;
    const id = window.setTimeout(() => {
      void loadSubscriptionSnapshot();
      void loadInvoices();
    }, 0);
    return () => window.clearTimeout(id);
  }, [isInitialized, loadSubscriptionSnapshot, loadInvoices]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('portal') !== '1') return;

    const id = window.setTimeout(() => {
      void refreshSnapshotAndRouter();
      void loadInvoices();
    }, 0);
    params.delete('portal');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
    return () => window.clearTimeout(id);
  }, [refreshSnapshotAndRouter, loadInvoices]);

  useEffect(() => {
    const onFocus = () => void refreshSnapshotAndRouter();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshSnapshotAndRouter();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshSnapshotAndRouter]);

  /* ---- auto-reconcile ---- */

  const snapshotQuantity = Math.max(
    0,
    Number(statusSnapshot?.subscription?.quantity ?? subscriptionDetails?.quantity ?? 0),
  );
  const snapshotOwnedCount = Math.max(
    0,
    Number(statusSnapshot?.owned_org_count ?? subscriptionDetails?.ownedOrgCount ?? 0),
  );

  useEffect(() => {
    if (!BILLING_ENABLED) return;
    if (reconcileAttemptedRef.current) return;
    if (snapshotQuantity <= Math.max(1, snapshotOwnedCount)) return;

    reconcileAttemptedRef.current = true;
    void (async () => {
      const result = await apiFetch('/api/billing/reconcile-quantity', { method: 'POST' });
      if (!result.ok) return;
      await loadSubscriptionSnapshot({ silent: true });
      router.refresh();
    })();
  }, [snapshotOwnedCount, snapshotQuantity, loadSubscriptionSnapshot, router]);

  /* ---- handlers ---- */

  const handleManageBilling = async () => {
    setError('');
    setPortalLoading(true);
    setFixingBillingLink(false);

    const openPortal = () =>
      apiFetch<{ url: string }>('/api/billing/create-portal-session', {
        method: 'POST',
        json: { organizationId: activeRestaurantId ?? undefined },
      });

    const first = await openPortal();
    if (first.ok && first.data?.url) {
      window.open(first.data.url, '_blank');
      setPortalLoading(false);
      return;
    }

    if (isMissingBillingAccountError(first.error || '')) {
      setFixingBillingLink(true);
      await sleep(1500);
      const retry = await openPortal();
      setFixingBillingLink(false);
      if (retry.ok && retry.data?.url) {
        window.open(retry.data.url, '_blank');
        setPortalLoading(false);
        return;
      }
    }

    setError(BILLING_PORTAL_ERROR_MESSAGE);
    setPortalLoading(false);
  };

  /* ---- loading state ---- */

  if (!isInitialized || snapshotLoading || subscriptionStatus === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
      </div>
    );
  }

  if (!currentUser) return null;

  /* ---- derived values ---- */

  const details = subscriptionDetails;
  const planLabel =
    details?.planInterval === 'monthly'
      ? 'Monthly'
      : details?.planInterval === 'annual'
        ? 'Annual'
        : 'Pro';
  const pricePerUnit = details?.planInterval === 'annual' ? 199 : 19.99;
  const interval = details?.planInterval === 'annual' ? '/yr' : '/mo';
  const quantity = Math.max(
    0,
    Number(details?.quantity ?? statusSnapshot?.subscription?.quantity ?? 0),
  );
  const totalPrice = (pricePerUnit * Math.max(1, quantity)).toFixed(2);
  const periodEndIso = details?.currentPeriodEnd ?? statusSnapshot?.current_period_end ?? null;
  const periodEnd = periodEndIso ? formatDateLong(periodEndIso) : null;
  const currentStatus = details?.status ?? subscriptionStatus ?? 'none';

  /* ---- render ---- */

  return (
    <>
      {selectedInvoice && (
        <ReceiptModal invoice={selectedInvoice} onClose={() => setSelectedInvoice(null)} />
      )}

      <div className="max-w-xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-5">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/dashboard')}
              className="p-2 rounded-xl bg-theme-tertiary text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
              aria-label="Back to dashboard"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <h1 className="text-xl font-bold text-theme-primary tracking-tight">Billing</h1>
          </div>
          <button
            onClick={handleManageBilling}
            disabled={portalLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-theme-secondary hover:text-theme-primary rounded-lg border border-theme-primary hover:bg-theme-hover transition-colors disabled:opacity-50"
          >
            {portalLoading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {fixingBillingLink ? 'Fixing...' : 'Opening...'}
              </>
            ) : (
              <>
                <Settings className="w-3.5 h-3.5" />
                Manage
              </>
            )}
          </button>
        </div>

        {/* Alerts */}
        {error && (
          <div className="rounded-xl bg-red-500/8 border border-red-500/20 px-4 py-3">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {details?.cancelAtPeriodEnd && (
          <div className="rounded-xl bg-amber-500/8 border border-amber-500/20 px-4 py-3">
            <p className="text-sm text-amber-500 font-medium">Cancellation scheduled</p>
            <p className="text-xs text-amber-400/80 mt-0.5">
              Your subscription ends {periodEnd}. Use Manage to reactivate.
            </p>
          </div>
        )}

        {(currentStatus === 'past_due' || noticeParam === 'past_due') && (
          <div className="rounded-xl bg-red-500/8 border border-red-500/20 px-4 py-3">
            <p className="text-sm font-medium text-red-400">Payment past due</p>
            <p className="text-xs text-red-400/70 mt-0.5">
              Update your payment method to restore full access.
            </p>
          </div>
        )}

        {/* ---- Plan card ---- */}
        <div className="bg-theme-secondary border border-theme-primary rounded-2xl overflow-hidden">
          <div className="px-5 py-5 sm:px-6">
            {/* Plan name + status row */}
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                  <Crown className="w-4 h-4 text-amber-500" />
                </div>
                <div>
                  <p className="text-sm font-bold text-theme-primary leading-tight">
                    CrewShyft Pro
                  </p>
                  <p className="text-[11px] text-theme-tertiary">{planLabel}</p>
                </div>
              </div>
              <StatusBadge status={currentStatus} />
            </div>

            {/* Pricing breakdown */}
            <div className="rounded-xl bg-theme-primary/[0.03] border border-theme-primary p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-theme-tertiary">
                  {quantity} location{quantity !== 1 ? 's' : ''}
                </span>
                <span className="text-xs text-theme-secondary tabular-nums">
                  ${pricePerUnit.toFixed(2)}{interval} each
                </span>
              </div>

              <div className="mt-3 pt-3 border-t border-theme-primary flex items-baseline justify-between">
                <span className="text-xs font-medium text-theme-secondary">
                  {details?.cancelAtPeriodEnd ? 'Final charge' : 'Total'}
                </span>
                <div className="text-right">
                  <span className="text-xl font-bold text-theme-primary tabular-nums tracking-tight">
                    ${totalPrice}
                  </span>
                  <span className="text-xs font-normal text-theme-tertiary ml-0.5">{interval}</span>
                </div>
              </div>
            </div>

            {/* Next invoice / period end */}
            {periodEnd && (
              <p className="text-[11px] text-theme-muted mt-3">
                {details?.cancelAtPeriodEnd
                  ? `Access continues until ${periodEnd}`
                  : `Next invoice ${periodEnd}`}
              </p>
            )}
          </div>
        </div>

        {/* ---- Invoice history ---- */}
        <div className="bg-theme-secondary border border-theme-primary rounded-2xl overflow-hidden">
          <div className="px-5 py-3.5 sm:px-6 border-b border-theme-primary flex items-center justify-between">
            <p className="text-xs font-semibold text-theme-secondary uppercase tracking-wider">
              Invoices
            </p>
            {invoices.length > 0 && (
              <span className="text-[11px] text-theme-muted tabular-nums">
                {invoices.length}
              </span>
            )}
          </div>

          {invoicesLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 text-theme-tertiary animate-spin" />
            </div>
          ) : invoices.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <FileText className="w-6 h-6 text-theme-tertiary mx-auto mb-2 opacity-30" />
              <p className="text-xs text-theme-tertiary">No invoices yet</p>
            </div>
          ) : (
            <ul className="divide-y divide-theme-primary">
              {invoices.map((invoice) => {
                const amount = formatCurrency(
                  invoice.status === 'paid' ? invoice.amount_paid : invoice.amount_due,
                  invoice.currency,
                );
                return (
                  <li key={invoice.id}>
                    <button
                      onClick={() => setSelectedInvoice(invoice)}
                      className="w-full flex items-center justify-between px-5 sm:px-6 py-3.5 hover:bg-theme-hover transition-colors group text-left"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-theme-primary truncate">
                          {invoice.number ?? invoice.id}
                        </p>
                        <p className="text-[11px] text-theme-muted mt-0.5">
                          {formatDate(invoice.created)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0 ml-3">
                        <InvoiceStatusChip status={invoice.status} />
                        <span className="text-sm font-semibold text-theme-primary tabular-nums">
                          {amount}
                        </span>
                        <ChevronRight className="w-3.5 h-3.5 text-theme-tertiary opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-1 pb-4">
          <button
            onClick={() => router.push('/restaurants')}
            className="text-[11px] text-theme-muted hover:text-theme-tertiary transition-colors"
          >
            Manage restaurants
          </button>
          <p className="text-[10px] text-theme-muted">
            Powered by Stripe
          </p>
        </div>
      </div>
    </>
  );
}
