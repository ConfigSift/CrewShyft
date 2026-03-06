'use client';
/* eslint-disable react-hooks/refs */

import { useScheduleStore } from '../store/scheduleStore';
import { useAuthStore } from '../store/authStore';
import { SECTIONS, type Shift } from '../types';
import { formatHourShort, formatHour, shiftsOverlap, getWeekRange } from '../utils/timeUtils';
import { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Palmtree, ArrowLeftRight } from 'lucide-react';
import { getUserRole, isManagerRole } from '../utils/role';
import { getJobColorClasses } from '../lib/jobColors';
import { compareJobs } from '../utils/jobOrder';
import { ScheduleToolbar } from './ScheduleToolbar';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { PublishScheduleDialog, type PublishEmailMode } from './ui/PublishScheduleDialog';
import { PasteJobPickerDialog } from './ui/PasteJobPickerDialog';
import { apiFetch } from '../lib/apiClient';
import { resolvePasteJob } from '../utils/pasteJobResolution';
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';

// Compact timeline sizing - pixels per hour
const DEFAULT_PX_PER_HOUR = 48;

// Week view: 7-day window (168 hours)
const CONTINUOUS_DAYS_COUNT = 7;
const CONTINUOUS_TOTAL_HOURS = 24 * CONTINUOUS_DAYS_COUNT;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const GRID_BACKGROUND_SELECTOR = '[data-grid-background="true"]';
const CELL_ID_PREFIX = 'cell:';
const SHIFT_ID_PREFIX = 'shift:';
const CELL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CROSS_EMPLOYEE_Y_THRESHOLD_PX = 20;
const DAY_MOVE_SNAP_MINUTES = 30;
const SCHEDULE_CLIPBOARD_KEY = 'crewshyft:scheduleClipboard:v1';
const CLIPBOARD_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const NON_GRAB_SCROLL_SELECTOR = [
  '[data-shift]',
  '.shift',
  '[data-resize-handle]',
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[contenteditable="true"]',
].join(',');

type TimelineContextMenu = {
  x: number;
  y: number;
  type: 'shift' | 'cell';
  shiftId?: string;
  cellId?: string;
};

type TimelineScheduleClipboard = {
  copiedAt: number;
  sourceOrgId: string;
  template: {
    shiftId: string;
    sourceUserId?: string;
    startHour: number;
    endHour: number;
    job: string;
    locationId?: string | null;
    notes?: string;
  };
};

type TimelineCellTarget = {
  organizationId: string;
  userId: string;
  date: string;
};

type PublishNotificationResponse = {
  ok?: boolean;
  sent?: number;
  failed?: number;
  skippedNoEmail?: number;
  requestId?: string;
};

type TimelineShiftTarget = {
  shiftId: string;
};

type TimelineOptimisticShiftMove = {
  employeeId: string;
  date: string;
};

function buildTimelineCellId(organizationId: string, userId: string, date: string): string {
  return `${CELL_ID_PREFIX}${organizationId}:${userId}:${date}`;
}

function buildTimelineShiftId(shiftId: string): string {
  return `${SHIFT_ID_PREFIX}${shiftId}`;
}

function parseTimelineCellId(rawId: unknown): TimelineCellTarget | null {
  const value = String(rawId ?? '');
  if (!value.startsWith(CELL_ID_PREFIX)) return null;
  const payload = value.slice(CELL_ID_PREFIX.length);
  const [organizationId, userId, date] = payload.split(':');
  if (!organizationId || !userId || !date || !CELL_DATE_RE.test(date)) return null;
  return { organizationId, userId, date };
}

function parseTimelineShiftId(rawId: unknown): TimelineShiftTarget | null {
  const value = String(rawId ?? '');
  if (!value.startsWith(SHIFT_ID_PREFIX)) return null;
  const shiftId = value.slice(SHIFT_ID_PREFIX.length);
  if (!shiftId) return null;
  return { shiftId };
}

function isKeyboardInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

function getClientPointFromEvent(event: Event | null | undefined): { x: number; y: number } | null {
  if (!event) return null;
  if ('clientX' in event && 'clientY' in event) {
    const mouseLike = event as MouseEvent;
    return { x: mouseLike.clientX, y: mouseLike.clientY };
  }
  if ('touches' in event) {
    const touchEvent = event as TouchEvent;
    const firstTouch = touchEvent.touches[0] ?? touchEvent.changedTouches[0];
    if (!firstTouch) return null;
    return { x: firstTouch.clientX, y: firstTouch.clientY };
  }
  return null;
}

function getSnappedDayMoveResult(shift: Shift, deltaX: number, pxPerHour: number) {
  const deltaHours = pxPerHour > 0 ? deltaX / pxPerHour : 0;
  const snappedDeltaMinutes = Math.round((deltaHours * 60) / DAY_MOVE_SNAP_MINUTES) * DAY_MOVE_SNAP_MINUTES;
  const minDurationMinutes = 15;
  const durationMinutes = Math.max(minDurationMinutes, Math.round((shift.endHour - shift.startHour) * 60));
  let nextStartMinutes = shift.startHour * 60 + snappedDeltaMinutes;
  let nextEndMinutes = shift.endHour * 60 + snappedDeltaMinutes;

  if (nextStartMinutes < 0) {
    nextStartMinutes = 0;
    nextEndMinutes = durationMinutes;
  }
  if (nextEndMinutes > 24 * 60) {
    nextEndMinutes = 24 * 60;
    nextStartMinutes = nextEndMinutes - durationMinutes;
  }
  if (nextEndMinutes - nextStartMinutes < minDurationMinutes) {
    nextEndMinutes = Math.min(24 * 60, nextStartMinutes + minDurationMinutes);
    nextStartMinutes = Math.max(0, nextEndMinutes - minDurationMinutes);
  }

  const startHour = Math.round((nextStartMinutes / 60) * 1000) / 1000;
  const endHour = Math.round((nextEndMinutes / 60) * 1000) / 1000;
  const changed = Math.abs(startHour - shift.startHour) >= 0.001 || Math.abs(endHour - shift.endHour) >= 0.001;

  return {
    startHour,
    endHour,
    changed,
    snappedDeltaMinutes,
  };
}

type TimelineDroppableSliceProps = {
  id: string;
  disabled?: boolean;
  employeeId: string;
  className?: string;
  style?: React.CSSProperties;
  isActiveCell?: boolean;
  isContextMenuTarget?: boolean;
  isDragOverCell?: boolean;
};

function TimelineDroppableSlice({
  id,
  disabled = false,
  employeeId,
  className,
  style,
  isActiveCell = false,
  isContextMenuTarget = false,
  isDragOverCell = false,
}: TimelineDroppableSliceProps) {
  const { setNodeRef, isOver } = useDroppable({
    id,
    disabled,
  });
  const isHighlighted = !disabled && (isOver || isDragOverCell);

  return (
    <div
      ref={setNodeRef}
      data-grid-background="true"
      data-employee-id={employeeId}
      data-cell-id={id}
      className={`${className ?? ''} ${isHighlighted ? 'outline outline-2 outline-sky-400/70 bg-sky-500/10' : ''} ${
        isContextMenuTarget
          ? 'outline outline-2 outline-amber-300/95 bg-amber-400/15'
          : isActiveCell
          ? 'outline outline-2 outline-amber-400/80'
          : ''
      }`}
      style={style}
    />
  );
}

type TimelineDraggableShiftProps = {
  shiftId: string;
  disabled?: boolean;
  children: (args: {
    setNodeRef: (element: HTMLElement | null) => void;
    attributes: Record<string, unknown>;
    listeners: Record<string, unknown>;
    transformStyle?: string;
    isDragging: boolean;
  }) => React.ReactNode;
};

function TimelineDraggableShift({ shiftId, disabled = false, children }: TimelineDraggableShiftProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: buildTimelineShiftId(shiftId),
    disabled,
  });
  const transformStyle = transform
    ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
    : undefined;
  return children({
    setNodeRef,
    attributes: attributes as unknown as Record<string, unknown>,
    listeners: listeners as unknown as Record<string, unknown>,
    transformStyle,
    isDragging,
  });
}

// Helper to get date string (YYYY-MM-DD) from Date using LOCAL timezone
// Note: Using local timezone ensures consistent date comparison for now-line positioning
function toDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper to get midnight of a date
function getMidnight(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Helper to add days to a date
function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Format date for day separator label
function formatDayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatPublishDayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPublishWeekLabel(start: Date, end: Date): string {
  const startMonthDay = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endMonthDay = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();
  if (startYear !== endYear) {
    return `${startMonthDay}, ${startYear} – ${endMonthDay}, ${endYear}`;
  }
  return `${startMonthDay} – ${endMonthDay}, ${startYear}`;
}

function dateFromDateString(dateString: string): Date {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

export function Timeline() {
  const {
    selectedDate,
    setSelectedDate,
    setViewMode,
    continuousDays,
    setContinuousDays,
    getFilteredEmployeesForRestaurant,
    getEmployeesForRestaurant,
    getShiftsForRestaurant,
    businessHours,
    locations,
    hoveredShiftId,
    setHoveredShift,
    openModal,
    modalType,
    showToast,
    addShift,
    updateShift,
    deleteShift,
    hasApprovedTimeOff,
    hasBlockedShiftOnDate,
    hasOrgBlackoutOnDate,
    dateNavDirection,
    dateNavKey,
    getEffectiveHourRange,
    viewMode,
    workingTodayOnly,
    scheduleViewSettings,
    scheduleMode,
    publishDraftRange,
    copyPreviousDayIntoDraft,
    shifts,
    loadRestaurantData,
  } = useScheduleStore();

  const gridScrollRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const isSyncingScrollRef = useRef(false);
  const timelineResizeRafRef = useRef<number | null>(null);
  const [isSliding, setIsSliding] = useState(false);
  const [slideDirection, setSlideDirection] = useState<'prev' | 'next' | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState(0);
  const [tooltip, setTooltip] = useState<{
    shiftId: string;
    left: number;
    top: number;
    employeeName: string;
    job?: string;
    location?: string;
    time: string;
  } | null>(null);
  const [activeDragShiftId, setActiveDragShiftId] = useState<string | null>(null);
  const [activeDragMode, setActiveDragMode] = useState<'move' | 'resize-left' | 'resize-right' | null>(null);
  const [contextMenu, setContextMenu] = useState<TimelineContextMenu | null>(null);
  const [scheduleClipboard, setScheduleClipboard] = useState<TimelineScheduleClipboard | null>(null);
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [contextMenuShiftHighlightId, setContextMenuShiftHighlightId] = useState<string | null>(null);
  const [contextMenuCellHighlightId, setContextMenuCellHighlightId] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmDeleteShiftId, setConfirmDeleteShiftId] = useState<string | null>(null);
  const [confirmDeleteLoading, setConfirmDeleteLoading] = useState(false);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [publishConfirmScope, setPublishConfirmScope] = useState<'day' | 'week' | null>(null);
  const [publishEmailMode, setPublishEmailMode] = useState<PublishEmailMode>('all');
  const [publishConfirmLoading, setPublishConfirmLoading] = useState(false);
  const [draggingShiftId, setDraggingShiftId] = useState<string | null>(null);
  const [dragOverCellId, setDragOverCellId] = useState<string | null>(null);
  const [dragOrigin, setDragOrigin] = useState<{
    shiftId: string;
    employeeId: string;
    date: string;
    startHour: number;
    endHour: number;
  } | null>(null);
  const [optimisticShiftMoves, setOptimisticShiftMoves] = useState<Record<string, TimelineOptimisticShiftMove>>({});
  const [pendingMoveShiftIds, setPendingMoveShiftIds] = useState<string[]>([]);
  const [dayMoveTimeTooltip, setDayMoveTimeTooltip] = useState<{
    left: number;
    top: number;
    label: string;
  } | null>(null);
  const [isPendingRowMove, setIsPendingRowMove] = useState(false);
  const [optimisticDeletedShiftIds, setOptimisticDeletedShiftIds] = useState<string[]>([]);
  const [pasteJobPickerOpen, setPasteJobPickerOpen] = useState(false);
  const [pasteJobPickerEmployeeName, setPasteJobPickerEmployeeName] = useState('');
  const [pasteJobPickerOptions, setPasteJobPickerOptions] = useState<string[]>([]);
  const [pasteJobPickerSelectedJob, setPasteJobPickerSelectedJob] = useState('');
  const dragStartRef = useRef<{ startX: number; startY: number; originUserId: string } | null>(null);
  const [dragPreview, setDragPreview] = useState<Record<string, { startHour: number; endHour: number; date?: string }>>({});
  const [commitOverridesVersion, setCommitOverridesVersion] = useState(0);
  const commitOverridesRef = useRef<Record<string, { startDate: string; startHour: number; endDate: string; endHour: number }>>({});
  const pendingShiftChangeRef = useRef<{
    shiftId: string;
    original: { date: string; startHour: number; endHour: number };
    proposed: { date: string; startHour: number; endHour: number };
  } | null>(null);
  const lastModalTypeRef = useRef(modalType);
  const [hoveredAddSlot, setHoveredAddSlot] = useState<{
    employeeId: string;
    date: string;
    startHour: number;
    absHoursFromWindowStart?: number;
  } | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const hoverPendingRef = useRef<{ employeeId: string; clientX: number; target: EventTarget | null } | null>(null);
  const lastPointerTypeRef = useRef<'mouse' | 'pen' | 'touch' | null>(null);
  const continuousCellAssertedRef = useRef(false);
  const pointerCaptureElRef = useRef<HTMLElement | null>(null);
  const activeDragRef = useRef<{
    pointerId: number;
    mode: 'move' | 'resize-left' | 'resize-right';
    shiftId: string;
    employeeId: string | null;
    anchorStartMin: number;
    anchorEndMin: number;
    anchorPointerMin: number;
    startClientX: number;
    startClientY: number;
    startedAt: number;
    activated: boolean;
    moved: boolean;
    lastStartMin: number;
    lastEndMin: number;
    dayIndex?: number;
  } | null>(null);

  // Drag-to-scroll state
  const [isDragScrolling, setIsDragScrolling] = useState(false);
  const dragScrollRef = useRef<{
    startX: number;
    scrollLeft: number;
    currentX: number;
  } | null>(null);
  const pxPerHourRef = useRef(0);
  const isDragScrollingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const scrollToDateRef = useRef<(date: Date, options?: { reanchor?: boolean }) => void>(() => {});
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const pasteJobPickerResolveRef = useRef<((job: string | null) => void) | null>(null);

  // Timeline range state (day vs week)

  const lanePointerRef = useRef<{ x: number; y: number; employeeId: string } | null>(null);
  const lastDragAtRef = useRef(0);

  const { activeRestaurantId, currentUser } = useAuthStore();
  const isManager = isManagerRole(getUserRole(currentUser?.role));
  const isDraftMode = scheduleMode === 'draft';
  const todayYmd = toDateString(new Date());
  const isEditableDate = useCallback((dateStr: string) => dateStr >= todayYmd, [todayYmd]);
  const draftHelperText = 'Changes are not visible to staff until published.';
  const draftBadge = (
    <span className="inline-flex items-center px-2 py-1 rounded-full bg-amber-500/20 text-amber-500 text-[10px] font-semibold tracking-wide">
      DRAFT MODE
    </span>
  );
  const weekStartDay = scheduleViewSettings?.weekStartDay ?? 'sunday';
  const weekRange = useMemo(() => getWeekRange(selectedDate, weekStartDay), [selectedDate, weekStartDay]);
  const windowStartDate = continuousDays ? weekRange.start : selectedDate;
  const selectedDateYmd = useMemo(() => toDateString(selectedDate), [selectedDate]);
  const rangeStartDate = continuousDays ? weekRange.start : selectedDate;
  const rangeEndDate = continuousDays ? weekRange.end : selectedDate;
  const rangeStartYmd = useMemo(() => toDateString(rangeStartDate), [rangeStartDate]);
  const rangeEndYmd = useMemo(() => toDateString(rangeEndDate), [rangeEndDate]);
  const weekStartYmd = useMemo(() => toDateString(weekRange.start), [weekRange.start]);
  const weekEndYmd = useMemo(() => toDateString(weekRange.end), [weekRange.end]);
  const publishDayLabel = useMemo(() => formatPublishDayLabel(selectedDate), [selectedDate]);
  const publishWeekLabel = useMemo(
    () => formatPublishWeekLabel(weekRange.start, weekRange.end),
    [weekRange.end, weekRange.start]
  );
  const canEditSelectedDate = isManager && isEditableDate(selectedDateYmd);
  const hasDraftOnSelectedDate = useMemo(
    () =>
      shifts.some(
        (shift) =>
          shift.restaurantId === activeRestaurantId &&
          shift.scheduleState === 'draft' &&
          shift.date === selectedDateYmd
      ),
    [activeRestaurantId, selectedDateYmd, shifts]
  );
  const hasDraftInRange = useMemo(
    () =>
      shifts.some(
        (shift) =>
          shift.restaurantId === activeRestaurantId &&
          shift.scheduleState === 'draft' &&
          shift.date >= rangeStartYmd &&
          shift.date <= rangeEndYmd
      ),
    [activeRestaurantId, rangeEndYmd, rangeStartYmd, shifts]
  );
  const hasDraftInWeek = useMemo(
    () =>
      shifts.some(
        (shift) =>
          shift.restaurantId === activeRestaurantId &&
          shift.scheduleState === 'draft' &&
          shift.date >= weekStartYmd &&
          shift.date <= weekEndYmd
      ),
    [activeRestaurantId, shifts, weekEndYmd, weekStartYmd]
  );
  const publishStatusLabel = hasDraftInRange ? 'DRAFT' : 'PUBLISHED';
  const statusTone = hasDraftInRange ? 'bg-amber-500 text-zinc-900' : 'bg-emerald-500 text-white';
  const isPastSelectedDate = selectedDateYmd < todayYmd;
  const isPastWeek = weekEndYmd < todayYmd;
  const publishDayEnabled = isManager && hasDraftOnSelectedDate && !isPastSelectedDate;
  const publishWeekEnabled = isManager && hasDraftInWeek && !isPastWeek;
  const publishDayDisabledReason = isPastSelectedDate
    ? "Past schedules can't be published."
    : !hasDraftOnSelectedDate
    ? 'No draft changes'
    : undefined;
  const publishWeekDisabledReason = isPastWeek
    ? "Past schedules can't be published."
    : !hasDraftInWeek
    ? 'No draft changes'
    : undefined;
  const openPublishConfirm = useCallback((scope: 'day' | 'week') => {
    setPublishConfirmScope(scope);
    setPublishEmailMode('all');
    setPublishConfirmOpen(true);
  }, []);

  const closePublishConfirm = useCallback(() => {
    if (publishConfirmLoading) return;
    setPublishConfirmOpen(false);
    setPublishConfirmScope(null);
  }, [publishConfirmLoading]);

  const handlePublishDay = useCallback(() => {
    if (!publishDayEnabled) return;
    openPublishConfirm('day');
  }, [openPublishConfirm, publishDayEnabled]);

  const handlePublishWeek = useCallback(() => {
    if (!publishWeekEnabled) return;
    openPublishConfirm('week');
  }, [openPublishConfirm, publishWeekEnabled]);

  const handleConfirmPublish = useCallback(async () => {
    if (!publishConfirmScope) return;
    if (!activeRestaurantId) {
      showToast('Select a restaurant first.', 'error');
      return;
    }

    const scope = publishConfirmScope;
    const startDate = scope === 'day' ? selectedDateYmd : weekStartYmd;
    const endDate = scope === 'day' ? selectedDateYmd : weekEndYmd;

    setPublishConfirmLoading(true);
    try {
      const publishResult = await publishDraftRange({
        startDate,
        endDate,
      });
      if (!publishResult.success) {
        showToast(publishResult.error || `Unable to publish ${scope}.`, 'error');
        return;
      }

      await loadRestaurantData(activeRestaurantId);
      showToast(scope === 'day' ? `Published ${publishDayLabel}.` : `Published week ${publishWeekLabel}.`, 'success');

      if (publishEmailMode !== 'none') {
        const notifyResult = await apiFetch<PublishNotificationResponse>('/api/notifications/schedule-published', {
          method: 'POST',
          json: {
            organizationId: activeRestaurantId,
            scope,
            rangeStart: startDate,
            rangeEnd: endDate,
            mode: publishEmailMode,
          },
        });
        const emailFailed =
          !notifyResult.ok
          || !notifyResult.data?.ok
          || (typeof notifyResult.data?.failed === 'number' && notifyResult.data.failed > 0);
        if (emailFailed) {
          showToast('Published, but emails failed to send.', 'error');
        }
      }

      setPublishConfirmOpen(false);
      setPublishConfirmScope(null);
    } finally {
      setPublishConfirmLoading(false);
    }
  }, [
    activeRestaurantId,
    loadRestaurantData,
    publishConfirmScope,
    publishDraftRange,
    publishDayLabel,
    publishEmailMode,
    publishWeekLabel,
    selectedDateYmd,
    showToast,
    weekEndYmd,
    weekStartYmd,
  ]);
  const handleCopyPreviousDayIntoDraft = useCallback(async () => {
    if (!activeRestaurantId) {
      showToast('Select a restaurant first.', 'error');
      return;
    }
    const result = await copyPreviousDayIntoDraft(selectedDate);
    if (!result.success) {
      showToast(result.error || 'Unable to copy previous day into draft.', 'error');
      return;
    }
    if ((result.sourceCount ?? 0) === 0) {
      showToast('No shifts found for previous day.', 'error');
      return;
    }
    const inserted = result.insertedCount ?? 0;
    const skipped = result.skippedCount ?? 0;
    const countsLabel = ` (${inserted} added${skipped ? `, ${skipped} skipped` : ''})`;
    showToast(`Copied previous day into draft.${countsLabel}`, 'success');
  }, [activeRestaurantId, copyPreviousDayIntoDraft, selectedDate, showToast]);
  const filteredEmployees = getFilteredEmployeesForRestaurant(activeRestaurantId);
  const scopedEmployees = getEmployeesForRestaurant(activeRestaurantId);
  const scopedShifts = getShiftsForRestaurant(activeRestaurantId);
  const shiftsForRender = useMemo(() => {
    if (Object.keys(optimisticShiftMoves).length === 0) return scopedShifts;
    return scopedShifts.map((shift) => {
      const move = optimisticShiftMoves[shift.id];
      if (!move) return shift;
      return {
        ...shift,
        employeeId: move.employeeId,
        date: move.date,
      };
    });
  }, [optimisticShiftMoves, scopedShifts]);
  const locationMap = useMemo(
    () => new Map(locations.map((location) => [location.id, location.name])),
    [locations]
  );

  const jobOrder = useMemo(() => {
    const uniqueJobs = new Set<string>();
    scopedEmployees.forEach((employee) => {
      if (!employee.isActive) return;
      (employee.jobs ?? []).forEach((job) => {
        if (job) uniqueJobs.add(job);
      });
    });
    return Array.from(uniqueJobs).sort(compareJobs);
  }, [scopedEmployees]);

  const dateString = toDateString(selectedDate);
  const canUseCopyPaste = isManager && Boolean(activeRestaurantId);
  const hasUsableClipboard = Boolean(
    scheduleClipboard && Date.now() - scheduleClipboard.copiedAt <= CLIPBOARD_MAX_AGE_MS
  );
  const dayReassignEnabled = isManager;
  const scopedShiftIdSet = useMemo(
    () => new Set(scopedShifts.map((shift) => shift.id)),
    [scopedShifts]
  );
  const optimisticDeletedShiftIdSet = useMemo(
    () => new Set(optimisticDeletedShiftIds),
    [optimisticDeletedShiftIds]
  );
  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    })
  );
  const collisionDetectionStrategy = useCallback((args: Parameters<typeof pointerWithin>[0]) => {
    const dragStart = dragStartRef.current;
    if (!dragStart || !dayReassignEnabled || !args.pointerCoordinates) return pointerWithin(args);
    const pointerY = args.pointerCoordinates.y;
    const deltaY = Math.abs(pointerY - dragStart.startY);
    if (deltaY >= CROSS_EMPLOYEE_Y_THRESHOLD_PX) {
      return pointerWithin(args);
    }
    const lockedContainers = args.droppableContainers.filter((container) => {
      const target = parseTimelineCellId(container.id);
      if (!target) return true;
      return target.userId === dragStart.originUserId;
    });
    if (lockedContainers.length === 0) {
      return pointerWithin(args);
    }
    return pointerWithin({
      ...args,
      droppableContainers: lockedContainers,
    });
  }, [dayReassignEnabled]);
  const confirmDeleteShift = useMemo(
    () => (confirmDeleteShiftId ? scopedShifts.find((shift) => shift.id === confirmDeleteShiftId) ?? null : null),
    [confirmDeleteShiftId, scopedShifts]
  );
  const confirmDeleteEmployeeName = useMemo(() => {
    if (!confirmDeleteShift) return 'Unknown';
    return filteredEmployees.find((employee) => employee.id === confirmDeleteShift.employeeId)?.name ?? 'Unknown';
  }, [confirmDeleteShift, filteredEmployees]);

  const updateSessionClipboard = useCallback((clipboard: TimelineScheduleClipboard | null) => {
    setScheduleClipboard(clipboard);
    if (typeof window === 'undefined') return;
    if (!clipboard) {
      window.sessionStorage.removeItem(SCHEDULE_CLIPBOARD_KEY);
      return;
    }
    window.sessionStorage.setItem(SCHEDULE_CLIPBOARD_KEY, JSON.stringify(clipboard));
  }, []);

  const handleCopyShiftToClipboard = useCallback((shiftId: string) => {
    if (!canUseCopyPaste || !activeRestaurantId) {
      showToast('Not permitted', 'error');
      return;
    }
    const sourceShift = scopedShifts.find(
      (shift) => shift.id === shiftId && !shift.isBlocked && !optimisticDeletedShiftIdSet.has(shift.id)
    );
    if (!sourceShift) {
      showToast('Select a shift first', 'error');
      return;
    }
    const job = String(sourceShift.job ?? '').trim();
    if (!job) {
      showToast('Copy failed: shift is missing a job', 'error');
      return;
    }

    const clipboard: TimelineScheduleClipboard = {
      copiedAt: Date.now(),
      sourceOrgId: activeRestaurantId,
      template: {
        shiftId: sourceShift.id,
        sourceUserId: sourceShift.employeeId,
        startHour: sourceShift.startHour,
        endHour: sourceShift.endHour,
        job,
        locationId: sourceShift.locationId ?? null,
        notes: sourceShift.notes ?? '',
      },
    };
    updateSessionClipboard(clipboard);
    if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
      const savedRaw = window.sessionStorage.getItem(SCHEDULE_CLIPBOARD_KEY);
      let savedClipboard: unknown = null;
      try {
        savedClipboard = savedRaw ? JSON.parse(savedRaw) : null;
      } catch {
        savedClipboard = savedRaw;
      }
      console.debug('[timeline-copy] clipboard-saved', { shiftId, clipboard, savedClipboard });
    }
    showToast('Shift copied', 'success');
  }, [activeRestaurantId, canUseCopyPaste, optimisticDeletedShiftIdSet, scopedShifts, showToast, updateSessionClipboard]);

  const resolvePasteJobPicker = useCallback((job: string | null) => {
    const resolver = pasteJobPickerResolveRef.current;
    pasteJobPickerResolveRef.current = null;
    setPasteJobPickerOpen(false);
    setPasteJobPickerEmployeeName('');
    setPasteJobPickerOptions([]);
    setPasteJobPickerSelectedJob('');
    if (resolver) resolver(job);
  }, []);

  const requestPasteJobSelection = useCallback((options: string[], employeeName: string) => {
    const normalizedOptions = options
      .map((option) => String(option ?? '').trim())
      .filter(Boolean);

    if (normalizedOptions.length === 0) {
      return Promise.resolve<string | null>(null);
    }

    if (pasteJobPickerResolveRef.current) {
      pasteJobPickerResolveRef.current(null);
      pasteJobPickerResolveRef.current = null;
    }

    setPasteJobPickerEmployeeName(employeeName);
    setPasteJobPickerOptions(normalizedOptions);
    setPasteJobPickerSelectedJob(normalizedOptions[0]);
    setPasteJobPickerOpen(true);

    return new Promise<string | null>((resolve) => {
      pasteJobPickerResolveRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (pasteJobPickerResolveRef.current) {
        pasteJobPickerResolveRef.current(null);
        pasteJobPickerResolveRef.current = null;
      }
    };
  }, []);

  const handlePasteShiftFromClipboard = useCallback(async (targetCellId?: string | null) => {
    const effectiveCellId = targetCellId ?? activeCellId;
    if (!canUseCopyPaste || !activeRestaurantId) {
      showToast('Paste failed: Not permitted', 'error');
      return;
    }
    if (!effectiveCellId) {
      showToast('Paste failed: Click a cell to choose where to paste', 'error');
      return;
    }
    const targetCell = parseTimelineCellId(effectiveCellId);
    if (!targetCell) {
      showToast('Paste failed: invalid target cell', 'error');
      return;
    }
    if (targetCell.organizationId !== activeRestaurantId) {
      showToast('Paste failed: Not permitted', 'error');
      return;
    }
    if (!isEditableDate(targetCell.date)) {
      showToast("Paste failed: Past schedules can't be edited.", 'error');
      return;
    }
    if (!scheduleClipboard) {
      showToast('Nothing to paste', 'error');
      return;
    }

    const clipboardAgeMs = Date.now() - scheduleClipboard.copiedAt;
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[timeline-paste] before-paste', {
        activeCellId,
        targetCellId: effectiveCellId,
        parsedTargetCell: targetCell,
        clipboardAgeMs,
        clipboard: scheduleClipboard,
      });
    }
    if (clipboardAgeMs > CLIPBOARD_MAX_AGE_MS) {
      updateSessionClipboard(null);
      showToast('Nothing to paste', 'error');
      return;
    }
    if (scheduleClipboard.sourceOrgId !== activeRestaurantId) {
      showToast('Paste failed: Not permitted', 'error');
      return;
    }
    const template = scheduleClipboard.template;
    if (
      !template
      || !String(template.job ?? '').trim()
      || !Number.isFinite(template.startHour)
      || !Number.isFinite(template.endHour)
      || template.startHour >= template.endHour
    ) {
      showToast('Paste failed: clipboard template is incomplete', 'error');
      return;
    }
    const sourceUserId = String(template.sourceUserId ?? '').trim()
      || scopedShifts.find((shift) => String(shift.id) === String(template.shiftId))?.employeeId
      || '';
    const targetEmployeeName =
      scopedEmployees.find((employee) => employee.id === targetCell.userId)?.name ?? 'This employee';
    const jobResolution = resolvePasteJob({
      targetUserId: targetCell.userId,
      sourceUserId,
      copiedJob: template.job,
      employees: scopedEmployees,
    });
    let resolvedJob = template.job;
    if (jobResolution.mode === 'auto') {
      resolvedJob = jobResolution.job;
    } else if (jobResolution.mode === 'pick') {
      const selectedJob = await requestPasteJobSelection(
        jobResolution.options.map((option) => option.name),
        targetEmployeeName,
      );
      if (!selectedJob) return;
      resolvedJob = selectedJob;
    } else {
      resolvedJob = jobResolution.job;
      showToast('Employee has no job set; using copied job.', 'error');
    }

    try {
      const result = await addShift({
        employeeId: targetCell.userId,
        restaurantId: activeRestaurantId,
        date: targetCell.date,
        startHour: template.startHour,
        endHour: template.endHour,
        notes: template.notes,
        isBlocked: false,
        job: resolvedJob,
        locationId: template.locationId ?? null,
        scheduleState: scheduleMode,
      });
      if (!result.success) {
        showToast(`Paste failed: ${result.error ?? 'Unknown error'}`, 'error');
        return;
      }
      showToast('Shift pasted', 'success');
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
        ? error
        : JSON.stringify(error);
      showToast(`Paste failed: ${message}`, 'error');
    }
  }, [
    activeCellId,
    activeRestaurantId,
    addShift,
    canUseCopyPaste,
    isEditableDate,
    requestPasteJobSelection,
    scheduleClipboard,
    scheduleMode,
    scopedEmployees,
    scopedShifts,
    showToast,
    updateSessionClipboard,
  ]);

  const openShiftContextMenu = useCallback((x: number, y: number, shiftId: string) => {
    setSelectedShiftId(shiftId);
    setContextMenuShiftHighlightId(shiftId);
    setContextMenuCellHighlightId(null);
    setContextMenu({ x, y, type: 'shift', shiftId });
  }, []);

  const openCellContextMenu = useCallback((x: number, y: number, cellId: string) => {
    setActiveCellId(cellId);
    setContextMenuCellHighlightId(cellId);
    setContextMenuShiftHighlightId(null);
    setContextMenu({ x, y, type: 'cell', cellId });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setContextMenuShiftHighlightId(null);
    setContextMenuCellHighlightId(null);
  }, []);

  const handleContextCopyShift = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'shift' || !contextMenu.shiftId) return;
    handleCopyShiftToClipboard(contextMenu.shiftId);
    closeContextMenu();
  }, [closeContextMenu, contextMenu, handleCopyShiftToClipboard]);

  const handleContextPasteShift = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'cell' || !contextMenu.cellId) return;
    const cellId = contextMenu.cellId;
    setActiveCellId(cellId);
    closeContextMenu();
    await handlePasteShiftFromClipboard(cellId);
  }, [closeContextMenu, contextMenu, handlePasteShiftFromClipboard]);

  const handleContextDeleteShift = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'shift' || !contextMenu.shiftId) return;
    closeContextMenu();
    setConfirmDeleteShiftId(contextMenu.shiftId);
    setConfirmDeleteOpen(true);
    setConfirmDeleteLoading(false);
  }, [closeContextMenu, contextMenu]);

  const closeConfirmDelete = useCallback(() => {
    if (confirmDeleteLoading) return;
    setConfirmDeleteOpen(false);
    setConfirmDeleteShiftId(null);
  }, [confirmDeleteLoading]);

  const handleConfirmDeleteShift = useCallback(async () => {
    const shiftId = confirmDeleteShiftId;
    if (!shiftId) return;
    if (!isManager) {
      showToast('Not permitted', 'error');
      return;
    }
    setConfirmDeleteLoading(true);
    setOptimisticDeletedShiftIds((prev) => (prev.includes(shiftId) ? prev : [...prev, shiftId]));
    try {
      const result = await deleteShift(shiftId);
      if (!result.success) {
        setOptimisticDeletedShiftIds((prev) => prev.filter((id) => id !== shiftId));
        showToast(`Delete failed: ${result.error ?? 'Unknown error'}`, 'error');
        return;
      }
      setOptimisticDeletedShiftIds((prev) => prev.filter((id) => id !== shiftId));
      showToast('Shift deleted', 'success');
      setConfirmDeleteOpen(false);
      setConfirmDeleteShiftId(null);
    } catch (error) {
      setOptimisticDeletedShiftIds((prev) => prev.filter((id) => id !== shiftId));
      const message = error instanceof Error ? error.message : String(error);
      showToast(`Delete failed: ${message}`, 'error');
    } finally {
      setConfirmDeleteLoading(false);
    }
  }, [confirmDeleteShiftId, deleteShift, isManager, showToast]);

  const clearDayReassignState = useCallback(() => {
    setDraggingShiftId(null);
    setDragOverCellId(null);
    setDragOrigin(null);
    setDayMoveTimeTooltip(null);
    dragStartRef.current = null;
  }, []);

  const markShiftMovePending = useCallback((shiftId: string, pending: boolean) => {
    setPendingMoveShiftIds((prev) => {
      if (pending) {
        if (prev.includes(shiftId)) return prev;
        return [...prev, shiftId];
      }
      return prev.filter((id) => id !== shiftId);
    });
  }, []);

  const commitShiftMove = useCallback(async ({
    shiftId,
    targetUserId,
    targetDate,
    startHour,
    endHour,
  }: {
    shiftId: string;
    targetUserId: string;
    targetDate: string;
    startHour: number;
    endHour: number;
  }) => {
    const previousMove = optimisticShiftMoves[shiftId];
    setOptimisticShiftMoves((prev) => ({
      ...prev,
      [shiftId]: {
        employeeId: targetUserId,
        date: targetDate,
      },
    }));
    markShiftMovePending(shiftId, true);
    setIsPendingRowMove(true);

    try {
      const result = await updateShift(shiftId, {
        employeeId: targetUserId,
        date: targetDate,
        startHour,
        endHour,
      });

      if (!result.success) {
        setOptimisticShiftMoves((prev) => {
          const next = { ...prev };
          if (previousMove) {
            next[shiftId] = previousMove;
          } else {
            delete next[shiftId];
          }
          return next;
        });
        const requestId = (result as Record<string, unknown>).requestId;
        const requestSuffix = typeof requestId === 'string' ? ` (request: ${requestId})` : '';
        showToast(`Move failed: ${result.error ?? 'Unknown error'}${requestSuffix}`, 'error');
        return false;
      }

      setOptimisticShiftMoves((prev) => {
        const next = { ...prev };
        delete next[shiftId];
        return next;
      });
      return true;
    } catch (error) {
      setOptimisticShiftMoves((prev) => {
        const next = { ...prev };
        if (previousMove) {
          next[shiftId] = previousMove;
        } else {
          delete next[shiftId];
        }
        return next;
      });
      const message = error instanceof Error ? error.message : String(error);
      showToast(`Move failed: ${message}`, 'error');
      return false;
    } finally {
      markShiftMovePending(shiftId, false);
      setIsPendingRowMove(false);
    }
  }, [markShiftMovePending, optimisticShiftMoves, showToast, updateShift]);

  const handleDayDragStart = useCallback((event: DragStartEvent) => {
    if (!dayReassignEnabled) return;
    const dragTarget = parseTimelineShiftId(event.active.id);
    if (!dragTarget) return;
    if (pendingMoveShiftIds.includes(dragTarget.shiftId)) return;
    setDraggingShiftId(dragTarget.shiftId);
    if (process.env.NODE_ENV !== 'production') {
      showToast('Drag start', 'success');
    }
    const sourceShift = shiftsForRender.find((shift) => shift.id === dragTarget.shiftId && !shift.isBlocked);
    if (sourceShift) {
      setDragOrigin({
        shiftId: sourceShift.id,
        employeeId: sourceShift.employeeId,
        date: sourceShift.date,
        startHour: sourceShift.startHour,
        endHour: sourceShift.endHour,
      });
    } else {
      setDragOrigin(null);
    }
    const point = getClientPointFromEvent(event.activatorEvent);
    dragStartRef.current = {
      startX: point?.x ?? 0,
      startY: point?.y ?? 0,
      originUserId: sourceShift?.employeeId ?? '',
    };
    if (sourceShift && point) {
      setDayMoveTimeTooltip({
        left: point.x + 12,
        top: point.y - 28,
        label: `${formatHour(sourceShift.startHour)}-${formatHour(sourceShift.endHour)}`,
      });
    }
  }, [dayReassignEnabled, pendingMoveShiftIds, shiftsForRender, showToast]);

  const handleDayDragMove = useCallback((event: DragMoveEvent) => {
    if (!dayReassignEnabled) return;
    const dragTarget = parseTimelineShiftId(event.active.id);
    if (!dragTarget) return;
    const sourceShift = shiftsForRender.find(
      (shift) => shift.id === dragTarget.shiftId && !shift.isBlocked && !optimisticDeletedShiftIdSet.has(shift.id)
    );
    if (!sourceShift) {
      setDayMoveTimeTooltip(null);
      return;
    }
    const startPoint = dragStartRef.current;
    if (!startPoint) return;

    const overId = event.over ? String(event.over.id) : null;
    const parsedTarget = overId ? parseTimelineCellId(overId) : null;
    const allowCrossEmployee = Math.abs(event.delta.y) >= CROSS_EMPLOYEE_Y_THRESHOLD_PX;
    const targetUserId = allowCrossEmployee && parsedTarget ? parsedTarget.userId : sourceShift.employeeId;
    const employeeChanged = sourceShift.employeeId !== targetUserId;
    const dateChanged = Boolean(parsedTarget && sourceShift.date !== parsedTarget.date);
    const preview = !employeeChanged && !dateChanged
      ? getSnappedDayMoveResult(sourceShift, event.delta.x, pxPerHourRef.current)
      : {
          startHour: sourceShift.startHour,
          endHour: sourceShift.endHour,
          changed: false,
          snappedDeltaMinutes: 0,
        };

    setDayMoveTimeTooltip({
      left: startPoint.startX + event.delta.x + 12,
      top: startPoint.startY + event.delta.y - 28,
      label: `${formatHour(preview.startHour)}-${formatHour(preview.endHour)}`,
    });
  }, [dayReassignEnabled, optimisticDeletedShiftIdSet, shiftsForRender]);

  const handleDayDragOver = useCallback((event: DragOverEvent) => {
    if (!dayReassignEnabled) return;
    const overRawId = event.over?.id;
    if (!overRawId) {
      setDragOverCellId(null);
      return;
    }
    const parsedTarget = parseTimelineCellId(overRawId);
    setDragOverCellId(parsedTarget ? buildTimelineCellId(parsedTarget.organizationId, parsedTarget.userId, parsedTarget.date) : null);
  }, [dayReassignEnabled]);

  const handleDayDragEnd = useCallback(async (event: DragEndEvent) => {
    const dragTarget = parseTimelineShiftId(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const parsedTarget = overId ? parseTimelineCellId(overId) : null;

    if (!dayReassignEnabled || !dragTarget) {
      clearDayReassignState();
      return;
    }

    const sourceShift = shiftsForRender.find(
      (shift) => shift.id === dragTarget.shiftId && !shift.isBlocked && !optimisticDeletedShiftIdSet.has(shift.id)
    );
    if (!sourceShift) {
      clearDayReassignState();
      return;
    }

    if (pendingMoveShiftIds.includes(sourceShift.id)) {
      clearDayReassignState();
      return;
    }

    if (!overId || !parsedTarget) {
      if (process.env.NODE_ENV !== 'production') {
        showToast('No drop target detected', 'error');
      }
      clearDayReassignState();
      return;
    }

    if (parsedTarget.userId === 'unassigned') {
      if (process.env.NODE_ENV !== 'production') {
        showToast('Drop target invalid (unassigned)', 'error');
      }
      clearDayReassignState();
      return;
    }

    if (!activeRestaurantId || parsedTarget.organizationId !== activeRestaurantId || !isEditableDate(parsedTarget.date)) {
      if (process.env.NODE_ENV !== 'production') {
        showToast('Drop blocked (permissions/date/etc.)', 'error');
      }
      clearDayReassignState();
      return;
    }

    const allowCrossEmployee = Math.abs(event.delta.y) >= CROSS_EMPLOYEE_Y_THRESHOLD_PX;
    const targetUserId = allowCrossEmployee ? parsedTarget.userId : sourceShift.employeeId;
    const targetHasTimeOff = hasApprovedTimeOff(targetUserId, parsedTarget.date);
    if (targetHasTimeOff) {
      showToast('Move failed: Employee has approved time off on this date', 'error');
      clearDayReassignState();
      return;
    }
    const targetHasBlockedShift = hasBlockedShiftOnDate(targetUserId, parsedTarget.date);
    if (targetHasBlockedShift) {
      showToast('Move failed: This employee is blocked out on that date', 'error');
      clearDayReassignState();
      return;
    }
    if (hasOrgBlackoutOnDate(parsedTarget.date)) {
      showToast('Move failed: Organization blackout day cannot receive shifts.', 'error');
      clearDayReassignState();
      return;
    }

    const employeeChanged = sourceShift.employeeId !== targetUserId;
    const dateChanged = sourceShift.date !== parsedTarget.date;
    if (!employeeChanged && !dateChanged) {
      const snappedMove = getSnappedDayMoveResult(sourceShift, event.delta.x, pxPerHourRef.current);
      if (!snappedMove.changed || snappedMove.snappedDeltaMinutes === 0) {
        clearDayReassignState();
        return;
      }
      clearDayReassignState();
      await commitShiftMove({
        shiftId: sourceShift.id,
        targetUserId: sourceShift.employeeId,
        targetDate: sourceShift.date,
        startHour: snappedMove.startHour,
        endHour: snappedMove.endHour,
      });
      return;
    }

    clearDayReassignState();
    await commitShiftMove({
      shiftId: sourceShift.id,
      targetUserId,
      targetDate: parsedTarget.date,
      startHour: sourceShift.startHour,
      endHour: sourceShift.endHour,
    });
  }, [
    activeRestaurantId,
    commitShiftMove,
    clearDayReassignState,
    dayReassignEnabled,
    hasApprovedTimeOff,
    hasBlockedShiftOnDate,
    hasOrgBlackoutOnDate,
    isEditableDate,
    optimisticDeletedShiftIdSet,
    pendingMoveShiftIds,
    shiftsForRender,
    showToast,
  ]);

  const handleDayDragCancel = useCallback(() => {
    clearDayReassignState();
  }, [clearDayReassignState]);

  const groupedRows = useMemo(() => {
    if (filteredEmployees.length === 0) return [];
    const rangeStart = toDateString(rangeStartDate);
    const rangeEnd = toDateString(rangeEndDate);
    const jobIndex = (job: string) => {
      const idx = jobOrder.indexOf(job);
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };

    const filteredIds = new Set(filteredEmployees.map((employee) => employee.id));
    const earliestByEmployee = new Map<string, { date: string; startHour: number; job: string }>();
    const earliestStartByEmployee = new Map<string, number>();

    shiftsForRender.forEach((shift) => {
      if (shift.isBlocked) return;
      if (!filteredIds.has(shift.employeeId)) return;
      if (shift.date < rangeStart || shift.date > rangeEnd) return;
      const jobName = shift.job ?? 'Unassigned';
      const existing = earliestByEmployee.get(shift.employeeId);
      if (!existing) {
        earliestByEmployee.set(shift.employeeId, { date: shift.date, startHour: shift.startHour, job: jobName });
        return;
      }
      if (shift.date < existing.date) {
        earliestByEmployee.set(shift.employeeId, { date: shift.date, startHour: shift.startHour, job: jobName });
        return;
      }
      if (shift.date === existing.date) {
        if (shift.startHour < existing.startHour) {
          earliestByEmployee.set(shift.employeeId, { date: shift.date, startHour: shift.startHour, job: jobName });
          return;
        }
        if (shift.startHour === existing.startHour && jobIndex(jobName) < jobIndex(existing.job)) {
          earliestByEmployee.set(shift.employeeId, { date: shift.date, startHour: shift.startHour, job: jobName });
        }
      }
    });

    // Sort rows within each job by earliest start time on the selected day.
    shiftsForRender.forEach((shift) => {
      if (shift.isBlocked) return;
      if (!filteredIds.has(shift.employeeId)) return;
      if (shift.date !== dateString) return;
      const minutes = shift.startHour * 60;
      const existing = earliestStartByEmployee.get(shift.employeeId);
      if (!Number.isFinite(existing) || minutes < (existing ?? Infinity)) {
        earliestStartByEmployee.set(shift.employeeId, minutes);
      }
    });

    const groups = new Map<string, typeof filteredEmployees>();
    const assignToGroup = (job: string, employee: (typeof filteredEmployees)[number]) => {
      if (!groups.has(job)) groups.set(job, []);
      groups.get(job)!.push(employee);
    };

    filteredEmployees.forEach((employee) => {
      const earliest = earliestByEmployee.get(employee.id);
      const preferredJob = earliest?.job && jobOrder.includes(earliest.job) ? earliest.job : 'Unassigned';
      assignToGroup(preferredJob, employee);
    });

    groups.forEach((list) => {
      list.sort((a, b) => {
        const aStart = earliestStartByEmployee.get(a.id);
        const bStart = earliestStartByEmployee.get(b.id);
        const aHas = Number.isFinite(aStart);
        const bHas = Number.isFinite(bStart);
        if (aHas && bHas && aStart !== bStart) return (aStart ?? 0) - (bStart ?? 0);
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        const nameCompare = a.name.localeCompare(b.name);
        if (nameCompare !== 0) return nameCompare;
        return a.id.localeCompare(b.id);
      });
    });

    const rows: Array<
      | { type: 'group'; job: string; count: number }
      | { type: 'employee'; employee: (typeof filteredEmployees)[number]; group: string }
    > = [];

    jobOrder.forEach((job) => {
      const list = groups.get(job);
      if (!list || list.length === 0) return;
      rows.push({ type: 'group', job, count: list.length });
      list.forEach((employee) => rows.push({ type: 'employee', employee, group: job }));
    });

    const unassigned = groups.get('Unassigned');
    if (unassigned && unassigned.length > 0) {
      rows.push({ type: 'group', job: 'Unassigned', count: unassigned.length });
      unassigned.forEach((employee) => rows.push({ type: 'employee', employee, group: 'Unassigned' }));
    }

    return rows;
  }, [dateString, filteredEmployees, jobOrder, rangeEndDate, rangeStartDate, shiftsForRender]);

  // Fit timeline grid width to available space
  useLayoutEffect(() => {
    if (continuousDays) return;
    const el = gridScrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((prev) => (Math.abs(prev - nextWidth) > 0.5 ? nextWidth : prev));
    };

    updateWidth(el.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextWidth = entry.contentRect.width;
      if (timelineResizeRafRef.current !== null) {
        cancelAnimationFrame(timelineResizeRafRef.current);
      }
      timelineResizeRafRef.current = requestAnimationFrame(() => {
        timelineResizeRafRef.current = null;
        updateWidth(nextWidth);
      });
    });

    observer.observe(el);

    return () => {
      if (timelineResizeRafRef.current !== null) {
        cancelAnimationFrame(timelineResizeRafRef.current);
        timelineResizeRafRef.current = null;
      }
      observer.disconnect();
    };
  }, [continuousDays]);

  // Single-day mode values
  const dayOfWeek = selectedDate.getDay();
  const { startHour: HOURS_START, endHour: HOURS_END } = getEffectiveHourRange(dayOfWeek);
  const TOTAL_HOURS = HOURS_END - HOURS_START;
  const totalHoursForScale = Math.max(1, TOTAL_HOURS);
  const gridViewportWidth = timelineWidthPx > 0 ? timelineWidthPx : totalHoursForScale * DEFAULT_PX_PER_HOUR;
  const pxPerHour = continuousDays ? DEFAULT_PX_PER_HOUR : gridViewportWidth / totalHoursForScale;
  useEffect(() => {
    pxPerHourRef.current = pxPerHour;
  }, [pxPerHour]);
  const pixelsPerMinute = pxPerHour / 60;
  const MOVE_SNAP_PX = pixelsPerMinute * DAY_MOVE_SNAP_MINUTES;
  const snapPx = useCallback((value: number) => {
    if (!Number.isFinite(value) || MOVE_SNAP_PX <= 0) return value;
    return Math.round(value / MOVE_SNAP_PX) * MOVE_SNAP_PX;
  }, [MOVE_SNAP_PX]);
  const snapToHalfHourModifier = useMemo<Modifier>(() => {
    return ({ transform }) => {
      if (!dayReassignEnabled) return transform;
      return {
        ...transform,
        x: snapPx(transform.x),
      };
    };
  }, [dayReassignEnabled, snapPx]);
  const singleDayHours = Array.from({ length: TOTAL_HOURS }, (_, i) => HOURS_START + i);
  const singleDayGridWidth = TOTAL_HOURS * pxPerHour;
  // Continuous mode values
  const continuousGridWidth = CONTINUOUS_TOTAL_HOURS * pxPerHour;

  const continuousDaysData = useMemo(() => {
    if (!continuousDays) return [];
    return Array.from({ length: CONTINUOUS_DAYS_COUNT }, (_, dayIndex) => {
      const date = addDays(windowStartDate, dayIndex);
      return {
        dayIndex,
        date,
        dateString: toDateString(date),
        hours: Array.from({ length: 24 }, (_, h) => h),
      };
    });
  }, [continuousDays, windowStartDate]);

  const continuousShifts = useMemo(() => {
    if (!continuousDays) return [];
    const dateStrings = continuousDaysData.map((d) => d.dateString);
    return shiftsForRender.filter(
      (s) => dateStrings.includes(s.date) && !s.isBlocked && !optimisticDeletedShiftIdSet.has(s.id)
    );
  }, [continuousDays, continuousDaysData, optimisticDeletedShiftIdSet, shiftsForRender]);

  const getDayIndexForDateString = useCallback(
    (targetDate: string) => continuousDaysData.findIndex((d) => d.dateString === targetDate),
    [continuousDaysData]
  );


  // Parse business hours for a specific day of week
  const parseTimeToDecimal = (value?: string | null) => {
    if (!value) return 0;
    const [hours, minutes = '0'] = value.split(':');
    const hour = Number(hours);
    const minute = Number(minutes);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return 0;
    return hour + minute / 60;
  };

  const getBusinessHoursForDate = useCallback((date: Date) => {
    const dow = date.getDay();
    const dayRanges = businessHours
      .filter((row) => row.dayOfWeek === dow && row.enabled && row.openTime && row.closeTime)
      .map((row) => {
        const openHour = parseTimeToDecimal(row.openTime);
        const closeHour = parseTimeToDecimal(row.closeTime);
        return closeHour > openHour ? { openHour, closeHour } : null;
      })
      .filter((range): range is { openHour: number; closeHour: number } => Boolean(range));
    if (dayRanges.length === 0) return null;
    dayRanges.sort((a, b) => a.openHour - b.openHour);
    const minOpen = Math.min(...dayRanges.map((r) => r.openHour));
    const maxClose = Math.max(...dayRanges.map((r) => r.closeHour));
    return { openHour: minOpen, closeHour: maxClose, ranges: dayRanges };
  }, [businessHours]);

  const getBusinessHoursForDateString = useCallback(
    (dateString: string) => getBusinessHoursForDate(dateFromDateString(dateString)),
    [getBusinessHoursForDate]
  );

  const getCenteredStartHour = useCallback(
    (hoveredHour: number, businessStart: number, businessEnd: number) => {
      const hoveredMinutes = hoveredHour * 60;
      const centeredStartMinutes = hoveredMinutes - 30;
      const roundedStartMinutes = Math.round(centeredStartMinutes / 30) * 30;
      const minStartMinutes = businessStart * 60;
      const maxStartMinutes = businessEnd * 60 - 60;
      const clampedStartMinutes = Math.max(minStartMinutes, Math.min(maxStartMinutes, roundedStartMinutes));
      return clampedStartMinutes / 60;
    },
    []
  );

  const businessHoursForDay = useMemo(() => {
    return getBusinessHoursForDate(selectedDate);
  }, [getBusinessHoursForDate, selectedDate]);

  const isWithinBusinessHours = useCallback(
    (bh: { ranges: Array<{ openHour: number; closeHour: number }> } | null, startHour: number, endHour: number) => {
      if (!bh) return false;
      return bh.ranges.some((range) => startHour >= range.openHour && endHour <= range.closeHour);
    },
    []
  );

  // ─────────────────────────────────────────────────────────────────
  // Position helpers
  // ─────────────────────────────────────────────────────────────────

  // Single-day mode: position as percentage
  const getShiftPositionForRange = useCallback((startHour: number, endHour: number) => {
    const left = ((startHour - HOURS_START) / TOTAL_HOURS) * 100;
    const width = ((endHour - startHour) / TOTAL_HOURS) * 100;
    return {
      left: `${Math.max(0, left)}%`,
      width: `${Math.min(100 - Math.max(0, left), Math.max(0, width))}%`,
    };
  }, [HOURS_START, TOTAL_HOURS]);

  // Continuous mode: position in pixels based on absolute time within window
  const getShiftPositionContinuous = useCallback((shiftDate: string, startHour: number, endHour: number) => {
    // Find which day this shift belongs to
    const dayIndex = continuousDaysData.findIndex(d => d.dateString === shiftDate);
    if (dayIndex === -1) return null;

    // Calculate pixel offset from window start
    const hoursFromWindowStart = dayIndex * 24 + startHour;
    const leftPx = hoursFromWindowStart * pxPerHour;
    const widthPx = (endHour - startHour) * pxPerHour;

    return { leftPx, widthPx };
  }, [continuousDaysData, pxPerHour]);

  // ─────────────────────────────────────────────────────────────────
  // Current time indicator
  // ─────────────────────────────────────────────────────────────────
  const now = new Date();
  const todayDateString = toDateString(now);
  const currentHour = now.getHours() + now.getMinutes() / 60;
  const isToday = selectedDate.toDateString() === now.toDateString();

  // Single-day current time position
  const currentTimePosition = isToday && currentHour >= HOURS_START && currentHour <= HOURS_END
    ? ((currentHour - HOURS_START) / TOTAL_HOURS) * 100
    : null;

  // Continuous mode current time position (in pixels)
  const currentTimePositionContinuous = useMemo(() => {
    if (!continuousDays) return null;
    const dayIndex = continuousDaysData.findIndex(d => d.dateString === todayDateString);
    if (dayIndex === -1) return null;
    return (dayIndex * 24 + currentHour) * pxPerHour;
  }, [continuousDays, continuousDaysData, currentHour, pxPerHour, todayDateString]);

  // ─────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────


  // Recenter scroll to a specific date in week view.
  // Keep this above any hooks that call it to avoid TDZ in dependency arrays.
  const scrollToDate = useCallback((targetDate: Date) => {
    if (!continuousDays || !gridScrollRef.current) return;
    const normalizedTarget = getMidnight(targetDate);
    const weekStart = getWeekRange(normalizedTarget, weekStartDay).start;
    const dayIndex = Math.floor((normalizedTarget.getTime() - weekStart.getTime()) / DAY_MS);
    const clampedIndex = Math.max(0, Math.min(CONTINUOUS_DAYS_COUNT - 1, dayIndex));

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (gridScrollRef.current) {
          const el = gridScrollRef.current;
          const targetDayBusinessHours = getBusinessHoursForDate(normalizedTarget);
          const centerHour = targetDayBusinessHours ? targetDayBusinessHours.openHour + 2 : 12;
          const hoursFromWindowStart = clampedIndex * 24 + centerHour;
          const desired = hoursFromWindowStart * pxPerHour - el.clientWidth / 2;
          const maxScroll = el.scrollWidth - el.clientWidth;
          el.scrollLeft = Math.max(0, Math.min(maxScroll, desired));
        }
      });
    });
  }, [continuousDays, getBusinessHoursForDate, pxPerHour, weekStartDay]);

  useEffect(() => {
    scrollToDateRef.current = scrollToDate;
  }, [scrollToDate]);

  // When toggling continuous mode ON, initialize window around selectedDate.
  // Note: handleGoToDate handles scrolling for navigation, so this only triggers on mode toggle.
  const prevContinuousDaysRef = useRef(continuousDays);
  useEffect(() => {
    const wasOff = !prevContinuousDaysRef.current;
    const isNowOn = continuousDays;
    prevContinuousDaysRef.current = continuousDays;
    // Only initialize when toggling from OFF to ON
    if (wasOff && isNowOn) {
      scrollToDateRef.current(selectedDate);
    }
  }, [continuousDays, selectedDate]);

  const handleGoToDate = useCallback((targetDate: Date, options?: { reanchor?: boolean }) => {
    const normalized = getMidnight(targetDate);
    if (continuousDays) {
      setSelectedDate(normalized);
      scrollToDateRef.current(normalized, { reanchor: options?.reanchor });
      return;
    }
    setSelectedDate(normalized);
  }, [continuousDays, setSelectedDate]);

  // ─────────────────────────────────────────────────────────────────
  // Continuous mode: Recycling (infinite scroll feel)
  // ─────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────
  // Shift interaction helpers
  // ─────────────────────────────────────────────────────────────────
  const getSingleDayXInGridPx = useCallback((clientX: number) => {
    if (!gridScrollRef.current) return null;
    const el = gridScrollRef.current;
    const rect = el.getBoundingClientRect();
    const xInGrid = clientX - rect.left + el.scrollLeft;
    return { rect, xInGrid, scrollWidth: el.scrollWidth };
  }, []);

  const getHourFromClientX = useCallback((clientX: number): number => {
    const metrics = getSingleDayXInGridPx(clientX);
    if (!metrics) return HOURS_START;
    const percentage = metrics.xInGrid / (metrics.scrollWidth || metrics.rect.width);
    const hour = HOURS_START + percentage * TOTAL_HOURS;
    return Math.max(HOURS_START, Math.min(HOURS_END, Math.round(hour * 4) / 4));
  }, [HOURS_START, HOURS_END, TOTAL_HOURS, getSingleDayXInGridPx]);

  const getSnappedStartHourFromClientX = useCallback((clientX: number): number | null => {
    const metrics = getSingleDayXInGridPx(clientX);
    if (!metrics) return null;
    const hourIndex = Math.floor(metrics.xInGrid / pxPerHour);
    const clampedIndex = Math.max(0, Math.min(TOTAL_HOURS - 1, hourIndex));
    return HOURS_START + clampedIndex;
  }, [HOURS_START, TOTAL_HOURS, getSingleDayXInGridPx, pxPerHour]);

  // Absolute grid mapping for move/resize - use full scroll width, not view hours.
  const getDayMinutesFromClientX = useCallback((clientX: number): number => {
    if (!gridScrollRef.current) return 0;
    const el = gridScrollRef.current;
    const rect = el.getBoundingClientRect();
    const xInGrid = clientX - rect.left + el.scrollLeft;
    const totalMinutes = 24 * 60;
    const minutes = (xInGrid / el.scrollWidth) * totalMinutes;
    return Math.max(0, Math.min(totalMinutes, minutes));
  }, []);

  const getContinuousMinutesFromClientX = useCallback((clientX: number): number => {
    if (!gridScrollRef.current) return 0;
    const el = gridScrollRef.current;
    const rect = el.getBoundingClientRect();
    const xInGrid = clientX - rect.left + el.scrollLeft;
    const totalMinutes = CONTINUOUS_TOTAL_HOURS * 60;
    const minutes = (xInGrid / el.scrollWidth) * totalMinutes;
    return Math.max(0, Math.min(totalMinutes, minutes));
  }, []);

  const getContinuousGridMetrics = useCallback((clientX: number) => {
    if (!gridScrollRef.current) return null;
    const el = gridScrollRef.current;
    const rect = el.getBoundingClientRect();
    const gridLeft = rect.left;
    const scrollLeft = el.scrollLeft;
    const xInGrid = clientX - gridLeft + scrollLeft;
    return { el, gridLeft, scrollLeft, xInGrid, pxPerHour, windowStartDate };
  }, [windowStartDate, pxPerHour]);

  const getContinuousHourInfoFromClientX = useCallback((clientX: number) => {
    const metrics = getContinuousGridMetrics(clientX);
    if (!metrics) return null;
    const hoursFromStart = metrics.xInGrid / pxPerHour;
    const dayIndex = Math.floor(hoursFromStart / 24);
    const hourInDay = hoursFromStart % 24;
    return { hoursFromStart, dayIndex, hourInDay, el: metrics.el, scrollLeft: metrics.scrollLeft, xInGrid: metrics.xInGrid };
  }, [getContinuousGridMetrics, pxPerHour]);

  // For continuous mode: get hour and date from clientX
  const getHourAndDateFromClientX = useCallback((clientX: number): { hour: number; date: string } | null => {
    if (!continuousDays || !gridScrollRef.current) return null;

    const info = getContinuousHourInfoFromClientX(clientX);
    if (!info) return null;
    const { dayIndex, hourInDay } = info;

    if (dayIndex < 0 || dayIndex >= CONTINUOUS_DAYS_COUNT) return null;

    const targetDate = addDays(windowStartDate, dayIndex);
    return {
      hour: Math.max(0, Math.min(24, Math.round(hourInDay * 4) / 4)),
      date: toDateString(targetDate),
    };
  }, [continuousDays, windowStartDate, getContinuousHourInfoFromClientX]);

  const openShiftEditor = useCallback(
    (shift: typeof scopedShifts[0]) => {
      if (shift.isBlocked) return;
      if (!isManager) return;
      if (!isEditableDate(shift.date)) {
        showToast("Past schedules can't be edited.", 'error');
        return;
      }
      openModal('editShift', shift);
    },
    [isEditableDate, isManager, openModal, showToast]
  );

  const showTooltipFn = (shiftId: string, target: HTMLElement) => {
    const shift = scopedShifts.find((s) => s.id === shiftId);
    if (!shift) return;
    const employee = filteredEmployees.find((emp) => emp.id === shift.employeeId);
    const locationName = shift.locationId ? locationMap.get(shift.locationId) : undefined;
    const rect = target.getBoundingClientRect();
    const tooltipWidth = 200;
    const tooltipHeight = locationName ? 88 : 72;
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
    let left = rect.left + rect.width / 2 - tooltipWidth / 2;
    left = Math.max(12, Math.min(viewportWidth - tooltipWidth - 12, left));
    let top = rect.top - tooltipHeight - 8;
    if (top < 8) {
      top = rect.bottom + 8;
    }
    setTooltip({
      shiftId,
      left,
      top,
      employeeName: employee?.name || 'Unknown',
      job: shift.job,
      location: locationName,
      time: `${formatHour(shift.startHour)} - ${formatHour(shift.endHour)}`,
    });
  };

  const handleEmptyClick = (employeeId: string, e: React.MouseEvent, targetDate?: string) => {
    const dateToUse = targetDate || dateString;
    if (!isManager) return;
    if (!isEditableDate(dateToUse)) {
      showToast("Past schedules can't be edited.", 'error');
      return;
    }
    const baseHour = continuousDays
      ? (getHourAndDateFromClientX(e.clientX)?.hour ?? 9)
      : getHourFromClientX(e.clientX);
    const hour = hoveredAddSlot?.employeeId === employeeId && hoveredAddSlot.date === dateToUse
      ? hoveredAddSlot.startHour
      : baseHour;
    const businessHours = continuousDays
      ? getBusinessHoursForDateString(dateToUse)
      : businessHoursForDay;
    if (!businessHours) return;
    if (!isWithinBusinessHours(businessHours, hour, hour + 1)) return;
    const defaultEnd = Math.round((hour + 1) * 4) / 4;

    const hasOverlap = scopedShifts.some(
      (shift) =>
        shift.employeeId === employeeId &&
        shift.date === dateToUse &&
        !shift.isBlocked &&
        shiftsOverlap(hour, defaultEnd, shift.startHour, shift.endHour)
    );
    if (hasOverlap) {
      showToast('Shift overlaps with existing shift', 'error');
      return;
    }
    openModal('addShift', {
      employeeId,
      date: dateToUse,
      startHour: hour,
      endHour: defaultEnd,
    });
  };
  const updateHoverAddSlot = useCallback((employeeId: string, clientX: number, target: EventTarget | null) => {
    if (lastPointerTypeRef.current === 'touch') {
      setHoveredAddSlot(null);
      return;
    }
    if (isDragScrolling || activeDragRef.current) {
      setHoveredAddSlot(null);
      return;
    }
    const element = target as HTMLElement | null;
    if (element?.closest(NON_GRAB_SCROLL_SELECTOR)) {
      setHoveredAddSlot(null);
      return;
    }
    if (continuousDays) {
      const info = getContinuousHourInfoFromClientX(clientX);
      if (!info) {
        setHoveredAddSlot(null);
        return;
      }
      if (info.dayIndex < 0 || info.dayIndex >= CONTINUOUS_DAYS_COUNT) {
        setHoveredAddSlot(null);
        return;
      }
      const targetDate = addDays(windowStartDate, info.dayIndex);
      const dateValue = toDateString(targetDate);
      if (!isEditableDate(dateValue)) {
        setHoveredAddSlot(null);
        return;
      }
      const bh = getBusinessHoursForDate(targetDate);
      if (!bh) {
        setHoveredAddSlot(null);
        return;
      }
      const startHour = getCenteredStartHour(info.hourInDay, bh.openHour, bh.closeHour);
      const inside = isWithinBusinessHours(bh, startHour, startHour + 1);
      if (!inside) {
        setHoveredAddSlot(null);
        return;
      }
      setHoveredAddSlot((prev) => {
        if (
          prev &&
          prev.employeeId === employeeId &&
          prev.date === dateValue &&
          prev.startHour === startHour &&
          prev.absHoursFromWindowStart === info.dayIndex * 24 + startHour
        ) {
          return prev;
        }
        return { employeeId, date: dateValue, startHour, absHoursFromWindowStart: info.dayIndex * 24 + startHour };
      });
      return;
    }
    if (!businessHoursForDay) {
      setHoveredAddSlot(null);
      return;
    }
    if (!isEditableDate(dateString)) {
      setHoveredAddSlot(null);
      return;
    }
    const startHour = getSnappedStartHourFromClientX(clientX);
    if (startHour === null) {
      setHoveredAddSlot(null);
      return;
    }
    const inside = isWithinBusinessHours(businessHoursForDay, startHour, startHour + 1);
    if (!inside) {
      setHoveredAddSlot(null);
      return;
    }
    setHoveredAddSlot((prev) => {
      if (prev && prev.employeeId === employeeId && prev.date === dateString && prev.startHour === startHour) {
        return prev;
      }
      return { employeeId, date: dateString, startHour };
    });
  }, [
    isDragScrolling,
    continuousDays,
    isEditableDate,
    getContinuousHourInfoFromClientX,
    getBusinessHoursForDate,
    getHourFromClientX,
    getSnappedStartHourFromClientX,
    businessHoursForDay,
    dateString,
    windowStartDate,
  ]);

  const clearHoverAddSlot = useCallback(() => {
    if (hoverRafRef.current !== null) {
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }
    hoverPendingRef.current = null;
    setHoveredAddSlot(null);
  }, []);
  const handleLanePointerMove = useCallback((employeeId: string, e: React.PointerEvent) => {
    if (!isManager) return;
    lastPointerTypeRef.current = e.pointerType as 'mouse' | 'pen' | 'touch';
    if (e.pointerType === 'touch') {
      clearHoverAddSlot();
      return;
    }
    hoverPendingRef.current = { employeeId, clientX: e.clientX, target: e.target };
    if (hoverRafRef.current !== null) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      const pending = hoverPendingRef.current;
      hoverPendingRef.current = null;
      hoverRafRef.current = null;
      if (!pending) return;
      updateHoverAddSlot(pending.employeeId, pending.clientX, pending.target);
    });
  }, [clearHoverAddSlot, isManager, updateHoverAddSlot]);

  const handleLaneMouseDown = (employeeId: string, e: React.MouseEvent) => {
    if (!isManager) return;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-shift]')) return;
    lanePointerRef.current = { x: e.clientX, y: e.clientY, employeeId };
  };

  const handleLaneMouseUp = (employeeId: string, e: React.MouseEvent, targetDate?: string) => {
    if (!isManager) return;
    if (!lanePointerRef.current) return;
    if ((e.target as HTMLElement).closest('[data-shift]')) {
      lanePointerRef.current = null;
      return;
    }
    if (Date.now() - lastDragAtRef.current < 200) {
      lanePointerRef.current = null;
      return;
    }
    const dx = e.clientX - lanePointerRef.current.x;
    const dy = e.clientY - lanePointerRef.current.y;
    const distance = Math.hypot(dx, dy);
    lanePointerRef.current = null;
    if (distance > 6) return;
    handleEmptyClick(employeeId, e, targetDate);
  };

  const isWithinBusinessHoursAtX = useCallback((clientX: number) => {
    if (continuousDays) {
      const info = getHourAndDateFromClientX(clientX);
      // If we can't determine position, allow grab scroll (return false = not in business hours)
      if (!info) return false;
      const bh = getBusinessHoursForDate(dateFromDateString(info.date));
      if (!bh) return false;
      return isWithinBusinessHours(bh, info.hour, info.hour);
    }
    if (!businessHoursForDay) return false;
    const hour = getHourFromClientX(clientX);
    return isWithinBusinessHours(businessHoursForDay, hour, hour);
  }, [
    continuousDays,
    getHourAndDateFromClientX,
    getBusinessHoursForDate,
    businessHoursForDay,
    getHourFromClientX,
    isWithinBusinessHours,
  ]);

  const shouldStartGrabScroll = useCallback((target: EventTarget | null, clientX: number) => {
    const element = target as HTMLElement | null;
    if (!element) return false;
    if (!element.closest(GRID_BACKGROUND_SELECTOR)) return false;
    if (element.closest(NON_GRAB_SCROLL_SELECTOR)) return false;
    if (isWithinBusinessHoursAtX(clientX)) return false;
    return true;
  }, [isWithinBusinessHoursAtX]);

  // ─────────────────────────────────────────────────────────────────
  // Drag-to-scroll handlers
  // ─────────────────────────────────────────────────────────────────
  const handleGridDragStart = useCallback((clientX: number) => {
    if (!gridScrollRef.current) return;
    setIsDragScrolling(true);
    isDragScrollingRef.current = true;
    setHoveredAddSlot(null);
    dragScrollRef.current = {
      startX: clientX,
      scrollLeft: gridScrollRef.current.scrollLeft,
      currentX: clientX,
    };
  }, []);

  const handleGridDragMove = useCallback((clientX: number) => {
    if (!isDragScrolling || !dragScrollRef.current || !gridScrollRef.current) return;

    const el = gridScrollRef.current;
    dragScrollRef.current.currentX = clientX;

    const dx = clientX - dragScrollRef.current.startX;
    const desired = dragScrollRef.current.scrollLeft - dx;
    if (continuousDays) {
      const maxScroll = el.scrollWidth - el.clientWidth;
      el.scrollLeft = Math.max(0, Math.min(maxScroll, desired));
    } else {
      el.scrollLeft = desired;
    }

    // In continuous mode, check for recycling
  }, [isDragScrolling, continuousDays]);

  const handleGridDragEnd = useCallback(() => {
    setIsDragScrolling(false);
    isDragScrollingRef.current = false;
    activePointerIdRef.current = null;
    dragScrollRef.current = null;
  }, []);

  const getGridBackgroundContext = useCallback((target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    if (!element) return null;
    const gridBgEl = element.closest(GRID_BACKGROUND_SELECTOR) as HTMLElement | null;
    if (!gridBgEl) return null;
    const employeeId = gridBgEl.getAttribute('data-employee-id');
    if (!employeeId) return null;
    return { gridBgEl, employeeId };
  }, []);

  const SNAP_MINUTES = 15;
  const MIN_DURATION_MINUTES = 15;
  const DRAG_ACTIVATION_DISTANCE = 4;
  const CLICK_DISTANCE = 2;
  const CLICK_DURATION_MS = 250;

  const snapMinutes = (value: number) => Math.round(value / SNAP_MINUTES) * SNAP_MINUTES;

  const resolveAbsoluteMinutes = useCallback(
    (absMinutes: number) => {
      const totalMinutes = CONTINUOUS_TOTAL_HOURS * 60;
      const clamped = Math.max(0, Math.min(totalMinutes, absMinutes));
      let dayOffset = Math.floor(clamped / (24 * 60));
      let minutesOfDay = clamped - dayOffset * 24 * 60;
      if (minutesOfDay < 0) {
        minutesOfDay += 24 * 60;
        dayOffset -= 1;
      }
      if (minutesOfDay >= 24 * 60) {
        minutesOfDay -= 24 * 60;
        dayOffset += 1;
      }
      return {
        date: toDateString(addDays(windowStartDate, dayOffset)),
        hour: minutesOfDay / 60,
      };
    },
    [windowStartDate]
  );

  const clampMoveRange = (startMinutes: number, endMinutes: number, minMinutes: number, maxMinutes: number) => {
    let nextStart = startMinutes;
    let nextEnd = endMinutes;
    if (nextStart < minMinutes) {
      const offset = minMinutes - nextStart;
      nextStart += offset;
      nextEnd += offset;
    }
    if (nextEnd > maxMinutes) {
      const offset = nextEnd - maxMinutes;
      nextStart -= offset;
      nextEnd -= offset;
    }
    if (nextEnd - nextStart < MIN_DURATION_MINUTES) {
      nextEnd = Math.min(maxMinutes, nextStart + MIN_DURATION_MINUTES);
      nextStart = Math.max(minMinutes, nextEnd - MIN_DURATION_MINUTES);
    }
    return { start: nextStart, end: nextEnd };
  };

  const clampResizeRange = (
    startMinutes: number,
    endMinutes: number,
    minMinutes: number,
    maxMinutes: number,
    edge: 'left' | 'right'
  ) => {
    let nextStart = startMinutes;
    let nextEnd = endMinutes;
    if (edge === 'left') {
      nextStart = Math.min(nextStart, nextEnd - MIN_DURATION_MINUTES);
      nextStart = Math.max(minMinutes, nextStart);
    } else {
      nextEnd = Math.max(nextEnd, nextStart + MIN_DURATION_MINUTES);
      nextEnd = Math.min(maxMinutes, nextEnd);
    }
    if (nextEnd - nextStart < MIN_DURATION_MINUTES) {
      nextEnd = Math.min(maxMinutes, nextStart + MIN_DURATION_MINUTES);
      nextStart = Math.max(minMinutes, nextEnd - MIN_DURATION_MINUTES);
    }
    return { start: nextStart, end: nextEnd };
  };
  const clearActiveDrag = useCallback(() => {
    const drag = activeDragRef.current;
    if (drag && pointerCaptureElRef.current) {
      try {
        pointerCaptureElRef.current.releasePointerCapture(drag.pointerId);
      } catch {
        // noop
      }
    }
    pointerCaptureElRef.current = null;
    activePointerIdRef.current = null;
    activeDragRef.current = null;
    setActiveDragShiftId(null);
    setActiveDragMode(null);
    setDragPreview((prev) => {
      if (!drag) return prev;
      const next = { ...prev };
      delete next[drag.shiftId];
      return next;
    });
    if (gridScrollRef.current) {
      gridScrollRef.current.style.touchAction = 'pan-y';
    }
  }, []);

  useEffect(() => {
    const overrides = commitOverridesRef.current;
    const ids = Object.keys(overrides);
    if (ids.length === 0) return;
    const EPS = 0.25;
    let changed = false;
    for (const shiftId of ids) {
      const override = overrides[shiftId];
      const shift = scopedShifts.find((s) => String(s.id) === String(shiftId));
      if (!shift) {
        delete overrides[shiftId];
        changed = true;
        continue;
      }
      if (shift.date !== override.startDate) continue;
      const startMatch = Math.abs(shift.startHour - override.startHour) <= EPS;
      const endMatch = Math.abs(shift.endHour - override.endHour) <= EPS;
      if (startMatch && endMatch) {
        delete overrides[shiftId];
        changed = true;
      }
    }
    if (changed) {
      setCommitOverridesVersion((v) => v + 1);
    }
  }, [scopedShifts, commitOverridesVersion]);

  useEffect(() => {
    const wasEdit = lastModalTypeRef.current === 'editShift';
    if (wasEdit && modalType !== 'editShift') {
      const pending = pendingShiftChangeRef.current;
      if (pending) {
        delete commitOverridesRef.current[pending.shiftId];
        setCommitOverridesVersion((v) => v + 1);
        setDragPreview((prev) => {
          if (!prev[pending.shiftId]) return prev;
          const next = { ...prev };
          delete next[pending.shiftId];
          return next;
        });
        pendingShiftChangeRef.current = null;
      }
    }
    lastModalTypeRef.current = modalType;
  }, [modalType]);

  const handleGridPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    lastPointerTypeRef.current = e.pointerType as 'mouse' | 'pen' | 'touch';
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activeDragRef.current) return;

    const target = e.target as HTMLElement | null;
    const handleEl = target?.closest('[data-resize-handle]') as HTMLElement | null;
    const bodyEl = target?.closest('[data-shift-body="true"]') as HTMLElement | null;
    const rootEl = (handleEl ?? bodyEl ?? target)?.closest('[data-shift-root="true"]') as HTMLElement | null;

    if ((handleEl || bodyEl || rootEl) && isManager) {
      if (!handleEl) {
        // Shift-body move is handled by dnd-kit in both day and continuous modes.
        return;
      }
      const shiftIdRaw = rootEl?.getAttribute('data-shift-id');
      const shift = shiftIdRaw ? scopedShifts.find((s) => String(s.id) === String(shiftIdRaw)) : null;
      if (!shift) return;
      if (!isEditableDate(shift.date)) {
        showToast("Past schedules can't be edited.", 'error');
        return;
      }

      const edge = handleEl?.getAttribute('data-resize-handle') ?? handleEl?.getAttribute('data-edge');
      const mode: 'move' | 'resize-left' | 'resize-right' = handleEl
        ? edge === 'left' || edge === 'start'
          ? 'resize-left'
          : 'resize-right'
        : 'move';

      const anchorPointerMin = continuousDays
        ? getContinuousMinutesFromClientX(e.clientX)
        : getDayMinutesFromClientX(e.clientX);
      const dayIndex = continuousDays ? getDayIndexForDateString(shift.date) : undefined;
      const effectiveDayIndex = dayIndex !== undefined && dayIndex >= 0 ? dayIndex : 0;
      const anchorStartMin = continuousDays
        ? effectiveDayIndex * 24 * 60 + shift.startHour * 60
        : shift.startHour * 60;
      const anchorEndMin = continuousDays
        ? effectiveDayIndex * 24 * 60 + shift.endHour * 60
        : shift.endHour * 60;

      activeDragRef.current = {
        pointerId: e.pointerId,
        mode,
        shiftId: String(shift.id),
        employeeId: shift.employeeId ? String(shift.employeeId) : null,
        anchorStartMin,
        anchorEndMin,
        anchorPointerMin,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startedAt: Date.now(),
        activated: false,
        moved: false,
        lastStartMin: anchorStartMin,
        lastEndMin: anchorEndMin,
        dayIndex: continuousDays ? effectiveDayIndex : undefined,
      };

      activePointerIdRef.current = e.pointerId;
      setHoveredAddSlot(null);
      if (gridScrollRef.current) {
        gridScrollRef.current.style.touchAction = 'none';
      }
      const captureEl = gridScrollRef.current ?? e.currentTarget;
      pointerCaptureElRef.current = captureEl;
      try {
        captureEl.setPointerCapture(e.pointerId);
      } catch {
        // noop
      }
      if (e.pointerType === 'mouse' && e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();
      return;
    }

    const ctx = getGridBackgroundContext(e.target);
    if (!ctx) return;
    if (shouldStartGrabScroll(e.target, e.clientX)) {
      e.preventDefault();
      activePointerIdRef.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // noop
      }
      handleGridDragStart(e.clientX);
      return;
    }
    if (e.pointerType !== 'touch') {
      handleLaneMouseDown(ctx.employeeId, e as unknown as React.MouseEvent);
    }
  }, [
    continuousDays,
    getContinuousMinutesFromClientX,
    getDayMinutesFromClientX,
    getDayIndexForDateString,
    getGridBackgroundContext,
    handleGridDragStart,
    handleLaneMouseDown,
    isEditableDate,
    isManager,
    scopedShifts,
    shouldStartGrabScroll,
    showToast,
  ]);

  const handleGridPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingShiftId) {
      clearHoverAddSlot();
      return;
    }
    const drag = activeDragRef.current;
    if (drag) {
      if (drag.pointerId !== e.pointerId) return;
      if (e.cancelable) e.preventDefault();
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      if (!drag.activated && dist >= DRAG_ACTIVATION_DISTANCE) {
        drag.activated = true;
        setActiveDragShiftId(drag.shiftId);
        setActiveDragMode(drag.mode);
      }
      if (!drag.activated) return;

      const pointerMin = continuousDays
        ? getContinuousMinutesFromClientX(e.clientX)
        : getDayMinutesFromClientX(e.clientX);
      const deltaMinutes = pointerMin - drag.anchorPointerMin;

      let nextStart = drag.anchorStartMin;
      let nextEnd = drag.anchorEndMin;
      if (drag.mode === 'move') {
        nextStart += deltaMinutes;
        nextEnd += deltaMinutes;
      } else if (drag.mode === 'resize-left') {
        nextStart += deltaMinutes;
      } else {
        nextEnd += deltaMinutes;
      }

      nextStart = snapMinutes(nextStart);
      nextEnd = snapMinutes(nextEnd);

      if (continuousDays) {
        const totalWindowMinutes = CONTINUOUS_TOTAL_HOURS * 60;
        let clamped;
        if (drag.mode === 'move') {
          const moved = clampMoveRange(nextStart, nextEnd, 0, totalWindowMinutes);
          const dayIndex = Math.floor(moved.start / (24 * 60));
          const dayStart = dayIndex * 24 * 60;
          const dayEnd = dayStart + 24 * 60;
          clamped = clampMoveRange(moved.start, moved.end, dayStart, dayEnd);
        } else {
          const dayIndex = drag.dayIndex ?? Math.floor(drag.anchorStartMin / (24 * 60));
          const dayStart = dayIndex * 24 * 60;
          const dayEnd = dayStart + 24 * 60;
          clamped = clampResizeRange(nextStart, nextEnd, dayStart, dayEnd, drag.mode === 'resize-left' ? 'left' : 'right');
        }
        drag.lastStartMin = clamped.start;
        drag.lastEndMin = clamped.end;
        drag.moved = true;
        const startInfo = resolveAbsoluteMinutes(clamped.start);
        const endInfo = resolveAbsoluteMinutes(clamped.end);
        setDragPreview((prev) => ({
          ...prev,
          [drag.shiftId]: { startHour: startInfo.hour, endHour: endInfo.hour, date: startInfo.date },
        }));
        return;
      }

      const clamped = drag.mode === 'move'
        ? clampMoveRange(nextStart, nextEnd, 0, 24 * 60)
        : clampResizeRange(nextStart, nextEnd, 0, 24 * 60, drag.mode === 'resize-left' ? 'left' : 'right');

      drag.lastStartMin = clamped.start;
      drag.lastEndMin = clamped.end;
      drag.moved = true;
      setDragPreview((prev) => ({
        ...prev,
        [drag.shiftId]: { startHour: clamped.start / 60, endHour: clamped.end / 60 },
      }));
      return;
    }

    if (isDragScrollingRef.current) {
      if (activePointerIdRef.current !== null && e.pointerId !== activePointerIdRef.current) return;
      e.preventDefault();
      handleGridDragMove(e.clientX);
      return;
    }

    const ctx = getGridBackgroundContext(e.target);
    if (!ctx) {
      clearHoverAddSlot();
      return;
    }
    handleLanePointerMove(ctx.employeeId, e);
  }, [
    clearHoverAddSlot,
    continuousDays,
    draggingShiftId,
    getContinuousMinutesFromClientX,
    getDayMinutesFromClientX,
    getGridBackgroundContext,
    handleGridDragMove,
    handleLanePointerMove,
  ]);

  const handleGridPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingShiftId) {
      return;
    }
    const drag = activeDragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const duration = Date.now() - drag.startedAt;
      if (drag.activated) {
        lastDragAtRef.current = Date.now();
        const shift = scopedShifts.find((s) => String(s.id) === String(drag.shiftId));
        if (shift) {
          if (continuousDays) {
            const startInfo = resolveAbsoluteMinutes(drag.lastStartMin);
            const endInfo = resolveAbsoluteMinutes(drag.lastEndMin);
            if (!isEditableDate(startInfo.date)) {
              showToast("Past schedules can't be edited.", 'error');
              clearActiveDrag();
              return;
            }
            const sameDate = shift.date === startInfo.date;
            const sameStart = Math.abs(shift.startHour - startInfo.hour) < 0.001;
            const sameEnd = Math.abs(shift.endHour - endInfo.hour) < 0.001;
            if (!sameDate || !sameStart || !sameEnd) {
              commitOverridesRef.current[drag.shiftId] = {
                startDate: startInfo.date,
                startHour: startInfo.hour,
                endDate: endInfo.date,
                endHour: endInfo.hour,
              };
              pendingShiftChangeRef.current = {
                shiftId: String(shift.id),
                original: { date: shift.date, startHour: shift.startHour, endHour: shift.endHour },
                proposed: { date: startInfo.date, startHour: startInfo.hour, endHour: endInfo.hour },
              };
              openModal('editShift', {
                ...shift,
                date: startInfo.date,
                startHour: startInfo.hour,
                endHour: endInfo.hour,
                draftDate: startInfo.date,
                draftStartHour: startInfo.hour,
                draftEndHour: endInfo.hour,
                modalKey: `${shift.id}:${startInfo.date}:${startInfo.hour.toFixed(2)}:${endInfo.hour.toFixed(2)}`,
              });
              setCommitOverridesVersion((v) => v + 1);
            }
          } else {
            const selectedDateString = toDateString(selectedDate);
            if (!isEditableDate(selectedDateString)) {
              showToast("Past schedules can't be edited.", 'error');
              clearActiveDrag();
              return;
            }
            const nextStart = drag.lastStartMin / 60;
            const nextEnd = drag.lastEndMin / 60;
            const sameDate = shift.date === selectedDateString;
            const sameStart = Math.abs(shift.startHour - nextStart) < 0.001;
            const sameEnd = Math.abs(shift.endHour - nextEnd) < 0.001;
            if (!sameDate || !sameStart || !sameEnd) {
              commitOverridesRef.current[drag.shiftId] = {
                startDate: selectedDateString,
                startHour: nextStart,
                endDate: selectedDateString,
                endHour: nextEnd,
              };
              pendingShiftChangeRef.current = {
                shiftId: String(shift.id),
                original: { date: shift.date, startHour: shift.startHour, endHour: shift.endHour },
                proposed: { date: selectedDateString, startHour: nextStart, endHour: nextEnd },
              };
              openModal('editShift', {
                ...shift,
                date: selectedDateString,
                startHour: nextStart,
                endHour: nextEnd,
                draftDate: selectedDateString,
                draftStartHour: nextStart,
                draftEndHour: nextEnd,
                modalKey: `${shift.id}:${selectedDateString}:${nextStart.toFixed(2)}:${nextEnd.toFixed(2)}`,
              });
              setCommitOverridesVersion((v) => v + 1);
            }
          }
        }
      } else if (dist < CLICK_DISTANCE && duration < CLICK_DURATION_MS) {
        const shift = scopedShifts.find((s) => String(s.id) === String(drag.shiftId));
        if (shift) {
          openShiftEditor(shift);
        }
      }
      clearActiveDrag();
      return;
    }

    if (isDragScrollingRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // noop
      }
      handleGridDragEnd();
      return;
    }

    const ctx = getGridBackgroundContext(e.target);
    if (!ctx) return;
    if (e.pointerType !== 'touch') {
      handleLaneMouseUp(
        ctx.employeeId,
        e as unknown as React.MouseEvent,
        continuousDays ? getHourAndDateFromClientX(e.clientX)?.date : undefined
      );
    }
  }, [
    clearActiveDrag,
    continuousDays,
    draggingShiftId,
    getGridBackgroundContext,
    getHourAndDateFromClientX,
    handleGridDragEnd,
    handleLaneMouseUp,
    isEditableDate,
    openModal,
    openShiftEditor,
    resolveAbsoluteMinutes,
    scopedShifts,
    selectedDate,
    showToast,
  ]);

  const handleGridPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = activeDragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      clearActiveDrag();
      return;
    }
    if (!isDragScrollingRef.current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // noop
    }
    handleGridDragEnd();
  }, [clearActiveDrag, handleGridDragEnd]);

  // Scroll handler
  const handleGridScroll = useCallback(() => {
    if (headerScrollRef.current && gridScrollRef.current) {
      if (!isSyncingScrollRef.current) {
        isSyncingScrollRef.current = true;
        headerScrollRef.current.scrollLeft = gridScrollRef.current.scrollLeft;
        requestAnimationFrame(() => {
          isSyncingScrollRef.current = false;
        });
      }
    }
  }, []);

  const handleHeaderScroll = useCallback(() => {
    if (headerScrollRef.current && gridScrollRef.current) {
      if (!isSyncingScrollRef.current) {
        isSyncingScrollRef.current = true;
        gridScrollRef.current.scrollLeft = headerScrollRef.current.scrollLeft;
        requestAnimationFrame(() => {
          isSyncingScrollRef.current = false;
        });
      }
    }
  }, []);

  // Slide animation effect (only for single-day mode)
  useEffect(() => {
    if (continuousDays) return; // Disable slide animation in continuous mode
    if (!dateNavDirection) return;
    setSlideDirection(dateNavDirection);
    setIsSliding(true);
    const timeout = setTimeout(() => setIsSliding(false), 220);
    return () => clearTimeout(timeout);
  }, [dateNavKey, dateNavDirection, continuousDays]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const rawClipboard = window.sessionStorage.getItem(SCHEDULE_CLIPBOARD_KEY);
    if (!rawClipboard) return;
    try {
      const parsed = JSON.parse(rawClipboard) as TimelineScheduleClipboard;
      const hasValidTemplate = Boolean(parsed?.template?.job)
        && Number.isFinite(parsed?.template?.startHour)
        && Number.isFinite(parsed?.template?.endHour)
        && typeof parsed?.template?.shiftId === 'string';
      const copiedAt = Number(parsed?.copiedAt);
      if (!hasValidTemplate || !Number.isFinite(copiedAt)) {
        window.sessionStorage.removeItem(SCHEDULE_CLIPBOARD_KEY);
        return;
      }
      if (Date.now() - copiedAt > CLIPBOARD_MAX_AGE_MS) {
        window.sessionStorage.removeItem(SCHEDULE_CLIPBOARD_KEY);
        return;
      }
      setScheduleClipboard(parsed);
    } catch {
      window.sessionStorage.removeItem(SCHEDULE_CLIPBOARD_KEY);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (isKeyboardInputTarget(event.target)) return;
      const hasShortcutModifier = event.ctrlKey || event.metaKey;
      if (!hasShortcutModifier) return;
      const key = event.key.toLowerCase();
      if (key !== 'c' && key !== 'v') return;

      event.preventDefault();
      if (!canUseCopyPaste) {
        showToast('Not permitted', 'error');
        return;
      }

      if (key === 'c') {
        if (!selectedShiftId) {
          showToast('Select a shift first', 'error');
          return;
        }
        handleCopyShiftToClipboard(selectedShiftId);
        return;
      }

      void handlePasteShiftFromClipboard();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    canUseCopyPaste,
    handleCopyShiftToClipboard,
    handlePasteShiftFromClipboard,
    selectedShiftId,
    showToast,
  ]);

  useEffect(() => {
    const root = timelineScrollRef.current;
    if (!root) return;

    const handleContextMenuCapture = (event: MouseEvent) => {
      event.preventDefault();
      const target = event.target as HTMLElement | null;
      if (!target) {
        closeContextMenu();
        return;
      }
      const shiftEl = target.closest('[data-shift-id]') as HTMLElement | null;
      if (shiftEl) {
        const shiftId = shiftEl.getAttribute('data-shift-id');
        if (shiftId) {
          openShiftContextMenu(event.clientX, event.clientY, shiftId);
          return;
        }
      }
      const cellEl = target.closest('[data-cell-id]') as HTMLElement | null;
      if (cellEl) {
        const cellId = cellEl.getAttribute('data-cell-id');
        if (cellId) {
          openCellContextMenu(event.clientX, event.clientY, cellId);
          return;
        }
      }
      closeContextMenu();
    };

    root.addEventListener('contextmenu', handleContextMenuCapture, true);
    return () => {
      root.removeEventListener('contextmenu', handleContextMenuCapture, true);
    };
  }, [closeContextMenu, openCellContextMenu, openShiftContextMenu]);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (!continuousDays) {
      continuousCellAssertedRef.current = false;
      return;
    }
    if (continuousCellAssertedRef.current) return;
    const root = gridScrollRef.current;
    if (!root) return;
    const cellCount = root.querySelectorAll('[data-cell-id]').length;
    console.debug('[timeline-week-view] rendered cell targets', {
      cellCount,
      employeeRows: groupedRows.length,
      visibleDays: continuousDaysData.length,
    });
    if (cellCount === 0) {
      throw new Error('[Timeline][WeekView] No droppable [data-cell-id] elements rendered in continuous mode.');
    }
    continuousCellAssertedRef.current = true;
  }, [continuousDays, continuousDaysData.length, groupedRows.length]);

  useEffect(() => {
    if (!contextMenu) return;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (!contextMenuRef.current) return;
      if (contextMenuRef.current.contains(event.target as Node)) return;
      closeContextMenu();
    };
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };
    const handleAnyScroll = () => {
      closeContextMenu();
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    window.addEventListener('keydown', handleDocumentKeyDown);
    window.addEventListener('scroll', handleAnyScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      window.removeEventListener('keydown', handleDocumentKeyDown);
      window.removeEventListener('scroll', handleAnyScroll, true);
    };
  }, [closeContextMenu, contextMenu]);

  useEffect(() => {
    if (!tooltip) return;
    const handleAnyScroll = () => {
      setTooltip(null);
    };
    const handleResize = () => {
      setTooltip(null);
    };
    window.addEventListener('scroll', handleAnyScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('scroll', handleAnyScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [tooltip]);

  useEffect(() => {
    setOptimisticDeletedShiftIds((prev) => {
      const next = prev.filter((shiftId) => scopedShiftIdSet.has(shiftId));
      if (next.length === prev.length) {
        let same = true;
        for (let i = 0; i < next.length; i += 1) {
          if (next[i] !== prev[i]) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
    setSelectedShiftId((prev) => {
      if (!prev) return prev;
      if (optimisticDeletedShiftIdSet.has(prev)) return null;
      if (!scopedShiftIdSet.has(prev)) return null;
      return prev;
    });
  }, [optimisticDeletedShiftIdSet, scopedShiftIdSet]);


  // Determine if we should show every-other-hour labels for very compact views
  const showEveryOtherLabel = pxPerHour < 40;

  // ─────────────────────────────────────────────────────────────────
  // DEBUG: DOM Probe for scroll container identification
  // ─────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────
  // Render: Single-day mode
  // ─────────────────────────────────────────────────────────────────
  const renderSingleDayHeader = () => (
    <div
      className={`flex h-8 border-b border-theme-primary ${
        isSliding
          ? slideDirection === 'next'
            ? '-translate-x-2 opacity-90'
            : 'translate-x-2 opacity-90'
          : 'translate-x-0 opacity-100'
      }`}
      style={{ width: `${singleDayGridWidth}px`, minWidth: `${singleDayGridWidth}px` }}
    >
      {singleDayHours.map((hour, idx) => (
        <div
          key={hour}
          className="border-r border-theme-primary/50 flex items-center justify-center"
          style={{ width: `${pxPerHour}px`, minWidth: `${pxPerHour}px` }}
        >
          {(!showEveryOtherLabel || idx % 2 === 0) && (
            <span className={`text-[10px] font-medium ${
              hour % 2 === 0 ? 'text-theme-tertiary' : 'text-theme-muted'
            }`}>
              {formatHourShort(hour)}
            </span>
          )}
        </div>
      ))}
    </div>
  );

  const renderSingleDayRows = () => (
    <div
      className={`transition-transform transition-opacity duration-200 ${
        isSliding
          ? slideDirection === 'next'
            ? '-translate-x-2 opacity-90'
            : 'translate-x-2 opacity-90'
          : 'translate-x-0 opacity-100'
      }`}
      style={{ width: `${singleDayGridWidth}px`, minWidth: `${singleDayGridWidth}px` }}
    >
      <div>
        {filteredEmployees.length === 0 ? (
          <div className="flex items-center justify-center h-full text-theme-muted">
            <div className="text-center">
              <p className="text-sm font-medium mb-1">
                {workingTodayOnly ? 'No staff working today' : 'No staff selected'}
              </p>
              <p className="text-xs">
                {workingTodayOnly
                  ? 'No shifts scheduled for this day, or try disabling the "Working today" filter'
                  : 'Use the sidebar to select employees'}
              </p>
            </div>
          </div>
        ) : (
          groupedRows.map((row) => {
            if (row.type === 'group') {
              return (
                <div
                  key={`group-${row.job}`}
                  className="h-7 border-b border-theme-primary/50 bg-theme-tertiary/40 pointer-events-none"
                  aria-hidden="true"
                />
              );
            }
            const employee = row.employee;
            const employeeShifts = shiftsForRender.filter(
              s =>
                s.employeeId === employee.id
                && s.date === dateString
                && !s.isBlocked
                && !optimisticDeletedShiftIdSet.has(s.id)
            );
            const hasTimeOff = hasApprovedTimeOff(employee.id, dateString);
            const hasBlocked = hasBlockedShiftOnDate(employee.id, dateString);
            const hasOrgBlackout = hasOrgBlackoutOnDate(dateString);
            const rowCellId = buildTimelineCellId(activeRestaurantId ?? 'none', employee.id, dateString);
            const rowBackground = hasTimeOff
              ? 'bg-emerald-500/5'
              : hasBlocked
              ? 'bg-red-500/5'
              : hasOrgBlackout
              ? 'bg-amber-500/5'
              : '';
            const allowHover = !hasTimeOff && !hasBlocked && !hasOrgBlackout;
            const canDropIntoRow = dayReassignEnabled && canEditSelectedDate && allowHover && !isPendingRowMove;

            return (
              <div
                key={employee.id}
                data-row={employee.id}
                className={`h-11 border-b border-theme-primary/50 transition-colors group ${
                  rowBackground
                } ${allowHover ? 'hover:bg-theme-hover/50' : ''}`}
              >
                <div className="relative h-full w-full">
                  {/* VISUAL LAYER */}
                  <div data-row-overlay className="absolute inset-0 z-0 pointer-events-none">
                    {/* Grid lines */}
                    <div className="absolute inset-0 flex">
                      {singleDayHours.map((hour) => (
                        <div
                          key={hour}
                          className="border-r border-theme-primary/30"
                          style={{ width: `${pxPerHour}px`, minWidth: `${pxPerHour}px` }}
                        />
                      ))}
                    </div>

                    {/* Business hours highlight */}
                    {businessHoursForDay?.ranges.map((range, idx) => (
                      <div
                        key={`bh-${range.openHour}-${range.closeHour}-${idx}`}
                        className="absolute top-0.5 bottom-0.5 rounded bg-emerald-500/5 border border-emerald-500/20"
                        style={getShiftPositionForRange(range.openHour, range.closeHour)}
                      />
                    ))}

                    {/* Current time indicator */}
                    {currentTimePosition !== null && (
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-amber-500 z-0"
                        style={{ left: `${currentTimePosition}%` }}
                      >
                        <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-amber-500" />
                      </div>
                    )}

                    {/* Time Off / Blocked / Blackout Indicators */}
                    {hasTimeOff && (
                      <div className="absolute inset-1 bg-emerald-500/20 border border-dashed border-emerald-500/50 rounded flex items-center justify-center gap-1 z-0">
                        <Palmtree className="w-3 h-3 text-emerald-500" />
                        <span className="text-[10px] font-medium text-emerald-500">OFF</span>
                      </div>
                    )}
                    {!hasTimeOff && hasBlocked && (
                      <div className="absolute inset-1 bg-red-500/15 border border-dashed border-red-500/50 rounded flex items-center justify-center gap-1 z-0">
                        <span className="text-[10px] font-medium text-red-400">BLOCKED</span>
                      </div>
                    )}
                    {hasOrgBlackout && (
                      <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded-full bg-amber-500/20 text-[9px] font-semibold text-amber-500">
                        BLACKOUT
                      </div>
                    )}
                  </div>

                  {/* INTERACTIVE LAYER */}
                  <div data-row-interactive className="relative z-20 pointer-events-auto h-full">
                    <TimelineDroppableSlice
                      id={rowCellId}
                      employeeId={employee.id}
                      disabled={!canDropIntoRow}
                      isActiveCell={activeCellId === rowCellId}
                      isContextMenuTarget={contextMenuCellHighlightId === rowCellId}
                      isDragOverCell={dragOverCellId === rowCellId}
                      className="absolute inset-0 z-0 pointer-events-auto"
                    />

                    {/* Hover add ghost */}
                    {canEditSelectedDate && !hasTimeOff && !hasBlocked && hoveredAddSlot?.employeeId === employee.id && hoveredAddSlot.date === dateString && (() => {
                      const metrics = gridScrollRef.current ? gridScrollRef.current.getBoundingClientRect() : null;
                      if (!metrics) {
                        return (
                          <div
                            className="absolute top-1 bottom-1 rounded border border-amber-400/50 bg-amber-400/10 flex items-center justify-center text-amber-500/80 text-sm font-semibold pointer-events-none"
                            style={getShiftPositionForRange(hoveredAddSlot.startHour, hoveredAddSlot.startHour + 1)}
                          >
                            +
                          </div>
                        );
                      }
                      const leftPx = (hoveredAddSlot.startHour - HOURS_START) * pxPerHour;
                      const widthPx = pxPerHour;
                      return (
                        <div
                          className="absolute top-1 bottom-1 rounded border border-amber-400/50 bg-amber-400/10 flex items-center justify-center text-amber-500/80 text-sm font-semibold pointer-events-none box-border"
                          style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                        >
                          +
                        </div>
                      );
                    })()}

                    {dragOrigin
                      && draggingShiftId === dragOrigin.shiftId
                      && dragOrigin.employeeId === employee.id
                      && dragOrigin.date === dateString && (
                        <div
                          className="absolute top-1 bottom-1 rounded border border-sky-300/35 bg-sky-400/15 pointer-events-none z-10"
                          style={getShiftPositionForRange(dragOrigin.startHour, dragOrigin.endHour)}
                        />
                      )}

                    {/* Shifts */}
                    {!hasTimeOff && !hasBlocked && employeeShifts.map((shift) => {
                      const override = commitOverridesRef.current[String(shift.id)];
                      const preview = dragPreview[String(shift.id)];
                      const startHour = preview?.startHour ?? (override ? override.startHour : shift.startHour);
                      const endHour = preview?.endHour ?? (override ? override.endHour : shift.endHour);
                      const position = getShiftPositionForRange(startHour, endHour);
                      const isHovered = hoveredShiftId === shift.id;
                      const isDraggingShift = activeDragShiftId === String(shift.id);
                      const isStartDrag = isDraggingShift && activeDragMode === 'resize-left';
                      const isEndDrag = isDraggingShift && activeDragMode === 'resize-right';
                      const isSelectedShift = selectedShiftId === shift.id;
                      const isContextMenuTarget = contextMenuShiftHighlightId === shift.id;
                      const jobColor = getJobColorClasses(shift.job);
                      const shiftDuration = endHour - startHour;
                      const shiftWidth = shiftDuration * pxPerHour;
                      const showTimeText = shiftWidth > 60;
                      const showJobText = shiftWidth > 80;
                      const shiftNotes = typeof shift.notes === 'string' ? shift.notes.trim() : '';
                      const isDraftShift = isManager && shift.scheduleState === 'draft';
                      const isBaselinePublished = isDraftMode && shift.scheduleState !== 'draft';
                      const isResizeActive = isDraggingShift && (activeDragMode === 'resize-left' || activeDragMode === 'resize-right');
                      const dragEnabled = dayReassignEnabled && !isPendingRowMove && isEditableDate(shift.date) && !isResizeActive;
                      const dragDisabledReason = !dayReassignEnabled
                        ? 'day-reassign-disabled'
                        : isPendingRowMove
                        ? 'pending-row-move'
                        : !isEditableDate(shift.date)
                        ? 'date-locked'
                        : isResizeActive
                        ? 'active-resize'
                        : undefined;

                      return (
                        <TimelineDraggableShift key={shift.id} shiftId={shift.id} disabled={!dragEnabled}>
                          {({ setNodeRef, attributes, listeners, transformStyle, isDragging: isDndDragging }) => {
                            const isReassignDragging = isDndDragging || draggingShiftId === String(shift.id);
                            const isAnyDragging = isDraggingShift || isReassignDragging;
                            const hoverScale = isHovered && !isAnyDragging ? 'scale(1.02)' : 'scale(1)';
                            const computedTransform = isReassignDragging
                              ? transformStyle
                              : transformStyle
                              ? `${transformStyle} ${hoverScale}`
                              : hoverScale;

                            return (
                              <div
                                ref={setNodeRef}
                                data-shift="true"
                                data-shift-root="true"
                                data-shift-id={shift.id}
                                data-employee-id={employee.id}
                                className={`absolute top-1 bottom-1 rounded transition-all z-30 ${
                                  isAnyDragging ? 'z-40 shadow-xl cursor-grabbing pointer-events-none opacity-45 ring-1 ring-sky-300/80' : isHovered ? 'shadow-lg cursor-pointer' : 'cursor-pointer'
                                } ${
                                  isContextMenuTarget
                                    ? 'ring-2 ring-amber-300/95 ring-offset-2 ring-offset-theme-timeline'
                                    : isSelectedShift
                                    ? 'ring-2 ring-sky-400/90 ring-offset-1 ring-offset-theme-timeline'
                                    : ''
                                }`}
                                style={{
                                  left: position.left,
                                  width: position.width,
                                  backgroundColor: isHovered || isAnyDragging ? jobColor.hoverBgColor : jobColor.bgColor,
                                  borderWidth: '1px',
                                  borderColor: jobColor.color,
                                  borderStyle: isAnyDragging || isDraftShift ? 'dashed' : 'solid',
                                  transform: computedTransform,
                                }}
                                onMouseEnter={(e) => {
                                  setHoveredShift(shift.id);
                                  showTooltipFn(shift.id, e.currentTarget);
                                }}
                                onMouseLeave={() => {
                                  setHoveredShift(null);
                                  setTooltip(null);
                                }}
                                onDoubleClick={() => {
                                  openShiftEditor(shift);
                                }}
                                onPointerDown={() => {
                                  if (!dragEnabled && process.env.NODE_ENV !== 'production') {
                                    console.debug('[Timeline] drag disabled', { shiftId: shift.id, reason: dragDisabledReason ?? 'unknown' });
                                  }
                                }}
                                {...(dragEnabled ? attributes : {})}
                                {...(dragEnabled ? listeners : {})}
                              >
                                {isDraftShift && (
                                  <span className="absolute top-0.5 right-1 px-1 rounded bg-amber-500/30 text-[8px] font-semibold text-amber-100/90">
                                    DRAFT
                                  </span>
                                )}
                                {isBaselinePublished && !isDraftShift && (
                                  <span className="absolute top-0.5 right-1 px-1 rounded bg-emerald-500/20 text-[8px] font-semibold text-emerald-100/90">
                                    PUBLISHED
                                  </span>
                                )}
                                <div
                                  data-shift-body="true"
                                  className={`absolute left-2 right-2 top-0 bottom-0 touch-none overflow-hidden pointer-events-auto ${
                                    dragEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                                  }`}
                                >
                                  <div className="h-full flex items-center px-0.5 overflow-hidden min-w-0">
                                    {showTimeText ? (
                                      <span
                                        className={`text-[10px] font-medium truncate shrink-0 ${
                                          isHovered || isAnyDragging ? 'text-white' : ''
                                        }`}
                                        style={isHovered || isAnyDragging ? undefined : { color: jobColor.color }}
                                      >
                                        {formatHour(startHour)}-{formatHour(endHour)}
                                      </span>
                                  ) : (
                                      <span
                                        className={`text-[9px] font-medium truncate shrink-0 ${
                                          isHovered || isAnyDragging ? 'text-white' : ''
                                        }`}
                                        style={isHovered || isAnyDragging ? undefined : { color: jobColor.color }}
                                      >
                                        {Math.round(shiftDuration)}h
                                      </span>
                                    )}
                                    {shiftNotes && (
                                      <span
                                        className={`ml-2 text-[9px] truncate text-right flex-1 min-w-0 ${
                                          isHovered || isAnyDragging ? 'text-white/80' : ''
                                        }`}
                                        style={isHovered || isAnyDragging ? undefined : { color: jobColor.color }}
                                        title={shiftNotes}
                                      >
                                        {shiftNotes}
                                      </span>
                                    )}
                                  </div>
                                  {showJobText && shift.job && (
                                    <span
                                      className={`absolute left-0.5 bottom-0 text-[9px] truncate max-w-full ${
                                        isHovered || isAnyDragging ? 'text-white/90' : ''
                                      }`}
                                      style={isHovered || isAnyDragging ? undefined : { color: jobColor.color }}
                                    >
                                      {shift.job}
                                    </span>
                                  )}
                                </div>

                                <div
                                  data-resize-handle="end"
                                data-edge="right"
                                  className={`absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-r flex items-center justify-center touch-none group/edge transition-colors z-40 ${
                                    isEndDrag ? 'bg-amber-400/20 ring-1 ring-amber-400/60' : 'hover:bg-zinc-500/20'
                                  }`}
                                  onPointerDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }}
                                >
                                  <span
                                    className={`w-0.5 h-4 rounded-full transition-colors ${
                                      isEndDrag ? 'bg-amber-200' : 'bg-zinc-300/50'
                                    } group-hover/edge:bg-zinc-200/80`}
                                  />
                                </div>
                                <div
                                  data-resize-handle="start"
                                data-edge="left"
                                  className={`absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-l flex items-center justify-center touch-none group/edge transition-colors z-40 ${
                                    isStartDrag ? 'bg-amber-400/20 ring-1 ring-amber-400/60' : 'hover:bg-zinc-500/20'
                                  }`}
                                  onPointerDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }}
                                >
                                  <span
                                    className={`w-0.5 h-4 rounded-full transition-colors ${
                                      isStartDrag ? 'bg-amber-200' : 'bg-zinc-300/50'
                                    } group-hover/edge:bg-zinc-200/80`}
                                  />
                                </div>
                              </div>
                            );
                          }}
                        </TimelineDraggableShift>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  // ─────────────────────────────────────────────────────────────────
  // Render: Continuous mode (3-day window)
  // ─────────────────────────────────────────────────────────────────
  const renderContinuousHeader = () => (
    <div
      className="flex h-8 border-b border-theme-primary"
      style={{
        width: `${continuousGridWidth}px`,
        minWidth: `${continuousGridWidth}px`,
        maxWidth: `${continuousGridWidth}px`,
      }}
    >
      {continuousDaysData.map((dayData) => (
        <div key={dayData.dateString} className="flex" style={{ width: `${24 * pxPerHour}px` }}>
          {dayData.hours.map((hour) => {
            const isFirstHour = hour === 0;
            return (
              <div
                key={`${dayData.dateString}-${hour}`}
                className={`flex items-center justify-center relative ${
                  isFirstHour ? 'border-l-2 border-theme-primary' : 'border-r border-theme-primary/50'
                }`}
                style={{ width: `${pxPerHour}px`, minWidth: `${pxPerHour}px` }}
              >
                {/* Day label at midnight */}
                {isFirstHour && (
                  <span className="absolute left-1 top-0.5 text-[9px] font-semibold text-amber-500 whitespace-nowrap">
                    {formatDayLabel(dayData.date)}
                  </span>
                )}
                {/* Hour label (skip 0 since we show day label there) */}
                {hour > 0 && (!showEveryOtherLabel || hour % 2 === 0) && (
                  <span className={`text-[10px] font-medium ${
                    hour % 2 === 0 ? 'text-theme-tertiary' : 'text-theme-muted'
                  }`}>
                    {formatHourShort(hour)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  const renderContinuousRows = () => (
    <div
      style={{
        width: `${continuousGridWidth}px`,
        minWidth: `${continuousGridWidth}px`,
        maxWidth: `${continuousGridWidth}px`,
      }}
    >
      <div>
        {filteredEmployees.length === 0 ? (
          <div className="flex items-center justify-center h-full text-theme-muted">
            <div className="text-center">
              <p className="text-sm font-medium mb-1">
                {workingTodayOnly ? 'No staff working today' : 'No staff selected'}
              </p>
              <p className="text-xs">
                {workingTodayOnly
                  ? 'No shifts scheduled for this day, or try disabling the "Working today" filter'
                  : 'Use the sidebar to select employees'}
              </p>
            </div>
          </div>
        ) : (
          groupedRows.map((row) => {
            if (row.type === 'group') {
              return (
                <div
                  key={`group-${row.job}`}
                  className="h-7 border-b border-theme-primary/50 bg-theme-tertiary/40 pointer-events-none"
                  style={{ width: `${continuousGridWidth}px`, maxWidth: `${continuousGridWidth}px` }}
                  aria-hidden="true"
                />
              );
            }
            const employee = row.employee;
            const rowOrgId = activeRestaurantId ?? 'none';
            // Get shifts for this employee across all 3 days
            const employeeShifts = continuousShifts.filter(s => s.employeeId === employee.id);

            return (
              <div
                key={employee.id}
                className="h-11 border-b border-theme-primary/50 transition-colors group hover:bg-theme-hover/50"
                style={{ width: `${continuousGridWidth}px`, maxWidth: `${continuousGridWidth}px` }}
              >
                <div className="relative h-full w-full">
                  {/* VISUAL LAYER */}
                  <div data-row-overlay className="absolute inset-0 z-0 pointer-events-none">
                    {/* Grid lines with day separators */}
                    <div className="absolute inset-0 flex">
                    {continuousDaysData.map((dayData, dayIdx) => (
                      <div key={dayData.dateString} className="flex">
                        {dayData.hours.map((hour) => {
                          const isFirstHour = hour === 0;
                          // Alternate day background for visual clarity
                          const dayBg = dayIdx % 2 === 1 ? 'bg-theme-secondary/20' : '';
                          return (
                            <div
                              key={`${dayData.dateString}-${hour}`}
                              className={`${
                                isFirstHour ? 'border-l-2 border-theme-primary' : 'border-r border-theme-primary/30'
                              } ${dayBg}`}
                              style={{ width: `${pxPerHour}px`, minWidth: `${pxPerHour}px` }}
                            />
                          );
                        })}
                      </div>
                    ))}
                    </div>

                    {/* Business hours highlight for each day */}
                    {continuousDaysData.map((dayData, dayIdx) => {
                    const bh = getBusinessHoursForDate(dayData.date);
                    if (!bh) return null;
                    return bh.ranges.map((range, rangeIdx) => {
                      const leftPx = (dayIdx * 24 + range.openHour) * pxPerHour;
                      const widthPx = (range.closeHour - range.openHour) * pxPerHour;
                      return (
                        <div
                          key={`bh-${dayData.dateString}-${rangeIdx}`}
                          className="absolute top-0.5 bottom-0.5 rounded bg-emerald-500/5 border border-emerald-500/20"
                          style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                        />
                      );
                    });
                    })}

                    {/* Current time indicator */}
                    {currentTimePositionContinuous !== null && (
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-amber-500 z-0"
                      style={{ left: `${currentTimePositionContinuous}px` }}
                    >
                      <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-amber-500" />
                    </div>
                    )}

                    {/* Time Off / Blocked / Blackout indicators for each day */}
                    {continuousDaysData.map((dayData, dayIdx) => {
                    const dayHasTimeOff = hasApprovedTimeOff(employee.id, dayData.dateString);
                    const dayHasBlocked = hasBlockedShiftOnDate(employee.id, dayData.dateString);
                    const dayHasOrgBlackout = hasOrgBlackoutOnDate(dayData.dateString);
                    if (!dayHasTimeOff && !dayHasBlocked && !dayHasOrgBlackout) return null;
                    const leftPx = dayIdx * 24 * pxPerHour;
                    const widthPx = 24 * pxPerHour;
                    return (
                      <div key={`blocker-${dayData.dateString}`}>
                        {/* Time Off Indicator */}
                        {dayHasTimeOff && (
                          <div
                            className="absolute top-1 bottom-1 bg-emerald-500/20 border border-dashed border-emerald-500/50 rounded flex items-center justify-center gap-1 z-0"
                            style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                          >
                            <Palmtree className="w-3 h-3 text-emerald-500" />
                            <span className="text-[10px] font-medium text-emerald-500">OFF</span>
                          </div>
                        )}
                        {/* Blocked Indicator */}
                        {!dayHasTimeOff && dayHasBlocked && (
                          <div
                            className="absolute top-1 bottom-1 bg-red-500/15 border border-dashed border-red-500/50 rounded flex items-center justify-center gap-1 z-0"
                            style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                          >
                            <span className="text-[10px] font-medium text-red-400">BLOCKED</span>
                          </div>
                        )}
                        {/* Org Blackout badge */}
                        {dayHasOrgBlackout && (
                          <div
                            className="absolute top-1 px-1.5 py-0.5 rounded-full bg-amber-500/20 text-[9px] font-semibold text-amber-500 z-0"
                            style={{ left: `${leftPx + widthPx - 60}px` }}
                          >
                            BLACKOUT
                          </div>
                        )}
                      </div>
                    );
                    })}
                  </div>

                  {/* INTERACTIVE LAYER */}
                  <div data-row-interactive className="relative z-20 pointer-events-auto h-full">
                    {continuousDaysData.map((dayData, dayIdx) => {
                      const dayCellId = buildTimelineCellId(rowOrgId, employee.id, dayData.dateString);
                      const dayHasTimeOff = hasApprovedTimeOff(employee.id, dayData.dateString);
                      const dayHasBlocked = hasBlockedShiftOnDate(employee.id, dayData.dateString);
                      const dayHasOrgBlackout = hasOrgBlackoutOnDate(dayData.dateString);
                      const canReceiveDrop =
                        dayReassignEnabled
                        && isEditableDate(dayData.dateString)
                        && !dayHasTimeOff
                        && !dayHasBlocked
                        && !dayHasOrgBlackout
                        && !isPendingRowMove;

                      return (
                        <TimelineDroppableSlice
                          key={`bg-${employee.id}-${dayData.dateString}`}
                          id={dayCellId}
                          employeeId={employee.id}
                          disabled={!canReceiveDrop}
                          isActiveCell={activeCellId === dayCellId}
                          isContextMenuTarget={contextMenuCellHighlightId === dayCellId}
                          isDragOverCell={dragOverCellId === dayCellId}
                          className={`absolute top-0 bottom-0 z-0 pointer-events-auto ${
                            canReceiveDrop ? 'hover:outline hover:outline-1 hover:outline-sky-300/50' : ''
                          }`}
                          style={{
                            left: `${dayIdx * 24 * pxPerHour}px`,
                            width: `${24 * pxPerHour}px`,
                          }}
                        />
                      );
                    })}
                    {/* Hover add ghost */}
                    {isManager && hoveredAddSlot?.employeeId === employee.id && (() => {
                      // Don't show ghost on days with time-off or blocked status
                      const ghostDayHasTimeOff = hasApprovedTimeOff(employee.id, hoveredAddSlot.date);
                      const ghostDayHasBlocked = hasBlockedShiftOnDate(employee.id, hoveredAddSlot.date);
                      if (ghostDayHasTimeOff || ghostDayHasBlocked) return null;
                      const absHours =
                        typeof hoveredAddSlot.absHoursFromWindowStart === 'number'
                          ? hoveredAddSlot.absHoursFromWindowStart
                          : (() => {
                              const dayIndex = continuousDaysData.findIndex((d) => d.dateString === hoveredAddSlot.date);
                              return dayIndex === -1 ? null : dayIndex * 24 + hoveredAddSlot.startHour;
                            })();
                      if (absHours === null) return null;
                      // Ghost is inside scrollable content, so use absolute grid coordinates (no scrollLeft subtraction)
                      const ghostLeftPx = absHours * pxPerHour;
                      const ghostWidthPx = pxPerHour;
                      return (
                        <div
                          className="absolute top-1 bottom-1 rounded border border-amber-400/50 bg-amber-400/10 flex items-center justify-center text-amber-500/80 text-sm font-semibold pointer-events-none z-30"
                          style={{ left: `${ghostLeftPx}px`, width: `${ghostWidthPx}px` }}
                        >
                          +
                        </div>
                      );
                    })()}

                    {dragOrigin
                      && draggingShiftId === dragOrigin.shiftId
                      && dragOrigin.employeeId === employee.id
                      && (() => {
                        const originPos = getShiftPositionContinuous(dragOrigin.date, dragOrigin.startHour, dragOrigin.endHour);
                        if (!originPos) return null;
                        return (
                          <div
                            className="absolute top-1 bottom-1 rounded border border-sky-300/35 bg-sky-400/15 pointer-events-none z-10"
                            style={{ left: `${originPos.leftPx}px`, width: `${originPos.widthPx}px` }}
                          />
                        );
                      })()}

                    {/* Shifts */}
                    {employeeShifts.map((shift) => {
                      const override = commitOverridesRef.current[String(shift.id)];
                      const preview = dragPreview[String(shift.id)];
                      const startHour = preview?.startHour ?? (override ? override.startHour : shift.startHour);
                      const endHour = preview?.endHour ?? (override ? override.endHour : shift.endHour);
                      const shiftDate = preview?.date ?? override?.startDate ?? shift.date;
                      const pos = getShiftPositionContinuous(shiftDate, startHour, endHour);
                      if (!pos) return null;
                      const shiftDayHasTimeOff = hasApprovedTimeOff(employee.id, shiftDate);
                      const shiftDayHasBlocked = hasBlockedShiftOnDate(employee.id, shiftDate);
                      if (shiftDayHasTimeOff || shiftDayHasBlocked) return null;

                      const isHovered = hoveredShiftId === shift.id;
                      const isDraggingShift = activeDragShiftId === String(shift.id);
                      const isStartDrag = isDraggingShift && activeDragMode === 'resize-left';
                      const isEndDrag = isDraggingShift && activeDragMode === 'resize-right';
                      const isSelectedShift = selectedShiftId === shift.id;
                      const isContextMenuTarget = contextMenuShiftHighlightId === shift.id;
                      const jobColor = getJobColorClasses(shift.job);
                      const shiftDuration = endHour - startHour;
                      const showTimeText = pos.widthPx > 60;
                      const showJobText = pos.widthPx > 80;
                      const shiftNotes = typeof shift.notes === 'string' ? shift.notes.trim() : '';
                      const isDraftShift = isManager && shift.scheduleState === 'draft';
                      const isBaselinePublished = isDraftMode && shift.scheduleState !== 'draft';
                      const isResizeActive = isDraggingShift && (activeDragMode === 'resize-left' || activeDragMode === 'resize-right');
                      const dragEnabled = dayReassignEnabled && !isPendingRowMove && isEditableDate(shiftDate) && !isResizeActive;
                      const dragDisabledReason = !dayReassignEnabled
                        ? 'day-reassign-disabled'
                        : isPendingRowMove
                        ? 'pending-row-move'
                        : !isEditableDate(shiftDate)
                        ? 'date-locked'
                        : isResizeActive
                        ? 'active-resize'
                        : undefined;

                      return (
                        <TimelineDraggableShift key={shift.id} shiftId={shift.id} disabled={!dragEnabled}>
                          {({ setNodeRef, attributes, listeners, transformStyle, isDragging: isDndDragging }) => {
                            const isReassignDragging = isDndDragging || draggingShiftId === String(shift.id);
                            const isAnyDragging = isDraggingShift || isReassignDragging;
                            const hoverScale = isHovered && !isAnyDragging ? 'scale(1.02)' : 'scale(1)';
                            const computedTransform = isReassignDragging
                              ? transformStyle
                              : transformStyle
                              ? `${transformStyle} ${hoverScale}`
                              : hoverScale;

                            return (
                              <div
                                ref={setNodeRef}
                                data-shift="true"
                                data-shift-root="true"
                                data-shift-id={shift.id}
                                data-employee-id={employee.id}
                                className={`absolute top-1 bottom-1 rounded transition-all z-30 ${
                                  isAnyDragging ? 'z-40 shadow-xl cursor-grabbing pointer-events-none opacity-45 ring-1 ring-sky-300/80' : isHovered ? 'shadow-lg cursor-pointer' : 'cursor-pointer'
                                } ${
                                  isContextMenuTarget
                                    ? 'ring-2 ring-amber-300/95 ring-offset-2 ring-offset-theme-timeline'
                                    : isSelectedShift
                                    ? 'ring-2 ring-sky-400/90 ring-offset-1 ring-offset-theme-timeline'
                                    : ''
                                }`}
                                style={{
                                  left: `${pos.leftPx}px`,
                                  width: `${pos.widthPx}px`,
                                  backgroundColor: isHovered || isAnyDragging ? jobColor.hoverBgColor : jobColor.bgColor,
                                  borderWidth: '1px',
                                  borderColor: jobColor.color,
                                  borderStyle: isAnyDragging || isDraftShift ? 'dashed' : 'solid',
                                  transform: computedTransform,
                                }}
                                onMouseEnter={(e) => {
                                  setHoveredShift(shift.id);
                                  showTooltipFn(shift.id, e.currentTarget);
                                }}
                                onMouseLeave={() => {
                                  setHoveredShift(null);
                                  setTooltip(null);
                                }}
                                onDoubleClick={() => {
                                  openShiftEditor(shift);
                                }}
                                onPointerDown={() => {
                                  if (!dragEnabled && process.env.NODE_ENV !== 'production') {
                                    console.debug('[Timeline] drag disabled', { shiftId: shift.id, reason: dragDisabledReason ?? 'unknown' });
                                  }
                                }}
                                {...(dragEnabled ? attributes : {})}
                                {...(dragEnabled ? listeners : {})}
                              >
                                {isDraftShift && (
                                  <span className="absolute top-0.5 right-1 px-1 rounded bg-amber-500/30 text-[8px] font-semibold text-amber-100/90">
                                    DRAFT
                                  </span>
                                )}
                                {isBaselinePublished && !isDraftShift && (
                                  <span className="absolute top-0.5 right-1 px-1 rounded bg-emerald-500/20 text-[8px] font-semibold text-emerald-100/90">
                                    PUBLISHED
                                  </span>
                                )}
                                <div
                                  data-shift-body="true"
                                  className={`absolute left-2 right-2 top-0 bottom-0 touch-none overflow-hidden pointer-events-auto ${
                                    dragEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                                  }`}
                                >
                                  <div className="h-full flex items-center px-0.5 overflow-hidden min-w-0">
                                    {showTimeText ? (
                                      <span
                                        className={`text-[10px] font-medium truncate shrink-0 ${
                                          isHovered || isAnyDragging ? 'text-white' : ''
                                        }`}
                                        style={isHovered || isAnyDragging ? undefined : { color: jobColor.color }}
                                      >
                                        {formatHour(startHour)}-{formatHour(endHour)}
                                      </span>
                                    ) : (
                                      <span
                                        className={`text-[9px] font-medium truncate shrink-0 ${
                                          isHovered || isAnyDragging ? 'text-white' : ''
                                        }`}
                                        style={isHovered || isAnyDragging ? undefined : { color: jobColor.color }}
                                      >
                                        {Math.round(shiftDuration)}h
                                      </span>
                                    )}
                                    {shiftNotes && (
                                      <span
                                        className={`ml-2 text-[9px] truncate text-right flex-1 min-w-0 ${
                                          isHovered || isAnyDragging ? 'text-white/80' : ''
                                        }`}
                                        style={isHovered || isAnyDragging ? undefined : { color: jobColor.color }}
                                        title={shiftNotes}
                                      >
                                        {shiftNotes}
                                      </span>
                                    )}
                                  </div>
                                  {showJobText && shift.job && (
                                    <span
                                      className={`absolute left-0.5 bottom-0 text-[9px] truncate max-w-full ${
                                        isHovered || isAnyDragging ? 'text-white/90' : ''
                                      }`}
                                      style={isHovered || isAnyDragging ? undefined : { color: jobColor.color }}
                                    >
                                      {shift.job}
                                    </span>
                                  )}
                                </div>

                                <div
                                  data-resize-handle="end"
                                  data-edge="right"
                                  className={`absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-r flex items-center justify-center touch-none group/edge transition-colors z-40 ${
                                    isEndDrag ? 'bg-amber-400/20 ring-1 ring-amber-400/60' : 'hover:bg-zinc-500/20'
                                  }`}
                                  onPointerDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }}
                                >
                                  <span
                                    className={`w-0.5 h-4 rounded-full transition-colors ${
                                      isEndDrag ? 'bg-amber-200' : 'bg-zinc-300/50'
                                    } group-hover/edge:bg-zinc-200/80`}
                                  />
                                </div>
                                <div
                                  data-resize-handle="start"
                                  data-edge="left"
                                  className={`absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-l flex items-center justify-center touch-none group/edge transition-colors z-40 ${
                                    isStartDrag ? 'bg-amber-400/20 ring-1 ring-amber-400/60' : 'hover:bg-zinc-500/20'
                                  }`}
                                  onPointerDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }}
                                >
                                  <span
                                    className={`w-0.5 h-4 rounded-full transition-colors ${
                                      isStartDrag ? 'bg-amber-200' : 'bg-zinc-300/50'
                                    } group-hover/edge:bg-zinc-200/80`}
                                  />
                                </div>
                              </div>
                            );
                          }}
                        </TimelineDraggableShift>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  // ─────────────────────────────────────────────────────────────────
  // Main render
  // ─────────────────────────────────────────────────────────────────
  const publishDisabledReason = isManager ? undefined : 'Only managers can publish.';
  const isPasteMenuDisabled = !canUseCopyPaste || !hasUsableClipboard;
  const pasteMenuTitle = !hasUsableClipboard ? 'Nothing to paste' : !canUseCopyPaste ? 'Not permitted' : undefined;
  const showContinuousToggle = viewMode === 'day';
  const rightActions = showContinuousToggle ? (
    <div className="w-[220px] h-9 rounded-lg border border-theme-primary bg-theme-secondary/80 p-1 grid grid-cols-2 gap-1">
      <button
        type="button"
        onClick={() => setContinuousDays(false)}
        className={`h-full rounded-md text-[11px] font-semibold transition-colors ${
          !continuousDays
            ? 'bg-amber-500 text-zinc-900'
            : 'text-theme-secondary hover:bg-theme-hover hover:text-theme-primary'
        }`}
      >
        Day View
      </button>
      <button
        type="button"
        onClick={() => setContinuousDays(true)}
        className={`h-full rounded-md text-[11px] font-semibold transition-colors ${
          continuousDays
            ? 'bg-amber-500 text-zinc-900'
            : 'text-theme-secondary hover:bg-theme-hover hover:text-theme-primary'
        }`}
      >
        Week View
      </button>
    </div>
  ) : undefined;

  return (
    <DndContext
      sensors={dndSensors}
      modifiers={dayReassignEnabled ? [snapToHalfHourModifier] : undefined}
      collisionDetection={collisionDetectionStrategy}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDayDragStart}
      onDragMove={handleDayDragMove}
      onDragOver={handleDayDragOver}
      onDragEnd={(event) => {
        void handleDayDragEnd(event);
      }}
      onDragCancel={handleDayDragCancel}
    >
      <div
        className="h-full flex flex-col min-h-0 bg-theme-timeline overflow-hidden relative transition-theme"
      >
      <ScheduleToolbar
        viewMode={viewMode}
        selectedDate={selectedDate}
        weekStartDay={weekStartDay}
        onPrev={() => {
          handleGoToDate(addDays(selectedDate, -1), { reanchor: true });
        }}
        onNext={() => {
          handleGoToDate(addDays(selectedDate, 1), { reanchor: true });
        }}
        onPrevJump={() => {
          handleGoToDate(addDays(selectedDate, -7), { reanchor: true });
        }}
        onNextJump={() => {
          handleGoToDate(addDays(selectedDate, 7), { reanchor: true });
        }}
        onSelectDate={(date) => handleGoToDate(date, { reanchor: true })}
        onViewModeChange={setViewMode}
        rightActions={rightActions}
        rightActionsWidthClass="w-[240px]"
        showPublish={isManager}
        publishDayEnabled={publishDayEnabled}
        publishWeekEnabled={publishWeekEnabled}
        onPublishDay={handlePublishDay}
        onPublishWeek={handlePublishWeek}
        publishDisabledReason={publishDisabledReason}
        publishDayDisabledReason={publishDayDisabledReason}
        publishWeekDisabledReason={publishWeekDisabledReason}
      />

      {isDraftMode && (
        <div className="shrink-0 border-b border-theme-primary bg-theme-secondary px-2 sm:px-4 py-2 sm:h-12 overflow-x-auto">
          <div className="flex items-center justify-between gap-4 min-w-max">
            <div className="flex items-center gap-2">
              {draftBadge}
              <span className="text-[11px] text-theme-muted whitespace-nowrap">{draftHelperText}</span>
            </div>

            <div className="flex items-center gap-2">
              {isManager && viewMode === 'day' ? (
                <button
                  type="button"
                  onClick={handleCopyPreviousDayIntoDraft}
                  className="w-[200px] h-[40px] flex items-center justify-center gap-1.5 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors text-xs font-medium"
                >
                  <ArrowLeftRight className="w-4 h-4" />
                  <span className="truncate">Copy previous day</span>
                </button>
              ) : (
                <div className="w-[200px] h-[40px] invisible" />
              )}
            </div>
          </div>
        </div>
      )}
      {/* Single vertical scroll container for names + grid */}
      <div
        ref={timelineScrollRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden relative"
      >
        {/* Sticky header row: names header + hour header */}
        <div className="sticky top-0 z-50 bg-theme-timeline border-b border-theme-primary flex">
          <div className={`w-36 shrink-0 border-r border-theme-primary h-8 flex items-center justify-center text-[10px] font-semibold uppercase tracking-wide ${statusTone}`}>
            {publishStatusLabel}
          </div>
          <div className="flex-1 min-w-0 overflow-x-hidden">
            <div
              ref={headerScrollRef}
              className="w-full overflow-x-auto overflow-y-hidden"
              onScroll={handleHeaderScroll}
            >
              <div style={{ width: continuousDays ? continuousGridWidth : singleDayGridWidth }}>
                {continuousDays ? renderContinuousHeader() : renderSingleDayHeader()}
              </div>
            </div>
          </div>
        </div>

        {/* Flex row: names column + grid area - both scroll vertically together */}
        <div className="flex">
          {/* Names Column - scrolls with parent, no separate overflow */}
          <div className="w-36 shrink-0 bg-theme-timeline z-20 border-r border-theme-primary">
            {/* Employee names - natural height, scrolls with parent */}
            <div>
              {filteredEmployees.length === 0 ? (
                <div className="h-32 flex items-center justify-center text-theme-muted text-xs">
                  No staff
                </div>
              ) : (
                groupedRows.map((row) => {
                  if (row.type === 'group') {
                    return (
                      <div
                        key={`group-${row.job}`}
                        className="h-7 border-b border-theme-primary/50 flex items-center px-2 text-[10px] uppercase tracking-widest text-theme-muted bg-theme-tertiary/40 pointer-events-none"
                        style={{ boxShadow: '4px 0 8px rgba(0,0,0,0.08)' }}
                      >
                        {row.job} ({row.count})
                      </div>
                    );
                  }
                  const employee = row.employee;
                  const sectionConfig = SECTIONS[employee.section];
                  return (
                    <div
                      key={employee.id}
                      data-name-row={employee.id}
                      className="h-11 border-b border-theme-primary/50 flex items-center gap-2 px-2"
                      style={{ boxShadow: '4px 0 8px rgba(0,0,0,0.08)' }}
                    >
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0"
                        style={{
                          backgroundColor: sectionConfig.bgColor,
                          color: sectionConfig.color,
                        }}
                      >
                        {employee.name.split(' ').map(n => n[0]).join('')}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-theme-primary truncate">
                          {employee.name}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Grid Area - horizontal scroll wrapper */}
          <div className="flex-1 min-w-0 overflow-x-hidden">
            <div
              ref={gridScrollRef}
              className={`w-full overflow-x-auto overflow-y-hidden ${isDragScrolling ? 'cursor-grabbing' : 'cursor-grab'}`}
              style={{ scrollBehavior: isDragScrolling ? 'auto' : 'smooth', touchAction: 'pan-y' }}
              onPointerDownCapture={handleGridPointerDown}
              onPointerMove={handleGridPointerMove}
              onPointerUp={handleGridPointerUp}
              onPointerCancel={handleGridPointerCancel}
              onPointerLeave={clearHoverAddSlot}
              onScroll={handleGridScroll}
            >
              {/* Fixed width content for horizontal scroll */}
              <div style={{ width: continuousDays ? continuousGridWidth : singleDayGridWidth }}>
                {/* Grid rows - natural height */}
                {continuousDays ? renderContinuousRows() : renderSingleDayRows()}
              </div>
            </div>
          </div>
        </div>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[80] min-w-[180px] rounded-md border border-theme-primary bg-theme-secondary py-1.5 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {contextMenu.type === 'shift' && (
            <div className="px-1">
              <button
                type="button"
                className="w-full rounded px-3 py-2 text-left text-sm text-theme-primary hover:bg-theme-hover"
                onClick={handleContextCopyShift}
              >
                Copy shift
              </button>
              <button
                type="button"
                className="mt-0.5 w-full rounded px-3 py-2 text-left text-sm text-red-400 hover:bg-red-500/10"
                onClick={() => {
                  void handleContextDeleteShift();
                }}
              >
                Delete shift
              </button>
            </div>
          )}
          {contextMenu.type === 'cell' && (
            <div className="px-1">
              <button
                type="button"
                className={`w-full rounded px-3 py-2 text-left text-sm ${
                  isPasteMenuDisabled ? 'text-theme-muted' : 'text-theme-primary hover:bg-theme-hover'
                }`}
                title={pasteMenuTitle}
                onClick={() => {
                  void handleContextPasteShift();
                }}
              >
                Paste shift
              </button>
            </div>
          )}
        </div>
      )}
      <PublishScheduleDialog
        open={publishConfirmOpen}
        selectedMode={publishEmailMode}
        isLoading={publishConfirmLoading}
        onModeChange={setPublishEmailMode}
        onCancel={closePublishConfirm}
        onConfirm={handleConfirmPublish}
      />
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete shift?"
        description="This can’t be undone."
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        isLoading={confirmDeleteLoading}
        onCancel={closeConfirmDelete}
        onConfirm={handleConfirmDeleteShift}
      >
        {confirmDeleteShift ? (
          <div className="rounded-md border border-theme-primary/60 bg-theme-timeline/60 px-3 py-2 text-xs text-theme-secondary">
            <div className="font-semibold text-theme-primary">{confirmDeleteEmployeeName}</div>
            <div>{formatHour(confirmDeleteShift.startHour)} - {formatHour(confirmDeleteShift.endHour)}</div>
            {confirmDeleteShift.job ? <div className="text-theme-muted">{confirmDeleteShift.job}</div> : null}
          </div>
        ) : null}
      </ConfirmDialog>
      <PasteJobPickerDialog
        open={pasteJobPickerOpen}
        employeeName={pasteJobPickerEmployeeName}
        options={pasteJobPickerOptions}
        selectedJob={pasteJobPickerSelectedJob}
        onSelectJob={setPasteJobPickerSelectedJob}
        onCancel={() => resolvePasteJobPicker(null)}
        onConfirm={() => resolvePasteJobPicker(pasteJobPickerSelectedJob || null)}
      />

      {tooltip && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed z-[9999] bg-theme-secondary border border-theme-primary rounded-lg px-2.5 py-1.5 text-xs text-theme-primary shadow-lg pointer-events-none"
              style={{ left: tooltip.left, top: tooltip.top, width: 200 }}
            >
              <div className="font-semibold text-xs">{tooltip.employeeName}</div>
              {tooltip.job && <div className="text-theme-tertiary text-[11px]">{tooltip.job}</div>}
              {tooltip.location && <div className="text-theme-tertiary text-[11px]">{tooltip.location}</div>}
              <div className="text-theme-muted text-[11px]">{tooltip.time}</div>
            </div>,
            document.body
          )
        : null}
      {dayMoveTimeTooltip && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed z-[10000] rounded-md border border-sky-300/70 bg-theme-secondary/95 px-2 py-1 text-[11px] font-semibold text-theme-primary shadow-lg pointer-events-none"
              style={{ left: dayMoveTimeTooltip.left, top: dayMoveTimeTooltip.top }}
            >
              {dayMoveTimeTooltip.label}
            </div>,
            document.body
          )
        : null}

      </div>
    </DndContext>
  );
}


