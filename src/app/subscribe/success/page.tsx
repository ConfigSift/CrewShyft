'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useAuthStore } from '../../../store/authStore';
import { apiFetch } from '../../../lib/apiClient';

type FinalizeResponse = {
  ok: boolean;
  organizationId?: string | null;
  organization_id?: string | null;
  stripeSubscriptionId?: string | null;
  stripeCustomerId?: string | null;
  status?: string;
  active?: boolean;
  current_period_end?: string | null;
  quantity?: number;
  intent_id?: string | null;
};

type SubscriptionStatusResponse = {
  active?: boolean;
  status?: string;
};

type CommitIntentResponse = {
  ok: boolean;
  organizationId: string;
  restaurantCode?: string | null;
};

type CommitIntentError = {
  error?: string;
  code?: string;
  message?: string;
  manageBillingUrl?: string;
  hostedInvoiceUrl?: string;
  redirect?: string;
};

type ViewState =
  | 'finalizing'
  | 'missing-session'
  | 'retry'
  | 'payment'
  | 'syncing';

const FINALIZE_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = [500, 1500, 3500];

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch/i.test(message) || /networkerror/i.test(message);
}

function parseJsonSafe(text: string) {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRetryableStatus(status: number) {
  return status === 401 || status === 403 || status >= 500;
}

async function finalizeCheckoutWithRetry(sessionId: string, intentId?: string | null) {
  let lastErrorMessage = 'Unable to finalize checkout.';
  let lastStatus = 0;

  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, FINALIZE_TIMEOUT_MS);

    try {
      const response = await fetch('/api/billing/finalize-checkout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: sessionId,
          intent_id: intentId ?? undefined,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const rawText = await response.text();
      const json = parseJsonSafe(rawText);

      if (response.ok) {
        return {
          ok: true as const,
          data: (json as FinalizeResponse | null) ?? null,
          status: response.status,
        };
      }

      lastStatus = response.status;
      lastErrorMessage =
        String(json?.message ?? json?.error ?? `Finalize failed (${response.status}).`);

      if (isRetryableStatus(response.status) && attempt < RETRY_BACKOFF_MS.length - 1) {
        await delay(RETRY_BACKOFF_MS[attempt]);
        continue;
      }

      return {
        ok: false as const,
        status: response.status,
        error: lastErrorMessage,
      };
    } catch (error) {
      clearTimeout(timeout);
      lastStatus = 0;
      if (controller.signal.aborted) {
        lastErrorMessage = 'Finalize request timed out.';
      } else {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
      }

      const retryable = controller.signal.aborted || isNetworkError(error);
      if (retryable && attempt < RETRY_BACKOFF_MS.length - 1) {
        await delay(RETRY_BACKOFF_MS[attempt]);
        continue;
      }

      return {
        ok: false as const,
        status: lastStatus,
        error: lastErrorMessage,
      };
    }
  }

  return {
    ok: false as const,
    status: lastStatus,
    error: lastErrorMessage,
  };
}

export default function SubscribeSuccessPage() {
  const router = useRouter();
  const {
    activeRestaurantId,
    accessibleRestaurants,
    isInitialized,
    init,
    setActiveOrganization,
    refreshProfile,
  } = useAuthStore();

  const [viewState, setViewState] = useState<ViewState>('finalizing');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const autoRedirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    if (!isInitialized) init();
  }, [isInitialized, init]);

  useEffect(() => {
    return () => {
      if (autoRedirectTimerRef.current) {
        clearTimeout(autoRedirectTimerRef.current);
        autoRedirectTimerRef.current = null;
      }
    };
  }, []);

  async function pollSubscriptionUntilActive(organizationId: string | null) {
    if (!organizationId) return false;

    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const elapsed = Date.now() - start;
      const interval = elapsed < 10_000 ? 1000 : 3000;
      await delay(interval);

      const statusResult = await apiFetch<SubscriptionStatusResponse>(
        `/api/billing/subscription-status?organizationId=${organizationId}`,
      );

      if (!statusResult.ok || !statusResult.data) {
        continue;
      }

      const rawStatus = String(statusResult.data.status ?? '').trim().toLowerCase();
      const active =
        Boolean(statusResult.data.active) || rawStatus === 'active' || rawStatus === 'trialing';
      if (active) {
        return true;
      }
    }

    return false;
  }

  const commitIntentAndRedirect = useCallback(async (intentId: string, sessionIdForLink?: string | null) => {
    const commitResult = await apiFetch<CommitIntentResponse | CommitIntentError>(
      '/api/orgs/commit-intent',
      {
        method: 'POST',
        json: { intentId, deferBillingCheck: true },
      },
    );

    if (commitResult.ok && (commitResult.data as CommitIntentResponse | null)?.organizationId) {
      const organizationId = (commitResult.data as CommitIntentResponse).organizationId;

      // Link the Stripe subscription to the newly created org so the subscriptions
      // table gets populated. Non-fatal: webhook may sync it if this call fails.
      if (sessionIdForLink) {
        try {
          await apiFetch('/api/billing/finalize-checkout', {
            method: 'POST',
            json: { session_id: sessionIdForLink, organization_id: organizationId },
          });
        } catch {
          // Non-fatal — subscription will sync via Stripe webhook
        }
      }

      await refreshProfile();
      const matchedRestaurant = useAuthStore
        .getState()
        .accessibleRestaurants
        .find((restaurant) => restaurant.id === organizationId);
      setActiveOrganization(organizationId, matchedRestaurant?.restaurantCode ?? null);
      router.replace('/dashboard');
      return true;
    }

    const body = (commitResult.data ?? null) as CommitIntentError | null;
    if (commitResult.status === 409) {
      setViewState('payment');
      setPaymentUrl(body?.hostedInvoiceUrl ?? body?.manageBillingUrl ?? body?.redirect ?? '/billing');
      setErrorMessage(body?.message ?? 'Payment is still required before creating this restaurant.');
      return false;
    }

    const fetchFailure = commitResult.status === 0 || isNetworkError(commitResult.error ?? '');
    if (fetchFailure) {
      setViewState('retry');
      setErrorMessage('Network error while creating your restaurant. Please retry.');
      return false;
    }

    setViewState('retry');
    setErrorMessage(body?.message || body?.error || commitResult.error || 'Unable to create your restaurant.');
    return false;
  }, [refreshProfile, router, setActiveOrganization]);

  useEffect(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    let cancelled = false;

    async function runFlow() {
      setViewState('finalizing');
      setErrorMessage(null);
      setPaymentUrl(null);

      const search = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search)
        : new URLSearchParams();
      const sessionId = String(search.get('session_id') ?? '').trim();
      const fallbackIntentId = String(search.get('intent_id') ?? '').trim() || null;

      if (!sessionId) {
        setViewState('missing-session');
        setErrorMessage('Missing checkout session id.');
        return;
      }

      const finalize = await finalizeCheckoutWithRetry(sessionId, fallbackIntentId);
      if (cancelled) return;

      if (!finalize.ok || !finalize.data) {
        setViewState('retry');
        setErrorMessage(finalize.error || 'Unable to finalize checkout.');
        return;
      }

      const finalizeData = finalize.data;
      const organizationId =
        String(finalizeData.organizationId ?? finalizeData.organization_id ?? '').trim() ||
        activeRestaurantId ||
        null;
      const resolvedIntentId =
        String(finalizeData.intent_id ?? fallbackIntentId ?? '').trim() || null;
      const activeNow = Boolean(finalizeData.active);

      if (organizationId && organizationId !== activeRestaurantId) {
        const matchedRestaurant = accessibleRestaurants.find((restaurant) => restaurant.id === organizationId);
        setActiveOrganization(organizationId, matchedRestaurant?.restaurantCode ?? null);
      }

      if (activeNow) {
        if (resolvedIntentId) {
          await commitIntentAndRedirect(resolvedIntentId, sessionId);
          return;
        }
        router.replace('/dashboard');
        return;
      }

      const becameActive = await pollSubscriptionUntilActive(organizationId);
      if (cancelled) return;

      if (becameActive) {
        if (resolvedIntentId) {
          await commitIntentAndRedirect(resolvedIntentId, sessionId);
          return;
        }
        router.replace('/dashboard');
        return;
      }

      setViewState('syncing');
      setErrorMessage('Your payment succeeded - subscription is syncing.');
      autoRedirectTimerRef.current = setTimeout(() => {
        router.replace('/dashboard');
      }, 3000);
    }

    void runFlow();

    return () => {
      cancelled = true;
      runningRef.current = false;
      if (autoRedirectTimerRef.current) {
        clearTimeout(autoRedirectTimerRef.current);
        autoRedirectTimerRef.current = null;
      }
    };
  }, [
    activeRestaurantId,
    accessibleRestaurants,
    retryNonce,
    router,
    setActiveOrganization,
    refreshProfile,
    commitIntentAndRedirect,
  ]);

  return (
    <div className="min-h-screen bg-theme-primary relative flex items-center justify-center p-4">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 40%, rgba(245,158,11,0.06) 0%, transparent 70%)',
        }}
      />

      <div className="relative w-full max-w-md text-center animate-auth-enter">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mb-4 shadow-lg">
            <Calendar className="w-8 h-8 text-zinc-900" />
          </div>
          <p className="text-xl font-bold text-theme-primary">CrewShyft</p>
        </div>

        <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-8 shadow-xl">
          {viewState === 'finalizing' && (
            <>
              <Loader2 className="w-12 h-12 text-amber-500 animate-spin mx-auto mb-4" />
              <h1 className="text-xl font-bold text-theme-primary mb-2">
                Finalizing subscription...
              </h1>
              <p className="text-sm text-theme-tertiary">
                We&apos;re activating your subscription. This usually takes just a moment.
              </p>
            </>
          )}

          {viewState === 'missing-session' && (
            <>
              <div className="w-12 h-12 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto mb-4">
                <RefreshCw className="w-6 h-6 text-amber-500" />
              </div>
              <h1 className="text-xl font-bold text-theme-primary mb-2">Session missing</h1>
              <p className="text-sm text-theme-tertiary mb-6">
                {errorMessage ?? 'We could not find your checkout session.'}
              </p>
              <button
                onClick={() => router.replace('/subscribe')}
                className="w-full py-3 bg-amber-500 text-zinc-900 font-semibold rounded-lg hover:bg-amber-400 transition-colors"
              >
                Back to Subscribe
              </button>
            </>
          )}

          {viewState === 'retry' && (
            <>
              <div className="w-12 h-12 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto mb-4">
                <RefreshCw className="w-6 h-6 text-amber-500" />
              </div>
              <h1 className="text-xl font-bold text-theme-primary mb-2">
                Couldn&apos;t finish automatically
              </h1>
              <p className="text-sm text-theme-tertiary mb-6">
                {errorMessage ?? 'A network issue interrupted finalization.'}
              </p>
              <button
                onClick={() => {
                  setRetryNonce((value) => value + 1);
                }}
                className="w-full py-3 bg-amber-500 text-zinc-900 font-semibold rounded-lg hover:bg-amber-400 transition-colors"
              >
                Retry
              </button>
              <button
                onClick={() => router.replace('/dashboard')}
                className="w-full mt-3 py-3 border border-theme-primary text-theme-secondary rounded-lg hover:bg-theme-hover transition-colors"
              >
                Continue to Site Manager
              </button>
            </>
          )}

          {viewState === 'payment' && (
            <>
              <div className="w-12 h-12 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto mb-4">
                <ExternalLink className="w-6 h-6 text-amber-500" />
              </div>
              <h1 className="text-xl font-bold text-theme-primary mb-2">
                Complete payment to continue
              </h1>
              <p className="text-sm text-theme-tertiary mb-6">
                {errorMessage ?? 'Your upgrade is pending payment.'}
              </p>
              <div className="space-y-3">
                <button
                  onClick={() => {
                    if (!paymentUrl) return;
                    window.open(paymentUrl, '_blank');
                  }}
                  className="w-full py-3 bg-amber-500 text-zinc-900 font-semibold rounded-lg hover:bg-amber-400 transition-colors"
                >
                  Open Payment
                </button>
                <button
                  onClick={() => {
                    setRetryNonce((value) => value + 1);
                  }}
                  className="w-full py-3 border border-theme-primary text-theme-secondary rounded-lg hover:bg-theme-hover transition-colors"
                >
                  I&apos;ve completed payment
                </button>
              </div>
            </>
          )}

          {viewState === 'syncing' && (
            <>
              <div className="w-12 h-12 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto mb-4">
                <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              </div>
              <h1 className="text-xl font-bold text-theme-primary mb-2">
                Subscription syncing
              </h1>
              <p className="text-sm text-theme-tertiary mb-6">
                {errorMessage ?? 'Your payment succeeded - subscription is syncing.'}
              </p>
              <button
                onClick={() => router.replace('/dashboard')}
                className="w-full py-3 bg-amber-500 text-zinc-900 font-semibold rounded-lg hover:bg-amber-400 transition-colors"
              >
                Continue to Site Manager
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
