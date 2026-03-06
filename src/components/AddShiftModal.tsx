'use client';

import { useState, useEffect, useMemo } from 'react';
import { useScheduleStore } from '../store/scheduleStore';
import { useAuthStore } from '../store/authStore';
import { Modal } from './Modal';
import { timeRangesOverlap } from '../utils/timeUtils';
import { getUserRole, isManagerRole } from '../utils/role';
import { useDemoContext } from '../demo/DemoProvider';
import { useRestaurantEmployees } from '../hooks/useRestaurantEmployees';
import { useRestaurantLocations } from '../hooks/useRestaurantLocations';

type ShiftModalData = {
  id?: string;
  modalKey?: string;
  employeeId?: string;
  date?: string;
  draftDate?: string;
  startHour?: number;
  draftStartHour?: number;
  endHour?: number;
  draftEndHour?: number;
  notes?: string | null;
  job?: string | null;
  locationId?: string | null;
  restaurantId?: string | null;
};

type TimeOption = {
  value: number;
  label: string;
};

type EmployeeOption = {
  id: string;
  label: string;
  jobs: string[];
  isActive: boolean;
};

function formatTimeOptionLabel(hourValue: number): string {
  if (hourValue === 24) return '12am';
  const wholeHour = Math.floor(hourValue);
  const minutes = Math.round((hourValue - wholeHour) * 60);
  const meridiem = wholeHour >= 12 ? 'pm' : 'am';
  const hour12 = wholeHour % 12 === 0 ? 12 : wholeHour % 12;
  return minutes === 30 ? `${hour12}:30${meridiem}` : `${hour12}${meridiem}`;
}

const TIME_OPTIONS: TimeOption[] = [
  ...Array.from({ length: 46 }, (_, i) => {
    const value = (i + 2) / 2; // 1.0 through 23.5 in 30-minute increments
    return { value, label: formatTimeOptionLabel(value) };
  }),
  { value: 24, label: '12am' },
];

export function AddShiftModal() {
  const { 
    modalType, 
    modalData, 
    closeModal, 
    addShift, 
    updateShift,
    deleteShift,
    selectedDate,
    showToast,
    hasApprovedTimeOff,
    hasBlockedShiftOnDate,
    shifts,
    dropRequests,
    createDropRequest,
    cancelDropRequest,
  } = useScheduleStore();

  const { activeRestaurantId, currentUser } = useAuthStore();
  const isManager = isManagerRole(getUserRole(currentUser?.role));
  const demo = useDemoContext();
  const shiftModalData = (modalData ?? null) as ShiftModalData | null;
  
  const isOpen = modalType === 'addShift' || modalType === 'editShift';
  const isEditing = modalType === 'editShift';
  const modalKey = isEditing && shiftModalData?.modalKey
    ? String(shiftModalData.modalKey)
    : isEditing && shiftModalData?.id
    ? `${shiftModalData.id}:${shiftModalData.date ?? ''}:${shiftModalData.startHour ?? ''}:${shiftModalData.endHour ?? ''}`
    : 'shift-modal';
  
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState('');
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(17);
  const [notes, setNotes] = useState('');
  const [job, setJob] = useState('');
  const [locationId, setLocationId] = useState('');

  const scopedRestaurantId = shiftModalData?.restaurantId ?? activeRestaurantId;
  const {
    data: employees = [],
    isLoading,
  } = useRestaurantEmployees(scopedRestaurantId);
  const {
    options: locationOptions,
    isLoading: isLocationsLoading,
  } = useRestaurantLocations(scopedRestaurantId);
  const schedulerEmployees = useMemo(
    () => employees,
    [employees],
  );
  const employeeOptions = useMemo<EmployeeOption[]>(
    () => {
      const all = schedulerEmployees
        .map((employee) => {
          const id = String(employee.id ?? '').trim();
          const label = String(employee.full_name ?? employee.name ?? '').trim();
          const jobs = Array.from(new Set((employee.jobs ?? [])
            .map((jobLabel) => String(jobLabel ?? '').trim())
            .filter((jobLabel) => jobLabel.length > 0)));
          return { id, label, jobs, isActive: Boolean(employee.isActive) };
        })
        .filter((option) => option.id.length > 0 && option.label.length > 0);
      const activeOnly = all.filter((option) => option.isActive);
      const source = activeOnly.length > 0 ? activeOnly : all;
      return source.sort((a, b) => a.label.localeCompare(b.label));
    },
    [schedulerEmployees],
  );
  const employeeById = useMemo(
    () => new Map(employeeOptions.map((option) => [option.id, option])),
    [employeeOptions],
  );
  const effectiveEmployeeId = employeeById.has(employeeId) ? employeeId : '';
  const selectedEmployeeOption = effectiveEmployeeId ? employeeById.get(effectiveEmployeeId) ?? null : null;
  const selectedEmployee: EmployeeOption | null = selectedEmployeeOption;
  const jobsForEmployee = selectedEmployee?.jobs ?? [];
  const effectiveJob = job && jobsForEmployee.includes(job)
    ? job
    : jobsForEmployee.length === 1
      ? jobsForEmployee[0]
      : '';
  const hasEligibleJobs = jobsForEmployee.length > 0;
  const isJobEligible = effectiveJob ? jobsForEmployee.includes(effectiveJob) : false;
  const effectiveLocationId = locationOptions.some((option) => option.id === locationId) ? locationId : '';
  const locationPlaceholder = !scopedRestaurantId
    ? 'Select a restaurant first'
    : isLocationsLoading
      ? 'Loading locations...'
      : 'No location';
  const isEmployeeListEmpty = !isLoading && employeeOptions.length === 0;
  const openDropRequestForShift =
    isEditing && shiftModalData?.id
      ? dropRequests.find((request) => request.shiftId === shiftModalData.id && request.status === 'open')
      : undefined;

  const overlapWarning = (() => {
    if (!effectiveEmployeeId || !date || startHour >= endHour) return null;
    const excludeId = isEditing && shiftModalData?.id ? String(shiftModalData.id) : undefined;
    const conflicts = shifts.filter(
      (shift) =>
        shift.employeeId === effectiveEmployeeId &&
        shift.date === date &&
        !shift.isBlocked
    );
    const hasOverlap = conflicts.some((shift) =>
      timeRangesOverlap(startHour, endHour, shift.startHour, shift.endHour, {
        excludeId,
        compareId: String(shift.id),
      })
    );
    return hasOverlap ? 'Shift overlaps with an existing shift for this employee.' : null;
  })();

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      if (isEditing && shiftModalData) {
        const draftDate = shiftModalData.draftDate ?? shiftModalData.date ?? '';
        const draftStart = shiftModalData.draftStartHour ?? shiftModalData.startHour ?? 9;
        const draftEnd = shiftModalData.draftEndHour ?? shiftModalData.endHour ?? 17;
        setEmployeeId(shiftModalData.employeeId ?? '');
        setDate(draftDate);
        setStartHour(draftStart);
        setEndHour(draftEnd);
        setNotes(shiftModalData.notes || '');
        setJob(shiftModalData.job || '');
        setLocationId(shiftModalData.locationId || '');
      } else {
        setEmployeeId(shiftModalData?.employeeId || '');
        setDate(shiftModalData?.date || selectedDate.toISOString().split('T')[0]);
        setStartHour(shiftModalData?.startHour || 9);
        setEndHour(shiftModalData?.endHour || 17);
        setNotes('');
        setJob('');
        setLocationId('');
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [isOpen, isEditing, selectedDate, shiftModalData]);

  const handleEmployeeChange = (nextEmployeeId: string) => {
    setEmployeeId(nextEmployeeId);
    const nextJobs = employeeById.get(nextEmployeeId)?.jobs ?? [];
    setJob((prevJob) => {
      if (nextJobs.length === 1) return nextJobs[0];
      if (prevJob && nextJobs.includes(prevJob)) return prevJob;
      return '';
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isManager) {
      showToast("You don't have permission to modify shifts.", 'error');
      return;
    }

    if (!effectiveEmployeeId || !date || startHour >= endHour) {
      showToast('Please fill in all fields correctly', 'error');
      return;
    }

    if (!effectiveJob) {
      showToast('Please select a job', 'error');
      return;
    }

    if (overlapWarning) {
      showToast(overlapWarning, 'error');
      return;
    }

    if (selectedEmployee && !hasEligibleJobs) {
      showToast('No eligible jobs assigned to this employee', 'error');
      return;
    }

    if (selectedEmployee && hasEligibleJobs && !isJobEligible) {
      const confirmed = window.confirm(
        "This job isn't in the employee's job list. Assign anyway?"
      );
      if (!confirmed) return;
    }

    let allowTimeOffOverride = false;
    if (hasApprovedTimeOff(effectiveEmployeeId, date)) {
      const confirmed = window.confirm(
        'Employee has approved time off on this date. Assign anyway?'
      );
      if (!confirmed) return;
      allowTimeOffOverride = true;
    }

    let allowBlockedOverride = false;
    if (hasBlockedShiftOnDate(effectiveEmployeeId, date)) {
      const confirmed = window.confirm(
        'This employee is blocked out on that date. Assign anyway?'
      );
      if (!confirmed) return;
      allowBlockedOverride = true;
    }

    const normalizedLocationId = effectiveLocationId || null;

    if (isEditing && shiftModalData?.id) {
      const result = await updateShift(
        shiftModalData.id,
        {
        employeeId: effectiveEmployeeId,
        date,
        startHour,
        endHour,
        notes: notes || undefined,
        job: effectiveJob,
        locationId: normalizedLocationId,
        restaurantId: shiftModalData.restaurantId ?? activeRestaurantId ?? '',
        },
        { allowTimeOffOverride, allowBlockedOverride }
      );
      if (!result.success) {
        showToast(result.error || 'Failed to update shift', 'error');
        return;
      }
      showToast('Shift updated successfully', 'success');
    } else {
      const result = await addShift(
        {
          employeeId: effectiveEmployeeId,
          date,
          startHour,
          endHour,
          notes: notes || undefined,
          job: effectiveJob,
          locationId: normalizedLocationId,
          restaurantId: activeRestaurantId ?? '',
        },
        { allowTimeOffOverride, allowBlockedOverride }
      );
      if (!result.success) {
        showToast(result.error || 'Failed to add shift', 'error');
        return;
      }
      showToast('Shift added successfully', 'success');
    }
    
    closeModal();
  };

  const handleDelete = async () => {
    if (isEditing && shiftModalData?.id) {
      const result = await deleteShift(shiftModalData.id);
      if (!result.success) {
        showToast(result.error || 'Failed to delete shift', 'error');
        return;
      }
      showToast('Shift deleted', 'success');
      closeModal();
    }
  };

  const handleOfferShift = () => {
    if (!isEditing || !shiftModalData?.id) return;
    if (openDropRequestForShift) {
      cancelDropRequest(openDropRequestForShift.id);
      showToast('Shift offer canceled', 'success');
      return;
    }
    createDropRequest(shiftModalData.id, shiftModalData.employeeId ?? '');
    showToast('Shift offered in demo exchange', 'success');
  };

  if (isOpen && isLoading && employeeOptions.length === 0) {
    return (
      <Modal
        key={modalKey}
        isOpen={isOpen}
        onClose={closeModal}
        title={isEditing ? 'Edit Shift' : 'Add Shift'}
        size="md"
      >
        <div className="p-4 text-sm text-theme-secondary">Loading staff...</div>
      </Modal>
    );
  }

  return (
    <Modal
      key={modalKey}
      isOpen={isOpen}
      onClose={closeModal}
      title={isEditing ? 'Edit Shift' : 'Add Shift'}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {!isManager && (
          <p className="text-sm text-red-400">
            You don&apos;t have permission to create or edit shifts.
          </p>
        )}
        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-1.5">Employee</label>
          <select
            value={effectiveEmployeeId}
            onChange={(e) => handleEmployeeChange(e.target.value)}
            className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            required
            disabled={!isManager || isLoading}
          >
            <option value="">
              {isLoading ? 'Loading employees...' : 'Select employee...'}
            </option>
            {employeeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {isEmployeeListEmpty && (
            <p className="text-xs text-red-400 mt-1">
              No employees found for this restaurant.
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-1.5">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            required
            disabled={!isManager}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-1.5">Job / Position</label>
          <select
            value={effectiveJob}
            onChange={(e) => setJob(e.target.value)}
            className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            required
            disabled={!isManager}
          >
            <option value="">Select job...</option>
            {jobsForEmployee.map((option) => {
              return (
                <option key={option} value={option}>
                  {option}
                </option>
              );
            })}
          </select>
          {selectedEmployee && !hasEligibleJobs && (
            <p className="text-xs text-red-400 mt-1">
              No eligible jobs assigned.
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-1.5">Location (optional)</label>
          <select
            value={effectiveLocationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            disabled={!isManager || isLocationsLoading || !scopedRestaurantId}
          >
            <option value="">{locationPlaceholder}</option>
            {locationOptions.map((location) => (
              <option key={location.id} value={location.id}>
                {location.label}
              </option>
            ))}
          </select>
          {!isLocationsLoading && scopedRestaurantId && locationOptions.length === 0 && (
            <p className="mt-1 text-xs text-theme-muted">
              No saved locations yet. Add one in Schedule Settings.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-1.5">Start Time</label>
            <select
              value={startHour}
              onChange={(e) => setStartHour(Number(e.target.value))}
              className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
              disabled={!isManager}
            >
              {TIME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-theme-secondary mb-1.5">End Time</label>
            <select
              value={endHour}
              onChange={(e) => setEndHour(Number(e.target.value))}
              className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50"
              disabled={!isManager}
            >
              {TIME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} disabled={option.value <= startHour}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="text-sm text-theme-tertiary">Duration: {endHour - startHour} hours</div>
        {overlapWarning && (
          <p className="text-sm text-red-400">{overlapWarning}</p>
        )}

        <div>
          <label className="block text-sm font-medium text-theme-secondary mb-1.5">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 bg-theme-tertiary border border-theme-primary rounded-lg text-theme-primary focus:outline-none focus:ring-2 focus:ring-amber-500/50 resize-none"
            placeholder="Any special instructions..."
            disabled={!isManager}
          />
        </div>

        <div className="flex gap-3 pt-2">
          {isEditing && isManager && demo?.isDemo && (
            <button
              type="button"
              onClick={handleOfferShift}
              className="px-4 py-2 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors text-sm font-medium"
            >
              {openDropRequestForShift ? 'Cancel Offer' : 'Offer Shift'}
            </button>
          )}
          {isEditing && isManager && (
            <button
              type="button"
              onClick={handleDelete}
              className="px-4 py-2 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors text-sm font-medium"
            >
              Delete
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover transition-colors text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!isManager || isLoading || isEmployeeListEmpty || (selectedEmployee && !hasEligibleJobs) || Boolean(overlapWarning)}
            className="px-4 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-400 transition-all hover:scale-105 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isEditing ? 'Save Changes' : 'Add Shift'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
