'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Lock, Mail } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { supabase } from '../../lib/supabase/client';
import { getAuthCallbackUrl, getSiteUrl } from '../../lib/site-url';
import { TransitionScreen } from '../../components/auth/TransitionScreen';
import { readStoredPersona } from '@/lib/persona';
import { resolvePostAuthDestination, resolveRoutingPersona, shouldRequirePersonaSelection } from '@/lib/authRedirect';
import { getAppBase } from '@/lib/routing/getBaseUrls';

type LoginClientProps = {
  notice?: string | null;
  nextPath?: string | null;
};

function getConfirmationRedirectUrl() {
  const next = encodeURIComponent('/login?notice=email-verified');
  return `${getAuthCallbackUrl()}?next=${next}`;
}

function isUnverifiedEmailError(message: string) {
  return /email.*not.*confirm|verify your email|confirm your email/i.test(message);
}

function resolvePersona(value: unknown) {
  return resolveRoutingPersona(value, readStoredPersona());
}

function pathMatchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Navigate to a path on the app domain. Uses window.location for cross-origin
 * transitions (e.g. login.crewshyft.com -> app.crewshyft.com) because
 * router.replace() is a same-origin SPA navigation that never leaves the
 * current host.
 */
function navigateToApp(path: string, router: ReturnType<typeof useRouter>) {
  const appBase = getAppBase(window.location.host);
  const currentOrigin = window.location.origin;
  if (currentOrigin === appBase) {
    router.replace(path);
  } else {
    window.location.href = `${appBase}${path}`;
  }
}

function sanitizeNextPath(candidate?: string | null): string | null {
  const value = String(candidate ?? '').trim();
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  if (/http/i.test(value)) return null;
  const pathname = value.split('?')[0] ?? '/';
  if (
    pathMatchesPrefix(pathname, '/login')
    || pathMatchesPrefix(pathname, '/signup')
    || pathMatchesPrefix(pathname, '/auth')
  ) {
    return null;
  }
  return value;
}

export default function LoginClient({ notice, nextPath }: LoginClientProps) {
  const router = useRouter();
  const { currentUser, accessibleRestaurants, resumableRestaurantIds, activeRestaurantId, init } = useAuthStore();
  const safeNextPath = sanitizeNextPath(nextPath);

  const [email, setEmail] = useState('');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendError, setResendError] = useState('');
  const [resendMessage, setResendMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (!currentUser && accessibleRestaurants.length === 0) return;

    const hasResumableManagerRestaurant = resumableRestaurantIds.length > 0;

    if (hasResumableManagerRestaurant && !activeRestaurantId) {
      navigateToApp('/restaurants', router);
      return;
    }

    // If login was triggered from a protected page, return there after auth.
    if (safeNextPath) {
      navigateToApp(safeNextPath, router);
      return;
    }

    const persona = resolvePersona(currentUser?.persona);
    if (shouldRequirePersonaSelection(accessibleRestaurants.length, persona)) {
      navigateToApp('/persona', router);
      return;
    }

    const destination = resolvePostAuthDestination(
      accessibleRestaurants.length,
      currentUser?.role,
      persona,
      currentUser?.hasCompletedRestaurantSetup,
      hasResumableManagerRestaurant,
      Boolean(activeRestaurantId),
    );
    navigateToApp(destination, router);
  }, [currentUser, accessibleRestaurants, resumableRestaurantIds, activeRestaurantId, router, safeNextPath]);

  const isPasscodeValid = passcode.trim().length >= 6;
  const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSubmit = isPasscodeValid && isEmailValid && !loading;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResendError('');
    setResendMessage('');
    setLoading(true);

    try {
      const loginEmail = email.trim().toLowerCase();

      const authPassword = passcode.trim();
      if (authPassword.length < 6) {
        setError('Enter your password.');
        return;
      }
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: authPassword,
      });

      if (authError) {
        if (isUnverifiedEmailError(authError.message || '')) {
          setError('Please verify your email before signing in. Check your inbox for the confirmation link.');
        } else {
          setError('Invalid login credentials.');
        }
        return;
      }

      await useAuthStore.getState().refreshProfile();
      setTransitioning(true);
      const {
        accessibleRestaurants: refreshedRestaurants,
        resumableRestaurantIds: refreshedResumableRestaurantIds,
        activeRestaurantId: refreshedActiveRestaurantId,
        currentUser: refreshedUser,
      } = useAuthStore.getState();
      const hasResumableManagerRestaurant = refreshedResumableRestaurantIds.length > 0;

      if (hasResumableManagerRestaurant && !refreshedActiveRestaurantId) {
        navigateToApp('/restaurants', router);
        return;
      }

      if (safeNextPath) {
        navigateToApp(safeNextPath, router);
        return;
      }

      const persona = resolvePersona(refreshedUser?.persona);
      if (shouldRequirePersonaSelection(refreshedRestaurants.length, persona)) {
        navigateToApp('/persona', router);
        return;
      }

      if (
        refreshedRestaurants.length === 1
        && !refreshedResumableRestaurantIds.includes(refreshedRestaurants[0].id)
      ) {
        const only = refreshedRestaurants[0];
        useAuthStore.getState().setActiveOrganization(only.id, only.restaurantCode);
      }
      const destination = resolvePostAuthDestination(
        refreshedRestaurants.length,
        refreshedUser?.role,
        persona,
        refreshedUser?.hasCompletedRestaurantSetup,
        hasResumableManagerRestaurant,
        Boolean(refreshedActiveRestaurantId),
      );
      navigateToApp(destination, router);
      return;
    } catch {
      setError('Login failed.');
      setTransitioning(false);
    } finally {
      setLoading(false);
    }
  };

  const handleRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryError('');
    setRecoveryMessage('');
    const targetEmail = recoveryEmail.trim().toLowerCase();
    if (!targetEmail) {
      setRecoveryError('Enter your email to receive a recovery link.');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(targetEmail)) {
      setRecoveryError('Enter a valid email address.');
      return;
    }
    setRecoveryLoading(true);
    try {
      await supabase.auth.resetPasswordForEmail(targetEmail, {
        redirectTo: `${getSiteUrl()}/auth/recovery`,
      });
      setRecoveryMessage('If an account exists, you will receive a recovery email shortly.');
    } catch {
      setRecoveryError('Unable to send recovery email. Please try again.');
    } finally {
      setRecoveryLoading(false);
    }
  };

  const handleResendConfirmation = async () => {
    setResendError('');
    setResendMessage('');
    const targetEmail = email.trim().toLowerCase();
    if (!targetEmail) {
      setResendError('Enter your email first, then resend the confirmation link.');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(targetEmail)) {
      setResendError('Enter a valid email address.');
      return;
    }

    setResendLoading(true);
    try {
      const { error: resendErrorResult } = await supabase.auth.resend({
        type: 'signup',
        email: targetEmail,
        options: {
          emailRedirectTo: getConfirmationRedirectUrl(),
        },
      });

      if (resendErrorResult) {
        setResendError(resendErrorResult.message || 'Unable to resend confirmation email.');
        return;
      }

      setResendMessage('If your account is pending verification, we sent a new confirmation email.');
    } catch {
      setResendError('Unable to resend confirmation email.');
    } finally {
      setResendLoading(false);
    }
  };

  if (transitioning) {
    return <TransitionScreen message="Signing you in..." />;
  }

  return (
    <div className="min-h-screen bg-theme-primary relative flex items-center justify-center p-4">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 40%, rgba(245,158,11,0.06) 0%, transparent 70%)',
        }}
      />
      <div className="pointer-events-none absolute top-0 right-0 w-96 h-96 rounded-full opacity-30 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(245,158,11,0.08) 0%, transparent 70%)' }}
      />

      <div className="relative w-full max-w-md animate-auth-enter">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Calendar className="w-8 h-8 text-zinc-900" />
          </div>
          <h1 className="text-2xl font-bold text-theme-primary">CrewShyft</h1>
          <p className="text-theme-tertiary mt-1">Sign in to continue</p>
        </div>

        <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-6 shadow-xl">
          {notice === 'manager-only' && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4">
              <p className="text-sm text-amber-400">
                Accounts are created by your manager.
              </p>
            </div>
          )}
          {notice === 'setup-disabled' && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4">
              <p className="text-sm text-amber-400">
                Setup is disabled. Contact your administrator.
              </p>
            </div>
          )}
          {notice === 'email-verified' && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 mb-4">
              <p className="text-sm text-emerald-400">
                Email verified. You can sign in now.
              </p>
            </div>
          )}
          {notice === 'account-deleted' && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 mb-4">
              <p className="text-sm text-emerald-400">
                Account deleted successfully.
              </p>
            </div>
          )}
          {notice === 'password-reset' && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 mb-4">
              <p className="text-sm text-emerald-400">
                Password updated. Sign in with your new password.
              </p>
            </div>
          )}
          {notice === 'verification-failed' && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4">
              <p className="text-sm text-red-400">
                Verification link is invalid or expired. Request a new confirmation email below.
              </p>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-theme-secondary mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-theme-muted" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  placeholder="you@restaurant.com"
                  autoFocus
                  required
                />
              </div>
              {!isEmailValid && email.length > 0 && (
                <p className="text-xs text-red-400 mt-1">Enter a valid email.</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-theme-secondary mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-theme-muted" />
                <input
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  placeholder="Enter your password"
                  required
                />
              </div>
              {!isPasscodeValid && passcode.length > 0 && (
                <p className="text-xs text-red-400 mt-1">
                  Password must be at least 6 characters.
                </p>
              )}
            </div>

            {error && <p className="text-sm text-red-400 text-center">{error}</p>}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full py-3 bg-amber-500 text-zinc-900 font-semibold rounded-lg hover:bg-amber-400 transition-all hover:scale-[1.02] disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => {
                setRecoveryOpen((prev) => !prev);
                setRecoveryError('');
                setRecoveryMessage('');
                setRecoveryEmail(email.trim());
              }}
              className="text-xs text-theme-muted hover:text-theme-primary"
            >
              Forgot password?
            </button>
          </div>

          <div className="mt-3 text-center space-y-1">
            <button
              type="button"
              onClick={handleResendConfirmation}
              disabled={resendLoading}
              className="text-xs text-amber-400 hover:text-amber-300 disabled:opacity-60"
            >
              {resendLoading ? 'Sending confirmation...' : 'Resend confirmation email'}
            </button>
            {resendError && <p className="text-xs text-red-400">{resendError}</p>}
            {resendMessage && <p className="text-xs text-emerald-400">{resendMessage}</p>}
          </div>

          <p className="text-xs text-theme-muted text-center mt-3">
            New here?{' '}
            <Link href="/signup?next=/join" className="text-amber-400 hover:text-amber-300">
              Create an account
            </Link>
          </p>

          {recoveryOpen && (
            <div className="mt-4 border-t border-theme-primary pt-4 space-y-3">
              <p className="text-xs text-theme-muted">
                Enter your email and we will send a password reset link.
              </p>
              <form onSubmit={handleRecovery} className="space-y-3">
                <input
                  type="email"
                  value={recoveryEmail}
                  onChange={(e) => setRecoveryEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary"
                  placeholder="you@restaurant.com"
                  required
                />
                {recoveryError && <p className="text-xs text-red-400">{recoveryError}</p>}
                {recoveryMessage && <p className="text-xs text-emerald-400">{recoveryMessage}</p>}
                <button
                  type="submit"
                  disabled={recoveryLoading}
                  className="w-full py-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover transition-colors disabled:opacity-50"
                >
                  {recoveryLoading ? 'Sending...' : 'Send recovery link'}
                </button>
              </form>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
