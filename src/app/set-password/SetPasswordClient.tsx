'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Calendar, Loader2, Lock } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';

type SetPasswordClientProps = {
  inviteRequired: boolean;
};

const DEFAULT_LANDING_PATH = '/dashboard';

function toSafeNext(candidate: string | null) {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return DEFAULT_LANDING_PATH;
  }
  if (/http/i.test(candidate) || candidate.startsWith('/set-password')) {
    return DEFAULT_LANDING_PATH;
  }
  return candidate;
}

export default function SetPasswordClient({ inviteRequired }: SetPasswordClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [navigating, setNavigating] = useState(false);

  const nextPath = useMemo(() => toSafeNext(searchParams.get('next')), [searchParams]);
  const isValidPassword = useMemo(() => password.trim().length >= 6, [password]);
  const passwordsMatch = password === confirmPassword;

  useEffect(() => {
    let isMounted = true;

    if (!inviteRequired) {
      setError('This invite session is not active. Open your invite email and try again.');
      setReady(false);
      setCheckingSession(false);
      return () => {
        isMounted = false;
      };
    }

    const loadUser = async () => {
      const { data, error: userError } = await supabase.auth.getUser();

      if (!isMounted) {
        return;
      }

      if (userError || !data.user) {
        setError('Your invite session is invalid or has expired. Request a new invite link.');
        setReady(false);
        setCheckingSession(false);
        return;
      }

      setReady(true);
      setCheckingSession(false);
    };

    void loadUser();

    return () => {
      isMounted = false;
    };
  }, [inviteRequired]);

  const clearInviteCookie = async () => {
    try {
      await fetch('/api/auth/invite/clear', {
        method: 'POST',
      });
    } catch {
      // Best effort: password setup should still complete if cookie cleanup fails.
    }
  };

  const handleCancel = async () => {
    setNavigating(true);

    try {
      await supabase.auth.signOut();
    } catch {
      // Best effort: the invite session may already be invalid.
    }

    await clearInviteCookie();
    router.replace('/login');
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    if (!isValidPassword) {
      setError('Password must be at least 6 characters.');
      return;
    }

    if (!passwordsMatch) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: password.trim(),
      });

      if (updateError) {
        setError(updateError.message || 'Unable to update your password.');
        return;
      }

      await clearInviteCookie();
      router.replace(nextPath);
    } catch {
      setError('Unable to update your password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-theme-primary relative flex items-center justify-center p-4">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 40%, rgba(245,158,11,0.06) 0%, transparent 70%)',
        }}
      />

      <div className="relative w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Calendar className="w-8 h-8 text-zinc-900" />
          </div>
          <h1 className="text-2xl font-bold text-theme-primary">CrewShyft</h1>
          <p className="text-theme-tertiary mt-1">Create your password</p>
        </div>

        <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-6 shadow-xl">
          {checkingSession && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-theme-tertiary">
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying your invite session...
            </div>
          )}

          {!checkingSession && !ready && (
            <div className="space-y-4">
              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}
              <button
                type="button"
                onClick={handleCancel}
                disabled={navigating}
                className="block w-full rounded-lg bg-theme-tertiary px-4 py-3 text-center text-sm font-medium text-theme-secondary transition-colors hover:bg-theme-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {navigating ? 'Returning to login...' : 'Back to login'}
              </button>
            </div>
          )}

          {ready && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-theme-secondary mb-1.5">
                  New password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-theme-muted" />
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="w-full rounded-lg border border-theme-primary bg-theme-tertiary py-3 pl-10 pr-4 text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                    placeholder="Create a password"
                    autoComplete="new-password"
                    required
                  />
                </div>
                {!isValidPassword && password.length > 0 && (
                  <p className="mt-1 text-xs text-red-400">Password must be at least 6 characters.</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-theme-secondary mb-1.5">
                  Confirm password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-theme-muted" />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    className="w-full rounded-lg border border-theme-primary bg-theme-tertiary py-3 pl-10 pr-4 text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                    placeholder="Confirm your password"
                    autoComplete="new-password"
                    required
                  />
                </div>
                {!passwordsMatch && confirmPassword.length > 0 && (
                  <p className="mt-1 text-xs text-red-400">Passwords do not match.</p>
                )}
              </div>

              {error && <p className="text-sm text-red-400 text-center">{error}</p>}

              <button
                type="submit"
                disabled={loading || navigating}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-3 font-semibold text-zinc-900 transition-all hover:bg-amber-400 hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? 'Saving password...' : 'Set password'}
              </button>

              <button
                type="button"
                onClick={handleCancel}
                disabled={loading || navigating}
                className="block w-full rounded-lg bg-theme-tertiary px-4 py-3 text-center text-sm font-medium text-theme-secondary transition-colors hover:bg-theme-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {navigating ? 'Returning to login...' : 'Cancel'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
