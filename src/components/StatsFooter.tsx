'use client';

import { useMemo } from 'react';
import { useScheduleStore } from '../store/scheduleStore';
import { useAuthStore } from '../store/authStore';
import { SECTIONS, Section } from '../types';
import { Clock, Users, DollarSign, Percent } from 'lucide-react';
import { getWeekDates, dateToString } from '../utils/timeUtils';
import { getUserRole } from '../utils/role';

function parseTimeToDecimal(value?: string | null): number {
  if (!value) return 0;
  const text = String(value);
  if (text.includes(':')) {
    const [hours, minutes = '0'] = text.split(':');
    const hour = Number(hours);
    const minute = Number(minutes);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return 0;
    return hour + minute / 60;
  }
  const asNumber = Number(text);
  return Number.isNaN(asNumber) ? 0 : asNumber;
}

type StatsFooterProps = {
  compact?: boolean;
};

export function StatsFooter({ compact = false }: StatsFooterProps) {
  const {
    selectedDate,
    viewMode,
    selectedEmployeeIds,
    employees,
    shifts,
    coreHours,
    scheduleViewSettings,
    getShiftsForRestaurant,
  } = useScheduleStore();
  const { activeRestaurantId, currentUser } = useAuthStore();

  const scopedEmployees = useMemo(
    () => (activeRestaurantId ? employees.filter((e) => e.restaurantId === activeRestaurantId) : []),
    [employees, activeRestaurantId],
  );
  const activeEmployees = useMemo(() => scopedEmployees.filter((e) => e.isActive), [scopedEmployees]);

  const role = getUserRole(currentUser?.role);
  const isEmployee = role === 'EMPLOYEE';

  const weekStartDay = scheduleViewSettings?.weekStartDay ?? 'sunday';
  const weekDates = useMemo(() => getWeekDates(selectedDate, weekStartDay), [selectedDate, weekStartDay]);
  const dayString = dateToString(selectedDate);
  const weekStart = dateToString(weekDates[0]);
  const weekEnd = dateToString(weekDates[6]);
  const monthStartDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  const monthEndDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1);
  const monthStart = dateToString(monthStartDate);
  const monthEnd = dateToString(monthEndDate);
  const rangeStart = viewMode === 'week' ? weekStart : viewMode === 'month' ? monthStart : dayString;
  const rangeEnd = viewMode === 'week' ? weekEnd : viewMode === 'month' ? monthEnd : dayString;

  const myEmployeeId = isEmployee ? currentUser?.id ?? null : null;

  const relevantShifts = useMemo(() => {
    const scopedShifts = activeRestaurantId ? getShiftsForRestaurant(activeRestaurantId) : [];
    void shifts;
    return scopedShifts.filter((shift) => {
      if (shift.isBlocked) return false;
      const inRange =
        viewMode === 'month'
          ? shift.date >= rangeStart && shift.date < rangeEnd
          : shift.date >= rangeStart && shift.date <= rangeEnd;
      if (!inRange) return false;
      if (isEmployee) {
        if (!myEmployeeId) return false;
        return shift.employeeId === myEmployeeId;
      }
      if (selectedEmployeeIds.length === 0) {
        return true;
      }
      return selectedEmployeeIds.includes(shift.employeeId);
    });
  }, [
    activeRestaurantId,
    getShiftsForRestaurant,
    isEmployee,
    myEmployeeId,
    rangeEnd,
    rangeStart,
    selectedEmployeeIds,
    shifts,
    viewMode,
  ]);

  const totalHours = useMemo(
    () => relevantShifts.reduce((sum, shift) => sum + (shift.endHour - shift.startHour), 0),
    [relevantShifts],
  );

  const workingCount = useMemo(() => new Set(relevantShifts.map((s) => s.employeeId)).size, [relevantShifts]);

  const shiftsBySection = useMemo(
    () =>
      relevantShifts.reduce((acc, shift) => {
        const employee = scopedEmployees.find((e) => e.id === shift.employeeId);
        if (employee) {
          acc[employee.section] = (acc[employee.section] || 0) + 1;
        }
        return acc;
      }, {} as Record<Section, number>),
    [relevantShifts, scopedEmployees],
  );

  const { estimatedCost, missingPayCount } = useMemo(() => {
    let total = 0;
    let missing = 0;

    relevantShifts.forEach((shift) => {
      const hours = shift.endHour - shift.startHour;
      let rate = 0;
      let foundRate = false;

      if (shift.payRate !== undefined && shift.payRate > 0) {
        rate = shift.payRate;
        foundRate = true;
      } else {
        const employee = scopedEmployees.find((emp) => emp.id === shift.employeeId);

        if (shift.job && employee?.jobPay && employee.jobPay[shift.job] !== undefined) {
          rate = employee.jobPay[shift.job];
          foundRate = true;
        } else if (employee?.jobPay && employee.jobs && employee.jobs.length > 0) {
          const firstJob = employee.jobs[0];
          if (employee.jobPay[firstJob] !== undefined) {
            rate = employee.jobPay[firstJob];
            foundRate = true;
          }
        }
      }

      if (!foundRate && process.env.NODE_ENV === 'development') {
        const employee = scopedEmployees.find((emp) => emp.id === shift.employeeId);
        console.warn(
          `[StatsFooter] Missing pay rate for shift ${shift.id}, employee ${employee?.name ?? shift.employeeId}, job: ${shift.job ?? 'none'}`,
        );
        missing++;
      }

      total += hours * rate;
    });

    return { estimatedCost: total, missingPayCount: missing };
  }, [relevantShifts, scopedEmployees]);

  const coveragePercent = useMemo(() => {
    if (viewMode === 'month') {
      return null;
    }
    if (!coreHours || coreHours.length === 0) {
      return null;
    }

    const coreByDay = new Map<number, Array<{ start: number; end: number }>>();
    coreHours.forEach((row) => {
      if (!row.enabled || !row.openTime || !row.closeTime) return;
      const start = parseTimeToDecimal(row.openTime);
      const end = parseTimeToDecimal(row.closeTime);
      if (end <= start) return;
      if (!coreByDay.has(row.dayOfWeek)) {
        coreByDay.set(row.dayOfWeek, []);
      }
      coreByDay.get(row.dayOfWeek)!.push({ start, end });
    });
    if (coreByDay.size === 0) {
      return null;
    }

    const mergeRanges = (ranges: Array<{ start: number; end: number }>) => {
      const sorted = [...ranges].sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];
      sorted.forEach((range) => {
        const last = merged[merged.length - 1];
        if (!last || range.start > last.end) {
          merged.push({ ...range });
          return;
        }
        last.end = Math.max(last.end, range.end);
      });
      return merged;
    };

    const shiftsByDate = new Map<string, typeof relevantShifts>();
    relevantShifts.forEach((shift) => {
      if (!shiftsByDate.has(shift.date)) {
        shiftsByDate.set(shift.date, []);
      }
      shiftsByDate.get(shift.date)!.push(shift);
    });

    const datesToCheck = viewMode === 'week' ? weekDates : [selectedDate];
    let totalCore = 0;
    let covered = 0;

    datesToCheck.forEach((date) => {
      const dayRanges = coreByDay.get(date.getDay());
      if (!dayRanges || dayRanges.length === 0) return;
      const mergedRanges = mergeRanges(dayRanges);
      const dateKey = dateToString(date);
      const shiftsForDate = shiftsByDate.get(dateKey) ?? [];

      mergedRanges.forEach((range) => {
        totalCore += range.end - range.start;
        shiftsForDate.forEach((shift) => {
          const overlap = Math.max(
            0,
            Math.min(shift.endHour, range.end) - Math.max(shift.startHour, range.start),
          );
          covered += overlap;
        });
      });
    });

    if (totalCore <= 0) {
      return null;
    }
    return (covered / totalCore) * 100;
  }, [coreHours, relevantShifts, selectedDate, viewMode, weekDates]);

  const footerClassName = compact
    ? 'fixed bottom-0 left-0 right-0 h-10 sm:h-11 bg-theme-secondary border-t border-theme-primary flex items-center px-2 sm:px-4 gap-2 sm:gap-5 shrink-0 transition-theme z-40'
    : 'fixed bottom-0 left-0 right-0 h-12 sm:h-14 bg-theme-secondary border-t border-theme-primary flex items-center px-3 sm:px-6 gap-3 sm:gap-8 shrink-0 transition-theme z-40';
  const iconWrapClassName = compact
    ? 'w-6 h-6 sm:w-7 sm:h-7 rounded-lg flex items-center justify-center'
    : 'w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center';
  const iconClassName = compact ? 'w-3 h-3 sm:w-3.5 sm:h-3.5' : 'w-3.5 h-3.5 sm:w-4 sm:h-4';
  const labelClassName = compact
    ? 'text-[9px] sm:text-[10px] text-theme-muted leading-tight'
    : 'text-[10px] sm:text-xs text-theme-muted leading-tight';
  const valueClassName = compact
    ? 'text-[11px] sm:text-xs font-semibold text-theme-primary'
    : 'text-xs sm:text-sm font-semibold text-theme-primary';
  const sectionWrapClassName = compact
    ? 'hidden lg:flex items-center gap-2 px-3 py-1 bg-theme-tertiary rounded-lg'
    : 'hidden md:flex items-center gap-3 px-4 py-2 bg-theme-tertiary rounded-lg';

  return (
    <footer className={footerClassName}>
      <div className="flex items-center gap-2">
        <div className={`${iconWrapClassName} bg-blue-500/10`}>
          <Clock className={`${iconClassName} text-blue-400`} />
        </div>
        <div>
          <p className={labelClassName}>{isEmployee ? 'My Hours' : 'Total Hours'}</p>
          <p className={valueClassName}>{totalHours}h</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className={`${iconWrapClassName} bg-green-500/10`}>
          <Users className={`${iconClassName} text-green-400`} />
        </div>
        <div>
          <p className={labelClassName}>Staff</p>
          <p className={valueClassName}>
            {workingCount}/{activeEmployees.length}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className={`${iconWrapClassName} bg-amber-500/10`}>
          <Percent className={`${iconClassName} text-amber-400`} />
        </div>
        <div>
          <p className={labelClassName}>Coverage</p>
          <p className={valueClassName}>
            {coveragePercent === null ? '-' : `${coveragePercent.toFixed(1)}%`}
          </p>
        </div>
      </div>

      <div className={sectionWrapClassName}>
        {(Object.keys(SECTIONS) as Section[]).map((section) => {
          const count = shiftsBySection[section] || 0;
          return (
            <div key={section} className="flex items-center gap-1.5">
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: SECTIONS[section].color }}
              />
              <span className="text-xs text-theme-tertiary">{count}</span>
            </div>
          );
        })}
      </div>

      {!isEmployee && (
        <>
          <div className="flex-1" />
          <div className="hidden sm:flex items-center gap-2">
            <div className={`${iconWrapClassName} bg-purple-500/10 relative`}>
              <DollarSign className={`${iconClassName} text-purple-400`} />
              {missingPayCount > 0 && (
                <span
                  className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-amber-500 text-zinc-900 text-[8px] font-bold rounded-full flex items-center justify-center"
                  title={`${missingPayCount} shift(s) missing pay rate`}
                >
                  !
                </span>
              )}
            </div>
            <div>
              <p className={labelClassName}>Est. Labor</p>
              <p className={valueClassName}>${estimatedCost.toFixed(0)}</p>
            </div>
          </div>
        </>
      )}
    </footer>
  );
}
