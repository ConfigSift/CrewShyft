'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Printer,
  FileDown,
  ClipboardList,
  BarChart3,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useScheduleStore } from '../../store/scheduleStore';
import { useAuthStore } from '../../store/authStore';
import {
  getPublishedShiftsForDate,
  getPublishedShiftsForWeek,
  fetchPublishedShiftsForWeek,
  renderReportToWindow,
} from './report-utils';
import { getWeekDates } from '../../utils/timeUtils';
import type { Shift } from '../../types';
import { DailyRosterReport } from './DailyRosterReport';
import { DailyTimelineReport } from './DailyTimelineReport';
import { WeeklyScheduleReport } from './WeeklyScheduleReport';
import { wrapInHTMLDocument } from './print-styles';
import {
  generateDailyRosterHTML,
  generateDailyTimelineHTML,
  generateWeeklyScheduleHTML,
} from './report-html';
import { usePathname } from 'next/navigation';
import { getUserRole, isManagerRole } from '../../utils/role';

type ReportType = 'roster' | 'timeline' | 'weekly';

const REPORT_OPTIONS: Array<{
  id: ReportType;
  label: string;
  description: string;
  icon: typeof ClipboardList;
}> = [
  {
    id: 'roster',
    label: 'Daily Roster',
    description: 'AM/PM split roster grouped by role',
    icon: ClipboardList,
  },
  {
    id: 'timeline',
    label: 'Daily Timeline',
    description: 'Visual Gantt-style shift chart',
    icon: BarChart3,
  },
  {
    id: 'weekly',
    label: 'Weekly Grid',
    description: 'Week-at-a-glance schedule grid',
    icon: CalendarDays,
  },
];

function toYMD(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatWeekNav(start: Date, end: Date): string {
  const s = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const e = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${s} \u2013 ${e}`;
}

function parseDateParam(value?: string): Date | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

type ReportsPageContentProps = {
  initialView?: ReportType;
  initialDate?: string;
};

type JobFilterOption = {
  key: string;
  label: string;
  count: number;
};

const JOB_FILTER_STORAGE_PREFIX = 'crewshyft:reports:jobFilter';

function normalizeJobLabel(job: string | null | undefined): string {
  const label = String(job ?? '').trim();
  return label || 'Unassigned';
}

function normalizeJobKey(job: string | null | undefined): string {
  return normalizeJobLabel(job).toLowerCase();
}

function buildJobFilterOptions(shifts: Shift[]): JobFilterOption[] {
  const byKey = new Map<string, JobFilterOption>();
  shifts.forEach((shift) => {
    const label = normalizeJobLabel(shift.job);
    const key = normalizeJobKey(label);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    byKey.set(key, { key, label, count: 1 });
  });
  return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
}

type ReportsToolbarProps = {
  activeReport: ReportType;
  onChangeReport: (report: ReportType) => void;
  navLabel: string;
  isWeekly: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPrint: () => void;
  onDownload: () => void;
};

type JobFilterChipsProps = {
  jobs: JobFilterOption[];
  selected: Set<string>;
  onToggle: (jobKey: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
};

function JobFilterChips({
  jobs,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
}: JobFilterChipsProps) {
  return (
    <div className="no-print border-b border-theme-primary bg-theme-tertiary px-4 py-2 print:border-zinc-200 print:bg-white">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-theme-muted">Filter jobs</span>
        </div>
        <div className="flex items-center gap-1.5 sm:justify-end">
          <button
            type="button"
            onClick={onSelectAll}
            className="rounded-full border border-theme-primary bg-theme-secondary px-2 py-0.5 text-[11px] font-medium text-theme-secondary transition-colors hover:border-theme-secondary hover:bg-theme-hover hover:text-theme-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-1 print:border-zinc-200 print:bg-zinc-100 print:text-zinc-700"
          >
            All
          </button>
          <button
            type="button"
            onClick={onSelectNone}
            className="rounded-full border border-theme-primary bg-theme-secondary px-2 py-0.5 text-[11px] font-medium text-theme-secondary transition-colors hover:border-theme-secondary hover:bg-theme-hover hover:text-theme-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-1 print:border-zinc-200 print:bg-zinc-100 print:text-zinc-700"
          >
            None
          </button>
        </div>
      </div>

      <div className="mt-1 overflow-x-auto pb-0.5 sm:overflow-visible sm:pb-0">
        <div className="flex min-w-max gap-1.5 sm:min-w-0 sm:flex-wrap">
          {jobs.length === 0 && (
            <span className="text-xs text-theme-muted">No jobs for this report range.</span>
          )}
          {jobs.map((job) => {
            const isSelected = selected.has(job.key);
            return (
              <button
                key={job.key}
                type="button"
                onClick={() => onToggle(job.key)}
                aria-pressed={isSelected}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-1 ${
                  isSelected
                    ? 'border-amber-500 bg-amber-500 text-zinc-900 hover:border-amber-400 hover:bg-amber-400'
                    : 'border-theme-primary bg-theme-secondary text-theme-secondary hover:border-theme-secondary hover:bg-theme-hover hover:text-theme-primary print:border-zinc-200 print:bg-zinc-100 print:text-zinc-700'
                }`}
              >
                <span>{job.label}</span>
                <span className={`text-[10px] font-medium ${isSelected ? 'text-zinc-900/90' : 'text-theme-muted print:text-zinc-500'}`}>
                  ({job.count})
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReportsToolbar({
  activeReport,
  onChangeReport,
  navLabel,
  isWeekly,
  onPrev,
  onNext,
  onPrint,
  onDownload,
}: ReportsToolbarProps) {
  return (
    <div className="reports-page-toolbar sticky top-0 z-20 rounded-t-2xl border-b border-theme-primary bg-theme-secondary print:static print:border-zinc-200 print:bg-white">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-bold text-theme-primary">Reports</h2>

          {/* Report type tabs */}
          <div className="inline-flex items-center gap-1 rounded-full border border-theme-primary bg-theme-tertiary p-1">
            {REPORT_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.id}
                  onClick={() => onChangeReport(opt.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                    activeReport === opt.id
                      ? 'bg-theme-primary text-theme-primary shadow-sm print:bg-zinc-100 print:text-zinc-900'
                      : 'text-theme-secondary hover:bg-theme-hover hover:text-theme-primary'
                  }`}
                  title={opt.description}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Date / week nav */}
          <div className="flex items-center gap-1 rounded-full border border-theme-primary bg-theme-tertiary px-1 py-0.5">
            <button
              onClick={onPrev}
              className="p-1 rounded-full hover:bg-theme-hover text-theme-secondary hover:text-theme-primary transition-colors"
              aria-label={isWeekly ? 'Previous week' : 'Previous day'}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-semibold text-theme-primary px-1.5 min-w-[120px] text-center">
              {navLabel}
            </span>
            <button
              onClick={onNext}
              className="p-1 rounded-full hover:bg-theme-hover text-theme-secondary hover:text-theme-primary transition-colors"
              aria-label={isWeekly ? 'Next week' : 'Next day'}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Print button */}
          <button
            onClick={onPrint}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500 text-zinc-900 hover:bg-amber-400 transition-colors text-xs font-semibold"
          >
            <Printer className="w-3.5 h-3.5" />
            Print
          </button>
          <button
            onClick={onDownload}
            className="btn-secondary px-3 py-1.5 rounded-full text-xs font-semibold"
          >
            <FileDown className="w-3.5 h-3.5" />
            Download PDF
          </button>
        </div>
      </div>
    </div>
  );
}

export function ReportsPageContent({ initialView, initialDate }: ReportsPageContentProps) {
  const pathname = usePathname();
  const {
    selectedDate,
    shifts,
    employees,
    scheduleViewSettings,
    applyRestaurantScope,
    loadRestaurantData,
  } = useScheduleStore();
  const { activeRestaurantId, accessibleRestaurants, currentUser } = useAuthStore();
  const [activeReport, setActiveReport] = useState<ReportType>(initialView ?? 'roster');
  const initialDateValue = useMemo(
    () => parseDateParam(initialDate) ?? selectedDate,
    [initialDate, selectedDate]
  );
  const [reportDate, setReportDate] = useState<Date>(initialDateValue);
  const [selectedJobKeys, setSelectedJobKeys] = useState<string[]>([]);
  const [knownJobKeys, setKnownJobKeys] = useState<string[]>([]);
  const [hydratedJobFilterKey, setHydratedJobFilterKey] = useState<string | null>(null);

  // Weekly report async state
  const [weeklyShifts, setWeeklyShifts] = useState<Shift[]>([]);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);
  const isDemoRoute = pathname?.startsWith('/demo') ?? false;

  const weekStartDay = scheduleViewSettings?.weekStartDay ?? 'sunday';
  const isManager = isManagerRole(getUserRole(currentUser?.role));

  useEffect(() => {
    applyRestaurantScope(activeRestaurantId);
    loadRestaurantData(activeRestaurantId);
  }, [activeRestaurantId, applyRestaurantScope, loadRestaurantData]);

  // Sync report date when query params change
  useEffect(() => {
    setReportDate(initialDateValue);
  }, [initialDateValue]);

  useEffect(() => {
    if (initialView) {
      setActiveReport(initialView);
    }
  }, [initialView]);

  const restaurantName = useMemo(() => {
    return accessibleRestaurants.find((r) => r.id === activeRestaurantId)?.name ?? 'Restaurant';
  }, [accessibleRestaurants, activeRestaurantId]);

  const dateString = useMemo(() => toYMD(reportDate), [reportDate]);

  // Week dates for the weekly report (also used for nav label)
  const weekDates = useMemo(
    () => getWeekDates(reportDate, weekStartDay),
    [reportDate, weekStartDay]
  );
  const weekStartYmd = useMemo(() => toYMD(weekDates[0]), [weekDates]);
  const weekEndYmd = useMemo(() => toYMD(weekDates[6]), [weekDates]);

  // Filter to published shifts for the selected date (daily reports)
  const publishedShifts = useMemo(
    () => getPublishedShiftsForDate(shifts, dateString),
    [shifts, dateString]
  );

  const rawActiveShifts = useMemo(
    () => (activeReport === 'weekly' ? weeklyShifts : publishedShifts),
    [activeReport, publishedShifts, weeklyShifts]
  );

  const jobFilterStorageKey = useMemo(
    () => `${JOB_FILTER_STORAGE_PREFIX}:${activeRestaurantId ?? 'none'}:${activeReport}`,
    [activeRestaurantId, activeReport]
  );

  const availableJobs = useMemo(() => buildJobFilterOptions(rawActiveShifts), [rawActiveShifts]);
  const availableJobKeys = useMemo(() => availableJobs.map((job) => job.key), [availableJobs]);

  useEffect(() => {
    if (!isManager) {
      setSelectedJobKeys([]);
      setKnownJobKeys([]);
      setHydratedJobFilterKey(null);
      return;
    }

    let persistedSelected: string[] = [];
    let persistedKnown: string[] = [];
    try {
      const raw = window.localStorage.getItem(jobFilterStorageKey);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          persistedSelected = parsed.map((value) => normalizeJobKey(String(value)));
          persistedKnown = [...persistedSelected];
        } else if (parsed && typeof parsed === 'object') {
          const parsedRecord = parsed as { selected?: unknown; known?: unknown };
          persistedSelected = Array.isArray(parsedRecord.selected)
            ? parsedRecord.selected.map((value) => normalizeJobKey(String(value)))
            : [];
          persistedKnown = Array.isArray(parsedRecord.known)
            ? parsedRecord.known.map((value) => normalizeJobKey(String(value)))
            : [];
        }
      }
    } catch {
      persistedSelected = [];
      persistedKnown = [];
    }

    const knownSet = new Set(persistedKnown);
    const newJobKeys = availableJobKeys.filter((key) => !knownSet.has(key));
    const initialSelected =
      persistedKnown.length > 0 || persistedSelected.length > 0
        ? Array.from(new Set([...persistedSelected, ...newJobKeys]))
        : availableJobKeys;
    const nextKnown = Array.from(new Set([...persistedKnown, ...availableJobKeys]));

    setSelectedJobKeys(initialSelected);
    setKnownJobKeys(nextKnown);
    setHydratedJobFilterKey(jobFilterStorageKey);
  }, [availableJobKeys, isManager, jobFilterStorageKey]);

  useEffect(() => {
    if (!isManager || hydratedJobFilterKey !== jobFilterStorageKey) return;
    const knownSet = new Set(knownJobKeys);
    const newJobKeys = availableJobKeys.filter((key) => !knownSet.has(key));
    if (newJobKeys.length === 0) return;
    setSelectedJobKeys((prev) => Array.from(new Set([...prev, ...newJobKeys])));
    setKnownJobKeys((prev) => Array.from(new Set([...prev, ...newJobKeys])));
  }, [
    availableJobKeys,
    hydratedJobFilterKey,
    isManager,
    jobFilterStorageKey,
    knownJobKeys,
  ]);

  useEffect(() => {
    if (!isManager || hydratedJobFilterKey !== jobFilterStorageKey) return;
    try {
      window.localStorage.setItem(
        jobFilterStorageKey,
        JSON.stringify({
          selected: selectedJobKeys,
          known: knownJobKeys,
        })
      );
    } catch {
      // no-op if storage is unavailable
    }
  }, [
    hydratedJobFilterKey,
    isManager,
    jobFilterStorageKey,
    knownJobKeys,
    selectedJobKeys,
  ]);

  const selectedJobKeySet = useMemo(() => new Set(selectedJobKeys), [selectedJobKeys]);

  const filteredPublishedShifts = useMemo(() => {
    if (!isManager) return publishedShifts;
    return publishedShifts.filter((shift) => selectedJobKeySet.has(normalizeJobKey(shift.job)));
  }, [isManager, publishedShifts, selectedJobKeySet]);

  const filteredWeeklyShifts = useMemo(() => {
    if (!isManager) return weeklyShifts;
    return weeklyShifts.filter((shift) => selectedJobKeySet.has(normalizeJobKey(shift.job)));
  }, [isManager, selectedJobKeySet, weeklyShifts]);

  const handleToggleJobFilter = useCallback((jobKey: string) => {
    setSelectedJobKeys((prev) =>
      prev.includes(jobKey) ? prev.filter((value) => value !== jobKey) : [...prev, jobKey]
    );
  }, []);

  const handleSelectAllJobs = useCallback(() => {
    setSelectedJobKeys(availableJobKeys);
  }, [availableJobKeys]);

  const handleSelectNoJobs = useCallback(() => {
    setSelectedJobKeys([]);
  }, []);

  // All employees for the restaurant (active only)
  const activeEmployees = useMemo(
    () => employees.filter((e) => e.isActive && e.restaurantId === activeRestaurantId),
    [employees, activeRestaurantId]
  );

  // Fetch weekly shifts from Supabase when weekly tab is active
  useEffect(() => {
    if (activeReport !== 'weekly' || !activeRestaurantId) return;

    if (isDemoRoute) {
      setWeeklyError(null);
      setWeeklyLoading(false);
      setWeeklyShifts(getPublishedShiftsForWeek(shifts, weekStartYmd, weekEndYmd));
      return;
    }

    let cancelled = false;
    setWeeklyLoading(true);
    setWeeklyError(null);

    fetchPublishedShiftsForWeek(activeRestaurantId, weekStartYmd, weekEndYmd).then(
      (result) => {
        if (cancelled) return;
        setWeeklyShifts(result.shifts);
        setWeeklyError(result.error);
        setWeeklyLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [activeReport, activeRestaurantId, isDemoRoute, shifts, weekStartYmd, weekEndYmd]);

  // Navigation – day-level for daily reports, week-level for weekly
  const isWeekly = activeReport === 'weekly';

  const handlePrev = useCallback(() => {
    setReportDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() - (isWeekly ? 7 : 1));
      return next;
    });
  }, [isWeekly]);

  const handleNext = useCallback(() => {
    setReportDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + (isWeekly ? 7 : 1));
      return next;
    });
  }, [isWeekly]);

  const buildReportHTML = useCallback(
    (titlePrefix?: string) => {
      const reportTitleMap: Record<ReportType, string> = {
        roster: 'Daily Roster',
        timeline: 'Daily Timeline',
        weekly: 'Weekly Schedule',
      };
      const reportTitle = reportTitleMap[activeReport];
      const dateLabel =
        activeReport === 'weekly'
          ? `${toYMD(weekDates[0])} to ${toYMD(weekDates[6])}`
          : toYMD(reportDate);
      const title = `${titlePrefix ? `${titlePrefix} ` : ''}${reportTitle} - ${dateLabel}`;
      const orientation: 'portrait' | 'landscape' =
        activeReport === 'roster' ? 'portrait' : 'landscape';

      let bodyHTML = '';
      if (activeReport === 'roster') {
        bodyHTML = generateDailyRosterHTML(reportDate, restaurantName, activeEmployees, filteredPublishedShifts);
      } else if (activeReport === 'timeline') {
        bodyHTML = generateDailyTimelineHTML(reportDate, restaurantName, activeEmployees, filteredPublishedShifts);
      } else {
        bodyHTML = generateWeeklyScheduleHTML(weekDates, restaurantName, activeEmployees, filteredWeeklyShifts, {
          loading: weeklyLoading,
          error: weeklyError,
        });
      }

      return { title, bodyHTML, orientation };
    },
    [
      activeReport,
      activeEmployees,
      filteredPublishedShifts,
      reportDate,
      restaurantName,
      weekDates,
      weeklyError,
      weeklyLoading,
      filteredWeeklyShifts,
    ]
  );

  const handlePrint = useCallback(() => {
    const { title, bodyHTML, orientation } = buildReportHTML();
    const html = wrapInHTMLDocument(bodyHTML, title, { orientation });
    renderReportToWindow(html, title);
  }, [buildReportHTML]);

  const handleDownloadPdf = useCallback(() => {
    const { title, bodyHTML, orientation } = buildReportHTML('CrewShyft');
    const html = wrapInHTMLDocument(bodyHTML, title, { orientation });
    renderReportToWindow(html, title);
  }, [buildReportHTML]);

  const navLabel = isWeekly
    ? formatWeekNav(weekDates[0], weekDates[6])
    : formatShortDate(reportDate);

  return (
    <div className="w-full text-theme-primary print:text-black">
      <div className="rounded-2xl border border-theme-primary bg-theme-secondary shadow-[0_18px_40px_rgba(0,0,0,0.18)] print:border-zinc-200 print:bg-white print:shadow-none">
        <ReportsToolbar
          activeReport={activeReport}
          onChangeReport={setActiveReport}
          navLabel={navLabel}
          isWeekly={isWeekly}
          onPrev={handlePrev}
          onNext={handleNext}
          onPrint={handlePrint}
          onDownload={handleDownloadPdf}
        />

        {isManager && (
          <JobFilterChips
            jobs={availableJobs}
            selected={selectedJobKeySet}
            onToggle={handleToggleJobFilter}
            onSelectAll={handleSelectAllJobs}
            onSelectNone={handleSelectNoJobs}
          />
        )}

        <div className="reports-page-content rounded-b-2xl bg-theme-primary px-5 py-6 text-theme-primary print:bg-white print:text-black">
        {activeReport === 'roster' && (
          <DailyRosterReport
            date={reportDate}
            restaurantName={restaurantName}
            employees={activeEmployees}
            shifts={filteredPublishedShifts}
          />
        )}

        {activeReport === 'timeline' && (
          <DailyTimelineReport
            date={reportDate}
            restaurantName={restaurantName}
            employees={activeEmployees}
            shifts={filteredPublishedShifts}
          />
        )}

        {activeReport === 'weekly' && (
          <WeeklyScheduleReport
            weekDates={weekDates}
            restaurantName={restaurantName}
            employees={activeEmployees}
            shifts={filteredWeeklyShifts}
            loading={weeklyLoading}
            error={weeklyError}
          />
        )}
        </div>
      </div>
    </div>
  );
}
