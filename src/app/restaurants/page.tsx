'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '../../store/authStore';
import { apiFetch } from '../../lib/apiClient';
import { Modal } from '../../components/Modal';
import { clearOnboardingDraft, replaceOnboardingDraft } from '@/lib/onboardingDraft';
import {
  PlusCircle,
  Check,
  ChevronRight,
  Pencil,
  Loader2,
  Store,
  Mail,
  Trash2,
  ExternalLink,
} from 'lucide-react';

type DeleteRestaurantResponse = {
  ok: boolean;
  deletedOrganizationId?: string;
  quantitySynced?: boolean;
  newQuantity?: number | null;
  ownedRestaurantCount?: number;
  subscriptionStatus?: string;
  syncError?: string;
};

type DeleteApiError = {
  error?: string;
  message?: string;
  table?: string;
  column?: string;
  code?: string;
  details?: string;
  hint?: string;
  manageBillingUrl?: string;
  count?: number;
  organizations?: Array<{ id: string; name: string; restaurantCode?: string | null }>;
};

type AccountDeleteResponse = {
  ok: boolean;
  deletedAuthUser: boolean;
};

type OrgSubscriptionEntry = {
  organization_id: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  billing_management_mode?: 'platform' | 'customer' | string;
};

type SubscriptionSnapshot = {
  billingEnabled?: boolean;
  status?: string;
  active?: boolean;
  owned_org_count?: number;
  subscription?: {
    quantity?: number;
    current_period_end?: string | null;
    cancel_at_period_end?: boolean;
    status?: string;
  } | null;
  org_subscriptions?: OrgSubscriptionEntry[];
};

const BILLING_ENABLED = process.env.NEXT_PUBLIC_BILLING_ENABLED === 'true';
const BLOCKING_BILLING_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'incomplete',
  'incomplete_expired',
  'unpaid',
]);

export default function RestaurantSelectPage() {
  const router = useRouter();
  const {
    currentUser,
    isInitialized,
    accessibleRestaurants,
    activeRestaurantId,
    pendingInvitations,
    setActiveOrganization,
    clearActiveOrganization,
    init,
    refreshProfile,
    signOut,
    subscriptionDetails,
  } = useAuthStore();

  const [inviteError, setInviteError] = useState('');
  const [newRestaurantName, setNewRestaurantName] = useState('');
  const [manageError, setManageError] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; restaurantCode: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteErrorDetails, setDeleteErrorDetails] = useState<DeleteApiError | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteToast, setDeleteToast] = useState<{ type: 'success' | 'warning'; message: string } | null>(null);
  const [billingSnapshot, setBillingSnapshot] = useState<SubscriptionSnapshot | null>(null);
  const [accountDeleteModalOpen, setAccountDeleteModalOpen] = useState(false);
  const [accountDeleteConfirm, setAccountDeleteConfirm] = useState('');
  const [accountDeleteError, setAccountDeleteError] = useState('');
  const [accountDeleteErrorDetails, setAccountDeleteErrorDetails] = useState<DeleteApiError | null>(null);
  const [accountDeleteSubmitting, setAccountDeleteSubmitting] = useState(false);
  const [accountDeleteManageBillingUrl, setAccountDeleteManageBillingUrl] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedName, setEditedName] = useState('');

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    clearOnboardingDraft();
  }, []);

  useEffect(() => {
    if (!deleteToast) return;
    const timer = setTimeout(() => {
      setDeleteToast(null);
    }, 3500);
    return () => {
      clearTimeout(timer);
    };
  }, [deleteToast]);

  const refreshBillingSnapshot = useCallback(async (): Promise<SubscriptionSnapshot | null> => {
    const result = await apiFetch<SubscriptionSnapshot>('/api/billing/subscription-status', {
      cache: 'no-store',
    });
    if (result.ok && result.data) {
      setBillingSnapshot(result.data);
      return result.data;
    }
    return null;
  }, []);

  useEffect(() => {
    if (!isInitialized) return;
    const timer = setTimeout(() => {
      void refreshBillingSnapshot();
    }, 0);
    return () => clearTimeout(timer);
  }, [isInitialized, refreshBillingSnapshot]);

  useEffect(() => {
    if (!isInitialized) return;

    // No user -> login
    if (!currentUser) {
      router.push('/login');
      return;
    }

    // DO NOT auto-redirect if:
    // - User has pending invitations (let them see/manage them)
    // - User has multiple restaurants (let them switch)
    // Only auto-redirect for single membership with no pending invitations
    if (
      accessibleRestaurants.length === 1 &&
      pendingInvitations.length === 0 &&
      !activeRestaurantId
    ) {
      const only = accessibleRestaurants[0];
      const onlyRole = String(only.role ?? '').trim().toLowerCase();
      const onlyCanResumeSetup = onlyRole === 'admin' || onlyRole === 'owner' || onlyRole === 'manager';
      if (onlyCanResumeSetup && BILLING_ENABLED && !billingSnapshot) {
        return;
      }
      const onlyHasSubscriptionRecord =
        billingSnapshot?.billingEnabled === false
          ? true
          : Boolean(
              billingSnapshot?.org_subscriptions?.some(
                (subscription) => subscription.organization_id === only.id,
              ),
            );
      if (onlyCanResumeSetup && billingSnapshot && !onlyHasSubscriptionRecord) {
        return;
      }
      setActiveOrganization(only.id, only.restaurantCode);
      if (process.env.NODE_ENV !== 'production') {
         
        console.debug('[restaurants] single membership, no invitations, auto-selecting and redirecting');
      }
      router.push('/dashboard');
    }

    // If activeRestaurantId is already set AND no pending invites AND user navigated here directly,
    // we let them stay (they may want to switch restaurants).
    // The page is now accessible to all authenticated users.
  }, [
    isInitialized,
    currentUser,
    activeRestaurantId,
    accessibleRestaurants,
    billingSnapshot,
    pendingInvitations,
    router,
    setActiveOrganization,
  ]);

  const hasAdminMembership = useMemo(
    () =>
      accessibleRestaurants.some((restaurant) => {
        const value = String(restaurant.role ?? '').trim().toLowerCase();
        return value === 'admin' || value === 'owner';
      }),
    [accessibleRestaurants]
  );
  const normalizedUserRole = String(currentUser?.role ?? '').trim().toUpperCase();
  const canCreateRestaurant = accessibleRestaurants.length === 0 || hasAdminMembership;
  const ownedOrgCount = Math.max(
    0,
    Number(billingSnapshot?.owned_org_count ?? subscriptionDetails?.ownedOrgCount ?? accessibleRestaurants.length),
  );
  const billedQuantity = Math.max(
    0,
    Number(billingSnapshot?.subscription?.quantity ?? subscriptionDetails?.quantity ?? ownedOrgCount),
  );
  const membershipCount = accessibleRestaurants.length;
  const billingStatus = String(billingSnapshot?.status ?? '').trim().toLowerCase();
  const hasRoleDeleteRestriction =
    membershipCount > 0 &&
    !hasAdminMembership &&
    normalizedUserRole !== 'ADMIN';
  const accountDeleteDisabledReason = ownedOrgCount > 0
    ? `Delete all restaurants first (${ownedOrgCount} remaining).`
    : hasRoleDeleteRestriction
      ? 'Only the primary account admin can delete this account.'
      : membershipCount > 0
        ? `Leave organization memberships first (${membershipCount} remaining).`
        : null;
  const billingLikelyBlocksAccountDelete =
    BILLING_ENABLED &&
    !accountDeleteDisabledReason &&
    BLOCKING_BILLING_STATUSES.has(billingStatus);
  const canDeleteAccountNow = !accountDeleteDisabledReason && !accountDeleteSubmitting;

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-theme-primary flex items-center justify-center">
        <p className="text-theme-secondary">Loading...</p>
      </div>
    );
  }

  const isManagerCapableRestaurant = useCallback((restaurant: { role: string }) => {
    const role = String(restaurant.role ?? '').trim().toLowerCase();
    return role === 'admin' || role === 'owner' || role === 'manager';
  }, []);

  const isResumableRestaurantFromSnapshot = useCallback((restaurant: { id: string; role: string }, snapshot: SubscriptionSnapshot | null) => {
    if (!snapshot || snapshot.billingEnabled === false) return false;
    if (!isManagerCapableRestaurant(restaurant)) return false;

    const orgSub = snapshot.org_subscriptions?.find(
      (subscription) => subscription.organization_id === restaurant.id,
    );

    return !orgSub;
  }, [isManagerCapableRestaurant]);

  const isResumableOnboardingRestaurant = useCallback((restaurant: {
    id: string;
    role: string;
  }) => {
    return isResumableRestaurantFromSnapshot(restaurant, billingSnapshot);
  }, [billingSnapshot, isResumableRestaurantFromSnapshot]);

  const isPlatformManagedBilling = useCallback((entry: OrgSubscriptionEntry | null | undefined) => {
    return String(entry?.billing_management_mode ?? '').trim().toLowerCase() === 'platform';
  }, []);

  useEffect(() => {
    if (!activeRestaurantId) return;
    const activeRestaurant = accessibleRestaurants.find((restaurant) => restaurant.id === activeRestaurantId);
    if (!activeRestaurant) return;
    if (!isResumableOnboardingRestaurant(activeRestaurant)) return;
    clearActiveOrganization();
  }, [activeRestaurantId, accessibleRestaurants, clearActiveOrganization, isResumableOnboardingRestaurant]);

  const handleSelectRestaurant = async (restaurantId: string) => {
    const selected = accessibleRestaurants.find((item) => item.id === restaurantId);
    if (!selected) return;

    let snapshot = billingSnapshot;
    if (!snapshot && BILLING_ENABLED && isManagerCapableRestaurant(selected)) {
      snapshot = await refreshBillingSnapshot();
    }

    if (isResumableRestaurantFromSnapshot(selected, snapshot)) {
      replaceOnboardingDraft({
        entryPoint: 'restaurants',
        organizationId: selected.id,
        restaurantCode: selected.restaurantCode,
        ownerName: resolveOwnerDraftName(),
        restaurantName: selected.name,
      });
      router.push('/onboarding');
      return;
    }

    setActiveOrganization(restaurantId, selected.restaurantCode ?? null);
    router.push('/dashboard');
  };

  const handleInviteResponse = async (invitationId: string, action: 'accept' | 'decline') => {
    setInviteError('');
    const result = await apiFetch('/api/auth/invitations/respond', {
      method: 'POST',
      json: { invitationId, action },
    });
    if (!result.ok) {
      setInviteError(result.error || 'Unable to update invitation.');
      return;
    }
    // Refresh profile and invitations from store (updates accessibleRestaurants and pendingInvitations)
    await refreshProfile();
  };

  const handleStartEdit = (id: string, name: string) => {
    setEditingId(id);
    setEditedName(name);
    setManageError('');
  };

  const handleSaveEdit = async (id: string) => {
    if (!editedName.trim()) {
      setManageError('Restaurant name is required.');
      return;
    }
    const result = await apiFetch('/api/organizations/update', {
      method: 'POST',
      json: {
        organizationId: id,
        name: editedName.trim(),
      },
    });
    if (!result.ok) {
      setManageError(result.error || 'Unable to update restaurant.');
      return;
    }
    setEditingId(null);
    setEditedName('');
    await refreshProfile();
  };

  const resolveOwnerDraftName = useCallback(() => {
    const ownerName = String(currentUser?.ownerName ?? currentUser?.fullName ?? '').trim();
    if (ownerName) return ownerName;

    const email = String(currentUser?.email ?? currentUser?.realEmail ?? '').trim();
    if (email) {
      const emailPrefix = email.split('@')[0]?.trim();
      if (emailPrefix) return emailPrefix;
    }

    return '';
  }, [currentUser?.email, currentUser?.fullName, currentUser?.ownerName, currentUser?.realEmail]);

  const handleCreateRestaurant = async () => {
    setManageError('');
    const name = newRestaurantName.trim();
    if (!name) {
      setManageError('Restaurant name is required');
      return;
    }

    setCreateSubmitting(true);
    replaceOnboardingDraft({
      entryPoint: 'restaurants',
      ownerName: resolveOwnerDraftName(),
      restaurantName: name,
    });
    router.push('/onboarding');
  };

  const handleOpenDelete = (restaurant: { id: string; name: string; restaurantCode: string }) => {
    const orgId = String(restaurant.id ?? '').trim();
    if (!orgId) {
      if (process.env.NODE_ENV !== 'production') {
         
        console.log('[restaurants] delete modal skipped (missing org id)', restaurant);
      }
      return;
    }
    if (process.env.NODE_ENV !== 'production') {
       
      console.log('[restaurants] open delete modal', { organizationId: orgId });
    }
    setDeleteTarget({ ...restaurant, id: orgId });
    setDeleteConfirm('');
    setDeleteError('');
    setDeleteErrorDetails(null);
  };

  const handleCloseDelete = () => {
    if (deleteSubmitting) return;
    setDeleteTarget(null);
    setDeleteConfirm('');
    setDeleteError('');
    setDeleteErrorDetails(null);
  };

  const handleDeleteRestaurant = async () => {
    if (!deleteTarget) return;
    const organizationId = String(deleteTarget.id ?? '').trim();
    if (!organizationId) return;
    if (deleteConfirm !== 'DELETE') return;

    setDeleteSubmitting(true);
    setDeleteError('');
    setDeleteErrorDetails(null);

    const result = await apiFetch<DeleteRestaurantResponse | DeleteApiError>(
      `/api/organizations/${organizationId}/delete`,
      {
        method: 'POST',
        json: { confirm: 'DELETE' },
      },
    );

    if (!result.ok) {
      const body = (result.data ?? null) as DeleteApiError | null;
      setDeleteError(
        body?.message ||
        body?.error ||
        result.error ||
        'Unable to delete restaurant.',
      );
      setDeleteErrorDetails(body);
      setDeleteSubmitting(false);
      return;
    }

    if (activeRestaurantId === deleteTarget.id) {
      clearActiveOrganization();
    }
    await refreshProfile();
    await useAuthStore.getState().fetchSubscriptionStatus();
    await refreshBillingSnapshot();
    const remainingRestaurants = useAuthStore.getState().accessibleRestaurants.length;

    const responseData = (result.data ?? {}) as DeleteRestaurantResponse;
    const quantitySynced = responseData.quantitySynced !== false;
    const newQuantity = Math.max(0, Number(responseData.newQuantity ?? 0));

    if (!quantitySynced) {
      setDeleteToast({
        type: 'warning',
        message: 'Restaurant deleted. Billing update is syncing - refresh in a moment.',
      });
    } else if (newQuantity === 0) {
      setDeleteToast({
        type: 'success',
        message: 'Restaurant deleted. Subscription canceled for 0 locations.',
      });
    } else {
      setDeleteToast({
        type: 'success',
        message: `Restaurant deleted. Billing updated to ${newQuantity} location${newQuantity === 1 ? '' : 's'}.`,
      });
    }

    setDeleteSubmitting(false);
    setDeleteTarget(null);
    setDeleteConfirm('');

    if (remainingRestaurants === 0) {
      router.replace('/restaurants');
    }
  };

  const handleDeleteAccount = async () => {
    if (!canDeleteAccountNow || accountDeleteConfirm !== 'DELETE') return;

    setAccountDeleteSubmitting(true);
    setAccountDeleteError('');
    setAccountDeleteErrorDetails(null);
    setAccountDeleteManageBillingUrl(null);

    const result = await apiFetch<AccountDeleteResponse | DeleteApiError>(
      '/api/account/delete',
      {
        method: 'POST',
        json: { confirm: 'DELETE' },
      },
    );

    if (!result.ok) {
      const body = (result.data ?? null) as DeleteApiError | null;
      const mappedErrorMessage =
        body?.error === 'RESTAURANTS_REMAIN'
          ? `Delete all restaurants first (${Number(body.count ?? ownedOrgCount)} remaining).`
          : body?.error === 'SUBSCRIPTION_ACTIVE'
            ? body?.message || 'Subscription is still active. Cancel it in billing, then retry.'
            : body?.error === 'MEMBERSHIPS_REMAIN'
              ? `Leave remaining memberships first (${Number(body.count ?? 0)} remaining).`
              : null;
      setAccountDeleteError(
        mappedErrorMessage ||
        body?.message ||
        body?.error ||
        result.error ||
        'Unable to delete account.',
      );
      setAccountDeleteErrorDetails(body);
      setAccountDeleteManageBillingUrl(body?.manageBillingUrl ?? null);
      setAccountDeleteSubmitting(false);
      if (body?.error === 'RESTAURANTS_REMAIN' || body?.error === 'SUBSCRIPTION_ACTIVE') {
        await refreshBillingSnapshot();
      }
      return;
    }

    setDeleteToast({
      type: 'success',
      message: 'Account deleted.',
    });
    await signOut();
    router.replace('/login?notice=account-deleted');
  };

  const openAccountDeleteModal = () => {
    setAccountDeleteError('');
    setAccountDeleteErrorDetails(null);
    setAccountDeleteManageBillingUrl(null);
    setAccountDeleteConfirm('');
    setAccountDeleteModalOpen(true);
  };

  const nextOwnedCountAfterDelete = deleteTarget ? Math.max(0, ownedOrgCount - 1) : ownedOrgCount;

  return (
    <div className="bg-theme-primary text-theme-primary p-4 sm:p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        {/* Page header */}
        <div className="mb-2">
          <h1 className="text-xl font-semibold">Site Manager</h1>
          <p className="text-theme-muted text-sm">Select a restaurant to manage.</p>
        </div>

        {/* Your Restaurants Card */}
        <div className="bg-theme-secondary border border-theme-primary rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-theme-primary bg-theme-tertiary/50">
            <h2 className="text-sm font-semibold text-theme-primary">Your Restaurants</h2>
          </div>
          {accessibleRestaurants.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-theme-muted text-sm">No restaurant access found.</p>
              <p className="text-theme-muted text-xs mt-1">Accept an invitation or contact your manager.</p>
            </div>
          ) : (
            <div className="divide-y divide-theme-primary">
              {accessibleRestaurants.map((restaurant) => {
                const isResumableSetup = isResumableOnboardingRestaurant(restaurant);
                const isActive = activeRestaurantId === restaurant.id && !isResumableSetup;
                const isManagerForThis = (() => {
                  const role = String(restaurant.role ?? '').trim().toLowerCase();
                  return role === 'admin' || role === 'manager';
                })();
                const isAdminForThis = (() => {
                  const role = String(restaurant.role ?? '').trim().toLowerCase();
                  return role === 'admin';
                })();
                return (
                  <div
                    key={restaurant.id}
                    onClick={() => handleSelectRestaurant(restaurant.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectRestaurant(restaurant.id);
                      }
                    }}
                    className={`group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-amber-500/10'
                        : 'hover:bg-theme-hover'
                    }`}
                  >
                    {/* Icon */}
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                      isActive
                        ? 'bg-amber-500/20 text-amber-500'
                        : 'bg-theme-tertiary text-theme-muted group-hover:text-theme-secondary'
                    }`}>
                      <Store className="w-4 h-4" />
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-theme-primary text-sm truncate">{restaurant.name}</p>
                        {isResumableSetup && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 text-[10px] font-semibold uppercase shrink-0">
                            Resume setup
                          </span>
                        )}
                        {isActive && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500 text-[10px] font-semibold uppercase shrink-0">
                            <Check className="w-2.5 h-2.5" />
                            Active
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-theme-muted">{restaurant.restaurantCode}</p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      {isManagerForThis && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartEdit(restaurant.id, restaurant.name);
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-theme-muted hover:text-theme-primary hover:bg-theme-tertiary transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                          aria-label={`Edit ${restaurant.name}`}
                        >
                          <Pencil className="w-3 h-3" />
                          <span className="hidden sm:inline">Edit</span>
                        </button>
                      )}
                      {isAdminForThis && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenDelete({
                              id: restaurant.id,
                              name: restaurant.name,
                              restaurantCode: restaurant.restaurantCode,
                            });
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-400 hover:bg-red-500/20 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                          aria-label={`Delete ${restaurant.name}`}
                        >
                          <Trash2 className="w-3 h-3" />
                          <span className="hidden sm:inline">Delete</span>
                        </button>
                      )}
                      {!isActive && (
                        <ChevronRight className="w-4 h-4 text-theme-muted group-hover:text-amber-500 transition-colors" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pending Invitations Card */}
        {pendingInvitations.length > 0 && (
          <div className="bg-theme-secondary border border-theme-primary rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-theme-primary bg-theme-tertiary/50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-theme-primary">Pending Invitations</h2>
              <span className="inline-flex items-center justify-center w-5 h-5 bg-emerald-500 text-zinc-900 text-[10px] font-bold rounded-full">
                {pendingInvitations.length}
              </span>
            </div>
            <div className="divide-y divide-theme-primary">
              {pendingInvitations.map((invite) => (
                <div
                  key={invite.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  {/* Icon */}
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/10 text-emerald-500">
                    <Mail className="w-4 h-4" />
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-theme-primary text-sm truncate">{invite.organizationName || 'Restaurant'}</p>
                    <p className="text-xs text-theme-muted">
                      {invite.restaurantCode} · <span className="capitalize">{invite.role}</span>
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleInviteResponse(invite.id, 'accept')}
                      className="px-3 py-1.5 rounded-md bg-emerald-500 text-zinc-900 font-semibold hover:bg-emerald-400 transition-colors text-xs"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => handleInviteResponse(invite.id, 'decline')}
                      className="px-3 py-1.5 rounded-md bg-theme-tertiary text-theme-secondary hover:bg-theme-hover transition-colors text-xs"
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {inviteError && (
              <div className="px-4 py-2 bg-red-500/10 border-t border-red-500/20">
                <p className="text-xs text-red-400">{inviteError}</p>
              </div>
            )}
          </div>
        )}

        {/* Edit Restaurant Card */}
        {editingId && (
          <div className="bg-theme-secondary border border-amber-500/40 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-amber-500/20 bg-amber-500/5">
              <h2 className="text-sm font-semibold text-theme-primary">Edit Restaurant</h2>
            </div>
            <div className="p-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  className="flex-1 px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                      setEditedName('');
                      setManageError('');
                    }}
                    className="px-3 py-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover transition-colors text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSaveEdit(editingId)}
                    className="px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 font-semibold hover:bg-amber-400 transition-colors text-sm"
                  >
                    Save
                  </button>
                </div>
              </div>
              {manageError && <p className="text-xs text-red-400 mt-2">{manageError}</p>}
            </div>
          </div>
        )}

        {/* Create Restaurant Card - ONLY for admin */}
        {canCreateRestaurant && !editingId && (
          <div className="bg-theme-secondary border border-theme-primary rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-theme-primary bg-theme-tertiary/50">
              <h2 className="text-sm font-semibold text-theme-primary">Create Restaurant</h2>
            </div>
            <div className="p-4">
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  value={newRestaurantName}
                  onChange={(e) => setNewRestaurantName(e.target.value)}
                  className="flex-1 px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary text-sm placeholder:text-theme-muted focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50"
                  placeholder="Restaurant name"
                />
                <button
                  onClick={handleCreateRestaurant}
                  disabled={createSubmitting}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 text-zinc-900 font-semibold hover:bg-emerald-400 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <PlusCircle className="w-4 h-4" />
                  {createSubmitting ? 'Continuing...' : 'Create'}
                </button>
              </div>
              {manageError && !editingId && <p className="text-xs text-red-400 mt-2">{manageError}</p>}
            </div>
          </div>
        )}
        {!canCreateRestaurant && !editingId && (
          <div className="bg-theme-secondary border border-theme-primary rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-theme-primary bg-theme-tertiary/50">
              <h2 className="text-sm font-semibold text-theme-primary">Create Restaurant</h2>
            </div>
            <div className="p-4">
              <p className="text-xs text-theme-muted">Only admins can create restaurants.</p>
            </div>
          </div>
        )}

        <div className="bg-theme-secondary border border-red-500/30 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-red-500/20 bg-red-500/5">
            <h2 className="text-sm font-semibold text-red-300">Account</h2>
          </div>
          <div className="p-4 space-y-3">
            <p className="text-xs text-theme-muted">
              Deleting your account is permanent and cannot be undone.
            </p>
            <button
              type="button"
              onClick={openAccountDeleteModal}
              disabled={!canDeleteAccountNow}
              className="px-4 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Delete account
            </button>
            {accountDeleteDisabledReason ? (
              <p className="text-xs text-amber-300">{accountDeleteDisabledReason}</p>
            ) : billingLikelyBlocksAccountDelete ? (
              <div className="space-y-2">
                <p className="text-xs text-amber-300">
                  Manage billing first. Subscription status is currently{' '}
                  <span className="font-semibold">{billingStatus || 'active'}</span>.
                </p>
                <button
                  type="button"
                  onClick={() => router.push('/billing')}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500 text-zinc-900 text-xs font-semibold hover:bg-amber-400 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Manage billing
                </button>
              </div>
            ) : (
              <p className="text-xs text-emerald-300">
                No restaurants remain. You can delete your account now.
              </p>
            )}
          </div>
        </div>
      </div>

      <Modal
        isOpen={Boolean(deleteTarget)}
        onClose={handleCloseDelete}
        title="Delete restaurant?"
        size="md"
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10 p-3">
            <p className="text-sm text-red-800 dark:text-red-300">
              Deleting removes schedules/staff/data and ends access immediately. Cannot be undone.
            </p>
          </div>
          {(() => {
            const orgSub = billingSnapshot?.org_subscriptions?.find(
              (s) => s.organization_id === deleteTarget?.id,
            );
            const isActive = orgSub
              && !isPlatformManagedBilling(orgSub)
              && (orgSub.status === 'active' || orgSub.status === 'trialing');
            if (!isActive) return null;
            return (
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 p-3">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  This will cancel the subscription for{' '}
                  <span className="font-semibold">{deleteTarget?.name}</span>.
                  {' '}You won&apos;t be charged again.
                </p>
              </div>
            );
          })()}
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-theme-muted">
              Type DELETE to confirm
            </label>
            <input
              type="text"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary"
              placeholder="DELETE"
            />
          </div>
          {deleteError && (
            <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10 p-3 space-y-1">
              <p className="text-xs text-red-800 dark:text-red-300">{deleteError}</p>
              {(deleteErrorDetails?.table || deleteErrorDetails?.code || deleteErrorDetails?.details || deleteErrorDetails?.hint) && (
                <div className="space-y-1 text-xs text-red-700 dark:text-red-200/90">
                  {deleteErrorDetails?.table && <p>Table: <span className="font-mono">{deleteErrorDetails.table}</span></p>}
                  {deleteErrorDetails?.code && <p>Code: <span className="font-mono">{deleteErrorDetails.code}</span></p>}
                  {deleteErrorDetails?.details && <p>Details: {deleteErrorDetails.details}</p>}
                  {deleteErrorDetails?.hint && <p>Hint: {deleteErrorDetails.hint}</p>}
                </div>
              )}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCloseDelete}
              className="px-4 py-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDeleteRestaurant}
              disabled={
                deleteSubmitting ||
                !deleteTarget ||
                deleteConfirm !== 'DELETE'
              }
              className="px-4 py-2 rounded-lg bg-red-500 text-white font-semibold hover:bg-red-400 transition-colors disabled:opacity-50"
            >
              {deleteSubmitting ? 'Deleting...' : 'Permanently delete'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={accountDeleteModalOpen}
        onClose={() => {
          if (accountDeleteSubmitting) return;
          setAccountDeleteModalOpen(false);
        }}
        title="Delete Account"
        size="md"
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10 p-3">
            <p className="text-sm text-red-800 dark:text-red-300">
              This permanently deletes your auth account and remaining billing data. This cannot be undone.
            </p>
          </div>
          {ownedOrgCount > 0 ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Delete all restaurants first. {ownedOrgCount} remaining.
            </p>
          ) : accountDeleteDisabledReason ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">{accountDeleteDisabledReason}</p>
          ) : billingLikelyBlocksAccountDelete ? (
            <div className="space-y-2">
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Billing may block deletion while subscription status is {billingStatus || 'active'}.
              </p>
              <button
                type="button"
                onClick={() => router.push('/billing')}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500 text-zinc-900 text-xs font-semibold hover:bg-amber-400 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Manage billing
              </button>
            </div>
          ) : (
            <p className="text-sm text-theme-secondary">
              No restaurants remain. You can now delete your full account.
            </p>
          )}

          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-theme-muted">
              Type DELETE to confirm
            </label>
            <input
              type="text"
              value={accountDeleteConfirm}
              onChange={(e) => setAccountDeleteConfirm(e.target.value)}
              className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary"
              placeholder="DELETE"
            />
          </div>

          {accountDeleteError && (
            <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10 p-3 space-y-2">
              <p className="text-xs text-red-800 dark:text-red-300">{accountDeleteError}</p>
              {(accountDeleteErrorDetails?.table || accountDeleteErrorDetails?.code || accountDeleteErrorDetails?.details || accountDeleteErrorDetails?.hint) && (
                <div className="space-y-1 text-xs text-red-700 dark:text-red-200/90">
                  {accountDeleteErrorDetails?.table && <p>Table: <span className="font-mono">{accountDeleteErrorDetails.table}</span></p>}
                  {accountDeleteErrorDetails?.code && <p>Code: <span className="font-mono">{accountDeleteErrorDetails.code}</span></p>}
                  {accountDeleteErrorDetails?.details && <p>Details: {accountDeleteErrorDetails.details}</p>}
                  {accountDeleteErrorDetails?.hint && <p>Hint: {accountDeleteErrorDetails.hint}</p>}
                </div>
              )}
              {accountDeleteManageBillingUrl && BILLING_ENABLED && (
                <button
                  type="button"
                  onClick={() => {
                    window.open(accountDeleteManageBillingUrl, '_blank');
                  }}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500 text-zinc-900 text-xs font-semibold hover:bg-amber-400 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Manage Billing
                </button>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setAccountDeleteModalOpen(false)}
              className="px-4 py-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDeleteAccount}
              disabled={!canDeleteAccountNow || accountDeleteConfirm !== 'DELETE' || accountDeleteSubmitting}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {accountDeleteSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Permanently delete account
            </button>
          </div>
        </div>
      </Modal>
      {deleteToast && (
        <div className="fixed bottom-4 right-4 z-50 animate-slide-in">
          <div
            className={`flex items-center gap-2 rounded-lg px-4 py-3 shadow-lg border ${
              deleteToast.type === 'success'
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                : 'border-amber-500/40 bg-amber-500/15 text-amber-100'
            }`}
          >
            <span className="text-sm font-medium">{deleteToast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
