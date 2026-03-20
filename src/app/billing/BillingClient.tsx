'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  Check,
  ExternalLink,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { apiFetch } from '../../lib/apiClient';

const BILLING_ENABLED = process.env.NEXT_PUBLIC_BILLING_ENABLED === 'true';
const BILLING_PORTAL_ERROR_MESSAGE =
  'We could not open the billing portal yet. Please try again in a moment.';

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

function StatusBadge({ subscriptionStatus }: { subscriptionStatus: string }) {
  if (subscriptionStatus === 'active') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-500">
        <Check className="w-3 h-3" /> Active
      </span>
    );
  }
  if (subscriptionStatus === 'past_due') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-500">
        <AlertTriangle className="w-3 h-3" /> Past Due
      </span>
    );
  }
  if (subscriptionStatus === 'canceled') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/15 text-red-400">
        <XCircle className="w-3 h-3" /> Canceled
      </span>
    );
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isMissingBillingAccountError(message: string) {
  const lowered = message.toLowerCase();
  return (
    lowered.includes('no billing account found') ||
    lowered.includes('no stripe billing identifiers found') ||
    lowered.includes('unable to resolve stripe customer id')
  );
}

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
  const reconcileAttemptedRef = useRef(false);

  useEffect(() => {
    if (!isInitialized) {
      void init();
    }
  }, [isInitialized, init]);

  const loadSubscriptionSnapshot = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent) {
        setSnapshotLoading(true);
      }

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

      if (!silent) {
        setSnapshotLoading(false);
      }
      return result.ok ? result.data ?? null : null;
    },
    [activeRestaurantId],
  );

  const refreshSnapshotAndRouter = useCallback(async () => {
    const snapshot = await loadSubscriptionSnapshot();
    if (snapshot) {
      router.refresh();
    }
  }, [loadSubscriptionSnapshot, router]);

  useEffect(() => {
    if (!isInitialized) return;
    const timeoutId = window.setTimeout(() => {
      void loadSubscriptionSnapshot();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [isInitialized, loadSubscriptionSnapshot]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('portal') !== '1') return;

    const timeoutId = window.setTimeout(() => {
      void refreshSnapshotAndRouter();
    }, 0);
    params.delete('portal');
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
    window.history.replaceState({}, '', nextUrl);
    return () => window.clearTimeout(timeoutId);
  }, [refreshSnapshotAndRouter]);

  useEffect(() => {
    const onFocus = () => {
      void refreshSnapshotAndRouter();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshSnapshotAndRouter();
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshSnapshotAndRouter]);

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
      const reconcileResult = await apiFetch('/api/billing/reconcile-quantity', {
        method: 'POST',
      });
      if (!reconcileResult.ok) {
        console.error('[billing:quantity] reconcile request failed', {
          status: reconcileResult.status,
          error: reconcileResult.error,
        });
        return;
      }
      await loadSubscriptionSnapshot({ silent: true });
      router.refresh();
    })();
  }, [snapshotOwnedCount, snapshotQuantity, loadSubscriptionSnapshot, router]);

  const handleManageBilling = async () => {
    setError('');
    setPortalLoading(true);
    setFixingBillingLink(false);

    const openPortal = () =>
      apiFetch<{ url: string }>('/api/billing/create-portal-session', {
        method: 'POST',
        json: { organizationId: activeRestaurantId ?? undefined },
      });

    const firstAttempt = await openPortal();
    if (firstAttempt.ok && firstAttempt.data?.url) {
      window.open(firstAttempt.data.url, '_blank');
      setPortalLoading(false);
      return;
    }

    const firstError = firstAttempt.error || '';
    if (isMissingBillingAccountError(firstError)) {
      setFixingBillingLink(true);
      await sleep(1500);
      const retryAttempt = await openPortal();
      setFixingBillingLink(false);
      if (retryAttempt.ok && retryAttempt.data?.url) {
        window.open(retryAttempt.data.url, '_blank');
        setPortalLoading(false);
        return;
      }
    }

    setError(BILLING_PORTAL_ERROR_MESSAGE);
    setPortalLoading(false);
  };

  if (!isInitialized || snapshotLoading || subscriptionStatus === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
      </div>
    );
  }

  if (!currentUser) {
    return null;
  }

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
  const periodEnd = periodEndIso
    ? new Date(periodEndIso).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    })
    : null;

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/dashboard')}
          className="p-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
          aria-label="Back to dashboard"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-theme-primary">Billing</h1>
          <p className="text-sm text-theme-tertiary">Manage your CrewShyft subscription</p>
        </div>
      </div>

      <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-6 shadow-xl">
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-zinc-900" />
            </div>
            <div>
              <p className="font-semibold text-theme-primary">CrewShyft Pro - {planLabel}</p>
              <StatusBadge subscriptionStatus={subscriptionStatus} />
            </div>
          </div>
        </div>

        <div className="space-y-3 mb-6">
          <div className="flex items-center justify-between text-sm">
            <span className="text-theme-tertiary">Locations</span>
            <span className="text-theme-primary font-medium">
              {quantity} location{quantity !== 1 ? 's' : ''} x ${pricePerUnit.toFixed(2)}{interval} ={' '}
              <span className="font-bold">${totalPrice}{interval}</span>
            </span>
          </div>

          {periodEnd && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-theme-tertiary">
                {details?.cancelAtPeriodEnd ? 'Cancels on' : 'Next billing date'}
              </span>
              <span className="text-theme-primary font-medium">{periodEnd}</span>
            </div>
          )}
        </div>

        {details?.cancelAtPeriodEnd && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-6">
            <p className="text-sm text-amber-500">
              Your subscription will not renew after {periodEnd}. Use Manage Billing to reactivate.
            </p>
          </div>
        )}

        {(subscriptionStatus === 'past_due' || noticeParam === 'past_due') && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-6">
            <p className="text-sm text-amber-500 font-medium">
              Payment past due — your account access is limited.
            </p>
            <p className="text-xs text-amber-400 mt-1">
              Please update your payment method below to restore full access.
            </p>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-6">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        <button
          onClick={handleManageBilling}
          disabled={portalLoading}
          className="w-full py-3 bg-amber-500 text-zinc-900 font-semibold rounded-lg hover:bg-amber-400 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {portalLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ExternalLink className="w-4 h-4" />
          )}
          {portalLoading ? (fixingBillingLink ? 'Fixing billing link...' : 'Opening...') : 'Manage Billing'}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-theme-secondary border border-theme-primary rounded-xl p-4">
          <p className="text-sm font-semibold text-theme-primary mb-1">Change Plan</p>
          <p className="text-xs text-theme-tertiary">
            Use Manage Billing to switch between monthly and annual plans.
          </p>
        </div>
        <div className="bg-theme-secondary border border-theme-primary rounded-xl p-4">
          <p className="text-sm font-semibold text-theme-primary mb-1">Invoice History</p>
          <p className="text-xs text-theme-tertiary">
            View and download past invoices in the billing portal.
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => router.push('/restaurants')}
          className="text-sm text-theme-tertiary hover:text-theme-primary underline underline-offset-4 transition-colors"
        >
          Manage restaurants
        </button>
      </div>
    </div>
  );
}
