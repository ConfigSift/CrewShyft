'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, ChevronRight, PlusCircle, Pencil, Trash2 } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { apiFetch } from '../../lib/apiClient';
import { Modal } from '../../components/Modal';
import { supabase } from '@/lib/supabase/client';

const MANAGER_ROLES = new Set(['admin', 'manager']);

function hasManagerMembership(role?: string | null) {
  return MANAGER_ROLES.has(String(role ?? '').trim().toLowerCase());
}

type DeleteRestaurantResponse = {
  ok: boolean;
  quantitySynced?: boolean;
  newQuantity?: number | null;
  ownedRestaurantCount?: number;
  subscriptionStatus?: string;
  syncError?: string;
};

type DeleteRestaurantError = {
  error?: string;
  message?: string;
  table?: string;
  code?: string;
  details?: string;
  hint?: string;
};

type CreateRestaurantResponse = {
  id: string;
  restaurant_code?: string | null;
};

function isDeleteRestaurantResponse(
  value: DeleteRestaurantResponse | DeleteRestaurantError | null | undefined,
): value is DeleteRestaurantResponse {
  return Boolean(value && typeof value === 'object' && 'ok' in value);
}

export default function ManagerClient() {
  const router = useRouter();
  const {
    currentUser,
    init,
    isInitialized,
    activeRestaurantId,
    setActiveOrganization,
    clearActiveOrganization,
    refreshProfile,
    accessibleRestaurants,
  } = useAuthStore();

  const [newRestaurantName, setNewRestaurantName] = useState('');
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; restaurantCode: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteErrorDetails, setDeleteErrorDetails] = useState<DeleteRestaurantError | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteToast, setDeleteToast] = useState<{ type: 'success' | 'warning'; message: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedName, setEditedName] = useState('');

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (!deleteToast) return;
    const timer = setTimeout(() => {
      setDeleteToast(null);
    }, 3500);
    return () => {
      clearTimeout(timer);
    };
  }, [deleteToast]);

  const canManageSite = useMemo(
    () => accessibleRestaurants.some((restaurant) => hasManagerMembership(restaurant.role)),
    [accessibleRestaurants]
  );
  const hasAdminMembership = useMemo(
    () =>
      accessibleRestaurants.some((restaurant) => {
        const value = String(restaurant.role ?? '').trim().toLowerCase();
        return value === 'admin';
      }),
    [accessibleRestaurants]
  );
  const canCreateRestaurant = accessibleRestaurants.length === 0 || hasAdminMembership;

  useEffect(() => {
    if (!isInitialized) return;
    if (!currentUser) {
      router.push('/login');
      return;
    }
    if (!canManageSite) {
      if (accessibleRestaurants.length === 0) {
        router.push('/restaurants');
      } else if (!activeRestaurantId && accessibleRestaurants.length > 1) {
        router.push('/restaurants');
      } else {
        router.push('/dashboard');
      }
    }
  }, [isInitialized, currentUser, canManageSite, activeRestaurantId, accessibleRestaurants, router]);

  if (!isInitialized || !currentUser) {
    return (
      <div className="min-h-screen bg-theme-primary flex items-center justify-center">
        <p className="text-theme-secondary">Loading...</p>
      </div>
    );
  }

  const managerRestaurants = accessibleRestaurants;

  const ensureOwnerAccountProfile = async () => {
    const { data } = await supabase.auth.getSession();
    const sessionUser = data.session?.user ?? null;
    const authUserId =
      currentUser?.authUserId
      || sessionUser?.id
      || null;
    if (!authUserId) return;

    const ownerName =
      String(currentUser?.fullName ?? sessionUser?.user_metadata?.full_name ?? sessionUser?.email ?? '')
        .trim()
      || null;

    await supabase
      .from('account_profiles')
      .upsert(
        {
          auth_user_id: authUserId,
          account_type: 'owner',
          ...(ownerName ? { owner_name: ownerName } : {}),
        },
        { onConflict: 'auth_user_id' },
      );
  };

  const handleSelectRestaurant = (restaurantId: string) => {
    const selected = managerRestaurants.find((item) => item.id === restaurantId);
    setActiveOrganization(restaurantId, selected?.restaurantCode ?? null);
    router.push('/dashboard');
  };

  const handleStartEdit = (id: string, name: string) => {
    setEditingId(id);
    setEditedName(name);
    setError('');
  };

  const handleSaveEdit = async (id: string) => {
    if (!editedName.trim()) {
      setError('Restaurant name is required.');
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
      setError(result.error || 'Unable to update restaurant.');
      return;
    }
    setEditingId(null);
    setEditedName('');
    await refreshProfile();
  };

  const handleCreateRestaurant = async () => {
    setError('');
    const name = newRestaurantName.trim();
    if (!name) {
      setError('Restaurant name is required');
      return;
    }

    const result = await apiFetch<CreateRestaurantResponse>('/api/organizations/create', {
      method: 'POST',
      json: { name },
    });

    if (!result.ok || !result.data?.id) {
      setError(result.error || 'Unable to create restaurant. Try again.');
      return;
    }

    await ensureOwnerAccountProfile();
    await refreshProfile();
    setActiveOrganization(result.data.id, result.data.restaurant_code);
    setNewRestaurantName('');
    router.push('/dashboard');
  };

  const handleOpenDelete = (restaurant: { id: string; name: string; restaurantCode: string }) => {
    const orgId = String(restaurant.id ?? '').trim();
    if (!orgId) {
      if (process.env.NODE_ENV !== 'production') {
         
        console.log('[manager] delete modal skipped (missing org id)', restaurant);
      }
      return;
    }
    if (process.env.NODE_ENV !== 'production') {
       
      console.log('[manager] open delete modal', { organizationId: orgId });
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
    const result = await apiFetch<DeleteRestaurantResponse | DeleteRestaurantError>(
      `/api/organizations/${organizationId}/delete`,
      {
        method: 'POST',
        json: { confirm: 'DELETE' },
      },
    );
    if (!result.ok) {
      const body = (result.data ?? null) as DeleteRestaurantError | null;
      setDeleteError(body?.message || body?.error || result.error || 'Unable to delete restaurant.');
      setDeleteErrorDetails(body ?? null);
      setDeleteSubmitting(false);
      return;
    }
    if (activeRestaurantId === deleteTarget.id) {
      clearActiveOrganization();
    }
    await refreshProfile();
    await useAuthStore.getState().fetchSubscriptionStatus();
    const remainingRestaurants = useAuthStore.getState().accessibleRestaurants.length;
    const successPayload = isDeleteRestaurantResponse(result.data) ? result.data : undefined;
    const quantitySynced = successPayload?.quantitySynced !== false;
    const newQuantity = Number(successPayload?.newQuantity ?? 0);
    if (!quantitySynced) {
      setDeleteToast({
        type: 'warning',
        message: 'Restaurant deleted. Billing update is syncing - refresh in a moment.',
      });
    } else if (Number.isFinite(newQuantity) && newQuantity > 0) {
      setDeleteToast({
        type: 'success',
        message: `Restaurant deleted. Billing updated to ${newQuantity} location${newQuantity === 1 ? '' : 's'}.`,
      });
    } else {
      setDeleteToast({
        type: 'success',
        message: 'Restaurant deleted. Subscription canceled for 0 locations.',
      });
    }
    setDeleteSubmitting(false);
    setDeleteTarget(null);
    if (remainingRestaurants === 0) {
      router.replace('/restaurants');
    }
  };

  return (
    <div className="min-h-screen bg-theme-primary p-6">
      <header className="max-w-3xl mx-auto mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-theme-primary">Site Manager</h1>
          <p className="text-theme-tertiary mt-1">
            Choose which restaurant you want to manage.
          </p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto space-y-6">
        <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-5">
          <h2 className="text-lg font-semibold text-theme-primary mb-3">Your Restaurants</h2>

          {managerRestaurants.length === 0 ? (
            <p className="text-sm text-theme-muted">No restaurants yet. Create your first one below.</p>
          ) : (
            <div className="space-y-3">
              {managerRestaurants.map((restaurant) => (
                <div
                  key={restaurant.id}
                  className={`w-full flex items-center justify-between bg-theme-tertiary border rounded-xl p-4 text-left transition-colors ${
                    activeRestaurantId === restaurant.id
                      ? 'border-amber-500/60 bg-amber-500/10'
                      : 'border-theme-primary hover:bg-theme-hover'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectRestaurant(restaurant.id)}
                    className="flex items-center gap-3 text-left flex-1"
                  >
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center">
                      <Building2 className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                      <p className="text-theme-primary font-medium">{restaurant.name}</p>
                      <p className="text-xs text-theme-muted">Restaurant ID: {restaurant.restaurantCode}</p>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 text-xs text-theme-muted">
                    {canManageSite && (
                      <button
                        type="button"
                        onClick={() => handleStartEdit(restaurant.id, restaurant.name)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-theme-primary bg-theme-secondary text-theme-secondary hover:bg-theme-hover transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        Edit
                      </button>
                    )}
                    {String(restaurant.role ?? '').trim().toLowerCase() === 'admin' && (
                      <button
                        type="button"
                        onClick={() =>
                          handleOpenDelete({
                            id: restaurant.id,
                            name: restaurant.name,
                            restaurantCode: restaurant.restaurantCode,
                          })
                        }
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                    )}
                    <span className="inline-flex items-center gap-1">
                      {activeRestaurantId === restaurant.id ? 'Active' : 'Select'}
                      <ChevronRight className="w-4 h-4" />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {editingId && (
          <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-5">
            <h2 className="text-lg font-semibold text-theme-primary mb-3">Edit Restaurant</h2>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                className="flex-1 px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setEditedName('');
                  }}
                  className="px-4 py-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveEdit(editingId)}
                  className="px-4 py-2 rounded-lg bg-emerald-500 text-zinc-900 font-semibold hover:bg-emerald-400 transition-colors"
                >
                  Save
                </button>
              </div>
            </div>
            {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
          </div>
        )}

        {canCreateRestaurant && (
          <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-5">
            <h2 className="text-lg font-semibold text-theme-primary mb-3">Create a Restaurant</h2>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={newRestaurantName}
                onChange={(e) => setNewRestaurantName(e.target.value)}
                className="flex-1 px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                placeholder="Restaurant name"
              />
              <button
                onClick={handleCreateRestaurant}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 text-zinc-900 font-semibold hover:bg-emerald-400 transition-all hover:scale-[1.02]"
              >
                <PlusCircle className="w-4 h-4" />
                Create
              </button>
            </div>
            {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
          </div>
        )}
        {!canCreateRestaurant && (
          <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-5">
            <h2 className="text-lg font-semibold text-theme-primary mb-3">Create a Restaurant</h2>
            <p className="text-sm text-theme-muted">Only admins can create restaurants.</p>
          </div>
        )}
      </main>

      <Modal
        isOpen={Boolean(deleteTarget)}
        onClose={handleCloseDelete}
        title="Delete restaurant?"
        size="md"
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
            <p className="text-sm text-red-300">
              Deleting removes schedules/staff/data and ends access immediately. Cannot be undone.
            </p>
          </div>
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
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 space-y-1">
              <p className="text-xs text-red-300">{deleteError}</p>
              {(deleteErrorDetails?.table || deleteErrorDetails?.code || deleteErrorDetails?.details || deleteErrorDetails?.hint) && (
                <div className="space-y-1 text-xs text-red-200/90">
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
