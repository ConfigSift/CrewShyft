'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Briefcase, Check, Users } from 'lucide-react';
import { TransitionScreen } from '@/components/auth/TransitionScreen';
import { apiFetch } from '@/lib/apiClient';
import { AccountPersona, normalizePersona, persistPersona } from '@/lib/persona';
import { resolvePostAuthDestination } from '@/lib/authRedirect';
import { supabase } from '@/lib/supabase/client';
import { useAuthStore } from '@/store/authStore';
import { useUIStore } from '@/store/uiStore';

function getPersonaCardClasses(isSelected: boolean) {
  return [
    'group relative w-full rounded-xl border p-5 text-left cursor-pointer transition-all duration-200 ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-theme-secondary',
    isSelected
      ? 'border-amber-500 bg-amber-500/12 ring-1 ring-inset ring-amber-400/30 shadow-[0_0_0_1px_rgba(245,158,11,0.3),0_18px_40px_-24px_rgba(245,158,11,0.65)]'
      : 'border-theme-primary bg-theme-tertiary/30 opacity-90 hover:opacity-100 hover:-translate-y-[2px] hover:border-amber-400/70 hover:bg-theme-tertiary/55 hover:shadow-[0_14px_30px_-24px_rgba(245,158,11,0.6)]',
  ].join(' ');
}

function PersonaContent() {
  const router = useRouter();
  const { init, isInitialized, accessibleRestaurants, currentUser, refreshProfile } = useAuthStore();
  const { setUiLockedForOnboarding } = useUIStore();

  const [isAuthResolved, setIsAuthResolved] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [selectedPersona, setSelectedPersona] = useState<AccountPersona | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isInitialized) init();
  }, [init, isInitialized]);

  useEffect(() => {
    let cancelled = false;
    async function resolveSession() {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setHasSession(Boolean(data.session?.user));
      setIsAuthResolved(true);
    }
    resolveSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setUiLockedForOnboarding(true);
    return () => {
      setUiLockedForOnboarding(false);
    };
  }, [setUiLockedForOnboarding]);

  const existingPersona = useMemo(
    () => normalizePersona(currentUser?.persona),
    [currentUser?.persona],
  );

  useEffect(() => {
    if (!isAuthResolved || !isInitialized) return;
    if (!hasSession) {
      router.replace('/login');
      return;
    }
    if (existingPersona) {
      router.replace(resolvePostAuthDestination(accessibleRestaurants.length, currentUser?.role, existingPersona));
    }
  }, [accessibleRestaurants.length, currentUser?.role, existingPersona, hasSession, isAuthResolved, isInitialized, router]);

  const handleContinue = async () => {
    if (!selectedPersona) {
      setError('Choose how you plan to use CrewShyft.');
      return;
    }

    setError('');
    setSubmitting(true);
    persistPersona(selectedPersona);

    const result = await apiFetch('/api/me/persona', {
      method: 'POST',
      json: { persona: selectedPersona },
    });

    if (!result.ok) {
      setError('Failed to save your selection. Please try again.');
      setSubmitting(false);
      return;
    }

    await refreshProfile();
    setUiLockedForOnboarding(false);
    router.refresh();
    router.push('/start');
  };

  if (!isInitialized || !isAuthResolved || !hasSession || existingPersona) {
    return <TransitionScreen message="Loading..." />;
  }

  return (
    <div className="min-h-screen bg-theme-primary relative flex items-center justify-center p-4">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 35%, rgba(245,158,11,0.08) 0%, transparent 70%)',
        }}
      />

      <div className="relative w-full max-w-2xl animate-auth-enter">
        <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-6 sm:p-8 shadow-xl">
          <h1 className="text-2xl font-bold text-theme-primary text-center">How will you use CrewShyft?</h1>
          <p className="text-sm text-theme-tertiary text-center mt-2 mb-6">
            This helps personalize your starting experience.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setSelectedPersona('manager')}
              aria-pressed={selectedPersona === 'manager'}
              className={getPersonaCardClasses(selectedPersona === 'manager')}
            >
              <div className="w-11 h-11 rounded-xl bg-amber-500/15 flex items-center justify-center mb-3">
                <Briefcase className="w-5 h-5 text-amber-500" />
              </div>
              <p className="text-base font-semibold text-theme-primary">I&apos;m an Owner/Manager</p>
              <p className="text-xs text-theme-tertiary mt-1">Set up restaurants and run schedules.</p>
            </button>

            <button
              type="button"
              onClick={() => setSelectedPersona('employee')}
              aria-pressed={selectedPersona === 'employee'}
              className={getPersonaCardClasses(selectedPersona === 'employee')}
            >
              <div className="w-11 h-11 rounded-xl bg-amber-500/15 flex items-center justify-center mb-3">
                <Users className="w-5 h-5 text-amber-500" />
              </div>
              <p className="text-base font-semibold text-theme-primary">I&apos;m an Employee</p>
              <p className="text-xs text-theme-tertiary mt-1">View schedules and manage availability.</p>
            </button>
          </div>

          {error && <p className="mt-4 text-sm text-red-400 text-center">{error}</p>}

          <button
            type="button"
            onClick={handleContinue}
            disabled={submitting || !selectedPersona}
            className="mt-6 w-full py-3 rounded-lg bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          >
            {submitting ? 'Saving...' : 'Continue'}
            {!submitting && <Check className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PersonaPage() {
  return (
    <Suspense fallback={<TransitionScreen message="Loading..." />}>
      <PersonaContent />
    </Suspense>
  );
}
