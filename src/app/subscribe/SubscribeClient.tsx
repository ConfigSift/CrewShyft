'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { loadStripe } from '@stripe/stripe-js';
import {
  Calendar,
  Check,
  CreditCard,
  Loader2,
  Users,
  CalendarDays,
  ArrowLeftRight,
  Clock,
  BarChart3,
} from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { apiFetch } from '../../lib/apiClient';

const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
const STRIPE_CONNECT_ACCOUNT_ID = String(process.env.NEXT_PUBLIC_STRIPE_ACCOUNT_ID ?? '').trim();
const STRIPE_CONNECT_OPTIONS =
  STRIPE_CONNECT_ACCOUNT_ID && STRIPE_CONNECT_ACCOUNT_ID.startsWith('acct_')
    ? { stripeAccount: STRIPE_CONNECT_ACCOUNT_ID }
    : undefined;
const stripePromise = STRIPE_PUBLISHABLE_KEY
  ? loadStripe(STRIPE_PUBLISHABLE_KEY, STRIPE_CONNECT_OPTIONS)
  : null;

type SubscriptionInfo = {
  active: boolean;
  status: string;
  subscription: {
    stripe_price_id: string | null;
    quantity: number;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
};

type CheckoutSessionResponse = {
  checkoutUrl?: string;
  url?: string;
  sessionId?: string;
  error_code?: string;
  redirect?: string;
};

type RedirectToCheckoutResult = {
  error?: { message?: string };
};

type StripeWithRedirectToCheckout = {
  redirectToCheckout?: (options: { sessionId: string }) => Promise<RedirectToCheckoutResult>;
};

export default function SubscribeClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const canceled = searchParams.get('canceled');
  // Support both ?intentId= (new create flow) and ?intent= (legacy)
  const intentId = String(searchParams.get('intentId') ?? searchParams.get('intent') ?? '').trim() || null;

  const { currentUser, activeRestaurantId, isInitialized, init } = useAuthStore();

  const [loading, setLoading] = useState<'monthly' | 'annual' | null>(null);
  const [error, setError] = useState('');
  const [existingSub, setExistingSub] = useState<SubscriptionInfo | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);
  const [restaurantName, setRestaurantName] = useState<string | null>(null);

  // Initialize auth if needed
  useEffect(() => {
    if (!isInitialized) init();
  }, [isInitialized, init]);

  // Check existing subscription status
  useEffect(() => {
    if (!activeRestaurantId && !intentId) {
      const timer = setTimeout(() => setCheckingStatus(false), 0);
      return () => clearTimeout(timer);
    }

    let mounted = true;
    async function check() {
      const result = await apiFetch<SubscriptionInfo>(
        activeRestaurantId
          ? `/api/billing/subscription-status?organizationId=${activeRestaurantId}`
          : '/api/billing/subscription-status',
      );
      if (!mounted) return;
      if (result.ok && result.data) {
        setExistingSub(result.data);
      }
      setCheckingStatus(false);
    }
    check();
    return () => { mounted = false; };
  }, [activeRestaurantId, intentId]);

  // Fetch restaurant name from pending intent when coming from create-restaurant flow
  useEffect(() => {
    if (!intentId) return;
    let mounted = true;
    async function fetchName() {
      const result = await apiFetch<{ restaurantName: string }>(
        `/api/orgs/intent-name?intentId=${encodeURIComponent(intentId!)}`,
      );
      if (mounted && result.ok && result.data?.restaurantName) {
        setRestaurantName(result.data.restaurantName);
      }
    }
    void fetchName();
    return () => { mounted = false; };
  }, [intentId]);

  // Redirect to restaurants if no org selected
  useEffect(() => {
    if (isInitialized && !activeRestaurantId && currentUser && !intentId) {
      router.push('/restaurants');
    }
  }, [isInitialized, activeRestaurantId, currentUser, router, intentId]);

  const handleCheckout = async (priceType: 'monthly' | 'annual') => {
    if (!activeRestaurantId && !intentId) {
      setError('No restaurant selected. Please go back and select one.');
      return;
    }
    setError('');
    setLoading(priceType);

    const result = await apiFetch<CheckoutSessionResponse>('/api/billing/create-checkout-session', {
      method: 'POST',
      json: {
        organizationId: activeRestaurantId ?? undefined,
        intentId: intentId ?? undefined,
        priceType,
      },
    });

    if (!result.ok) {
      const redirect = (result.data as { redirect?: string } | null)?.redirect;
      if (result.status === 409 && redirect) {
        router.push(redirect);
        setLoading(null);
        return;
      }
      const serverErrorCode = result.code || result.data?.error_code;
      const errorCode = serverErrorCode ? ` (${serverErrorCode})` : '';
      setError((result.error || 'Unable to start checkout. Please try again.') + errorCode);
      setLoading(null);
      return;
    }

    const checkoutUrl = String(result.data?.checkoutUrl ?? result.data?.url ?? '').trim();
    if (checkoutUrl) {
      window.location.assign(checkoutUrl);
      return;
    }

    const sessionId = String(result.data?.sessionId ?? '').trim();
    if (sessionId) {
      if (!stripePromise) {
        setError('Stripe is not configured in this environment.');
        setLoading(null);
        return;
      }
      const stripeClient = await stripePromise;
      if (!stripeClient) {
        setError('Unable to initialize Stripe checkout.');
        setLoading(null);
        return;
      }
      const checkoutClient = stripeClient as unknown as StripeWithRedirectToCheckout;
      if (typeof checkoutClient.redirectToCheckout !== 'function') {
        setError('Stripe checkout redirect is not available in this environment.');
        setLoading(null);
        return;
      }
      const redirectResult = await checkoutClient.redirectToCheckout({ sessionId });
      if (redirectResult.error?.message) {
        setError(redirectResult.error.message);
      } else {
        setError('Unable to redirect to Stripe Checkout.');
      }
      setLoading(null);
      return;
    }

    setError('Unable to start checkout. Missing checkout URL.');
    setLoading(null);
  };

  const handlePortal = async () => {
    if (!activeRestaurantId && !intentId) return;
    setPortalLoading(true);

    const result = await apiFetch<{ url: string }>('/api/billing/create-portal-session', {
      method: 'POST',
      json: { organizationId: activeRestaurantId ?? undefined },
    });

    if (result.ok && result.data?.url) {
      window.location.href = result.data.url;
    } else {
      setError(result.error || 'Unable to open billing portal.');
      setPortalLoading(false);
    }
  };

  // Show spinner while initializing
  if (!isInitialized || checkingStatus) {
    return (
      <div className="min-h-screen bg-theme-primary flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
      </div>
    );
  }

  const isActive = existingSub?.active === true || existingSub?.status === 'active' || existingSub?.status === 'trialing';

  // Already subscribed — show current plan info
  if (isActive && existingSub?.subscription) {
    const sub = existingSub.subscription;
    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      : null;

    return (
      <div className="min-h-screen bg-theme-primary flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <Logo />
            <h1 className="text-2xl font-bold text-theme-primary">Your Subscription</h1>
          </div>

          <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                <Check className="w-5 h-5 text-emerald-500" />
              </div>
              <div>
                <p className="font-semibold text-theme-primary">CrewShyft Pro</p>
                <p className="text-sm text-theme-tertiary">Active</p>
              </div>
            </div>

            <div className="space-y-2 text-sm text-theme-secondary mb-6">
              <p>
                <span className="text-theme-tertiary">Locations:</span>{' '}
                {sub.quantity}
              </p>
              {periodEnd && (
                <p>
                  <span className="text-theme-tertiary">
                    {sub.cancel_at_period_end ? 'Expires:' : 'Next billing:'}
                  </span>{' '}
                  {periodEnd}
                </p>
              )}
              {sub.cancel_at_period_end && (
                <p className="text-amber-500 text-xs mt-2">
                  Your subscription will not renew after the current period.
                </p>
              )}
            </div>

            <button
              onClick={handlePortal}
              disabled={portalLoading}
              className="w-full py-3 bg-amber-500 text-zinc-900 font-semibold rounded-lg hover:bg-amber-400 transition-colors disabled:opacity-50"
            >
              {portalLoading ? 'Opening...' : 'Manage Billing'}
            </button>

            <button
              onClick={() => router.push('/dashboard')}
              className="w-full py-3 mt-3 text-theme-secondary hover:text-theme-primary text-sm transition-colors"
            >
              Back to Dashboard
            </button>
          </div>

          {error && (
            <p className="text-sm text-red-400 text-center mt-4">{error}</p>
          )}
        </div>
      </div>
    );
  }

  // Not subscribed — show pricing
  return (
    <div className="min-h-screen bg-theme-primary flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center p-4 py-12">
        <div className="w-full max-w-2xl">
          {/* Header */}
          <div className="text-center mb-10">
            <Logo />
            <h1 className="text-2xl sm:text-3xl font-bold text-theme-primary">
              {intentId
                ? `Subscribe to activate ${restaurantName ?? 'your restaurant'}`
                : 'Choose your plan'}
            </h1>
            <p className="text-theme-tertiary mt-2">
              {intentId
                ? 'Choose a plan to complete setup for this restaurant.'
                : 'One plan. Everything you need to manage your team.'}
            </p>
          </div>

          {canceled && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-6 text-center">
              <p className="text-sm text-amber-500">
                Checkout was canceled. You can try again when you&#39;re ready.
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-6 text-center">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Pricing cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            {/* Monthly */}
            <div className="relative bg-theme-secondary border border-theme-primary rounded-2xl p-6 shadow-xl flex flex-col">
              <div className="absolute -top-3 left-4">
                <span className="inline-block bg-amber-500 text-zinc-900 text-xs font-bold px-3 py-1 rounded-full">
                  $1 first month
                </span>
              </div>
              <div className="mt-2 mb-4">
                <h2 className="text-lg font-bold text-theme-primary">Monthly</h2>
                <p className="text-theme-tertiary text-sm mt-1">Flexible month-to-month</p>
              </div>
              <div className="mb-6">
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-theme-primary">$19.99</span>
                  <span className="text-theme-tertiary text-sm">/mo</span>
                </div>
                <p className="text-theme-muted text-xs mt-1">per location</p>
              </div>
              <div className="flex-1" />
              <button
                onClick={() => handleCheckout('monthly')}
                disabled={loading !== null}
                className="w-full py-3 bg-amber-500 text-zinc-900 font-semibold rounded-lg hover:bg-amber-400 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading === 'monthly' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CreditCard className="w-4 h-4" />
                )}
                {loading === 'monthly' ? 'Redirecting...' : 'Get Started'}
              </button>
            </div>

            {/* Annual */}
            <div className="relative bg-theme-secondary border-2 border-amber-500/40 rounded-2xl p-6 shadow-xl flex flex-col">
              <div className="absolute -top-3 left-4">
                <span className="inline-block bg-emerald-500 text-white text-xs font-bold px-3 py-1 rounded-full">
                  Save 17%
                </span>
              </div>
              <div className="mt-2 mb-4">
                <h2 className="text-lg font-bold text-theme-primary">Annual</h2>
                <p className="text-theme-tertiary text-sm mt-1">Best value — pay yearly</p>
              </div>
              <div className="mb-6">
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-theme-primary">$199</span>
                  <span className="text-theme-tertiary text-sm">/yr</span>
                </div>
                <p className="text-theme-muted text-xs mt-1">per location</p>
              </div>
              <div className="flex-1" />
              <button
                onClick={() => handleCheckout('annual')}
                disabled={loading !== null}
                className="w-full py-3 bg-amber-500 text-zinc-900 font-semibold rounded-lg hover:bg-amber-400 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading === 'annual' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CreditCard className="w-4 h-4" />
                )}
                {loading === 'annual' ? 'Redirecting...' : 'Get Started'}
              </button>
            </div>
          </div>

          {/* Features list */}
          <div className="mt-10">
            <p className="text-center text-sm font-semibold text-theme-secondary mb-4">
              All plans include
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Feature icon={Users} label="Unlimited staff" />
              <Feature icon={CalendarDays} label="Schedule builder" />
              <Feature icon={ArrowLeftRight} label="Shift exchange" />
              <Feature icon={Clock} label="Time-off management" />
              <Feature icon={BarChart3} label="Reports" />
              <Feature icon={CreditCard} label="Pay tracking" />
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center pb-6 pt-4">
        <p className="text-xs text-theme-muted">
          Questions?{' '}
          <a href="mailto:support@crewshyft.app" className="text-amber-500 hover:underline">
            Contact support
          </a>
        </p>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <div className="flex flex-col items-center mb-4">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mb-4 shadow-lg">
        <Calendar className="w-8 h-8 text-zinc-900" />
      </div>
      <p className="text-xl font-bold text-theme-primary mb-1">CrewShyft</p>
    </div>
  );
}

function Feature({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-theme-secondary">
      <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
        <Icon className="w-3.5 h-3.5 text-amber-500" />
      </div>
      <span>{label}</span>
    </div>
  );
}
