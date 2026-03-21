'use client';

import { create } from 'zustand';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase/client';
import { UserProfile } from '../types';
import { clearStorage, loadFromStorage, saveToStorage, STORAGE_KEYS } from '../utils/storage';
import { getUserRole } from '../utils/role';
import { normalizeUserRow } from '../utils/userMapper';
import { apiFetch } from '../lib/apiClient';
import { normalizePersona, readStoredPersona } from '@/lib/persona';

interface PendingInvitation {
  id: string;
  organizationId: string;
  organizationName: string;
  restaurantCode: string;
  email: string;
  role: string;
  status: string;
}

type InvitationsResponse = {
  invitations?: Array<Record<string, unknown>>;
};

type RestaurantsResponse = {
  restaurants?: Array<Record<string, unknown>>;
};

type SubscriptionStatus = 'loading' | 'active' | 'past_due' | 'canceled' | 'none';

interface SubscriptionDetails {
  planInterval: 'monthly' | 'annual' | 'unknown';
  quantity: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  ownedOrgCount: number;
  requiredQuantity: number;
  overLimit: boolean;
  status: string;
}

type AccessibleRestaurant = { id: string; name: string; restaurantCode: string; role: string };
type AccountProfileType = 'owner' | 'employee';
type AccountProfileState = {
  accountType: AccountProfileType;
  ownerName: string | null;
};

const BILLING_ENABLED = process.env.NEXT_PUBLIC_BILLING_ENABLED === 'true';
const IS_DEV = process.env.NODE_ENV !== 'production';

function devAuthLog(event: string, payload?: Record<string, unknown>) {
  if (!IS_DEV) return;
   
  console.debug(`[authStore] ${event}`, payload ?? {});
}

function normalizeAccountType(value: unknown): AccountProfileType {
  return String(value ?? '').trim().toLowerCase() === 'employee' ? 'employee' : 'owner';
}

function normalizeOwnerName(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function buildDisplayName({
  accountType,
  ownerName,
  fullName,
  firstName,
  lastName,
  email,
}: {
  accountType: AccountProfileType;
  ownerName?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}) {
  const preferredOwnerName = accountType === 'owner' ? normalizeOwnerName(ownerName) : null;
  if (preferredOwnerName) return preferredOwnerName;

  const normalizedFullName = String(fullName ?? '').trim();
  if (normalizedFullName) return normalizedFullName;

  const combined = `${String(firstName ?? '').trim()} ${String(lastName ?? '').trim()}`.trim();
  if (combined) return combined;

  const normalizedEmail = String(email ?? '').trim();
  return normalizedEmail || 'CrewShyft User';
}

interface AuthState {
  currentUser: UserProfile | null;
  userProfiles: UserProfile[];
  accessibleRestaurants: Array<{ id: string; name: string; restaurantCode: string; role: string }>;
  pendingInvitations: PendingInvitation[];
  isInitialized: boolean;
  activeRestaurantId: string | null;
  activeRestaurantCode: string | null;

  // Billing
  subscriptionStatus: SubscriptionStatus;
  subscriptionDetails: SubscriptionDetails | null;

  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  setActiveOrganization: (organizationId: string | null, restaurantCode?: string | null) => void;
  clearActiveOrganization: () => void;
  refreshProfile: () => Promise<void>;
  refreshInvitations: () => Promise<void>;
  fetchSubscriptionStatus: (organizationId?: string | null) => Promise<void>;
  updateProfile: (data: { fullName: string; phone?: string | null; email?: string | null }) => Promise<{ success: boolean; error?: string; emailPending?: boolean }>;
}

/** Fetches pending invitations for the current user */
async function fetchPendingInvitations(): Promise<PendingInvitation[]> {
  const result = await apiFetch<InvitationsResponse>('/api/auth/invitations');
  if (!result.ok) return [];
  const rows = Array.isArray(result.data?.invitations) ? result.data.invitations : [];
  return rows.map((invite: Record<string, unknown>) => ({
    id: String(invite.id),
    organizationId: String(invite.organization_id ?? invite.organizationId ?? ''),
    organizationName: String(invite.organization_name ?? invite.organizationName ?? ''),
    restaurantCode: String(invite.restaurant_code ?? invite.restaurantCode ?? ''),
    email: String(invite.email ?? ''),
    role: String(invite.role ?? 'employee'),
    status: String(invite.status ?? 'pending'),
  }));
}

async function fetchUserProfiles(authUserId: string) {
  const { data, error } = (await supabase
    .from('users')
    .select('*')
    .eq('auth_user_id', authUserId)) as {
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  };

  if (error) {
    throw error;
  }

  const profiles: UserProfile[] = (data || []).map((row) => {
    const normalized = normalizeUserRow(row);
    return {
      id: normalized.id,
      authUserId: normalized.authUserId ?? '',
      organizationId: normalized.organizationId,
      email: normalized.email,
      phone: normalized.phone,
      fullName: normalized.fullName,
      role: normalized.role,
      jobs: normalized.jobs,
      hourlyPay: normalized.hourlyPay,
      jobPay: normalized.jobPay,
      employeeNumber: normalized.employeeNumber ?? null,
      realEmail: normalized.realEmail ?? null,
      persona: normalized.persona,
    };
  });

  return profiles;
}

async function fetchAccountProfile(authUserId: string): Promise<AccountProfileState> {
  const { data, error } = (await supabase
    .from('account_profiles')
    .select('account_type, owner_name')
    .eq('auth_user_id', authUserId)
    .maybeSingle()) as {
      data: { account_type?: string | null; owner_name?: string | null } | null;
      error: { message: string } | null;
    };

  if (error) {
    devAuthLog('accountProfile:error', { authUserId, message: error.message });
    return { accountType: 'owner', ownerName: null };
  }

  return {
    accountType: normalizeAccountType(data?.account_type),
    ownerName: normalizeOwnerName(data?.owner_name),
  };
}

function applyAccountProfileToUserProfile(
  profile: UserProfile,
  accountProfile: AccountProfileState,
) {
  return {
    ...profile,
    accountType: accountProfile.accountType,
    ownerName: accountProfile.ownerName,
    fullName: buildDisplayName({
      accountType: accountProfile.accountType,
      ownerName: accountProfile.ownerName,
      fullName: profile.fullName,
      email: profile.email,
    }),
  };
}

function resolveActiveRestaurantSelection(
  accessibleRestaurants: AccessibleRestaurant[],
  storedActiveId: string | null,
) {
  if (accessibleRestaurants.length === 1) {
    return {
      activeRestaurantId: accessibleRestaurants[0].id,
      activeRestaurantCode: accessibleRestaurants[0].restaurantCode,
    };
  }

  if (accessibleRestaurants.length > 1) {
    const storedIsValid = Boolean(storedActiveId)
      && accessibleRestaurants.some((restaurant) => restaurant.id === storedActiveId);
    if (storedIsValid) {
      return {
        activeRestaurantId: storedActiveId,
        activeRestaurantCode:
          accessibleRestaurants.find((restaurant) => restaurant.id === storedActiveId)?.restaurantCode ?? null,
      };
    }
  }

  return {
    activeRestaurantId: null,
    activeRestaurantCode: null,
  };
}

function buildSessionFallbackProfile(
  authUser: User,
  activeRestaurantId: string | null,
  accountProfile: AccountProfileState = { accountType: 'owner', ownerName: null },
): UserProfile {
  const metadata = (authUser.user_metadata ?? {}) as Record<string, unknown>;
  const metadataRole = metadata.role;
  const persona = normalizePersona(metadata.persona) ?? readStoredPersona() ?? undefined;
  const email = authUser.email ?? null;
  const emailPrefix = email ? email.split('@')[0] : null;
  const fullNameCandidate = String(metadata.full_name ?? metadata.name ?? emailPrefix ?? '').trim();
  const fullName = buildDisplayName({
    accountType: accountProfile.accountType,
    ownerName: accountProfile.ownerName,
    fullName: fullNameCandidate || null,
    firstName: String(metadata.first_name ?? '').trim() || null,
    lastName: String(metadata.last_name ?? '').trim() || null,
    email,
  });

  return {
    id: authUser.id,
    authUserId: authUser.id,
    organizationId: activeRestaurantId ?? '',
    email,
    phone: null,
    fullName,
    role: getUserRole(metadataRole),
    accountType: accountProfile.accountType,
    ownerName: accountProfile.ownerName,
    jobs: [],
    hourlyPay: undefined,
    jobPay: {},
    employeeNumber: null,
    realEmail: email,
    persona,
  };
}

/** Set a short-lived cookie that middleware checks to avoid DB queries */
function setBillingCookie(status: string) {
  if (typeof document === 'undefined') return;
  // 1-hour TTL cookie; middleware uses this as a lightweight signal
  const maxAge = 3600;
  document.cookie = `sf_billing_ok=${status}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

function clearBillingCookie() {
  if (typeof document === 'undefined') return;
  document.cookie = 'sf_billing_ok=; path=/; max-age=0; SameSite=Lax';
}

/** Determine plan interval from Stripe price ID */
function resolvePlanInterval(priceId: string): 'monthly' | 'annual' | 'unknown' {
  const monthlyPriceId = process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_MONTHLY ?? '';
  const annualPriceId = process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_YEARLY ?? '';
  if (monthlyPriceId && priceId === monthlyPriceId) return 'monthly';
  if (annualPriceId && priceId === annualPriceId) return 'annual';
  // Fallback heuristic: price IDs often contain "month" or "year"
  const lower = priceId.toLowerCase();
  if (lower.includes('month')) return 'monthly';
  if (lower.includes('year') || lower.includes('annual')) return 'annual';
  return 'unknown';
}

export const useAuthStore = create<AuthState>((set, get) => ({
  currentUser: null,
  userProfiles: [],
  accessibleRestaurants: [],
  pendingInvitations: [],
  subscriptionStatus: BILLING_ENABLED ? 'loading' : 'active',
  subscriptionDetails: null,
  isInitialized: false,
  activeRestaurantId: loadFromStorage<{ id: string | null; code: string | null }>(
    STORAGE_KEYS.ACTIVE_RESTAURANT,
    { id: null, code: null }
  ).id,
  activeRestaurantCode: loadFromStorage<{ id: string | null; code: string | null }>(
    STORAGE_KEYS.ACTIVE_RESTAURANT,
    { id: null, code: null }
  ).code,

  init: async () => {
    const { data } = await supabase.auth.getSession();
    const sessionUser = data.session?.user ?? null;
    devAuthLog('init:getSession', {
      hasSession: Boolean(sessionUser),
      userId: sessionUser?.id ?? null,
      email: sessionUser?.email ?? null,
    });

    if (!sessionUser) {
      set({
        currentUser: null,
        userProfiles: [],
        pendingInvitations: [],
        isInitialized: true,
        activeRestaurantId: null,
        activeRestaurantCode: null,
      });
      return;
    }

    try {
      // Fetch profiles, restaurants, and invitations in parallel
      const [profiles, restaurantsResult, invitations, accountProfile] = await Promise.all([
        fetchUserProfiles(sessionUser.id),
        apiFetch<RestaurantsResponse | Array<Record<string, unknown>>>('/api/auth/restaurants'),
        fetchPendingInvitations(),
        fetchAccountProfile(sessionUser.id),
      ]);

      const restaurantsPayload = restaurantsResult.ok ? restaurantsResult.data : null;
      const restaurants = Array.isArray(restaurantsPayload)
        ? restaurantsPayload
        : restaurantsPayload?.restaurants ?? [];
      const accessibleRestaurants: AccessibleRestaurant[] = restaurants.map(
        (row: Record<string, unknown>) => ({
          id: String(row.id ?? ''),
          name: String(row.name ?? ''),
          restaurantCode: String(row.restaurant_code ?? ''),
          role: String(row.role ?? ''),
        })
      );
      devAuthLog('init:loadedData', {
        profileCount: profiles.length,
        membershipCount: accessibleRestaurants.length,
        invitationCount: invitations.length,
        accountType: accountProfile.accountType,
        hasOwnerName: Boolean(accountProfile.ownerName),
      });

      const storedActiveId = get().activeRestaurantId;
      const { activeRestaurantId, activeRestaurantCode } = resolveActiveRestaurantSelection(
        accessibleRestaurants,
        storedActiveId,
      );
      const primaryProfile = profiles[0] ?? null;
      if (!primaryProfile) {
        devAuthLog('init:fallbackProfile', {
          reason: 'no-users-row',
          membershipCount: accessibleRestaurants.length,
          activeRestaurantId,
        });
        const fallbackProfile = buildSessionFallbackProfile(
          sessionUser,
          activeRestaurantId,
          accountProfile,
        );
        const activeMembership = accessibleRestaurants.find((row) => row.id === activeRestaurantId);
        set({
          currentUser: {
            ...fallbackProfile,
            role: getUserRole(activeMembership?.role ?? fallbackProfile.role),
          },
          userProfiles: [],
          accessibleRestaurants,
          pendingInvitations: invitations,
          isInitialized: true,
          activeRestaurantId,
          activeRestaurantCode,
        });
        if (activeRestaurantId && activeRestaurantCode) {
          saveToStorage(STORAGE_KEYS.ACTIVE_RESTAURANT, {
            id: activeRestaurantId,
            code: activeRestaurantCode,
          });
          get().fetchSubscriptionStatus(activeRestaurantId);
        }
        return;
      }

      const activeProfile =
        profiles.find((profile) => profile.organizationId === activeRestaurantId) ?? primaryProfile;
      const activeMembership = accessibleRestaurants.find((row) => row.id === activeRestaurantId);
      const resolvedActiveProfile = activeProfile
        ? applyAccountProfileToUserProfile(
            {
              ...activeProfile,
              role: getUserRole(activeMembership?.role ?? activeProfile.role),
            },
            accountProfile,
          )
        : activeProfile;

      set({
        currentUser: resolvedActiveProfile,
        userProfiles: profiles,
        accessibleRestaurants,
        pendingInvitations: invitations,
        isInitialized: true,
        activeRestaurantId,
        activeRestaurantCode,
      });
      devAuthLog('init:stateReady', {
        currentUserId: resolvedActiveProfile?.authUserId ?? null,
        currentUserRole: resolvedActiveProfile?.role ?? null,
        membershipCount: accessibleRestaurants.length,
        activeRestaurantId,
      });

      // Persist valid selection to localStorage
      if (activeRestaurantId && activeRestaurantCode) {
        saveToStorage(STORAGE_KEYS.ACTIVE_RESTAURANT, {
          id: activeRestaurantId,
          code: activeRestaurantCode,
        });
      }

      // Fetch subscription status for the active org
      if (activeRestaurantId) {
        get().fetchSubscriptionStatus(activeRestaurantId);
      }
    } catch (error: unknown) {
      devAuthLog('init:error', {
        message: error instanceof Error ? error.message : String(error),
      });
      const fallbackProfile = buildSessionFallbackProfile(sessionUser, null);
      set({
        currentUser: fallbackProfile,
        userProfiles: [],
        accessibleRestaurants: [],
        pendingInvitations: [],
        isInitialized: true,
        activeRestaurantId: null,
        activeRestaurantCode: null,
      });
    }
  },

  refreshProfile: async () => {
    let authUserId = get().currentUser?.authUserId;
    if (!authUserId) {
      const { data } = await supabase.auth.getSession();
      authUserId = data.session?.user?.id;
    }
    devAuthLog('refreshProfile:start', {
      authUserId: authUserId ?? null,
    });
    if (!authUserId) return;

    // Fetch profiles, restaurants, and invitations in parallel
    const [profiles, restaurantsResult, invitations, accountProfile] = await Promise.all([
      fetchUserProfiles(authUserId),
      apiFetch<RestaurantsResponse | Array<Record<string, unknown>>>('/api/auth/restaurants'),
      fetchPendingInvitations(),
      fetchAccountProfile(authUserId),
    ]);

    const restaurantsPayload = restaurantsResult.ok ? restaurantsResult.data : null;
    const restaurants = Array.isArray(restaurantsPayload)
      ? restaurantsPayload
      : restaurantsPayload?.restaurants ?? [];
    const accessibleRestaurants: AccessibleRestaurant[] = restaurants.map(
      (row: Record<string, unknown>) => ({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        restaurantCode: String(row.restaurant_code ?? ''),
        role: String(row.role ?? ''),
      })
    );
    devAuthLog('refreshProfile:loadedData', {
      profileCount: profiles.length,
      membershipCount: accessibleRestaurants.length,
      invitationCount: invitations.length,
      accountType: accountProfile.accountType,
      hasOwnerName: Boolean(accountProfile.ownerName),
    });

    const storedActiveId = get().activeRestaurantId;
    const { activeRestaurantId, activeRestaurantCode } = resolveActiveRestaurantSelection(
      accessibleRestaurants,
      storedActiveId,
    );

    const primaryProfile = profiles[0] ?? null;
    if (!primaryProfile) {
      const { data } = await supabase.auth.getSession();
      const sessionUser = data.session?.user ?? null;
      if (!sessionUser) return;
      devAuthLog('refreshProfile:fallbackProfile', {
        reason: 'no-users-row',
        membershipCount: accessibleRestaurants.length,
        activeRestaurantId,
      });

      const fallbackProfile = buildSessionFallbackProfile(
        sessionUser,
        activeRestaurantId,
        accountProfile,
      );
      const activeMembership = accessibleRestaurants.find((row) => row.id === activeRestaurantId);
      set({
        currentUser: {
          ...fallbackProfile,
          role: getUserRole(activeMembership?.role ?? fallbackProfile.role),
        },
        userProfiles: [],
        accessibleRestaurants,
        pendingInvitations: invitations,
        activeRestaurantId,
        activeRestaurantCode,
      });

      if (activeRestaurantId && activeRestaurantCode) {
        saveToStorage(STORAGE_KEYS.ACTIVE_RESTAURANT, {
          id: activeRestaurantId,
          code: activeRestaurantCode,
        });
        get().fetchSubscriptionStatus(activeRestaurantId);
      }
      return;
    }

    const activeProfile =
      profiles.find((profile) => profile.organizationId === activeRestaurantId) ?? primaryProfile;
    const activeMembership = accessibleRestaurants.find((row) => row.id === activeRestaurantId);
    const resolvedActiveProfile = activeProfile
      ? applyAccountProfileToUserProfile(
          {
            ...activeProfile,
            role: getUserRole(activeMembership?.role ?? activeProfile.role),
          },
          accountProfile,
        )
      : activeProfile;
    set({
      currentUser: resolvedActiveProfile,
      userProfiles: profiles,
      accessibleRestaurants,
      pendingInvitations: invitations,
      activeRestaurantId,
      activeRestaurantCode,
    });
    devAuthLog('refreshProfile:stateReady', {
      currentUserId: resolvedActiveProfile?.authUserId ?? null,
      currentUserRole: resolvedActiveProfile?.role ?? null,
      membershipCount: accessibleRestaurants.length,
      activeRestaurantId,
    });

    if (activeRestaurantId && activeRestaurantCode) {
      saveToStorage(STORAGE_KEYS.ACTIVE_RESTAURANT, {
        id: activeRestaurantId,
        code: activeRestaurantCode,
      });
    }

    // Refresh subscription status for the active org
    if (activeRestaurantId) {
      get().fetchSubscriptionStatus(activeRestaurantId);
    }
  },

  refreshInvitations: async () => {
    const invitations = await fetchPendingInvitations();
    set({ pendingInvitations: invitations });
  },

  fetchSubscriptionStatus: async (organizationId?: string | null) => {
    // Billing disabled — always active, set cookie for middleware
    if (!BILLING_ENABLED) {
      set({ subscriptionStatus: 'active', subscriptionDetails: null });
      setBillingCookie('active');
      return;
    }

    set({ subscriptionStatus: 'loading' });

    const result = await apiFetch<{
      billingEnabled: boolean;
      active: boolean;
      over_limit?: boolean;
      owned_org_count?: number;
      required_quantity?: number;
      status: string;
      subscription: {
        stripe_price_id: string | null;
        quantity: number;
        current_period_end: string | null;
        cancel_at_period_end: boolean;
      } | null;
      has_per_org_billing?: boolean;
      covered_org_count?: number;
      uncovered_org_count?: number;
      org_subscriptions?: Array<{
        cancel_at_period_end: boolean;
        current_period_end: string | null;
        status: string;
      }>;
    }>(
      organizationId
        ? `/api/billing/subscription-status?organizationId=${organizationId}`
        : '/api/billing/subscription-status',
    );

    if (!result.ok || !result.data) {
      set({ subscriptionStatus: 'none', subscriptionDetails: null });
      clearBillingCookie();
      return;
    }

    const {
      status: rawStatus,
      subscription,
      active: activeByQuantity,
      over_limit: overLimitRaw,
      owned_org_count: ownedOrgCountRaw,
      required_quantity: requiredQuantityRaw,
    } = result.data;
    const overLimit = Boolean(overLimitRaw);
    const ownedOrgCount = Math.max(0, Number(ownedOrgCountRaw ?? 0));
    const requiredQuantity = Math.max(
      1,
      Number(requiredQuantityRaw ?? ownedOrgCount ?? 1),
    );

    // If the API says billing is not enabled, treat as active
    if (!result.data.billingEnabled) {
      set({ subscriptionStatus: 'active', subscriptionDetails: null });
      setBillingCookie('active');
      return;
    }

    const subscriptionStatus: SubscriptionStatus =
      activeByQuantity
        ? 'active'
        : rawStatus === 'past_due'
          ? 'past_due'
          : rawStatus === 'canceled'
            ? 'canceled'
            : 'none';

    // Per-org subscriptions return subscription: null; fall back to org_subscriptions[0].
    const orgSub0 = result.data.org_subscriptions?.[0] ?? null;
    const effectiveCancelAtPeriodEnd =
      subscription?.cancel_at_period_end ?? Boolean(orgSub0?.cancel_at_period_end);
    const effectiveCurrentPeriodEnd =
      subscription?.current_period_end ?? orgSub0?.current_period_end ?? null;

    const subscriptionDetails: SubscriptionDetails | null = subscription
      ? {
          planInterval: subscription.stripe_price_id
            ? resolvePlanInterval(subscription.stripe_price_id)
            : 'unknown',
          quantity: subscription.quantity,
          currentPeriodEnd: effectiveCurrentPeriodEnd,
          cancelAtPeriodEnd: effectiveCancelAtPeriodEnd,
          ownedOrgCount,
          requiredQuantity,
          overLimit,
          status: rawStatus,
        }
      : {
          planInterval: 'unknown',
          quantity: 0,
          currentPeriodEnd: effectiveCurrentPeriodEnd,
          cancelAtPeriodEnd: effectiveCancelAtPeriodEnd,
          ownedOrgCount,
          requiredQuantity,
          overLimit,
          status: rawStatus,
        };

    set({ subscriptionStatus, subscriptionDetails });

    // Set cookie for middleware — use the API's `active` flag which accounts
    // for both legacy bundled and per-org subscription coverage.
    if (activeByQuantity) {
      setBillingCookie('active');
    } else {
      clearBillingCookie();
    }
  },

  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return { error: error.message };
    }

    await get().init();
    return {};
  },

  signOut: async () => {
    devAuthLog('signOut:called');
    await supabase.auth.signOut();
    clearStorage();
    clearBillingCookie();
    set({
      currentUser: null,
      userProfiles: [],
      accessibleRestaurants: [],
      pendingInvitations: [],
      isInitialized: true,
      activeRestaurantId: null,
      activeRestaurantCode: null,
      subscriptionStatus: BILLING_ENABLED ? 'loading' : 'active',
      subscriptionDetails: null,
    });
  },

  setActiveOrganization: (organizationId, restaurantCode = null) => {
    saveToStorage(STORAGE_KEYS.ACTIVE_RESTAURANT, {
      id: organizationId,
      code: restaurantCode ?? null,
    });
    set({ activeRestaurantId: organizationId, activeRestaurantCode: restaurantCode ?? null });
    // Fetch subscription status for newly selected org
    if (organizationId) {
      get().fetchSubscriptionStatus(organizationId);
    }
  },
  clearActiveOrganization: () => {
    saveToStorage(STORAGE_KEYS.ACTIVE_RESTAURANT, {
      id: null,
      code: null,
    });
    set({ activeRestaurantId: null, activeRestaurantCode: null });
  },
  updateProfile: async (data) => {
    const current = get().currentUser;
    if (!current) return { success: false, error: 'No user session.' };
    const normalizedEmail = data.email ? data.email.trim() : '';
    const previousEmail = String(current.email ?? '').trim().toLowerCase();
    const emailChanged =
      normalizedEmail !== '' && normalizedEmail.toLowerCase() !== previousEmail;
    const result = await apiFetch('/api/me/update-profile', {
      method: 'POST',
      json: {
        fullName: data.fullName,
        phone: data.phone ?? '',
        ...(emailChanged ? {} : { email: data.email ?? null }),
      },
    });
    if (!result.ok) {
      return {
        success: false,
        error: result.error || 'Unable to update profile.',
      };
    }
    await get().refreshProfile();
    return { success: true, emailPending: false };
  },
}));
