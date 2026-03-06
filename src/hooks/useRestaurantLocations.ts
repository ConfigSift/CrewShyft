'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { useAuthStore } from '@/store/authStore';
import { useScheduleStore } from '@/store/scheduleStore';
import type { Location } from '@/types';

type LocationRow = {
  id: string;
  organization_id: string;
  name: string;
  sort_order: number | null;
  created_at: string | null;
};

export type RestaurantLocation = {
  id: string;
  restaurantId: string;
  name: string;
  sortOrder: number;
  createdAt: string;
};

export type RestaurantLocationOption = {
  id: string;
  name: string;
  label: string;
};

type AddLocationInput = {
  name: string;
  restaurantId?: string | null;
};

function mapLocationRow(row: LocationRow): RestaurantLocation {
  return {
    id: String(row.id ?? ''),
    restaurantId: String(row.organization_id ?? ''),
    name: String(row.name ?? '').trim(),
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at ?? ''),
  };
}

function toScheduleLocation(location: RestaurantLocation): Location {
  return {
    id: location.id,
    organizationId: location.restaurantId,
    name: location.name,
    sortOrder: location.sortOrder,
    createdAt: location.createdAt,
  };
}

function sortLocations(locations: RestaurantLocation[]): RestaurantLocation[] {
  return [...locations].sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    if (nameCompare !== 0) return nameCompare;
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    return left.id.localeCompare(right.id);
  });
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }
  return fallback;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ message: String(value ?? 'Unknown error') }, null, 2);
  }
}

function logLocationError(label: string, error: unknown) {
  if (process.env.NODE_ENV !== 'production') {
    console.error(label, safeStringify(error));
  }
}

function syncActiveRestaurantLocations(restaurantId: string, locations: RestaurantLocation[]) {
  if (useAuthStore.getState().activeRestaurantId !== restaurantId) {
    return;
  }
  useScheduleStore.getState().setLocations(locations.map(toScheduleLocation));
}

export function useRestaurantLocations(restaurantId: string | null | undefined) {
  const queryClient = useQueryClient();
  const scopedRestaurantId = String(restaurantId ?? '').trim();
  const queryKey = ['restaurantLocations', scopedRestaurantId] as const;

  const setCachedLocations = (updater: (current: RestaurantLocation[]) => RestaurantLocation[]) => {
    queryClient.setQueryData<RestaurantLocation[]>(queryKey, (current) => {
      const next = sortLocations(updater(current ?? []));
      syncActiveRestaurantLocations(scopedRestaurantId, next);
      return next;
    });
  };

  const query = useQuery<RestaurantLocation[]>({
    queryKey,
    enabled: scopedRestaurantId.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const result = await supabase
        .from('locations')
        .select('id,organization_id,name,sort_order,created_at')
        .eq('organization_id', scopedRestaurantId)
        .order('name', { ascending: true });

      if (result.error) {
        logLocationError('Load locations failed', result.error);
        throw new Error(getErrorMessage(result.error, 'Unable to load locations.'));
      }

      const mapped = sortLocations(
        ((result.data ?? []) as LocationRow[])
          .map(mapLocationRow)
          .filter((location) => location.id.length > 0 && location.name.length > 0),
      );
      syncActiveRestaurantLocations(scopedRestaurantId, mapped);
      return mapped;
    },
  });

  const addMutation = useMutation({
    mutationFn: async (input: AddLocationInput) => {
      const name = String(input.name ?? '').trim();
      const inputRestaurantId = String(input.restaurantId ?? scopedRestaurantId).trim();
      if (!scopedRestaurantId) {
        throw new Error('Missing restaurant id.');
      }
      if (!inputRestaurantId || inputRestaurantId !== scopedRestaurantId) {
        throw new Error('Invalid restaurant id.');
      }
      if (!name) {
        throw new Error('Location name is required.');
      }

      const cached = queryClient.getQueryData<RestaurantLocation[]>(queryKey) ?? [];
      const nextSortOrder = cached.length > 0
        ? Math.max(...cached.map((location) => Number(location.sortOrder ?? 0))) + 1
        : 0;

      const insertResult = await supabase
        .from('locations')
        .insert({
          organization_id: scopedRestaurantId,
          name,
          sort_order: nextSortOrder,
        })
        .select('id,organization_id,name,sort_order,created_at')
        .maybeSingle();

      const failure =
        insertResult.error
        ?? (!insertResult.data
          ? {
              message: 'Insert returned no rows.',
              operation: 'locations.insert',
              organization_id: scopedRestaurantId,
              name,
            }
          : null);

      if (failure) {
        logLocationError('Add location failed', failure);
        throw new Error(getErrorMessage(failure, 'Unable to add location.'));
      }

      return mapLocationRow(insertResult.data as LocationRow);
    },
    onSuccess: (inserted) => {
      setCachedLocations((current) => [
        ...current.filter((location) => location.id !== inserted.id),
        inserted,
      ]);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (locationId: string) => {
      const id = String(locationId ?? '').trim();
      if (!scopedRestaurantId) {
        throw new Error('Missing restaurant id.');
      }
      if (!id) {
        throw new Error('Location id is required.');
      }

      const deleteResult = await supabase
        .from('locations')
        .delete()
        .eq('id', id)
        .eq('organization_id', scopedRestaurantId)
        .select('id,organization_id,name,sort_order,created_at')
        .maybeSingle();

      const failure =
        deleteResult.error
        ?? (!deleteResult.data
          ? {
              message: 'Delete returned no rows.',
              operation: 'locations.delete',
              id,
              organization_id: scopedRestaurantId,
            }
          : null);

      if (failure) {
        logLocationError('Delete location failed', failure);
        throw new Error(getErrorMessage(failure, 'Unable to remove location.'));
      }

      return String((deleteResult.data as LocationRow).id ?? id);
    },
    onSuccess: (deletedId) => {
      setCachedLocations((current) => current.filter((location) => location.id !== deletedId));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const options = useMemo<RestaurantLocationOption[]>(
    () =>
      (query.data ?? []).map((location) => ({
        id: location.id,
        name: location.name,
        label: location.name,
      })),
    [query.data],
  );

  return {
    locations: query.data ?? [],
    options,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    addLocation: addMutation.mutateAsync,
    deleteLocation: deleteMutation.mutateAsync,
    isAdding: addMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}
