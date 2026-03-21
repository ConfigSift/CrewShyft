'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useAuthStore } from '../store/authStore';
import { CheckCircle } from 'lucide-react';
import { readStoredPersona } from '@/lib/persona';
import { resolvePostAuthDestination, resolveRoutingPersona, shouldRequirePersonaSelection } from '@/lib/authRedirect';

const LandingPage = dynamic(() => import('../components/landing/LandingPage').then(m => ({ default: m.LandingPage })), {
  loading: () => (
    <div className="min-h-screen bg-white dark:bg-zinc-950 flex items-center justify-center">
      <div className="text-center">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-zinc-900" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <p className="text-zinc-500">Loading...</p>
      </div>
    </div>
  ),
});

export default function Home() {
  const router = useRouter();
  const [showDeletedToast, setShowDeletedToast] = useState(false);
  const {
    currentUser,
    isInitialized,
    activeRestaurantId,
    accessibleRestaurants,
    resumableRestaurantIds,
    pendingInvitations,
    init,
  } = useAuthStore();

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('deleted') !== 'true') return;

    const timer = setTimeout(() => setShowDeletedToast(true), 0);
    params.delete('deleted');
    const queryString = params.toString();
    const nextUrl = `${window.location.pathname}${queryString ? `?${queryString}` : ''}`;
    window.history.replaceState({}, '', nextUrl);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    // No user -> show landing page (handled in render)
    if (!currentUser) return;

    const persona = resolveRoutingPersona(currentUser.persona, readStoredPersona());
    const hasResumableManagerRestaurant = resumableRestaurantIds.length > 0;

    if (accessibleRestaurants.length > 0) {
      if (pendingInvitations.length > 0 && !activeRestaurantId) {
        router.push('/restaurants');
        return;
      }

      if (hasResumableManagerRestaurant && !activeRestaurantId) {
        router.push('/restaurants');
        return;
      }

      if (accessibleRestaurants.length === 1 || activeRestaurantId) {
        router.push('/dashboard');
        return;
      }

      router.push('/restaurants');
      return;
    }

    if (shouldRequirePersonaSelection(accessibleRestaurants.length, persona)) {
      router.replace('/persona');
      return;
    }

    if (pendingInvitations.length > 0 && !activeRestaurantId) {
      router.push('/restaurants');
      return;
    }

    router.replace(resolvePostAuthDestination(
      accessibleRestaurants.length,
      currentUser.role,
      persona,
      currentUser.hasCompletedRestaurantSetup,
      hasResumableManagerRestaurant,
      Boolean(activeRestaurantId),
    ));
  }, [isInitialized, currentUser, activeRestaurantId, accessibleRestaurants, resumableRestaurantIds, pendingInvitations, router]);

  // Show landing page while initializing or when not authenticated
  if (!isInitialized || !currentUser) {
    return (
      <>
        {showDeletedToast && (
          <div className="fixed bottom-4 right-4 z-50 animate-slide-in">
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-4 py-3 shadow-lg">
              <CheckCircle className="h-5 w-5 text-emerald-400" />
              <span className="text-sm font-medium text-emerald-200">Account deleted</span>
            </div>
          </div>
        )}
        <LandingPage />
      </>
    );
  }

  // Authenticated user - show loading while redirect happens
  return (
    <div className="min-h-screen bg-theme-primary flex items-center justify-center">
      <div className="text-center">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-zinc-900" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <p className="text-theme-secondary">Loading...</p>
      </div>
    </div>
  );
}
