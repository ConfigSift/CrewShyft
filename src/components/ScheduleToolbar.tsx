'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, CloudUpload, Loader2 } from 'lucide-react';
import { ScheduleDateControl } from './ScheduleDateControl';
import type { WeekStartDay } from '../types';
import { getWeekRange } from '../utils/timeUtils';

type ScheduleToolbarProps = {
  viewMode: 'day' | 'week' | 'month';
  selectedDate: Date;
  weekStartDay: WeekStartDay;
  onPrev: () => void;
  onNext: () => void;
  onSelectDate: (date: Date) => void;
  onPrevJump?: () => void;
  onNextJump?: () => void;
  rightActions?: ReactNode;
  rightActionsWidthClass?: string;
  showPublish?: boolean;
  publishDayEnabled?: boolean;
  publishWeekEnabled?: boolean;
  onPublishDay?: () => Promise<void> | void;
  onPublishWeek?: () => Promise<void> | void;
  publishDisabledReason?: string;
  publishDayDisabledReason?: string;
  publishWeekDisabledReason?: string;
  onViewModeChange?: (mode: 'day' | 'week') => void;
};

export function ScheduleToolbar({
  viewMode,
  selectedDate,
  weekStartDay,
  onPrev,
  onNext,
  onSelectDate,
  onPrevJump,
  onNextJump,
  rightActions,
  rightActionsWidthClass = 'w-[240px]',
  showPublish = true,
  publishDayEnabled = false,
  publishWeekEnabled = false,
  onPublishDay,
  onPublishWeek,
  publishDisabledReason,
  publishDayDisabledReason,
  publishWeekDisabledReason,
  onViewModeChange,
}: ScheduleToolbarProps) {
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [publishMenuPosition, setPublishMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [publishingAction, setPublishingAction] = useState<'day' | 'week' | null>(null);
  const publishMenuRef = useRef<HTMLDivElement>(null);
  const publishButtonRef = useRef<HTMLButtonElement>(null);
  const publishDayDisabled = !publishDayEnabled;
  const publishWeekDisabled = !publishWeekEnabled;
  const isPublishing = publishingAction !== null;
  const publishDayTitle = publishDayDisabled
    ? (publishDayDisabledReason ?? 'No draft changes')
    : 'Publish Day';
  const publishWeekTitle = publishWeekDisabled
    ? (publishWeekDisabledReason ?? 'No draft changes')
    : 'Publish Week';
  const dayLabel = useMemo(
    () => selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    [selectedDate]
  );
  const weekRange = useMemo(() => getWeekRange(selectedDate, weekStartDay), [selectedDate, weekStartDay]);
  const weekLabel = useMemo(() => {
    const startMonthDay = weekRange.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endMonthDay = weekRange.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const startYear = weekRange.start.getFullYear();
    const endYear = weekRange.end.getFullYear();
    if (startYear !== endYear) {
      return `${startMonthDay}, ${startYear} – ${endMonthDay}, ${endYear}`;
    }
    return `${startMonthDay} – ${endMonthDay}, ${startYear}`;
  }, [weekRange.end, weekRange.start]);
  const dayMenuLabel = `Publish ${dayLabel}`;
  const weekMenuLabel = `Publish Week ${weekLabel}`;
  const daySubtext = publishDayDisabledReason ?? "Publishes only this day's draft shifts";
  const weekSubtext = publishWeekDisabledReason ?? 'Publishes all draft shifts in this week';

  const updateMenuPosition = useCallback(() => {
    if (!publishButtonRef.current) return;
    const rect = publishButtonRef.current.getBoundingClientRect();
    const menuWidth = 176;
    const menuHeight = 120;
    const margin = 8;
    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + menuWidth > window.innerWidth - margin) {
      left = window.innerWidth - menuWidth - margin;
    }
    if (left < margin) left = margin;
    if (top + menuHeight > window.innerHeight - margin) {
      const above = rect.top - menuHeight - 8;
      if (above > margin) top = above;
    }
    setPublishMenuPosition({ top, left });
  }, []);

  useEffect(() => {
    if (!publishMenuOpen) return;
    updateMenuPosition();
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (publishMenuRef.current?.contains(target)) return;
      if (publishButtonRef.current?.contains(target)) return;
      setPublishMenuOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPublishMenuOpen(false);
      }
    };
    const handleReposition = () => updateMenuPosition();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [publishMenuOpen, updateMenuPosition]);

  const publishButtonTitle = publishDisabledReason ?? 'Publish schedule';
  const showViewToggle = Boolean(onViewModeChange);
  const isDayMode = viewMode === 'day';
  const isWeekMode = viewMode === 'week';
  const handlePublish = useCallback(
    async (action: 'day' | 'week') => {
      if (publishingAction) return;
      setPublishMenuOpen(false);
      setPublishingAction(action);
      try {
        if (action === 'day') {
          await onPublishDay?.();
        } else {
          await onPublishWeek?.();
        }
      } finally {
        setPublishingAction(null);
      }
    },
    [onPublishDay, onPublishWeek, publishingAction]
  );

  return (
    <div className="shrink-0 border-b border-theme-primary bg-theme-secondary px-2 sm:px-4 py-2 sm:h-14 overflow-x-auto">
      <div className="grid grid-cols-[140px_minmax(0,1fr)_320px] items-center gap-2 min-w-max">
        <div className="flex items-center gap-2">
          {showPublish ? (
            <div className="relative">
              <button
                ref={publishButtonRef}
                type="button"
                onClick={() => {
                  if (isPublishing) return;
                  setPublishMenuOpen((prev) => !prev);
                }}
                aria-haspopup="menu"
                aria-expanded={publishMenuOpen}
                title={publishButtonTitle}
                disabled={isPublishing}
                className={`w-[120px] h-[40px] rounded-lg text-xs sm:text-sm font-semibold transition-colors flex items-center justify-center gap-2 ${
                  isPublishing
                    ? 'bg-amber-500/70 text-zinc-900 cursor-wait'
                    : 'bg-amber-500 text-zinc-900 hover:bg-amber-400'
                }`}
              >
                {isPublishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
                Publish
              </button>
              {publishMenuOpen && publishMenuPosition && typeof document !== 'undefined' &&
                createPortal(
                  <div
                    ref={publishMenuRef}
                    role="menu"
                    className="fixed w-64 rounded-xl border border-theme-primary bg-theme-secondary shadow-xl z-[9999] py-2"
                    style={{ top: publishMenuPosition.top, left: publishMenuPosition.left }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={publishDayDisabled || isPublishing}
                      title={publishDayTitle}
                      onClick={() => {
                        if (publishDayDisabled || isPublishing) return;
                        void handlePublish('day');
                      }}
                      className={`group/menuitem relative w-full text-left pl-5 pr-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80 focus-visible:ring-inset ${
                        publishDayDisabled || isPublishing
                          ? 'text-theme-muted cursor-not-allowed'
                          : 'text-theme-primary hover:bg-theme-hover focus-visible:bg-theme-hover'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`absolute left-1.5 top-2 bottom-2 w-0.5 rounded-full transition-colors ${
                          publishDayDisabled || isPublishing
                            ? 'bg-transparent'
                            : 'bg-transparent group-hover/menuitem:bg-amber-400/90 group-focus-visible/menuitem:bg-amber-400/90'
                        }`}
                      />
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <CloudUpload className="w-4 h-4 mt-0.5" />
                          <div>
                            <div className="text-xs font-semibold">{dayMenuLabel}</div>
                            <div className="text-[10px] text-theme-muted">{daySubtext}</div>
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-theme-muted" />
                      </div>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={publishWeekDisabled || isPublishing}
                      title={publishWeekTitle}
                      onClick={() => {
                        if (publishWeekDisabled || isPublishing) return;
                        void handlePublish('week');
                      }}
                      className={`group/menuitem relative w-full text-left pl-5 pr-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80 focus-visible:ring-inset ${
                        publishWeekDisabled || isPublishing
                          ? 'text-theme-muted cursor-not-allowed'
                          : 'text-theme-primary hover:bg-theme-hover focus-visible:bg-theme-hover'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`absolute left-1.5 top-2 bottom-2 w-0.5 rounded-full transition-colors ${
                          publishWeekDisabled || isPublishing
                            ? 'bg-transparent'
                            : 'bg-transparent group-hover/menuitem:bg-amber-400/90 group-focus-visible/menuitem:bg-amber-400/90'
                        }`}
                      />
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <CloudUpload className="w-4 h-4 mt-0.5" />
                          <div>
                            <div className="text-xs font-semibold">{weekMenuLabel}</div>
                            <div className="text-[10px] text-theme-muted">{weekSubtext}</div>
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-theme-muted" />
                      </div>
                    </button>
                  </div>,
                  document.body
                )}
            </div>
          ) : (
            <div className="w-[100px] h-[40px]" />
          )}
        </div>

        <div className="flex items-center justify-center gap-3">
          <ScheduleDateControl
            viewMode={viewMode}
            selectedDate={selectedDate}
            weekStartDay={weekStartDay}
            onSelectDate={onSelectDate}
            onPrev={onPrev}
            onNext={onNext}
            onPrevJump={onPrevJump}
            onNextJump={onNextJump}
          />
          {showViewToggle && (
            <div className="w-[160px] h-9 rounded-lg border border-theme-primary bg-theme-secondary/80 p-1 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => onViewModeChange?.('day')}
                className={`h-full rounded-md text-xs font-semibold transition-colors ${
                  isDayMode
                    ? 'bg-amber-500 text-zinc-900'
                    : 'text-theme-secondary hover:bg-theme-hover hover:text-theme-primary'
                }`}
              >
                Day
              </button>
              <button
                type="button"
                onClick={() => onViewModeChange?.('week')}
                className={`h-full rounded-md text-xs font-semibold transition-colors ${
                  isWeekMode
                    ? 'bg-amber-500 text-zinc-900'
                    : 'text-theme-secondary hover:bg-theme-hover hover:text-theme-primary'
                }`}
              >
                Week
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end">
          <div className={`${rightActionsWidthClass} flex items-center justify-end gap-2`}>
            {rightActions}
          </div>
        </div>
      </div>
    </div>
  );
}
