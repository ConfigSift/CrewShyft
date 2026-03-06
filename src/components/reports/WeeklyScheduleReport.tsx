'use client';

import { useMemo } from 'react';
import type { Employee, Shift } from '../../types';
import {
  calculateWeeklyHours,
  classifyShift,
  compareJobs,
  formatHourForReport,
  formatReportTimestamp,
  formatReportWeekRange,
  getJobColorClasses,
} from './report-utils';
import { ReportHeader } from './ReportHeader';

interface WeeklyGroup {
  job: string;
  color: string;
  bgColor: string;
  rows: WeeklyRow[];
}

interface WeeklyRow {
  employee: Employee;
  shiftsByDay: Map<string, Shift[]>;
  totalHours: number;
}

function toYMD(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDayHeader(date: Date): { weekday: string; monthDay: string } {
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
  const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { weekday, monthDay };
}

function buildWeeklyGroups(employees: Employee[], shifts: Shift[], weekDates: Date[]): WeeklyGroup[] {
  const employeeMap = new Map(employees.map((employee) => [employee.id, employee]));
  const dateStrings = weekDates.map(toYMD);
  const shiftsByEmployee = new Map<string, Shift[]>();

  shifts.forEach((shift) => {
    if (shift.isBlocked) return;
    if (!shiftsByEmployee.has(shift.employeeId)) {
      shiftsByEmployee.set(shift.employeeId, []);
    }
    shiftsByEmployee.get(shift.employeeId)?.push(shift);
  });

  const employeePrimaryJob = new Map<string, string>();
  shiftsByEmployee.forEach((employeeShifts, employeeId) => {
    const sorted = [...employeeShifts].sort(
      (left, right) => left.date.localeCompare(right.date) || left.startHour - right.startHour,
    );
    for (const shift of sorted) {
      if (shift.job) {
        employeePrimaryJob.set(employeeId, shift.job);
        break;
      }
    }
  });

  const groupMap = new Map<string, WeeklyRow[]>();
  shiftsByEmployee.forEach((employeeShifts, employeeId) => {
    const employee = employeeMap.get(employeeId);
    if (!employee || !employee.isActive) return;

    const shiftsByDay = new Map<string, Shift[]>();
    dateStrings.forEach((date) => shiftsByDay.set(date, []));
    employeeShifts.forEach((shift) => {
      shiftsByDay.get(shift.date)?.push(shift);
    });
    shiftsByDay.forEach((list) => list.sort((left, right) => left.startHour - right.startHour));

    const totalHours = calculateWeeklyHours(employeeId, employeeShifts);
    const job = employeePrimaryJob.get(employeeId) ?? 'Unassigned';

    if (!groupMap.has(job)) {
      groupMap.set(job, []);
    }
    groupMap.get(job)?.push({ employee, shiftsByDay, totalHours });
  });

  groupMap.forEach((rows) => rows.sort((left, right) => left.employee.name.localeCompare(right.employee.name)));

  const result: WeeklyGroup[] = [];
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

function ShiftCell({ shifts }: { shifts: Shift[] }) {
  if (shifts.length === 0) {
    return <span className="text-theme-muted print:text-zinc-300">&mdash;</span>;
  }

  return (
    <div className="flex flex-col gap-[2px]">
      {shifts.map((shift) => {
        const colors = getJobColorClasses(shift.job);
        const period = classifyShift(shift.startHour);
        return (
          <div
            key={shift.id}
            className="inline-flex items-center gap-[3px] rounded px-1 py-[1px] text-[9px] font-medium leading-tight whitespace-nowrap"
            style={{ backgroundColor: colors.bgColor, color: colors.color }}
          >
            <span>
              {formatHourForReport(shift.startHour)}-
              {formatHourForReport(shift.endHour, { isEnd: true })}
            </span>
            <span
              className="h-[5px] w-[5px] flex-shrink-0 rounded-full"
              style={{ backgroundColor: period === 'AM' ? '#f59e0b' : '#6366f1' }}
              title={period}
            />
          </div>
        );
      })}
    </div>
  );
}

interface WeeklyScheduleReportProps {
  weekDates: Date[];
  restaurantName: string;
  employees: Employee[];
  shifts: Shift[];
  loading?: boolean;
  error?: string | null;
}

export function WeeklyScheduleReport({
  weekDates,
  restaurantName,
  employees,
  shifts,
  loading,
  error,
}: WeeklyScheduleReportProps) {
  const groups = useMemo(() => buildWeeklyGroups(employees, shifts, weekDates), [employees, shifts, weekDates]);
  const dateStrings = useMemo(() => weekDates.map(toYMD), [weekDates]);

  const totalStaff = useMemo(() => {
    const ids = new Set<string>();
    shifts.forEach((shift) => {
      if (!shift.isBlocked) {
        ids.add(shift.employeeId);
      }
    });
    return ids.size;
  }, [shifts]);

  const totalLaborHours = useMemo(() => {
    let total = 0;
    shifts.forEach((shift) => {
      if (!shift.isBlocked) {
        total += Math.max(0, shift.endHour - shift.startHour);
      }
    });
    return Math.round(total * 10) / 10;
  }, [shifts]);

  const estLaborCost = useMemo(() => {
    const employeeMap = new Map(employees.map((employee) => [employee.id, employee]));
    let total = 0;
    shifts.forEach((shift) => {
      if (shift.isBlocked) return;
      const hours = Math.max(0, shift.endHour - shift.startHour);
      const rate = shift.payRate ?? employeeMap.get(shift.employeeId)?.hourlyPay ?? 0;
      total += hours * rate;
    });
    return Math.round(total);
  }, [employees, shifts]);

  const weekStart = weekDates[0];
  const weekEnd = weekDates[6];

  return (
    <div className="report-weekly-root text-theme-primary print:text-black">
      <ReportHeader
        title="Weekly Schedule"
        subtitle={formatReportWeekRange(weekStart, weekEnd)}
        restaurantName={restaurantName}
      />

      <div className="stats-bar mb-4 flex gap-4 rounded-md bg-theme-secondary px-3 py-2 text-[11px] print:bg-zinc-100">
        <div className="stat-item flex items-center gap-1">
          <span className="stat-label font-medium text-theme-muted print:text-zinc-400">Staff</span>
          <span className="stat-value font-bold text-theme-primary print:text-zinc-900">{totalStaff}</span>
        </div>
        <div className="stat-item flex items-center gap-1">
          <span className="stat-label font-medium text-theme-muted print:text-zinc-400">Total Hours</span>
          <span className="stat-value font-bold text-theme-primary print:text-zinc-900">{totalLaborHours}h</span>
        </div>
        {estLaborCost > 0 && (
          <div className="stat-item flex items-center gap-1">
            <span className="stat-label font-medium text-theme-muted print:text-zinc-400">Est. Labor</span>
            <span className="stat-value font-bold text-theme-primary print:text-zinc-900">
              ${estLaborCost.toLocaleString()}
            </span>
          </div>
        )}
      </div>

      {loading && <div className="py-12 text-center text-sm text-theme-secondary print:text-zinc-500">Loading shifts...</div>}
      {error && <div className="py-8 text-center text-sm text-red-400 print:text-red-600">Error: {error}</div>}
      {!loading && !error && shifts.length === 0 && <div className="empty-state">No shifts scheduled.</div>}

      {!loading && !error && shifts.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-theme-primary bg-theme-secondary print:border-zinc-200 print:bg-white">
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr>
                <th className="w-[120px] min-w-[120px] border border-theme-primary bg-theme-tertiary px-2 py-1.5 text-left font-bold text-theme-primary print:border-zinc-200 print:bg-zinc-50 print:text-zinc-700">
                  Employee
                </th>
                {weekDates.map((date, index) => {
                  const { weekday, monthDay } = formatDayHeader(date);
                  const isToday = toYMD(date) === toYMD(new Date());
                  return (
                    <th
                      key={index}
                      className={`border border-theme-primary px-1 py-1.5 text-center font-bold ${
                        isToday
                          ? 'bg-amber-500/10 text-amber-400 print:bg-amber-50 print:text-amber-700'
                          : 'bg-theme-tertiary text-theme-primary print:bg-zinc-50 print:text-zinc-700'
                      }`}
                    >
                      <div className="text-[10px]">{weekday}</div>
                      <div className={`text-[9px] font-medium ${isToday ? 'text-amber-300 print:text-amber-600' : 'text-theme-muted print:text-zinc-400'}`}>
                        {monthDay}
                      </div>
                    </th>
                  );
                })}
                <th className="w-[48px] min-w-[48px] border border-theme-primary bg-theme-tertiary px-1 py-1.5 text-center font-bold text-theme-primary print:border-zinc-200 print:bg-zinc-50 print:text-zinc-700">
                  Hours
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.job}>
                <tr className="week-role-separator">
                  <td
                    colSpan={9}
                    className="border-0 px-2 py-1 text-[10px] font-bold uppercase tracking-wide"
                    style={{ backgroundColor: group.bgColor, color: group.color }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
                      {group.job}
                      <span className="text-[9px] font-semibold opacity-60">({group.rows.length})</span>
                    </span>
                  </td>
                </tr>

                {group.rows.map((row) => (
                  <tr key={row.employee.id}>
                    <td className="max-w-[120px] truncate border border-theme-primary px-2 py-1 font-semibold text-theme-primary print:border-zinc-200 print:text-zinc-800">
                      {row.employee.name}
                    </td>
                    {dateStrings.map((dateString, index) => (
                      <td
                        key={index}
                        className="border border-theme-primary px-1 py-1 text-center align-top print:border-zinc-200"
                      >
                        <ShiftCell shifts={row.shiftsByDay.get(dateString) ?? []} />
                      </td>
                    ))}
                    <td className="border border-theme-primary px-1 py-1 text-center font-bold text-theme-secondary print:border-zinc-200 print:text-zinc-700">
                      {row.totalHours > 0 ? `${row.totalHours}h` : '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      <div className="report-footer mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-theme-primary pt-3 text-[10px] text-theme-secondary print:border-zinc-200 print:text-zinc-500">
        <div className="footer-meta">Generated {formatReportTimestamp()}</div>
      </div>
    </div>
  );
}
