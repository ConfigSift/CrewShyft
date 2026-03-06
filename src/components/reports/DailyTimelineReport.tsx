'use client';

import type { Employee, Shift } from '../../types';
import {
  calculateDailyStats,
  compareJobs,
  formatHourForReport,
  formatReportDate,
  formatReportTimestamp,
  getJobColorClasses,
} from './report-utils';
import { ReportHeader } from './ReportHeader';

const TIMELINE_START = 6;
const TIMELINE_END = 24;

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function hourLabel(hour: number): string {
  if (hour === 0 || hour === 24) return '12a';
  if (hour === 12) return '12p';
  if (hour > 12) return `${hour - 12}p`;
  return `${hour}a`;
}

interface TimelineGroup {
  job: string;
  color: string;
  bgColor: string;
  rows: TimelineRow[];
}

interface TimelineRow {
  employee: Employee;
  shifts: Shift[];
}

function buildTimelineGroups(employees: Employee[], shifts: Shift[]): TimelineGroup[] {
  const employeeMap = new Map(employees.map((employee) => [employee.id, employee]));
  const employeePrimaryJob = new Map<string, string>();
  const employeeShifts = new Map<string, Shift[]>();
  const employeesWithShifts = new Set<string>();

  shifts.forEach((shift) => {
    if (shift.isBlocked) return;
    employeesWithShifts.add(shift.employeeId);
    if (!employeePrimaryJob.has(shift.employeeId) && shift.job) {
      employeePrimaryJob.set(shift.employeeId, shift.job);
    }
    if (!employeeShifts.has(shift.employeeId)) {
      employeeShifts.set(shift.employeeId, []);
    }
    employeeShifts.get(shift.employeeId)?.push(shift);
  });

  employeeShifts.forEach((list) => list.sort((left, right) => left.startHour - right.startHour));

  const groupMap = new Map<string, TimelineRow[]>();
  employeesWithShifts.forEach((employeeId) => {
    const employee = employeeMap.get(employeeId);
    if (!employee || !employee.isActive) return;
    const job = employeePrimaryJob.get(employeeId) ?? 'Unassigned';
    if (!groupMap.has(job)) {
      groupMap.set(job, []);
    }
    groupMap.get(job)?.push({
      employee,
      shifts: employeeShifts.get(employeeId) ?? [],
    });
  });

  groupMap.forEach((rows) =>
    rows.sort((left, right) => {
      const leftStart = left.shifts[0]?.startHour;
      const rightStart = right.shifts[0]?.startHour;
      const leftHas = Number.isFinite(leftStart);
      const rightHas = Number.isFinite(rightStart);
      if (leftHas && rightHas && leftStart !== rightStart) {
        return (leftStart ?? 0) - (rightStart ?? 0);
      }
      if (leftHas && !rightHas) return -1;
      if (!leftHas && rightHas) return 1;
      return left.employee.name.localeCompare(right.employee.name);
    }),
  );

  const result: TimelineGroup[] = [];
  Array.from(groupMap.keys())
    .sort(compareJobs)
    .forEach((job) => {
      const rows = groupMap.get(job);
      if (!rows || rows.length === 0) return;
      const colors = getJobColorClasses(job);
      result.push({ job, color: colors.color, bgColor: colors.bgColor, rows });
    });

  return result;
}

function getEffectiveEnd(shifts: Shift[]): number {
  let maxEnd = 23;
  for (const shift of shifts) {
    if (shift.endHour > maxEnd) {
      maxEnd = Math.ceil(shift.endHour);
    }
  }
  return Math.min(maxEnd, TIMELINE_END);
}

function getTotalHours(shifts: Shift[]): number {
  let total = 0;
  for (const shift of shifts) {
    if (!shift.isBlocked) {
      total += Math.max(0, shift.endHour - shift.startHour);
    }
  }
  return Math.round(total * 10) / 10;
}

interface DailyTimelineReportProps {
  date: Date;
  restaurantName: string;
  employees: Employee[];
  shifts: Shift[];
}

export function DailyTimelineReport({
  date,
  restaurantName,
  employees,
  shifts,
}: DailyTimelineReportProps) {
  const stats = calculateDailyStats(employees, shifts);
  const groups = buildTimelineGroups(employees, shifts);
  const effectiveEnd = getEffectiveEnd(shifts);
  const effectiveHours = effectiveEnd - TIMELINE_START;
  const totalHours = getTotalHours(shifts);
  const hours: number[] = [];
  for (let hour = TIMELINE_START; hour < effectiveEnd; hour += 1) {
    hours.push(hour);
  }
  const colPct = 100 / effectiveHours;

  return (
    <div className="report-timeline-root text-theme-primary print:text-black">
      <ReportHeader
        title="Daily Timeline"
        subtitle={formatReportDate(date)}
        restaurantName={restaurantName}
      />

      <div className="stats-bar mb-4 flex gap-4 rounded-md bg-theme-secondary px-3 py-2 text-[11px] print:bg-zinc-100">
        <div className="stat-item flex items-center gap-1">
          <span className="stat-label font-medium text-theme-muted print:text-zinc-400">Staff</span>
          <span className="stat-value font-bold text-theme-primary print:text-zinc-900">{stats.total}</span>
        </div>
        <div className="stat-item flex items-center gap-1">
          <span className="stat-label font-medium text-theme-muted print:text-zinc-400">AM</span>
          <span className="stat-value font-bold text-theme-primary print:text-zinc-900">{stats.amCount}</span>
        </div>
        <div className="stat-item flex items-center gap-1">
          <span className="stat-label font-medium text-theme-muted print:text-zinc-400">PM</span>
          <span className="stat-value font-bold text-theme-primary print:text-zinc-900">{stats.pmCount}</span>
        </div>
        {stats.doublesCount > 0 && (
          <div className="stat-item flex items-center gap-1">
            <span className="stat-label font-medium text-theme-muted print:text-zinc-400">Doubles</span>
            <span className="stat-value stat-accent font-bold">{stats.doublesCount}</span>
          </div>
        )}
        <div className="stat-item flex items-center gap-1">
          <span className="stat-label font-medium text-theme-muted print:text-zinc-400">Total Hours</span>
          <span className="stat-value font-bold text-theme-primary print:text-zinc-900">{totalHours}h</span>
        </div>
        {stats.estLaborCost > 0 && (
          <div className="stat-item flex items-center gap-1">
            <span className="stat-label font-medium text-theme-muted print:text-zinc-400">Est. Labor</span>
            <span className="stat-value font-bold text-theme-primary print:text-zinc-900">
              ${stats.estLaborCost.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </span>
          </div>
        )}
      </div>

      {shifts.length === 0 && <div className="empty-state">No shifts scheduled.</div>}

      {shifts.length > 0 && (
        <div
          className="timeline-grid rounded-xl border border-theme-primary bg-theme-secondary print:border-zinc-200 print:bg-white"
          style={{ display: 'grid', gridTemplateColumns: '160px 1fr' }}
        >
          <div className="h-6 border-b border-theme-primary print:border-zinc-300" />
          <div className="relative h-6 border-b border-theme-primary print:border-zinc-300">
            {hours.map((hour) => (
              <div
                key={hour}
                className="absolute top-0 bottom-0 text-center"
                style={{ left: `${(hour - TIMELINE_START) * colPct}%`, width: `${colPct}%` }}
              >
                <span className="leading-6 text-[9px] font-semibold text-theme-muted print:text-zinc-400">
                  {hourLabel(hour)}
                </span>
              </div>
            ))}
          </div>

          {groups.map((group) => (
            <div key={group.job} className="contents">
              <div
                className="col-span-2 flex items-center gap-1.5 px-2 py-[3px] text-[10px] font-bold uppercase tracking-wide"
                style={{ gridColumn: '1 / -1', backgroundColor: group.bgColor, color: group.color }}
              >
                <span
                  className="h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: group.color }}
                />
                {group.job}
                <span className="ml-1 text-[9px] font-semibold opacity-60">({group.rows.length})</span>
              </div>

              {group.rows.map((row) => {
                const jobColor = getJobColorClasses(row.shifts[0]?.job);
                return (
                  <div key={row.employee.id} className="contents">
                    <div className="flex h-7 min-w-0 items-center gap-1.5 border-b border-theme-primary px-2 print:border-zinc-100">
                      <div
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[8px] font-bold"
                        style={{ backgroundColor: jobColor.bgColor, color: jobColor.color }}
                      >
                        {getInitials(row.employee.name)}
                      </div>
                      <span className="truncate text-[10px] font-semibold text-theme-primary print:text-zinc-800">
                        {row.employee.name}
                      </span>
                    </div>

                    <div className="relative h-7 border-b border-theme-primary print:border-zinc-100">
                      {hours.map((hour) => (
                        <div
                          key={hour}
                          className="absolute top-0 bottom-0"
                          style={{
                            left: `${(hour - TIMELINE_START) * colPct}%`,
                            width: '1px',
                            backgroundColor: hour % 3 === 0 ? 'var(--border-secondary)' : 'var(--border-primary)',
                          }}
                        />
                      ))}

                      {row.shifts.map((shift) => {
                        const shiftColor = getJobColorClasses(shift.job);
                        const start = Math.max(shift.startHour, TIMELINE_START);
                        const end = Math.min(shift.endHour, effectiveEnd);
                        if (end <= start) return null;
                        const leftPct = ((start - TIMELINE_START) / effectiveHours) * 100;
                        const widthPct = ((end - start) / effectiveHours) * 100;

                        return (
                          <div
                            key={shift.id}
                            className="absolute top-[3px] bottom-[3px] rounded"
                            style={{
                              left: `${leftPct}%`,
                              width: `${widthPct}%`,
                              minWidth: '20px',
                              backgroundColor: shiftColor.bgColor,
                              borderLeft: `3px solid ${shiftColor.color}`,
                              borderTop: `1px solid ${shiftColor.color}`,
                              borderRight: `1px solid ${shiftColor.color}`,
                              borderBottom: `1px solid ${shiftColor.color}`,
                            }}
                          >
                            <div className="flex h-full items-center overflow-hidden px-1">
                              <span className="truncate whitespace-nowrap text-[8px] font-semibold" style={{ color: shiftColor.color }}>
                                {formatHourForReport(shift.startHour)}-{formatHourForReport(shift.endHour, { isEnd: true })}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div className="report-footer mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-theme-primary pt-3 text-[10px] text-theme-secondary print:border-zinc-200 print:text-zinc-500">
        <div className="footer-meta">Generated {formatReportTimestamp()}</div>
      </div>
    </div>
  );
}
