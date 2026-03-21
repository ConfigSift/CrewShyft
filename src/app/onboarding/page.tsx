'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '../../store/authStore';
import { supabase } from '../../lib/supabase/client';
import { TransitionScreen } from '../../components/auth/TransitionScreen';
import { OnboardingBackground } from './OnboardingBackground';
import { OnboardingStepper } from './OnboardingStepper';
import { readStoredPersona } from '@/lib/persona';
import { hasCompletedManagerSetup, resolveNoMembershipDestination, resolveRoutingPersona, shouldRequirePersonaSelection } from '@/lib/authRedirect';
import { hasOnboardingDraftPrefill } from '@/lib/onboardingDraft';

function OnboardingGuard() {
  const router = useRouter();
  const {
    isInitialized,
    init,
    currentUser,
    accessibleRestaurants,
  } = useAuthStore();

  const [isAuthResolved, setIsAuthResolved] = useState(false);
  const [hasAuthSession, setHasAuthSession] = useState(false);
  const [hasOnboardingDraft, setHasOnboardingDraft] = useState(false);

  useEffect(() => {
    if (!isInitialized) init();
  }, [isInitialized, init]);

  useEffect(() => {
    let cancelled = false;
    async function resolveSession() {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setHasAuthSession(Boolean(data.session?.user));
      setHasOnboardingDraft(hasOnboardingDraftPrefill());
      setIsAuthResolved(true);
    }
    resolveSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasManagerMembership = useMemo(() => {
    if (accessibleRestaurants.length === 0) return false;
    return accessibleRestaurants.some((r) => {
      const role = String(r.role ?? '').trim().toLowerCase();
      return role === 'owner' || role === 'admin' || role === 'manager';
    });
  }, [accessibleRestaurants]);

  const persona = useMemo(
    () => resolveRoutingPersona(currentUser?.persona, readStoredPersona()),
    [currentUser?.persona],
  );

  useEffect(() => {
    if (!isInitialized || !isAuthResolved) return;

    if (!hasAuthSession) {
      router.replace('/login');
      return;
    }

    if (accessibleRestaurants.length > 0 && !hasManagerMembership) {
      router.replace('/dashboard');
      return;
    }

    if (accessibleRestaurants.length === 0) {
      if (shouldRequirePersonaSelection(accessibleRestaurants.length, persona)) {
        router.replace('/persona?next=/onboarding');
        return;
      }

      if (
        hasCompletedManagerSetup(currentUser?.role, persona, currentUser?.hasCompletedRestaurantSetup)
        && !hasOnboardingDraft
      ) {
        router.replace('/restaurants');
        return;
      }

      if (persona !== 'manager') {
        router.replace(resolveNoMembershipDestination(currentUser?.role, persona));
      }
    }
  }, [
    currentUser?.hasCompletedRestaurantSetup,
    currentUser?.role,
    hasOnboardingDraft,
    isInitialized,
    isAuthResolved,
    hasAuthSession,
    accessibleRestaurants.length,
    hasManagerMembership,
    persona,
    router,
  ]);

  if (!isInitialized || !isAuthResolved) {
    return <TransitionScreen message="Loading..." />;
  }

  // While redirecting, show transition
  if (
    !hasAuthSession ||
    (accessibleRestaurants.length > 0 && !hasManagerMembership) ||
    (accessibleRestaurants.length === 0 && shouldRequirePersonaSelection(accessibleRestaurants.length, persona)) ||
    (
      accessibleRestaurants.length === 0
      && hasCompletedManagerSetup(currentUser?.role, persona, currentUser?.hasCompletedRestaurantSetup)
      && !hasOnboardingDraft
    ) ||
    (accessibleRestaurants.length === 0 && persona !== 'manager')
  ) {
    return <TransitionScreen message="Redirecting..." />;
  }

  return (
    <OnboardingBackground>
      <OnboardingStepper />
    </OnboardingBackground>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<TransitionScreen message="Loading..." />}>
      <OnboardingGuard />
    </Suspense>
  );
}
