'use client';

import type { Employee, Shift } from '../../types';
import {
  classifyShift,
  isDoubleShift,
  calculateDailyStats,
  formatReportDate,
  formatReportTimestamp,
  formatPhoneStrict,
  formatTimeLabel,
  getJobColorClasses,
  compareJobs,
} from './report-utils';
import { ReportHeader } from './ReportHeader';

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

interface RosterGroup {
  job: string;
  color: string;
  bgColor: string;
  entries: RosterEntry[];
}

interface RosterEntry {
  employee: Employee;
  shift: Shift;
  isDouble: boolean;
}

function buildRosterGroups(
  employees: Employee[],
  shifts: Shift[],
  period: 'AM' | 'PM'
): RosterGroup[] {
  const employeeMap = new Map(employees.map((e) => [e.id, e]));
  const doubleSet = new Set<string>();
  // Pre-compute doubles
  const employeeIds = new Set(shifts.map((s) => s.employeeId));
  employeeIds.forEach((id) => {
    if (isDoubleShift(id, shifts)) doubleSet.add(id);
  });

  // Collect entries for this period
  const periodShifts = shifts.filter((s) => classifyShift(s.startHour) === period);

  // Group by job
  const groupMap = new Map<string, RosterEntry[]>();
  periodShifts.forEach((shift) => {
    const emp = employeeMap.get(shift.employeeId);
    if (!emp) return;
    const job = shift.job ?? 'Unassigned';
    if (!groupMap.has(job)) groupMap.set(job, []);
    groupMap.get(job)!.push({
      employee: emp,
      shift,
      isDouble: doubleSet.has(shift.employeeId),
    });
  });

  // Sort entries within each group by start time, then name
  groupMap.forEach((entries) =>
    entries.sort((a, b) => a.shift.startHour - b.shift.startHour || a.employee.name.localeCompare(b.employee.name))
  );

  const result: RosterGroup[] = [];
  const jobList = Array.from(groupMap.keys()).sort(compareJobs);
  jobList.forEach((job) => {
    const entries = groupMap.get(job);
    if (!entries || entries.length === 0) return;
    const colors = getJobColorClasses(job);
    result.push({ job, color: colors.color, bgColor: colors.bgColor, entries });
  });

  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DailyRosterReportProps {
  date: Date;
  restaurantName: string;
  employees: Employee[];
  shifts: Shift[];
}

export function DailyRosterReport({
  date,
  restaurantName,
  employees,
  shifts,
}: DailyRosterReportProps) {
  const stats = calculateDailyStats(employees, shifts);
  const amGroups = buildRosterGroups(employees, shifts, 'AM');
  const pmGroups = buildRosterGroups(employees, shifts, 'PM');
  const totalHours = shifts.reduce((sum, shift) => sum + Math.max(0, shift.endHour - shift.startHour), 0);

  const formatPhone = (emp: Employee) => {
    const phone = emp.phone ?? emp.profile?.phone;
    return formatPhoneStrict(phone);
  };

  return (
    <div className="report-roster-root text-theme-primary print:text-black">
      <ReportHeader
        title="Daily Roster"
        subtitle={formatReportDate(date)}
        restaurantName={restaurantName}
        stats={[
          { label: 'Total Staff', value: stats.total },
          { label: 'AM', value: stats.amCount },
          { label: 'PM', value: stats.pmCount },
          { label: 'Doubles', value: stats.doublesCount },
          { label: 'Total Hours', value: `${Math.round(totalHours * 10) / 10}h` },
          {
            label: 'Est. Labor',
            value:
              stats.estLaborCost > 0
                ? `$${stats.estLaborCost.toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}`
                : '\u2014',
          },
        ]}
      />

      <div>
        {/* Empty state */}
        {shifts.length === 0 && (
          <div className="empty-state">No shifts scheduled.</div>
        )}

          {/* AM / PM columns */}
        {shifts.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* AM Column */}
            <div className="space-y-4">
              <div className="text-center text-xs font-semibold uppercase tracking-wide text-theme-secondary print:text-zinc-500">
                AM Shift
              </div>
              {amGroups.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-theme-muted print:text-zinc-400">No AM shifts</p>
              )}
              {amGroups.map((group) => (
                <div key={group.job} className="overflow-hidden rounded-xl border border-theme-primary bg-theme-secondary print:border-zinc-200 print:bg-white">
                  <div
                    className="flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
                    style={{
                      backgroundColor: group.bgColor,
                      color: group.color,
                      borderLeft: `4px solid ${group.color}`,
                    }}
                  >
                    <span>{group.job} ({group.entries.length})</span>
                  </div>
                  <div className="divide-y divide-theme-primary print:divide-zinc-100">
                    {group.entries.map((entry) => (
                      <div
                        key={entry.shift.id}
                        className="grid items-center gap-3 px-3 py-2 text-[11px]"
                        style={{ gridTemplateColumns: 'minmax(0,1fr) 140px 90px' }}
                      >
                        <span className="truncate font-semibold text-theme-primary print:text-zinc-900">
                          {entry.employee.name}
                          {entry.isDouble && <span className="text-amber-500 font-bold text-[12px] ml-1">*</span>}
                        </span>
                        <span className="text-center tabular-nums text-theme-secondary print:text-zinc-500">
                          {formatPhone(entry.employee)}
                        </span>
                        <span className="text-right font-medium tabular-nums text-theme-secondary print:text-zinc-700">
                          {formatTimeLabel(entry.shift.startHour)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* PM Column */}
            <div className="space-y-4">
              <div className="text-center text-xs font-semibold uppercase tracking-wide text-theme-secondary print:text-zinc-500">
                PM Shift
              </div>
              {pmGroups.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-theme-muted print:text-zinc-400">No PM shifts</p>
              )}
              {pmGroups.map((group) => (
                <div key={group.job} className="overflow-hidden rounded-xl border border-theme-primary bg-theme-secondary print:border-zinc-200 print:bg-white">
                  <div
                    className="flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
                    style={{
                      backgroundColor: group.bgColor,
                      color: group.color,
                      borderLeft: `4px solid ${group.color}`,
                    }}
                  >
                    <span>{group.job} ({group.entries.length})</span>
                  </div>
                  <div className="divide-y divide-theme-primary print:divide-zinc-100">
                    {group.entries.map((entry) => (
                      <div
                        key={entry.shift.id}
                        className="grid items-center gap-3 px-3 py-2 text-[11px]"
                        style={{ gridTemplateColumns: 'minmax(0,1fr) 140px 90px' }}
                      >
                        <span className="truncate font-semibold text-theme-primary print:text-zinc-900">
                          {entry.employee.name}
                          {entry.isDouble && <span className="text-amber-500 font-bold text-[12px] ml-1">*</span>}
                        </span>
                        <span className="text-center tabular-nums text-theme-secondary print:text-zinc-500">
                          {formatPhone(entry.employee)}
                        </span>
                        <span className="text-right font-medium tabular-nums text-theme-secondary print:text-zinc-700">
                          {formatTimeLabel(entry.shift.startHour)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="report-footer mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-theme-primary pt-4 text-[10px] text-theme-secondary print:border-zinc-200 print:text-zinc-500">
        <div className="footer-meta">Generated {formatReportTimestamp()}</div>
      </div>
    </div>
  );
}
