'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Calendar, Loader2, Lock } from 'lucide-react';
import { supabase } from '@/lib/supabase/client';

type VerifyInviteResponse = {
  ok?: boolean;
  error?: string;
};

function toSafeNext(candidate: string | null) {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return '/set-password';
  }
  if (/http/i.test(candidate)) {
    return '/set-password';
  }
  return candidate;
}

function getInviteErrorMessage(code: string | undefined) {
  if (code === 'missing_token_hash') {
    return 'Invalid invite link. Please open the latest invite email or return to login.';
  }
  if (code === 'otp_invalid_or_expired') {
    return 'This invite link is invalid or has expired. Please request a new invite link.';
  }
  return 'Unable to verify this invite link. Please try again or return to login.';
}

export default function InviteVerifyClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [navigating, setNavigating] = useState(false);

  const inviteParams = useMemo(() => {
    const tokenHash = searchParams.get('token_hash')?.trim() || '';
    const type = searchParams.get('type')?.trim() || 'invite';
    const next = toSafeNext(searchParams.get('next'));

    return {
      tokenHash,
      type,
      next,
      hasTokenHash: Boolean(tokenHash),
      hasInvalidType: Boolean(type) && type !== 'invite',
    };
  }, [searchParams]);

  const handleContinue = async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/auth/invite/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token_hash: inviteParams.tokenHash,
        }),
      });

      const result = (await response.json().catch(() => ({}))) as VerifyInviteResponse;

      if (!response.ok || !result.ok) {
        setError(getInviteErrorMessage(result.error));
        return;
      }

      router.replace(inviteParams.next);
    } catch {
      setError(getInviteErrorMessage(undefined));
    } finally {
      setLoading(false);
    }
  };

  const handleBackToLogin = async () => {
    setNavigating(true);
    setError('');

    try {
      await supabase.auth.signOut();
    } catch {
      // Best effort: the invite session may already be invalid.
    }

    try {
      await fetch('/api/auth/invite/clear', {
        method: 'POST',
      });
    } catch {
      // Best effort: we still want to return the user to login.
    }

    router.replace('/login');
  };

  const showInvalidLinkState = !inviteParams.hasTokenHash || inviteParams.hasInvalidType;

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
          <p className="text-theme-tertiary mt-1">Set up your account</p>
        </div>

        <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-start gap-3 rounded-xl border border-theme-primary bg-theme-tertiary px-4 py-3">
            <div className="mt-0.5 rounded-lg bg-amber-500/10 p-2">
              <Lock className="h-4 w-4 text-amber-400" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-theme-primary">Finish setting up your account</p>
              <p className="text-sm text-theme-tertiary">
                Continue to verify your invite and open the password setup screen.
              </p>
            </div>
          </div>

          {showInvalidLinkState && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
              <p className="text-sm text-red-400">
                Invalid invite link. Please open the latest invite email or return to login.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <button
            type="button"
            onClick={handleContinue}
            disabled={showInvalidLinkState || loading || navigating}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-3 font-semibold text-zinc-900 transition-all hover:bg-amber-400 hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? 'Continuing...' : 'Continue'}
          </button>

          <div className="text-center">
            <button
              type="button"
              onClick={handleBackToLogin}
              disabled={navigating || loading}
              className="text-sm text-amber-400 transition-colors hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {navigating ? 'Returning to login...' : 'Back to login'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
