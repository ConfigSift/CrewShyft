'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useScheduleStore } from '../../store/scheduleStore';
import { useAuthStore } from '../../store/authStore';
import { getUserRole, isManagerRole } from '../../utils/role';
import { apiFetch } from '../../lib/apiClient';
import { ScheduleHourMode } from '../../types';
import { HoursRangeSection, type HourRow } from '../../components/HoursRangeSection';
import { useRestaurantLocations } from '../../hooks/useRestaurantLocations';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';

const readString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
};

const makeRangeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `range-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const buildDefaultRows = () =>
  Array.from({ length: 7 }, (_, day) => ({
    id: makeRangeId(),
    dayOfWeek: day,
    openTime: '09:00',
    closeTime: '17:00',
    enabled: true,
  }));

const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message || fallback : fallback;

export default function BusinessHoursPage() {
  const router = useRouter();
  const {
    businessHours,
    coreHours,
    scheduleViewSettings,
    loadRestaurantData,
    showToast,
    setScheduleViewSettings,
  } = useScheduleStore();
  const { currentUser, isInitialized, activeRestaurantId, init } = useAuthStore();
  const {
    locations: restaurantLocations,
    isLoading: locationsLoading,
    error: locationsError,
    addLocation,
    deleteLocation,
    isAdding: isAddingLocation,
    isDeleting: isDeletingLocation,
  } = useRestaurantLocations(activeRestaurantId);

  const [rows, setRows] = useState<HourRow[]>([]);
  const [coreRows, setCoreRows] = useState<HourRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [savingCore, setSavingCore] = useState(false);
  const [newLocationName, setNewLocationName] = useState('');
  const [locationsMessage, setLocationsMessage] = useState<string | null>(null);
  const [locationActionId, setLocationActionId] = useState<string | null>(null);
  const [locationPendingDelete, setLocationPendingDelete] = useState<{ id: string; name: string } | null>(null);

  // Schedule View Settings state
  const [hourMode, setHourMode] = useState<ScheduleHourMode>('full24');
  const [customStartHour, setCustomStartHour] = useState(6);
  const [customEndHour, setCustomEndHour] = useState(22);
  const [weekStartDay, setWeekStartDay] = useState<'sunday' | 'monday'>('sunday');
  const [savingViewSettings, setSavingViewSettings] = useState(false);
  const [savingWeekStart, setSavingWeekStart] = useState(false);

  const isManager = isManagerRole(getUserRole(currentUser?.role));

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (isInitialized && activeRestaurantId) {
      loadRestaurantData(activeRestaurantId);
    }
  }, [isInitialized, activeRestaurantId, loadRestaurantData]);

  useEffect(() => {
    if (isInitialized && (!currentUser || !isManager)) {
      router.push('/dashboard?notice=forbidden');
    }
  }, [isInitialized, currentUser, isManager, router]);

  useEffect(() => {
    if (businessHours.length === 0) {
      setRows(buildDefaultRows());
      return;
    }
    const mapped = businessHours.map((range) => ({
      id: range.id ?? makeRangeId(),
      dayOfWeek: range.dayOfWeek,
      openTime: range.openTime?.slice(0, 5) ?? '09:00',
      closeTime: range.closeTime?.slice(0, 5) ?? '17:00',
      enabled: range.enabled ?? true,
      sortOrder: range.sortOrder,
    }));
    setRows(mapped);
  }, [businessHours]);

  useEffect(() => {
    if (coreHours.length === 0) {
      setCoreRows(buildDefaultRows());
      return;
    }
    const mapped = coreHours.map((range) => ({
      id: range.id ?? makeRangeId(),
      dayOfWeek: range.dayOfWeek,
      openTime: range.openTime?.slice(0, 5) ?? '09:00',
      closeTime: range.closeTime?.slice(0, 5) ?? '17:00',
      enabled: range.enabled ?? true,
      sortOrder: range.sortOrder,
    }));
    setCoreRows(mapped);
  }, [coreHours]);

  // Load schedule view settings
  useEffect(() => {
    if (scheduleViewSettings) {
      setHourMode(scheduleViewSettings.hourMode);
      setCustomStartHour(scheduleViewSettings.customStartHour);
      setCustomEndHour(scheduleViewSettings.customEndHour);
      setWeekStartDay(scheduleViewSettings.weekStartDay ?? 'sunday');
    } else {
      // Default values
      setHourMode('full24');
      setCustomStartHour(6);
      setCustomEndHour(22);
      setWeekStartDay('sunday');
    }
  }, [scheduleViewSettings]);

  const parseTimeToDecimal = (value: string) => {
    if (!value) return 0;
    const [hours, minutes = '0'] = value.split(':');
    const hour = Number(hours);
    const minute = Number(minutes);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return 0;
    return hour + minute / 60;
  };

  const buildHoursPayload = (ranges: HourRow[]) => {
    const sorted = [...ranges].sort((a, b) => {
      if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
      return parseTimeToDecimal(a.openTime) - parseTimeToDecimal(b.openTime);
    });
    const orderByDay = new Map<number, number>();
    return sorted.map((row) => {
      const order = orderByDay.get(row.dayOfWeek) ?? 0;
      orderByDay.set(row.dayOfWeek, order + 1);
      return {
        id: row.id,
        dayOfWeek: row.dayOfWeek,
        openTime: row.openTime,
        closeTime: row.closeTime,
        enabled: row.enabled,
        sortOrder: order,
      };
    });
  };

  const handleSave = async () => {
    if (!activeRestaurantId) {
      showToast('Select a restaurant first', 'error');
      if (process.env.NODE_ENV !== 'production') {
        console.error('[schedule-settings] save business hours failed', new Error('Missing active restaurant'));
      }
      return;
    }
    const payload = {
      organizationId: activeRestaurantId,
      hours: buildHoursPayload(rows),
    };
    setSaving(true);
    try {
      const result = await apiFetch('/api/business-hours/save', {
        method: 'POST',
        json: payload,
      });

      if (!result.ok) {
        const statusLabel = result.status === 0 ? 'network' : result.status;
        const message = result.error ?? result.rawText?.slice(0, 120) ?? 'Unknown error';
        showToast(`Save failed (${statusLabel}): ${message}`, 'error');
        if (process.env.NODE_ENV !== 'production') {
          let safeData: string;
          try {
            safeData = JSON.stringify(result.data ?? null);
          } catch {
            safeData = '"[unserializable]"';
          }
          const debugPayload = {
            endpoint: '/api/business-hours/save',
            payload,
            status: result.status,
            error: result.error,
            rawText: result.rawText?.slice(0, 500),
            data: safeData,
          };
          console.error('[schedule-settings] save business hours failed', JSON.stringify(debugPayload, null, 2));
        }
        return;
      }

      await loadRestaurantData(activeRestaurantId);
      showToast('Business hours updated', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Save failed (network): ${message || 'Unknown error'}`, 'error');
      if (process.env.NODE_ENV !== 'production') {
        const debugPayload = {
          endpoint: '/api/business-hours/save',
          payload,
          status: 0,
          error: message,
          rawText: undefined,
          data: null,
        };
        console.error('[schedule-settings] save business hours failed', JSON.stringify(debugPayload, null, 2));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCore = async () => {
    if (!activeRestaurantId) {
      showToast('Select a restaurant first', 'error');
      if (process.env.NODE_ENV !== 'production') {
        console.error('[schedule-settings] save core hours failed', new Error('Missing active restaurant'));
      }
      return;
    }
    const payload = {
      organizationId: activeRestaurantId,
      hours: buildHoursPayload(coreRows),
    };
    setSavingCore(true);
    try {
      const result = await apiFetch('/api/core-hours/save', {
        method: 'POST',
        json: payload,
      });

      if (!result.ok) {
        const statusLabel = result.status === 0 ? 'network' : result.status;
        const message = result.error ?? result.rawText?.slice(0, 120) ?? 'Unknown error';
        showToast(`Save failed (${statusLabel}): ${message}`, 'error');
        if (process.env.NODE_ENV !== 'production') {
          let safeData: string;
          try {
            safeData = JSON.stringify(result.data ?? null);
          } catch {
            safeData = '"[unserializable]"';
          }
          const debugPayload = {
            endpoint: '/api/core-hours/save',
            payload,
            status: result.status,
            error: result.error,
            rawText: result.rawText?.slice(0, 500),
            data: safeData,
          };
          console.error('[schedule-settings] save core hours failed', JSON.stringify(debugPayload, null, 2));
        }
        return;
      }

      await loadRestaurantData(activeRestaurantId);
      showToast('Core hours updated', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Save failed (network): ${message || 'Unknown error'}`, 'error');
      if (process.env.NODE_ENV !== 'production') {
        const debugPayload = {
          endpoint: '/api/core-hours/save',
          payload,
          status: 0,
          error: message,
          rawText: undefined,
          data: null,
        };
        console.error('[schedule-settings] save core hours failed', JSON.stringify(debugPayload, null, 2));
      }
    } finally {
      setSavingCore(false);
    }
  };

  const handleSaveViewSettings = async () => {
    if (!activeRestaurantId) {
      showToast('Select a restaurant first', 'error');
      if (process.env.NODE_ENV !== 'production') {
        console.error('[schedule-settings] save view settings failed', new Error('Missing active restaurant'));
      }
      return;
    }

    // Validate custom hours
    if (hourMode === 'custom' && customEndHour <= customStartHour) {
      showToast('End hour must be greater than start hour', 'error');
      return;
    }

    const payload = {
      organizationId: activeRestaurantId,
      hourMode,
      customStartHour,
      customEndHour,
    };
    setSavingViewSettings(true);
    try {
      const result = await apiFetch<{ settings: Record<string, unknown> }>('/api/schedule-view-settings/save', {
        method: 'POST',
        json: payload,
      });

      if (!result.ok) {
        const statusLabel = result.status === 0 ? 'network' : result.status;
        const message = result.error ?? result.rawText?.slice(0, 120) ?? 'Unknown error';
        showToast(`Save failed (${statusLabel}): ${message}`, 'error');
        if (process.env.NODE_ENV !== 'production') {
          let safeData: string;
          try {
            safeData = JSON.stringify(result.data ?? null);
          } catch {
            safeData = '"[unserializable]"';
          }
          const debugPayload = {
            endpoint: '/api/schedule-view-settings/save',
            payload,
            status: result.status,
            error: result.error,
            rawText: result.rawText?.slice(0, 500),
            data: safeData,
          };
          console.error('[schedule-settings] save view settings failed', JSON.stringify(debugPayload, null, 2));
        }
        return;
      }

      // Update the store with new settings
      if (result.data?.settings) {
        const s = result.data.settings;
        setScheduleViewSettings({
          id: readString(s.id),
          organizationId: readString(s.organization_id),
          hourMode: s.hour_mode as ScheduleHourMode,
          customStartHour: Number(s.custom_start_hour ?? 0),
          customEndHour: Number(s.custom_end_hour ?? 24),
          weekStartDay: s.week_start_day === 'monday' ? 'monday' : 'sunday',
        });
      }

      showToast('Schedule view settings updated', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Save failed (network): ${message || 'Unknown error'}`, 'error');
      if (process.env.NODE_ENV !== 'production') {
        const debugPayload = {
          endpoint: '/api/schedule-view-settings/save',
          payload,
          status: 0,
          error: message,
          rawText: undefined,
          data: null,
        };
        console.error('[schedule-settings] save view settings failed', JSON.stringify(debugPayload, null, 2));
      }
    } finally {
      setSavingViewSettings(false);
    }
  };

  const handleSaveWeekStart = async () => {
    if (!activeRestaurantId) {
      showToast('Select a restaurant first', 'error');
      if (process.env.NODE_ENV !== 'production') {
        console.error('[schedule-settings] save week start failed', new Error('Missing active restaurant'));
      }
      return;
    }

    const payload = {
      organizationId: activeRestaurantId,
      weekStartDay,
    };

    setSavingWeekStart(true);
    try {
      const result = await apiFetch<{ settings: Record<string, unknown> }>('/api/schedule-view-settings/save', {
        method: 'POST',
        json: payload,
      });

      if (!result.ok) {
        const statusLabel = result.status === 0 ? 'network' : result.status;
        const message = result.error ?? result.rawText?.slice(0, 120) ?? 'Unknown error';
        showToast(`Save failed (${statusLabel}): ${message}`, 'error');
        if (process.env.NODE_ENV !== 'production') {
          let safeData: string;
          try {
            safeData = JSON.stringify(result.data ?? null);
          } catch {
            safeData = '"[unserializable]"';
          }
          const debugPayload = {
            endpoint: '/api/schedule-view-settings/save',
            payload,
            status: result.status,
            error: result.error,
            rawText: result.rawText?.slice(0, 500),
            data: safeData,
          };
          console.error('[schedule-settings] save week start failed', JSON.stringify(debugPayload, null, 2));
        }
        return;
      }

      if (result.data?.settings) {
        const s = result.data.settings;
        setScheduleViewSettings({
          id: readString(s.id),
          organizationId: readString(s.organization_id),
          hourMode: s.hour_mode as ScheduleHourMode,
          customStartHour: Number(s.custom_start_hour ?? 0),
          customEndHour: Number(s.custom_end_hour ?? 24),
          weekStartDay: s.week_start_day === 'monday' ? 'monday' : 'sunday',
        });
      }

      showToast('Start of week updated', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Save failed (network): ${message || 'Unknown error'}`, 'error');
      if (process.env.NODE_ENV !== 'production') {
        const debugPayload = {
          endpoint: '/api/schedule-view-settings/save',
          payload,
          status: 0,
          error: message,
          rawText: undefined,
          data: null,
        };
        console.error('[schedule-settings] save week start failed', JSON.stringify(debugPayload, null, 2));
      }
    } finally {
      setSavingWeekStart(false);
    }
  };

  const handleAddLocation = async () => {
    if (!activeRestaurantId) {
      const message = 'Select a restaurant to manage locations.';
      setLocationsMessage(message);
      showToast(message, 'error');
      return;
    }
    const trimmedName = newLocationName.trim();
    if (!trimmedName) {
      const message = 'Location name is required.';
      setLocationsMessage(message);
      showToast(message, 'error');
      return;
    }

    try {
      setLocationsMessage(null);
      await addLocation({ name: trimmedName, restaurantId: activeRestaurantId });
      setNewLocationName('');
      showToast('Location added.', 'success');
    } catch (error) {
      const message = getErrorMessage(error, 'Unable to add location.');
      setLocationsMessage(message);
      showToast(message, 'error');
    }
  };

  const handleDeleteLocation = async (locationId: string, locationName: string) => {
    if (!activeRestaurantId) {
      const message = 'Select a restaurant to manage locations.';
      setLocationsMessage(message);
      showToast(message, 'error');
      return;
    }
    setLocationPendingDelete({ id: locationId, name: locationName });
  };

  const handleConfirmDeleteLocation = async () => {
    if (!activeRestaurantId || !locationPendingDelete) {
      return;
    }

    setLocationActionId(locationPendingDelete.id);
    try {
      setLocationsMessage(null);
      await deleteLocation(locationPendingDelete.id);
      showToast('Location removed.', 'success');
      setLocationPendingDelete(null);
    } catch (error) {
      const message = getErrorMessage(error, 'Unable to remove location.');
      setLocationsMessage(message);
      showToast(message, 'error');
    } finally {
      setLocationActionId(null);
    }
  };

  const trimmedNewLocationName = newLocationName.trim();
  const locationGuardMessage = !activeRestaurantId ? 'Select a restaurant to manage locations.' : null;
  const locationLoadMessage = locationsError ? getErrorMessage(locationsError, 'Unable to load locations.') : null;
  const locationInlineMessage = locationGuardMessage ?? locationsMessage ?? locationLoadMessage;
  const canAddLocation = Boolean(activeRestaurantId) && trimmedNewLocationName.length > 0 && !isAddingLocation;

  if (!isInitialized || !currentUser || !isManager) {
    return (
      <div className="min-h-screen bg-theme-primary flex items-center justify-center">
        <p className="text-theme-secondary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-theme-primary p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-theme-primary">Schedule Settings</h1>
          <p className="text-theme-tertiary mt-1">
            Configure business hours and schedule view preferences.
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Schedule View Hours Section */}
          <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-3 space-y-2.5">
            <div>
              <h2 className="text-lg font-semibold text-theme-primary">Schedule View Hours</h2>
              <p className="text-xs text-theme-tertiary mt-0.5">
                Choose which hours to display on the schedule timeline.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="flex items-start gap-2 p-1.5 bg-theme-tertiary border border-theme-primary rounded-lg cursor-pointer hover:bg-theme-hover transition-colors">
                <input
                  type="radio"
                  name="hourMode"
                  value="full24"
                  checked={hourMode === 'full24'}
                  onChange={() => setHourMode('full24')}
                  className="accent-amber-500 mt-0.5"
                />
                <div>
                  <span className="text-sm font-medium text-theme-primary">Full 24 Hours</span>
                  <p className="text-[11px] text-theme-muted leading-tight">00:00-24:00</p>
                </div>
              </label>

              <label className="flex items-start gap-2 p-1.5 bg-theme-tertiary border border-theme-primary rounded-lg cursor-pointer hover:bg-theme-hover transition-colors">
                <input
                  type="radio"
                  name="hourMode"
                  value="business"
                  checked={hourMode === 'business'}
                  onChange={() => setHourMode('business')}
                  className="accent-amber-500 mt-0.5"
                />
                <div>
                  <span className="text-sm font-medium text-theme-primary">Business Hours</span>
                  <p className="text-[11px] text-theme-muted leading-tight">Business hours + 3h padding</p>
                </div>
              </label>

              <label className="flex items-start gap-2 p-1.5 bg-theme-tertiary border border-theme-primary rounded-lg cursor-pointer hover:bg-theme-hover transition-colors">
                <input
                  type="radio"
                  name="hourMode"
                  value="custom"
                  checked={hourMode === 'custom'}
                  onChange={() => setHourMode('custom')}
                  className="accent-amber-500 mt-0.5"
                />
                <div className="flex-1">
                  <span className="text-sm font-medium text-theme-primary">Custom Range</span>
                  <p className="text-[11px] text-theme-muted mb-0.5 leading-tight">Specify a custom hour range</p>
                  {hourMode === 'custom' && (
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-1.5 mt-1">
                      <select
                        value={customStartHour}
                        onChange={(e) => setCustomStartHour(Number(e.target.value))}
                        className="px-2 py-0.5 bg-theme-secondary border border-theme-primary rounded text-theme-primary text-sm"
                      >
                        {Array.from({ length: 24 }, (_, i) => (
                          <option key={i} value={i}>
                            {i === 0 ? '12am' : i < 12 ? `${i}am` : i === 12 ? '12pm' : `${i - 12}pm`}
                          </option>
                        ))}
                      </select>
                      <span className="text-[11px] text-theme-muted text-center">to</span>
                      <select
                        value={customEndHour}
                        onChange={(e) => setCustomEndHour(Number(e.target.value))}
                        className="px-2 py-0.5 bg-theme-secondary border border-theme-primary rounded text-theme-primary text-sm"
                      >
                        {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                          <option key={h} value={h}>
                            {h === 24 ? '12am (next day)' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </label>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveViewSettings}
                disabled={savingViewSettings}
                className="w-full sm:w-auto px-3 py-1.5 rounded-lg bg-amber-500 text-zinc-900 text-sm font-semibold hover:bg-amber-400 transition-colors disabled:opacity-50"
              >
                {savingViewSettings ? 'Saving...' : 'Save View Settings'}
              </button>
            </div>
          </div>

          {/* Start of Week Section */}
          <div className="bg-theme-secondary border border-theme-primary rounded-2xl p-3 space-y-2.5">
            <div>
              <h2 className="text-lg font-semibold text-theme-primary">Start of Week</h2>
              <p className="text-xs text-theme-tertiary mt-0.5">
                Set which day your schedule week begins.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setWeekStartDay('sunday')}
                className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                  weekStartDay === 'sunday'
                    ? 'bg-amber-500/20 text-amber-500 border-amber-500/40'
                    : 'bg-theme-tertiary text-theme-secondary border-theme-primary hover:bg-theme-hover'
                }`}
              >
                Sunday
              </button>
              <button
                type="button"
                onClick={() => setWeekStartDay('monday')}
                className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                  weekStartDay === 'monday'
                    ? 'bg-amber-500/20 text-amber-500 border-amber-500/40'
                    : 'bg-theme-tertiary text-theme-secondary border-theme-primary hover:bg-theme-hover'
                }`}
              >
                Monday
              </button>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveWeekStart}
                disabled={savingWeekStart}
                className="w-full sm:w-auto px-3 py-1.5 rounded-lg bg-amber-500 text-zinc-900 text-sm font-semibold hover:bg-amber-400 transition-colors disabled:opacity-50"
              >
                {savingWeekStart ? 'Saving...' : 'Save Start of Week'}
              </button>
            </div>
          </div>

          <HoursRangeSection
            title="Core Hours"
            description="Define the core coverage window for each day."
            helperText="Used to calculate schedule coverage in the footer."
            rows={coreRows}
            setRows={setCoreRows}
            onSave={handleSaveCore}
            saving={savingCore}
            saveLabel="Save Core Hours"
          />

          <HoursRangeSection
            title="Business Hours"
            description="Configure open hours for each day of the week."
            helperText="Controls the highlighted business-hours region on the schedule."
            rows={rows}
            setRows={setRows}
            onSave={handleSave}
            saving={saving}
            saveLabel="Save Business Hours"
          />

          {/* Locations Section */}
          <div className="rounded-3xl border border-theme-primary bg-theme-secondary p-5 shadow-[0_18px_50px_rgba(0,0,0,0.18)] space-y-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold text-theme-primary">Locations</h2>
              <p className="text-sm text-theme-tertiary">
                Manage the location list used by Add/Edit Shift. Changes appear immediately in the shift form.
              </p>
            </div>

            {locationInlineMessage && (
              <p
                className={`rounded-2xl border px-3 py-2 text-sm ${
                  locationGuardMessage
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                    : 'border-red-500/30 bg-red-500/10 text-red-400'
                }`}
              >
                {locationInlineMessage}
              </p>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={newLocationName}
                onChange={(event) => {
                  setNewLocationName(event.target.value);
                  if (locationsMessage) {
                    setLocationsMessage(null);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleAddLocation();
                  }
                }}
                placeholder="Add location name"
                disabled={!activeRestaurantId || isAddingLocation}
                className="flex-1 rounded-2xl border border-theme-primary bg-theme-tertiary px-4 py-3 text-sm text-theme-primary focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => {
                  void handleAddLocation();
                }}
                disabled={!canAddLocation}
                className="rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isAddingLocation ? 'Adding...' : 'Add'}
              </button>
            </div>

            <div className="mt-1">
              {locationsLoading ? (
                <p className="px-4 py-4 text-sm text-theme-muted">Loading locations...</p>
              ) : locationLoadMessage ? (
                <p className="px-4 py-4 text-sm text-theme-muted">Unable to load locations right now.</p>
              ) : restaurantLocations.length === 0 ? (
                <p className="px-4 py-4 text-sm text-theme-muted">No locations yet.</p>
              ) : (
                <ul className="mt-4 space-y-2">
                  {restaurantLocations.map((location) => {
                    const isBusy = locationActionId === location.id && isDeletingLocation;
                    return (
                      <li
                        key={location.id}
                        className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 transition-colors hover:bg-white/[0.05]"
                      >
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" aria-hidden="true" />
                          <span className="text-sm font-medium text-theme-primary">{location.name}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void handleDeleteLocation(location.id, location.name);
                          }}
                          disabled={isBusy}
                          aria-label={`Delete ${location.name}`}
                          className="rounded-md p-2 text-white/40 transition-colors hover:bg-white/5 hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        .dark [data-bh-track-bg="true"] {
          background: transparent !important;
        }
      `}</style>
      <ConfirmDialog
        open={Boolean(locationPendingDelete)}
        title="Remove location?"
        description={
          locationPendingDelete
            ? `Remove "${locationPendingDelete.name}" from active locations? This will only remove it from the location list used by Add/Edit Shift.`
            : undefined
        }
        confirmText="Remove"
        cancelText="Cancel"
        loadingText="Removing..."
        variant="danger"
        isLoading={Boolean(locationPendingDelete) && locationActionId === locationPendingDelete?.id && isDeletingLocation}
        onCancel={() => {
          if (isDeletingLocation) return;
          setLocationPendingDelete(null);
        }}
        onConfirm={handleConfirmDeleteLocation}
      />
    </div>
  );
}

