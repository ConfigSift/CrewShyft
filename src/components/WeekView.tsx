'use client';

import { useScheduleStore } from '../store/scheduleStore';
import { useAuthStore } from '../store/authStore';
import { SECTIONS, type Shift } from '../types';
import { getWeekDates, getWeekStart, dateToString, isSameDay, formatHour, shiftsOverlap } from '../utils/timeUtils';
import { Palmtree, ArrowLeftRight } from 'lucide-react';
import { getUserRole, isManagerRole } from '../utils/role';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getJobColorClasses } from '../lib/jobColors';
import { ScheduleToolbar } from './ScheduleToolbar';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { apiFetch } from '../lib/apiClient';
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

// Compact sizing - pixels per day column
const PX_PER_DAY = 100;
const SHIFT_DND_PREFIX = 'shift:';
const CELL_DND_PREFIX = 'cell:';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CROSS_EMPLOYEE_Y_THRESHOLD_PX = 20;
const SCHEDULE_CLIPBOARD_KEY = 'crewshyft:scheduleClipboard:v1';
const CLIPBOARD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

type ShiftDragTarget = {
  shiftId: string;
};

type CellDropTarget = {
  organizationId: string;
  userId: string;
  date: string;
};

type OptimisticShiftMove = {
  employeeId: string;
  date: string;
};

type ScheduleClipboard = {
  copiedAt: number;
  sourceOrgId: string;
  template: {
    shiftId: string;
    startHour: number;
    endHour: number;
    job: string;
    locationId?: string | null;
    notes?: string;
  };
};

type OptimisticCreatedShift = Shift;
type ScheduleContextMenu = {
  x: number;
  y: number;
  type: 'shift' | 'cell';
  shiftId?: string;
  cellId?: string;
};

function isKeyboardInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

function buildShiftDragId(shiftId: string): string {
  return `${SHIFT_DND_PREFIX}${shiftId}`;
}

function parseShiftDragId(rawId: unknown): ShiftDragTarget | null {
  const value = String(rawId ?? '');
  if (!value.startsWith(SHIFT_DND_PREFIX)) return null;
  const shiftId = value.slice(SHIFT_DND_PREFIX.length);
  if (!shiftId) return null;
  return { shiftId };
}

function buildCellDropId(organizationId: string, userId: string, date: string): string {
  return `${CELL_DND_PREFIX}${organizationId}:${userId}:${date}`;
}

function parseCellDropId(rawId: unknown): CellDropTarget | null {
  const value = String(rawId ?? '');
  if (!value.startsWith(CELL_DND_PREFIX)) return null;
  const payload = value.slice(CELL_DND_PREFIX.length);
  const [organizationId, userId, date] = payload.split(':');
  if (!organizationId || !userId || !date || !DATE_RE.test(date)) return null;
  return { organizationId, userId, date };
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

type WeekShiftCardProps = {
  shift: Shift;
  isDraftShift: boolean;
  isBaselinePublished: boolean;
  isDraggingShiftId: boolean;
  isSelected: boolean;
  isContextMenuTarget: boolean;
  isPendingMove: boolean;
  dragEnabled: boolean;
  dragDisabledReason?: string;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
};

function WeekShiftCard({
  shift,
  isDraftShift,
  isBaselinePublished,
  isDraggingShiftId,
  isSelected,
  isContextMenuTarget,
  isPendingMove,
  dragEnabled,
  dragDisabledReason,
  onClick,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
}: WeekShiftCardProps) {
  const jobColor = getJobColorClasses(shift.job);
  const shiftDuration = shift.endHour - shift.startHour;
  const draggableId = buildShiftDragId(shift.id);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: draggableId,
    disabled: !dragEnabled,
  });
  const dragTransform = transform
    ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
    : undefined;
  const isActiveDragCard = isDragging || isDraggingShiftId;

  return (
    <div
      ref={setNodeRef}
      data-shift="true"
      data-shift-id={shift.id}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onPointerDown={() => {
        if (!dragEnabled && process.env.NODE_ENV !== 'production') {
          console.debug('[WeekView] drag disabled', { shiftId: shift.id, reason: dragDisabledReason ?? 'unknown' });
        }
      }}
      className={`relative px-1 py-0.5 rounded text-[9px] truncate transition-transform ${
        dragEnabled ? 'cursor-grab hover:scale-[1.02]' : 'cursor-pointer'
      } ${
        isDraftShift ? 'border border-amber-400/60 border-dashed' : ''
      } ${isBaselinePublished ? 'ring-1 ring-emerald-400/40' : ''} ${
        isActiveDragCard ? 'opacity-85 pointer-events-none cursor-grabbing shadow-lg ring-1 ring-sky-300/70' : ''
      } ${isPendingMove ? 'opacity-60' : ''} ${
        isContextMenuTarget
          ? 'ring-2 ring-amber-300/95 ring-offset-2 ring-offset-theme-timeline shadow-[0_0_0_1px_rgba(251,191,36,0.4)]'
          : isSelected
          ? 'ring-2 ring-sky-400/90 ring-offset-1 ring-offset-theme-timeline'
          : ''
      }`}
      style={{
        backgroundColor: jobColor.bgColor,
        borderLeft: `2px solid ${jobColor.color}`,
        color: jobColor.color,
        transform: dragTransform,
      }}
      title={`${formatHour(shift.startHour)} - ${formatHour(shift.endHour)}`}
      {...(dragEnabled ? attributes : {})}
      {...(dragEnabled ? listeners : {})}
    >
      <div
        data-resize-handle="start"
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize opacity-60"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      <div
        data-resize-handle="end"
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize opacity-60"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      {isDraftShift && (
        <span className="absolute top-0 right-0 px-1 rounded bg-amber-500/30 text-[7px] font-semibold text-amber-100/90">
          DRAFT
        </span>
      )}
      {Math.round(shiftDuration)}h
    </div>
  );
}

type WeekGridCellProps = {
  droppableId: string;
  disabledDrop: boolean;
  className: string;
  style: React.CSSProperties;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseUp: (event: React.MouseEvent<HTMLDivElement>) => void;
  isActiveCell: boolean;
  isContextMenuTarget: boolean;
  isDragOverCell: boolean;
  children: React.ReactNode;
};

function WeekGridCell({
  droppableId,
  disabledDrop,
  className,
  style,
  onClick,
  onMouseDown,
  onMouseUp,
  isActiveCell,
  isContextMenuTarget,
  isDragOverCell,
  children,
}: WeekGridCellProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
    disabled: disabledDrop,
  });
  const showDropHighlight = (isOver || isDragOverCell) && !disabledDrop;

  return (
    <div
      data-cell-id={droppableId}
      className={`${className} ${showDropHighlight ? 'outline outline-2 outline-sky-400/70 bg-sky-500/10' : ''} ${
        isContextMenuTarget
          ? 'outline outline-2 outline-amber-300/95 bg-amber-400/15'
          : isActiveCell
          ? 'outline outline-2 outline-amber-400/80'
          : ''
      } h-full relative`}
      style={style}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
    >
      <div ref={setNodeRef} className="absolute inset-0 pointer-events-none" />
      <div className="relative h-full">{children}</div>
    </div>
  );
}

export function WeekView() {
  const {
    selectedDate,
    goToPrevious,
    goToNext,
    getFilteredEmployeesForRestaurant,
    getShiftsForRestaurant,
    setSelectedDate,
    setViewMode,
    openModal,
    showToast,
    addShift,
    updateShift,
    deleteShift,
    loadRestaurantData,
    selectAllEmployeesForRestaurant,
    publishDraftRange,
    hasApprovedTimeOff,
    hasBlockedShiftOnDate,
    hasOrgBlackoutOnDate,
    dateNavDirection,
    dateNavKey,
    getEffectiveHourRange,
    scheduleViewSettings,
    scheduleMode,
  } = useScheduleStore();

  const { activeRestaurantId, currentUser } = useAuthStore();
  const isManager = isManagerRole(getUserRole(currentUser?.role));
  const todayStr = dateToString(new Date());
  const isEditableDate = useCallback((dateStr: string) => dateStr >= todayStr, [todayStr]);
  const canEditDate = useCallback((dateStr: string) => isManager && isEditableDate(dateStr), [isManager, isEditableDate]);
  const weekStartDay = scheduleViewSettings?.weekStartDay ?? 'sunday';
  const weekDates = getWeekDates(selectedDate, weekStartDay);
  const weekStartYmd = useMemo(() => dateToString(weekDates[0]), [weekDates]);
  const weekEndYmd = useMemo(() => dateToString(weekDates[6]), [weekDates]);
  const publishWeekLabel = useMemo(
    () => formatPublishWeekLabel(weekDates[0], weekDates[6]),
    [weekDates]
  );
  const filteredEmployees = getFilteredEmployeesForRestaurant(activeRestaurantId);
  const scopedShifts = getShiftsForRestaurant(activeRestaurantId);
  const today = new Date();
  const hasDraftInWeek = useMemo(
    () =>
      scopedShifts.some(
        (shift) =>
          shift.scheduleState === 'draft' &&
          shift.date >= weekStartYmd &&
          shift.date <= weekEndYmd
      ),
    [scopedShifts, weekEndYmd, weekStartYmd]
  );
  const weekShiftCount = useMemo(
    () => scopedShifts.filter((shift) => shift.date >= weekStartYmd && shift.date <= weekEndYmd).length,
    [scopedShifts, weekEndYmd, weekStartYmd]
  );
  const publishStatusLabel = hasDraftInWeek ? 'DRAFT' : 'PUBLISHED';
  const statusTone = hasDraftInWeek ? 'bg-amber-500 text-zinc-900' : 'bg-emerald-500 text-white';
  const isDraftMode = scheduleMode === 'draft';
  const draftHelperText = 'Changes are not visible to staff until published.';
  const draftBadge = (
    <span className="inline-flex items-center px-2 py-1 rounded-full bg-amber-500/20 text-amber-500 text-[11px] font-semibold tracking-wide">
      DRAFT MODE
    </span>
  );
  const isPastWeek = weekEndYmd < todayStr;
  const publishWeekEnabled = isManager && hasDraftInWeek && !isPastWeek;
  const publishWeekDisabledReason = isPastWeek
    ? "Past schedules can't be published."
    : !hasDraftInWeek
    ? 'No draft changes'
    : undefined;
  const showCopyDraftWeek = isManager && isDraftMode && weekShiftCount === 0;

  // Refs for scroll syncing
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const namesScrollRef = useRef<HTMLDivElement>(null);
  const weekGridRootRef = useRef<HTMLDivElement | null>(null);

  // Drag-to-scroll state
  const [isDragScrolling, setIsDragScrolling] = useState(false);
  const dragScrollRef = useRef<{
    startX: number;
    scrollLeft: number;
  } | null>(null);

  const cellPointerRef = useRef<{ x: number; y: number; employeeId: string; date: string } | null>(null);
  const [isSliding, setIsSliding] = useState(false);
  const [slideDirection, setSlideDirection] = useState<'prev' | 'next' | null>(null);
  const [hoveredShiftId, setHoveredShiftId] = useState<string | null>(null);
  const [draggingShiftId, setDraggingShiftId] = useState<string | null>(null);
  const [dragOverCellId, setDragOverCellId] = useState<string | null>(null);
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [scheduleClipboard, setScheduleClipboard] = useState<ScheduleClipboard | null>(null);
  const [contextMenu, setContextMenu] = useState<ScheduleContextMenu | null>(null);
  const [contextMenuShiftHighlightId, setContextMenuShiftHighlightId] = useState<string | null>(null);
  const [contextMenuCellHighlightId, setContextMenuCellHighlightId] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmDeleteShiftId, setConfirmDeleteShiftId] = useState<string | null>(null);
  const [confirmDeleteLoading, setConfirmDeleteLoading] = useState(false);
  const [optimisticShiftMoves, setOptimisticShiftMoves] = useState<Record<string, OptimisticShiftMove>>({});
  const [optimisticCreatedShifts, setOptimisticCreatedShifts] = useState<OptimisticCreatedShift[]>([]);
  const [optimisticDeletedShiftIds, setOptimisticDeletedShiftIds] = useState<string[]>([]);
  const [pendingMoveShiftIds, setPendingMoveShiftIds] = useState<string[]>([]);
  const [dragOrigin, setDragOrigin] = useState<{
    shiftId: string;
    employeeId: string;
    date: string;
    startHour: number;
    endHour: number;
  } | null>(null);
  const dragStartRef = useRef<{ startX: number; startY: number; originUserId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    })
  );
  const collisionDetectionStrategy = useCallback((args: Parameters<typeof pointerWithin>[0]) => {
    const dragStart = dragStartRef.current;
    if (!dragStart || !args.pointerCoordinates) return pointerWithin(args);
    const pointerY = args.pointerCoordinates.y;
    const deltaY = Math.abs(pointerY - dragStart.startY);
    if (deltaY >= CROSS_EMPLOYEE_Y_THRESHOLD_PX) {
      return pointerWithin(args);
    }
    const lockedContainers = args.droppableContainers.filter((container) => {
      const target = parseCellDropId(container.id);
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
  }, []);
  const sortableShiftIds = useMemo(
    () => scopedShifts.map((shift) => buildShiftDragId(shift.id)),
    [scopedShifts]
  );
  const displayShifts = useMemo(() => {
    const movedShifts = scopedShifts.map((shift) => {
      const move = optimisticShiftMoves[shift.id];
      if (!move) return shift;
      return {
        ...shift,
        employeeId: move.employeeId,
        date: move.date,
      };
    });
    const merged = [...movedShifts, ...optimisticCreatedShifts];
    if (optimisticDeletedShiftIds.length === 0) return merged;
    const hiddenIds = new Set(optimisticDeletedShiftIds);
    return merged.filter((shift) => !hiddenIds.has(shift.id));
  }, [optimisticCreatedShifts, optimisticDeletedShiftIds, optimisticShiftMoves, scopedShifts]);
  const confirmDeleteShift = useMemo(
    () => (confirmDeleteShiftId ? scopedShifts.find((shift) => shift.id === confirmDeleteShiftId) ?? null : null),
    [confirmDeleteShiftId, scopedShifts]
  );
  const confirmDeleteEmployeeName = useMemo(() => {
    if (!confirmDeleteShift) return 'Unknown';
    return filteredEmployees.find((employee) => employee.id === confirmDeleteShift.employeeId)?.name ?? 'Unknown';
  }, [confirmDeleteShift, filteredEmployees]);

  // Calculate grid width based on days
  const gridWidth = 7 * PX_PER_DAY;

  const handleDayClick = (date: Date) => {
    setSelectedDate(date);
    setViewMode('day');
  };

  const handlePrevious = useCallback(() => goToPrevious(), [goToPrevious]);
  const handleNext = useCallback(() => goToNext(), [goToNext]);
  const handlePrevJump = useCallback(() => {
    const weekStart = getWeekStart(selectedDate, weekStartDay);
    weekStart.setDate(weekStart.getDate() - 28);
    setSelectedDate(weekStart);
  }, [selectedDate, setSelectedDate, weekStartDay]);
  const handleNextJump = useCallback(() => {
    const weekStart = getWeekStart(selectedDate, weekStartDay);
    weekStart.setDate(weekStart.getDate() + 28);
    setSelectedDate(weekStart);
  }, [selectedDate, setSelectedDate, weekStartDay]);
  const handleSelectDate = useCallback((date: Date) => {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    setSelectedDate(normalized);
  }, [setSelectedDate]);

  const handlePublishWeek = useCallback(async () => {
    if (!activeRestaurantId) {
      showToast('Select a restaurant first.', 'error');
      return;
    }
    const result = await publishDraftRange({ startDate: weekStartYmd, endDate: weekEndYmd });
    if (!result.success) {
      showToast(result.error || 'Unable to publish week.', 'error');
      return;
    }
    await loadRestaurantData(activeRestaurantId);
    showToast(`Published week ${publishWeekLabel}.`, 'success');
  }, [activeRestaurantId, loadRestaurantData, publishDraftRange, publishWeekLabel, showToast, weekEndYmd, weekStartYmd]);

  const handleCreateDraft = useCallback(async () => {
    if (!activeRestaurantId) {
      showToast('Select a restaurant first.', 'error');
      return;
    }
    const addDays = (dateStr: string, days: number) => {
      const date = new Date(`${dateStr}T00:00:00`);
      date.setDate(date.getDate() + days);
      return dateToString(date);
    };
    const sourceWeekStart = addDays(weekStartYmd, -7);
    const sourceWeekEnd = addDays(weekEndYmd, -7);
    const result = await apiFetch('/api/shifts/copy', {
      method: 'POST',
      json: {
        mode: 'nextWeek',
        sourceWeekStart,
        sourceWeekEnd,
        targetScheduleState: 'draft',
        sourceScheduleState: 'published',
      },
    });
    if (!result.ok) {
      showToast(result.error || 'Unable to create draft.', 'error');
      return;
    }
    await loadRestaurantData(activeRestaurantId);
    const { selectedEmployeeIds } = useScheduleStore.getState();
    if (!selectedEmployeeIds.length) {
      selectAllEmployeesForRestaurant(activeRestaurantId);
    }
    showToast('Draft schedule created.', 'success');
  }, [activeRestaurantId, loadRestaurantData, selectAllEmployeesForRestaurant, showToast, weekEndYmd, weekStartYmd]);

  const publishDisabledReason = isManager ? undefined : 'Only managers can publish.';
  const canUseCopyPaste = isManager && Boolean(activeRestaurantId);
  const hasUsableClipboard = Boolean(
    scheduleClipboard && Date.now() - scheduleClipboard.copiedAt <= CLIPBOARD_MAX_AGE_MS
  );

  const updateSessionClipboard = useCallback((clipboard: ScheduleClipboard | null) => {
    setScheduleClipboard(clipboard);
    if (typeof window === 'undefined') return;
    if (!clipboard) {
      window.sessionStorage.removeItem(SCHEDULE_CLIPBOARD_KEY);
      return;
    }
    window.sessionStorage.setItem(SCHEDULE_CLIPBOARD_KEY, JSON.stringify(clipboard));
  }, []);

  const handleShiftEdit = useCallback((shift: Shift) => {
    if (shift.isBlocked) return;
    if (!canEditDate(shift.date)) {
      showToast("Past schedules can't be edited.", 'error');
      return;
    }
    openModal('editShift', shift);
  }, [canEditDate, openModal, showToast]);

  const handleShiftCardClick = useCallback((shift: Shift, e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (shift.isBlocked) return;
    setContextMenu(null);
    setContextMenuShiftHighlightId(null);
    setContextMenuCellHighlightId(null);
    setSelectedShiftId(shift.id);
  }, []);

  const handleCopyShiftToClipboard = useCallback((sourceShiftId?: string | null) => {
    if (!canUseCopyPaste || !activeRestaurantId) {
      showToast('Not permitted', 'error');
      return;
    }
    const effectiveShiftId = sourceShiftId ?? selectedShiftId;
    if (!effectiveShiftId) {
      showToast('Select a shift first', 'error');
      return;
    }
    const sourceShift = displayShifts.find((shift) => shift.id === effectiveShiftId);
    if (!sourceShift) {
      showToast('Select a shift first', 'error');
      return;
    }
    const job = String(sourceShift.job ?? '').trim();
    if (!job) {
      showToast('Shift is missing a job', 'error');
      return;
    }

    const clipboard: ScheduleClipboard = {
      copiedAt: Date.now(),
      sourceOrgId: activeRestaurantId,
      template: {
        shiftId: sourceShift.id,
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
      console.debug('[week-copy] clipboard-saved', {
        sourceShiftId: sourceShift.id,
        clipboard,
        savedClipboard,
      });
    }
    showToast('Shift copied', 'success');
  }, [activeRestaurantId, canUseCopyPaste, displayShifts, selectedShiftId, showToast, updateSessionClipboard]);

  const handlePasteShiftFromClipboard = useCallback(async (targetCellId?: string | null) => {
    if (!canUseCopyPaste || !activeRestaurantId) {
      showToast('Not permitted', 'error');
      return;
    }
    const effectiveCellId = targetCellId ?? activeCellId;
    if (!effectiveCellId) {
      showToast('Paste failed: Click a cell to choose where to paste', 'error');
      return;
    }
    const targetCell = parseCellDropId(effectiveCellId);
    if (!targetCell || targetCell.userId === 'unassigned') {
      showToast('Paste failed: invalid target cell', 'error');
      return;
    }
    if (!canEditDate(targetCell.date)) {
      showToast("Paste failed: Past schedules can't be edited.", 'error');
      return;
    }
    if (targetCell.organizationId !== activeRestaurantId) {
      showToast('Paste failed: Not permitted', 'error');
      return;
    }

    if (!scheduleClipboard) {
      showToast('Nothing to paste', 'error');
      return;
    }
    const clipboardAgeMs = Date.now() - scheduleClipboard.copiedAt;
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[week-paste] before-paste', {
        activeCellId,
        targetCellId: effectiveCellId,
        parsedTargetCell: targetCell,
        clipboardAgeMs,
        clipboard: scheduleClipboard,
      });
    }
    if (Date.now() - scheduleClipboard.copiedAt > CLIPBOARD_MAX_AGE_MS) {
      updateSessionClipboard(null);
      showToast('Nothing to paste', 'error');
      return;
    }
    if (scheduleClipboard.sourceOrgId !== activeRestaurantId) {
      showToast('Not permitted', 'error');
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
    const tempId = `optimistic-paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticShift: Shift = {
      id: tempId,
      employeeId: targetCell.userId,
      restaurantId: activeRestaurantId,
      date: targetCell.date,
      startHour: template.startHour,
      endHour: template.endHour,
      notes: template.notes,
      job: template.job,
      locationId: template.locationId ?? null,
      isBlocked: false,
      scheduleState: scheduleMode,
    };

    setOptimisticCreatedShifts((prev) => [...prev, optimisticShift]);

    try {
      const result = await addShift({
        employeeId: targetCell.userId,
        restaurantId: activeRestaurantId,
        date: targetCell.date,
        startHour: template.startHour,
        endHour: template.endHour,
        notes: template.notes,
        isBlocked: false,
        job: template.job,
        locationId: template.locationId ?? null,
        scheduleState: scheduleMode,
      });

      setOptimisticCreatedShifts((prev) => prev.filter((shift) => shift.id !== tempId));

      if (!result.success) {
        showToast(`Paste failed: ${result.error ?? 'Unknown error'}`, 'error');
        return;
      }
      showToast('Shift pasted', 'success');
    } catch (error) {
      setOptimisticCreatedShifts((prev) => prev.filter((shift) => shift.id !== tempId));
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
    canEditDate,
    canUseCopyPaste,
    scheduleClipboard,
    scheduleMode,
    showToast,
    updateSessionClipboard,
  ]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setContextMenuShiftHighlightId(null);
    setContextMenuCellHighlightId(null);
  }, []);

  const openShiftContextMenu = useCallback((x: number, y: number, shiftId: string) => {
    setSelectedShiftId(shiftId);
    setContextMenuShiftHighlightId(shiftId);
    setContextMenuCellHighlightId(null);
    setContextMenu({
      x,
      y,
      type: 'shift',
      shiftId,
    });
  }, []);

  const openCellContextMenu = useCallback((x: number, y: number, cellId: string) => {
    setActiveCellId(cellId);
    setContextMenuCellHighlightId(cellId);
    setContextMenuShiftHighlightId(null);
    setContextMenu({
      x,
      y,
      type: 'cell',
      cellId,
    });
  }, []);

  const handleContextCopyShift = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'shift' || !contextMenu.shiftId) return;
    handleCopyShiftToClipboard(contextMenu.shiftId);
    closeContextMenu();
  }, [closeContextMenu, contextMenu, handleCopyShiftToClipboard]);

  const handleContextPasteShift = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'cell' || !contextMenu.cellId) return;
    setActiveCellId(contextMenu.cellId);
    await handlePasteShiftFromClipboard(contextMenu.cellId);
    closeContextMenu();
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

  const showDevDropToast = useCallback((message: string) => {
    if (process.env.NODE_ENV !== 'production') {
      showToast(message, 'error');
    }
  }, [showToast]);

  const markShiftMovePending = useCallback((shiftId: string, pending: boolean) => {
    setPendingMoveShiftIds((prev) => {
      if (pending) {
        if (prev.includes(shiftId)) return prev;
        return [...prev, shiftId];
      }
      return prev.filter((id) => id !== shiftId);
    });
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const dragTarget = parseShiftDragId(event.active.id);
    if (!dragTarget) return;
    setDraggingShiftId(dragTarget.shiftId);
    if (process.env.NODE_ENV !== 'production') {
      showToast('Drag start', 'success');
    }
    const sourceShift = scopedShifts.find((shift) => shift.id === dragTarget.shiftId);
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
  }, [scopedShifts, showToast]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const dropTarget = parseCellDropId(event.over?.id);
    if (!dropTarget) {
      setDragOverCellId(null);
      return;
    }
    setDragOverCellId(buildCellDropId(dropTarget.organizationId, dropTarget.userId, dropTarget.date));
  }, []);

  const clearDragIndicators = useCallback(() => {
    setDraggingShiftId(null);
    setDragOverCellId(null);
    setDragOrigin(null);
    dragStartRef.current = null;
  }, []);

  const handleDragCancel = useCallback(() => {
    clearDragIndicators();
  }, [clearDragIndicators]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const dragTarget = parseShiftDragId(event.active.id);
    const dropTarget = parseCellDropId(event.over?.id);
    clearDragIndicators();
    if (!dragTarget) {
      showDevDropToast('No drop target detected');
      return;
    }
    if (!event.over || !dropTarget) {
      showDevDropToast('No drop target detected');
      return;
    }
    if (dropTarget.userId === 'unassigned') {
      showDevDropToast('Drop target invalid (unassigned)');
      return;
    }
    if (!isManager || !activeRestaurantId) {
      showDevDropToast('Drop blocked (permissions/date/etc.)');
      return;
    }
    if (dropTarget.organizationId !== activeRestaurantId) {
      showDevDropToast('Drop blocked (permissions/date/etc.)');
      return;
    }

    const sourceShift = scopedShifts.find((shift) => shift.id === dragTarget.shiftId);
    if (!sourceShift) {
      showDevDropToast('Drop blocked (permissions/date/etc.)');
      return;
    }
    const allowCrossEmployee = Math.abs(event.delta.y) >= CROSS_EMPLOYEE_Y_THRESHOLD_PX;
    const targetUserId = allowCrossEmployee ? dropTarget.userId : sourceShift.employeeId;
    if (!canEditDate(sourceShift.date) || !canEditDate(dropTarget.date)) {
      showDevDropToast('Drop blocked (permissions/date/etc.)');
      showToast("Past schedules can't be edited.", 'error');
      return;
    }
    if (pendingMoveShiftIds.includes(sourceShift.id)) {
      showDevDropToast('Drop blocked (permissions/date/etc.)');
      return;
    }

    const targetHasTimeOff = hasApprovedTimeOff(targetUserId, dropTarget.date);
    if (targetHasTimeOff) {
      showDevDropToast('Drop blocked (permissions/date/etc.)');
      showToast('Employee has approved time off on this date', 'error');
      return;
    }
    const targetHasBlockedShift = hasBlockedShiftOnDate(targetUserId, dropTarget.date);
    if (targetHasBlockedShift) {
      showDevDropToast('Drop blocked (permissions/date/etc.)');
      showToast('This employee is blocked out on that date', 'error');
      return;
    }
    if (hasOrgBlackoutOnDate(dropTarget.date)) {
      showDevDropToast('Drop blocked (permissions/date/etc.)');
      showToast('Organization blackout day cannot receive shifts.', 'error');
      return;
    }

    const sameCell = sourceShift.employeeId === targetUserId && sourceShift.date === dropTarget.date;
    if (sameCell) return;

    const previousMove = optimisticShiftMoves[sourceShift.id];
    const duration = sourceShift.endHour - sourceShift.startHour;
    const nextStartHour = sourceShift.startHour;
    const nextEndHour = nextStartHour + duration;

    setOptimisticShiftMoves((prev) => ({
      ...prev,
      [sourceShift.id]: {
        employeeId: targetUserId,
        date: dropTarget.date,
      },
    }));
    markShiftMovePending(sourceShift.id, true);

    const result = await updateShift(sourceShift.id, {
      employeeId: targetUserId,
      date: dropTarget.date,
      startHour: nextStartHour,
      endHour: nextEndHour,
    });

    markShiftMovePending(sourceShift.id, false);

    if (!result.success) {
      setOptimisticShiftMoves((prev) => {
        const next = { ...prev };
        if (previousMove) {
          next[sourceShift.id] = previousMove;
        } else {
          delete next[sourceShift.id];
        }
        return next;
      });
      showToast(result.error || 'Unable to move shift.', 'error');
      return;
    }

    setOptimisticShiftMoves((prev) => {
      const next = { ...prev };
      delete next[sourceShift.id];
      return next;
    });
  }, [
    activeRestaurantId,
    canEditDate,
    clearDragIndicators,
    hasApprovedTimeOff,
    hasBlockedShiftOnDate,
    hasOrgBlackoutOnDate,
    isManager,
    markShiftMovePending,
    optimisticShiftMoves,
    pendingMoveShiftIds,
    scopedShifts,
    showDevDropToast,
    showToast,
    updateShift,
  ]);

  // Drag-to-scroll handlers
  const handleGridDragStart = useCallback((clientX: number) => {
    if (!gridScrollRef.current) return;
    setIsDragScrolling(true);
    dragScrollRef.current = {
      startX: clientX,
      scrollLeft: gridScrollRef.current.scrollLeft,
    };
  }, []);

  const handleGridDragMove = useCallback((clientX: number) => {
    if (!isDragScrolling || !dragScrollRef.current || !gridScrollRef.current) return;
    const dx = clientX - dragScrollRef.current.startX;
    gridScrollRef.current.scrollLeft = dragScrollRef.current.scrollLeft - dx;
  }, [isDragScrolling]);

  const handleGridDragEnd = useCallback(() => {
    setIsDragScrolling(false);
    dragScrollRef.current = null;
  }, []);

  const handleGridMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-shift]')) return;
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0) return;
    handleGridDragStart(e.clientX);
  };

  const handleGridMouseMove = (e: React.MouseEvent) => {
    if (isDragScrolling) {
      handleGridDragMove(e.clientX);
    }
  };

  const handleGridMouseUp = () => {
    handleGridDragEnd();
  };

  const handleGridMouseLeave = () => {
    handleGridDragEnd();
  };

  // Touch handlers for drag-to-scroll
  const handleGridTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest('[data-shift]')) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const touch = e.touches[0];
    if (!touch) return;
    handleGridDragStart(touch.clientX);
  };

  const handleGridTouchMove = (e: React.TouchEvent) => {
    if (isDragScrolling) {
      const touch = e.touches[0];
      if (!touch) return;
      handleGridDragMove(touch.clientX);
    }
  };

  const handleGridTouchEnd = () => {
    handleGridDragEnd();
  };

  // Sync vertical scroll between names column and grid
  const handleGridScroll = useCallback(() => {
    if (namesScrollRef.current && gridScrollRef.current) {
      namesScrollRef.current.scrollTop = gridScrollRef.current.scrollTop;
    }
    if (contextMenu) {
      closeContextMenu();
    }
  }, [closeContextMenu, contextMenu]);

  const handleNamesScroll = useCallback(() => {
    if (namesScrollRef.current && gridScrollRef.current) {
      gridScrollRef.current.scrollTop = namesScrollRef.current.scrollTop;
    }
    if (contextMenu) {
      closeContextMenu();
    }
  }, [closeContextMenu, contextMenu]);

  useEffect(() => {
    if (!dateNavDirection) return;
    const startTimer = setTimeout(() => {
      setSlideDirection(dateNavDirection);
      setIsSliding(true);
    }, 0);
    const timeout = setTimeout(() => setIsSliding(false), 220);
    return () => {
      clearTimeout(startTimer);
      clearTimeout(timeout);
    };
  }, [dateNavKey, dateNavDirection]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const rawClipboard = window.sessionStorage.getItem(SCHEDULE_CLIPBOARD_KEY);
    if (!rawClipboard) return;
    try {
      const parsed = JSON.parse(rawClipboard) as ScheduleClipboard;
      const hasValidTemplate = Boolean(parsed?.template?.job)
        && Number.isFinite(parsed?.template?.startHour)
        && Number.isFinite(parsed?.template?.endHour);
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
        handleCopyShiftToClipboard();
        return;
      }
      void handlePasteShiftFromClipboard();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canUseCopyPaste, handleCopyShiftToClipboard, handlePasteShiftFromClipboard, showToast]);

  useEffect(() => {
    const root = weekGridRootRef.current;
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
    setOptimisticShiftMoves((prev) => {
      const validIds = new Set(scopedShifts.map((shift) => shift.id));
      const entries = Object.entries(prev).filter(([shiftId]) => validIds.has(shiftId));
      if (entries.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(entries);
    });
    setOptimisticDeletedShiftIds((prev) => prev.filter((shiftId) => scopedShifts.some((shift) => shift.id === shiftId)));
    setPendingMoveShiftIds((prev) => prev.filter((shiftId) => scopedShifts.some((shift) => shift.id === shiftId)));
    setSelectedShiftId((prev) => {
      if (!prev) return prev;
      return displayShifts.some((shift) => shift.id === prev) ? prev : null;
    });
  }, [displayShifts, scopedShifts]);

  const handleCellClick = useCallback((employeeId: string, date: string, e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-shift]')) return;
    if (!activeRestaurantId) return;
    setContextMenu(null);
    setContextMenuShiftHighlightId(null);
    setContextMenuCellHighlightId(null);
    setActiveCellId(buildCellDropId(activeRestaurantId, employeeId, date));
  }, [activeRestaurantId]);

  const handleCellMouseDown = (employeeId: string, date: string, e: React.MouseEvent<HTMLDivElement>) => {
    if (!canEditDate(date)) return;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-shift]')) return;
    if (selectedShiftId && !scheduleClipboard) {
      setSelectedShiftId(null);
    }
    cellPointerRef.current = { x: e.clientX, y: e.clientY, employeeId, date };
  };

  const handleCellMouseUp = (employeeId: string, date: string, e: React.MouseEvent<HTMLDivElement>) => {
    if (!canEditDate(date)) {
      showToast("Past schedules can't be edited.", 'error');
      return;
    }
    if (!cellPointerRef.current) return;
    if ((e.target as HTMLElement).closest('[data-shift]')) {
      cellPointerRef.current = null;
      return;
    }
    const dx = e.clientX - cellPointerRef.current.x;
    const dy = e.clientY - cellPointerRef.current.y;
    const distance = Math.hypot(dx, dy);
    cellPointerRef.current = null;
    if (distance > 6) return;
    if (selectedShiftId && Boolean(scheduleClipboard)) return;

    // Get effective hour range for this day
    const clickDate = new Date(date);
    const { startHour: HOURS_START, endHour: HOURS_END } = getEffectiveHourRange(clickDate.getDay());
    const TOTAL_HOURS = HOURS_END - HOURS_START;

    const rect = e.currentTarget.getBoundingClientRect();
    const percentage = (e.clientX - rect.left) / rect.width;
    const rawHour = HOURS_START + percentage * TOTAL_HOURS;
    const startHour = Math.max(HOURS_START, Math.min(HOURS_END, Math.round(rawHour * 4) / 4));
    const endHour = Math.min(HOURS_END, Math.round((startHour + 2) * 4) / 4);
    const hasOverlap = displayShifts.some(
      (shift) =>
        shift.employeeId === employeeId &&
        shift.date === date &&
        !shift.isBlocked &&
        shiftsOverlap(startHour, endHour, shift.startHour, shift.endHour)
    );
    if (hasOverlap) {
      showToast('Shift overlaps with existing shift', 'error');
      return;
    }

    openModal('addShift', {
      employeeId,
      date,
      startHour,
      endHour,
    });
  };

  const isPasteMenuDisabled = !canUseCopyPaste || !hasUsableClipboard;
  const pasteMenuTitle = !hasUsableClipboard ? 'Nothing to paste' : !canUseCopyPaste ? 'Not permitted' : undefined;
  const contextMenuCellTarget = contextMenu?.type === 'cell' && contextMenu.cellId
    ? parseCellDropId(contextMenu.cellId)
    : null;
  const contextMenuTargetUserShort = contextMenuCellTarget?.userId
    ? contextMenuCellTarget.userId.slice(0, 8)
    : null;

  return (
    <div className="flex-1 flex flex-col bg-theme-timeline overflow-hidden transition-theme">
      {process.env.NODE_ENV !== 'production' && (
        <div className="fixed top-2 left-2 z-[9999] rounded bg-zinc-900/90 px-2 py-1 text-[10px] font-semibold text-zinc-100">
          DEV VIEW: WeekView
        </div>
      )}
      <ScheduleToolbar
        viewMode="week"
        selectedDate={selectedDate}
        weekStartDay={weekStartDay}
        onPrev={handlePrevious}
        onNext={handleNext}
        onPrevJump={handlePrevJump}
        onNextJump={handleNextJump}
        onSelectDate={handleSelectDate}
        onViewModeChange={setViewMode}
        showPublish={isManager}
        publishWeekEnabled={publishWeekEnabled}
        onPublishWeek={handlePublishWeek}
        publishDisabledReason={publishDisabledReason}
        publishWeekDisabledReason={publishWeekDisabledReason}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetectionStrategy}
        measuring={{
          droppable: {
            strategy: MeasuringStrategy.Always,
          },
        }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {isDraftMode && (
          <div className="shrink-0 border-b border-theme-primary bg-theme-secondary/95 backdrop-blur px-2 sm:px-4 py-2 sm:h-12 overflow-x-auto">
            <div className="flex items-center justify-between gap-4 min-w-max">
              <div className="flex items-center gap-2">
                {draftBadge}
                <span className="text-[11px] text-theme-muted whitespace-nowrap">{draftHelperText}</span>
              </div>

              <div className="w-[300px] flex items-center justify-end">
                {showCopyDraftWeek ? (
                  <button
                    type="button"
                    onClick={handleCreateDraft}
                    className="w-[300px] h-[40px] flex items-center gap-1.5 px-3 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors text-xs sm:text-sm font-medium"
                  >
                    <ArrowLeftRight className="w-4 h-4" />
                    <span className="truncate">Copy last published week into draft</span>
                  </button>
                ) : (
                  <div className="w-[300px] h-[40px] invisible" />
                )}
              </div>
            </div>
          </div>
        )}

        <div ref={weekGridRootRef} className="flex-1 flex overflow-hidden relative">
        {/* Fixed Employee Names Column - compact */}
        <div className="w-36 shrink-0 flex flex-col bg-theme-timeline z-20 border-r border-theme-primary">
          {/* Header spacer */}
          <div className={`h-10 border-b border-theme-primary shrink-0 flex items-center justify-center text-[10px] font-semibold uppercase tracking-wide ${statusTone}`}>
            {publishStatusLabel}
          </div>

          {/* Employee names list - synced scroll */}
          <div
            ref={namesScrollRef}
            className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide"
            onScroll={handleNamesScroll}
          >
            {filteredEmployees.length === 0 ? (
              <div className="h-full" />
            ) : (
              filteredEmployees.map((employee) => {
                const sectionConfig = SECTIONS[employee.section];

                return (
                  <div
                    key={employee.id}
                    className="h-12 border-b border-theme-primary/50 flex items-center gap-2 px-2 bg-theme-timeline"
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

        {/* Scrollable Week Grid */}
        <div
          ref={gridScrollRef}
          className={`flex-1 overflow-x-auto overflow-y-auto ${isDragScrolling ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ scrollBehavior: isDragScrolling ? 'auto' : 'smooth' }}
          onMouseDown={handleGridMouseDown}
          onMouseMove={handleGridMouseMove}
          onMouseUp={handleGridMouseUp}
          onMouseLeave={handleGridMouseLeave}
          onTouchStart={handleGridTouchStart}
          onTouchMove={handleGridTouchMove}
          onTouchEnd={handleGridTouchEnd}
          onTouchCancel={handleGridTouchEnd}
          onScroll={handleGridScroll}
        >
          <div
            className={`flex flex-col h-max min-h-full transition-transform transition-opacity duration-200 ${
              isSliding
                ? slideDirection === 'next'
                  ? '-translate-x-2 opacity-90'
                  : 'translate-x-2 opacity-90'
                : 'translate-x-0 opacity-100'
            }`}
            style={{ width: `${gridWidth}px`, minWidth: `${gridWidth}px` }}
          >
            {/* Day Headers */}
            <div className="h-10 border-b border-theme-primary flex shrink-0 sticky top-0 bg-theme-timeline z-10">
              {weekDates.map((date) => {
                const isToday = isSameDay(date, today);
                const isSelected = isSameDay(date, selectedDate);

                return (
                  <button
                    key={date.toISOString()}
                    onClick={() => handleDayClick(date)}
                    className={`border-r border-theme-primary/50 flex flex-col items-center justify-center transition-colors ${
                      isToday
                        ? 'bg-amber-500/10'
                        : isSelected
                        ? 'bg-theme-hover'
                        : 'hover:bg-theme-hover/50'
                    }`}
                    style={{ width: `${PX_PER_DAY}px`, minWidth: `${PX_PER_DAY}px` }}
                  >
                    <span className={`text-[10px] font-medium ${
                      isToday ? 'text-amber-500' : 'text-theme-muted'
                    }`}>
                      {date.toLocaleDateString('en-US', { weekday: 'short' })}
                    </span>
                    <span className={`text-xs font-semibold ${
                      isToday ? 'text-amber-500' : 'text-theme-secondary'
                    }`}>
                      {date.getDate()}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Week Grid Rows */}
            <SortableContext items={sortableShiftIds}>
              <div className="flex-1">
              {filteredEmployees.length === 0 ? (
                <div className="flex items-center justify-center h-full text-theme-muted">
                  <div className="text-center">
                    <p className="text-sm font-medium mb-1">No staff selected</p>
                    <p className="text-xs">Use the sidebar to select employees</p>
                  </div>
                </div>
              ) : (
                filteredEmployees.map((employee) => {
                  return (
                    <div
                      key={employee.id}
                      className="flex h-12 border-b border-theme-primary/50 hover:bg-theme-hover/30 transition-colors group"
                    >
                      {weekDates.map((date) => {
                        const dateStr = dateToString(date);
                        const dayShifts = displayShifts.filter(
                          s => s.employeeId === employee.id && s.date === dateStr && !s.isBlocked
                        );
                        const isToday = isSameDay(date, today);
                        const hasTimeOff = hasApprovedTimeOff(employee.id, dateStr);
                        const hasBlocked = hasBlockedShiftOnDate(employee.id, dateStr);
                        const hasOrgBlackout = hasOrgBlackoutOnDate(dateStr);
                        const orgId = activeRestaurantId ?? 'none';
                        const droppableId = buildCellDropId(orgId, employee.id, dateStr);
                        const canReceiveDrop =
                          Boolean(activeRestaurantId)
                          && isManager
                          && canEditDate(dateStr)
                          && !hasTimeOff
                          && !hasBlocked
                          && !hasOrgBlackout;

                        return (
                          <WeekGridCell
                            key={date.toISOString()}
                            droppableId={droppableId}
                            disabledDrop={!canReceiveDrop}
                            isActiveCell={activeCellId === droppableId}
                            isContextMenuTarget={contextMenuCellHighlightId === droppableId}
                            isDragOverCell={dragOverCellId === droppableId}
                            className={`border-r border-theme-primary/30 p-0.5 group relative overflow-hidden ${
                              isToday ? 'bg-amber-500/5' : ''
                            } ${hasTimeOff ? 'bg-emerald-500/5' : ''} ${hasBlocked ? 'bg-red-500/5' : ''} ${hasOrgBlackout ? 'bg-amber-500/5' : ''} ${
                              canReceiveDrop ? 'hover:outline hover:outline-1 hover:outline-sky-300/50' : ''
                            }`}
                            style={{ width: `${PX_PER_DAY}px`, minWidth: `${PX_PER_DAY}px` }}
                            onClick={(e) => handleCellClick(employee.id, dateStr, e)}
                            onMouseDown={(e) => handleCellMouseDown(employee.id, dateStr, e)}
                            onMouseUp={(e) => handleCellMouseUp(employee.id, dateStr, e)}
                          >
                            {dragOrigin
                              && draggingShiftId === dragOrigin.shiftId
                              && dragOrigin.employeeId === employee.id
                              && dragOrigin.date === dateStr && (
                                <div className="absolute inset-1 rounded border border-sky-300/35 bg-sky-400/10 pointer-events-none" />
                              )}
                            {!hasTimeOff && !hasBlocked && !hasOrgBlackout && canEditDate(dateStr) && (
                              <div
                                className={`absolute inset-0 flex items-center justify-center pointer-events-none transition-opacity ${
                                  hoveredShiftId || draggingShiftId ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'
                                }`}
                              >
                                <span className="text-[9px] text-theme-muted">+</span>
                              </div>
                            )}
                            {hasTimeOff ? (
                              <div className="h-full flex items-center justify-center">
                                <div className="flex items-center gap-0.5 px-1 py-0.5 bg-emerald-500/20 rounded text-emerald-500">
                                  <Palmtree className="w-2.5 h-2.5" />
                                  <span className="text-[9px] font-medium">OFF</span>
                                </div>
                              </div>
                            ) : hasBlocked ? (
                              <div className="h-full flex items-center justify-center">
                                <div className="flex items-center px-1 py-0.5 bg-red-500/20 rounded text-red-400">
                                  <span className="text-[9px] font-medium">X</span>
                                </div>
                              </div>
                            ) : hasOrgBlackout ? (
                              <div className="h-full flex items-center justify-center">
                                <div className="flex items-center px-1 py-0.5 bg-amber-500/20 rounded text-amber-500">
                                  <span className="text-[9px] font-medium">BO</span>
                                </div>
                              </div>
                            ) : (
                              <div className="flex flex-col gap-0.5 overflow-hidden h-full">
                                {dayShifts.slice(0, 2).map((shift) => {
                                  const isDraftShift = isManager && shift.scheduleState === 'draft';
                                  const isBaselinePublished = scheduleMode === 'draft' && shift.scheduleState !== 'draft';
                                  const isPendingMove = pendingMoveShiftIds.includes(shift.id);
                                  const dragEnabled = canEditDate(shift.date) && isManager && !isPendingMove;
                                  const dragDisabledReason = !isManager
                                    ? 'not-manager'
                                    : !canEditDate(shift.date)
                                    ? 'date-locked'
                                    : isPendingMove
                                    ? 'pending-move'
                                    : undefined;

                                  return (
                                    <WeekShiftCard
                                      key={shift.id}
                                      shift={shift}
                                      isDraftShift={isDraftShift}
                                      isBaselinePublished={isBaselinePublished}
                                      isDraggingShiftId={draggingShiftId === shift.id}
                                      isSelected={selectedShiftId === shift.id}
                                      isContextMenuTarget={contextMenuShiftHighlightId === shift.id}
                                      isPendingMove={isPendingMove}
                                      dragEnabled={dragEnabled}
                                      dragDisabledReason={dragDisabledReason}
                                      onClick={(e) => handleShiftCardClick(shift, e)}
                                      onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        handleShiftEdit(shift);
                                      }}
                                      onMouseEnter={() => setHoveredShiftId(shift.id)}
                                      onMouseLeave={() => setHoveredShiftId(null)}
                                    />
                                  );
                                })}
                                {dayShifts.length > 2 && (
                                  <span className="text-[9px] text-theme-muted text-center">
                                    +{dayShifts.length - 2}
                                  </span>
                                )}
                              </div>
                            )}
                          </WeekGridCell>
                        );
                      })}
                    </div>
                  );
                })
              )}
              </div>
            </SortableContext>
          </div>
        </div>
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[80] min-w-[180px] rounded-md border border-zinc-200 bg-white py-1.5 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {contextMenu.type === 'shift' && (
            <div className="px-1">
              <button
                type="button"
                className="w-full rounded px-3 py-2 text-left text-sm text-zinc-800 hover:bg-zinc-100"
                onClick={handleContextCopyShift}
              >
                Copy shift
              </button>
              <button
                type="button"
                className="mt-0.5 w-full rounded px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
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
              {process.env.NODE_ENV !== 'production' && contextMenuCellTarget && (
                <p className="px-2 py-1 text-[10px] text-zinc-500">
                  Paste to: {contextMenuTargetUserShort ?? '-'} {contextMenuCellTarget.date}
                </p>
              )}
              <button
                type="button"
                className={`w-full rounded px-3 py-2 text-left text-sm ${
                  isPasteMenuDisabled ? 'text-zinc-400' : 'text-zinc-800 hover:bg-zinc-100'
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
      </DndContext>
    </div>
  );
}

