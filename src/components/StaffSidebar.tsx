'use client';

import { useScheduleStore } from '../store/scheduleStore';
import { useAuthStore } from '../store/authStore';
import { useUIStore } from '../store/uiStore';
import { Users, ChevronDown, Check, User, X, ChevronLeft, ChevronRight, CalendarCheck } from 'lucide-react';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { getJobColorClasses } from '../lib/jobColors';
import { StaffProfileModal } from './StaffProfileModal';
import { getUserRole, isManagerRole } from '../utils/role';
import { supabase } from '../lib/supabase/client';
import { normalizeUserRow } from '../utils/userMapper';
import { getWeekDates } from '../utils/timeUtils';
import { useDemoContext } from '../demo/DemoProvider';

const STORAGE_KEY = 'schedule.sidebarCollapsed';

export function StaffSidebar() {
  const {
    getEmployeesForRestaurant,
    selectedEmployeeIds,
    toggleEmployee,
    setSelectedEmployeeIds,
    getShiftsForRestaurant,
    loadRestaurantData,
    selectedDate,
    viewMode,
    workingTodayOnly,
    toggleWorkingTodayOnly,
    showToast,
    scheduleViewSettings,
  } = useScheduleStore();

  const { activeRestaurantId, currentUser } = useAuthStore();
  const { isSidebarOpen, closeSidebar } = useUIStore();
  const demo = useDemoContext();

  const [expandedSections, setExpandedSections] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  });
  const [profileUser, setProfileUser] = useState<{
    id: string;
    authUserId: string | null;
    fullName: string;
    email: string;
    phone: string;
    employeeNumber?: number | null;
    accountType: string;
    jobs: string[];
    hourlyPay?: number;
    jobPay?: Record<string, number>;
  } | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  const currentRole = getUserRole(currentUser?.role);
  const isManager = isManagerRole(currentRole);
  const isAdmin = currentRole === 'ADMIN';
  const isEmployee = currentRole === 'EMPLOYEE';

  // Close sidebar on window resize to desktop
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768 && isSidebarOpen) {
        closeSidebar();
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isSidebarOpen, closeSidebar]);

  // Close sidebar on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isSidebarOpen) {
        closeSidebar();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isSidebarOpen, closeSidebar]);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
      }
      return next;
    });
  }, []);

  // Prevent body scroll when mobile sidebar is open
  useEffect(() => {
    if (isSidebarOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isSidebarOpen]);

  const toggleExpanded = useCallback((section: string) => {
    setExpandedSections(prev =>
      prev.includes(section) ? prev.filter(s => s !== section) : [...prev, section]
    );
  }, []);

  // Use local timezone for date string to match shift_date values
  const dateString = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`;

  const scopedEmployees = getEmployeesForRestaurant(activeRestaurantId);
  const scopedShifts = getShiftsForRestaurant(activeRestaurantId);

  const employeeHoursSummary = useMemo(() => {
    if (!isEmployee || !currentUser) {
      return { lastWeek: 0, thisWeek: 0, today: 0 };
    }

    const toLocalYMD = (value: Date) =>
      `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

    const asRecord = (value: unknown): Record<string, unknown> =>
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

    const getBreakMinutes = (shift: unknown) => {
      const shiftRecord = asRecord(shift);
      const raw = shiftRecord.breakMinutes ?? shiftRecord.break_minutes ?? 0;
      const minutes = Number(raw);
      return Number.isFinite(minutes) ? minutes : 0;
    };

    const calcDuration = (shift: unknown) => {
      const shiftRecord = asRecord(shift);
      const base = Number(shiftRecord.endHour) - Number(shiftRecord.startHour);
      const breakMinutes = getBreakMinutes(shift);
      const hours = base - breakMinutes / 60;
      return Number.isFinite(hours) ? Math.max(0, hours) : 0;
    };

    const weekStartDay = scheduleViewSettings?.weekStartDay ?? 'sunday';
    const weekDates = getWeekDates(selectedDate, weekStartDay);
    const weekStart = weekDates[0];
    const weekEnd = weekDates[6];
    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);
    const lastWeekEnd = new Date(weekStart);
    lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);

    const weekStartYmd = toLocalYMD(weekStart);
    const weekEndYmd = toLocalYMD(weekEnd);
    const lastWeekStartYmd = toLocalYMD(lastWeekStart);
    const lastWeekEndYmd = toLocalYMD(lastWeekEnd);

    let lastWeek = 0;
    let thisWeek = 0;
    let today = 0;

    scopedShifts.forEach((shift) => {
      if (shift.isBlocked) return;
      if (shift.employeeId !== currentUser.id) return;
      const hours = calcDuration(shift);
      if (shift.date === dateString) {
        today += hours;
      }
      if (shift.date >= weekStartYmd && shift.date <= weekEndYmd) {
        thisWeek += hours;
      }
      if (shift.date >= lastWeekStartYmd && shift.date <= lastWeekEndYmd) {
        lastWeek += hours;
      }
    });

    return { lastWeek, thisWeek, today };
  }, [isEmployee, currentUser, scopedShifts, selectedDate, dateString, scheduleViewSettings?.weekStartDay]);

  const formatHours = (value: number) => {
    const safe = Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
    return `${safe}h`;
  };

  const visibleRange = useMemo(() => {
    const weekStartDay = scheduleViewSettings?.weekStartDay ?? 'sunday';
    if (viewMode === 'week') {
      const weekDates = getWeekDates(selectedDate, weekStartDay);
      return {
        start: `${weekDates[0].getFullYear()}-${String(weekDates[0].getMonth() + 1).padStart(2, '0')}-${String(weekDates[0].getDate()).padStart(2, '0')}`,
        end: `${weekDates[6].getFullYear()}-${String(weekDates[6].getMonth() + 1).padStart(2, '0')}-${String(weekDates[6].getDate()).padStart(2, '0')}`,
      };
    }
    return { start: dateString, end: dateString };
  }, [dateString, selectedDate, scheduleViewSettings?.weekStartDay, viewMode]);

  const scheduledEmployeeIds = useMemo(() => {
    const ids = new Set<string>();
    scopedShifts.forEach((shift) => {
      if (shift.isBlocked) return;
      if (shift.date < visibleRange.start || shift.date > visibleRange.end) return;
      ids.add(shift.employeeId);
    });
    return ids;
  }, [scopedShifts, visibleRange.end, visibleRange.start]);

  // Search filter only affects visible employees in the sidebar.
  // Group toggles operate on visible employees only.
  const filteredEmployees = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    let nextEmployees = scopedEmployees;
    if (query) {
      nextEmployees = nextEmployees.filter((emp) =>
      emp.name.toLowerCase().includes(query)
        || emp.email?.toLowerCase().includes(query)
        || emp.phone?.toLowerCase().includes(query)
      );
    }
    if (workingTodayOnly) {
      nextEmployees = nextEmployees.filter((emp) => scheduledEmployeeIds.has(emp.id));
    }
    return nextEmployees;
  }, [scopedEmployees, scheduledEmployeeIds, searchQuery, workingTodayOnly]);

  // Group employees by job title for sidebar display
  // Uses filteredEmployees so groups only contain visible (search-matched) employees
  // This ensures group checkboxes only toggle visible employees
  const employeesByJob = useMemo(() => {
    const map: Record<string, typeof filteredEmployees> = {};
    filteredEmployees.forEach((emp) => {
      if (!emp.isActive) return;
      const jobs = emp.jobs ?? [];
      if (!jobs.length) {
        map.Unassigned = map.Unassigned ?? [];
        map.Unassigned.push(emp);
        return;
      }
      jobs.forEach((job) => {
        map[job] = map[job] ?? [];
        map[job].push(emp);
      });
    });
    return map;
  }, [filteredEmployees]);

  const hasScheduledShiftInRange = useCallback((employeeId: string) => {
    return scheduledEmployeeIds.has(employeeId);
  }, [scheduledEmployeeIds]);

  const activeEmployees = useMemo(() => 
    scopedEmployees.filter((e) => e.isActive),
    [scopedEmployees]
  );

  const isSectionFullySelected = useCallback((group: string) => {
    const sectionEmps = employeesByJob[group] || [];
    if (sectionEmps.length === 0) return false;
    return sectionEmps.every(e => selectedEmployeeIds.includes(e.id));
  }, [employeesByJob, selectedEmployeeIds]);

  const isSectionPartiallySelected = useCallback((group: string) => {
    const sectionEmps = employeesByJob[group] || [];
    if (sectionEmps.length === 0) return false;
    const selectedCount = sectionEmps.filter(e => selectedEmployeeIds.includes(e.id)).length;
    return selectedCount > 0 && selectedCount < sectionEmps.length;
  }, [employeesByJob, selectedEmployeeIds]);

  // Toggle selection for all VISIBLE employees in a job group
  // When search filter is active, only visible employees are toggled
  // This follows "what you see is what you get" UX principle
  const handleSectionToggle = useCallback((group: string) => {
    const sectionEmps = employeesByJob[group] || [];
    if (sectionEmps.length === 0) return;

    const employeeIdsInGroup = sectionEmps.map(e => e.id);
    const allSelected = sectionEmps.every(e => selectedEmployeeIds.includes(e.id));

    let newSelectedIds: string[];
    if (allSelected) {
      // Deselect all visible employees in this group
      newSelectedIds = selectedEmployeeIds.filter(id => !employeeIdsInGroup.includes(id));
    } else {
      // Select all visible employees in this group
      newSelectedIds = [...new Set([...selectedEmployeeIds, ...employeeIdsInGroup])];
    }
    setSelectedEmployeeIds(newSelectedIds);
  }, [employeesByJob, selectedEmployeeIds, setSelectedEmployeeIds]);

  const openProfileForEmployee = useCallback(async (employeeId: string) => {
    if (demo?.isDemo) {
      demo.intercept('view full staff profiles');
      return;
    }
    if (!activeRestaurantId) return;
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', employeeId)
      .eq('organization_id', activeRestaurantId)
      .maybeSingle();

    if (error || !data) {
      showToast(error?.message || 'Unable to load staff profile.', 'error');
      return;
    }

    const normalized = normalizeUserRow(data);
    setProfileUser({
      id: normalized.id,
      authUserId: data.auth_user_id ?? null,
      fullName: normalized.fullName,
      email: normalized.email ?? '',
      phone: normalized.phone ?? '',
      employeeNumber: normalized.employeeNumber ?? null,
      accountType: normalized.role,
      jobs: normalized.jobs,
      hourlyPay: normalized.hourlyPay,
      jobPay: normalized.jobPay,
    });
    setProfileOpen(true);
  }, [activeRestaurantId, demo, showToast]);

  const sidebarContent = (
    <>
      <div className="px-2 py-2 border-b border-theme-primary">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Users className="w-4 h-4 text-theme-tertiary" />
            <span className="font-medium text-theme-primary text-[11px] uppercase tracking-widest">Staff</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-theme-muted">
              {selectedEmployeeIds.length} / {activeEmployees.length}
            </span>
            <button
              onClick={toggleSidebarCollapsed}
              className="hidden md:inline-flex p-1 rounded-lg hover:bg-theme-hover text-theme-tertiary hover:text-theme-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronLeft className="w-4 h-4" />
              )}
            </button>
            {/* Mobile close button */}
            <button
              onClick={closeSidebar}
              className="md:hidden p-1.5 rounded-lg hover:bg-theme-hover text-theme-tertiary hover:text-theme-primary transition-colors"
              aria-label="Close sidebar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        {/* Working Today filter toggle */}
        <button
          onClick={toggleWorkingTodayOnly}
          className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 mt-2 rounded-lg transition-colors text-[11px] font-medium ${
            workingTodayOnly
              ? 'bg-amber-500/15 text-amber-500 hover:bg-amber-500/25'
              : 'bg-theme-tertiary text-theme-muted hover:text-theme-secondary hover:bg-theme-hover'
          }`}
          title={viewMode === 'week' ? 'Hide staff with no shifts in the visible week' : 'Hide staff with no shifts on the selected day'}
          aria-pressed={workingTodayOnly}
        >
          <span className="flex items-center gap-1.5">
            <CalendarCheck className="w-3.5 h-3.5" />
            <span>Working today</span>
          </span>
          <span
            className={`w-7 h-4 rounded-full transition-colors relative ${
              workingTodayOnly ? 'bg-amber-500' : 'bg-theme-secondary'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
                workingTodayOnly ? 'translate-x-3' : 'translate-x-0'
              }`}
            />
          </span>
        </button>

        {isEmployee && currentUser && (
          <div className="mt-3 rounded-xl border border-theme-primary bg-theme-tertiary/70 p-3">
            <p className="text-[10px] uppercase tracking-widest text-theme-muted">Employee Hours Summary</p>
            <div className="mt-2 space-y-1 text-[11px] text-theme-tertiary">
              <div className="flex items-center justify-between">
                <span>Last week</span>
                <span className="font-semibold text-theme-primary">{formatHours(employeeHoursSummary.lastWeek)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>This week</span>
                <span className="font-semibold text-theme-primary">{formatHours(employeeHoursSummary.thisWeek)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Selected day</span>
                <span className="font-semibold text-theme-primary">{formatHours(employeeHoursSummary.today)}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1.5">
        <div className="px-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search staff"
            className="w-full px-2.5 py-1.5 rounded-lg bg-theme-tertiary border border-theme-primary text-[12px] text-theme-primary placeholder:text-theme-muted focus:outline-none focus:ring-2 focus:ring-amber-500/40"
          />
        </div>
        {Object.keys(employeesByJob).length === 0 ? (
          <p className="text-xs text-theme-muted px-2">No staff to show.</p>
        ) : (
          Object.keys(employeesByJob).map((job) => {
            const jobEmployees = employeesByJob[job];
            if (!jobEmployees || jobEmployees.length === 0) return null;
            const isExpanded = expandedSections.includes(job);
            const isFullySelected = isSectionFullySelected(job);
            const isPartiallySelected = isSectionPartiallySelected(job);
            // Count employees scheduled (have shift) on the selected date
            const scheduledCount = jobEmployees.filter((e) => scheduledEmployeeIds.has(e.id)).length;
            const jobColor = getJobColorClasses(job);

            return (
              <div key={job} className="mb-0.5">
                <div className="flex items-center gap-1">
                  <span className={`w-0.5 h-5 rounded-full shrink-0 ${jobColor.indicatorClass}`} aria-hidden="true" />
                  <button
                    onClick={() => handleSectionToggle(job)}
                    className="p-1 rounded-lg hover:bg-theme-hover transition-colors min-w-[30px] min-h-[30px] flex items-center justify-center"
                    aria-label={`Toggle all ${job} employees`}
                  >
                    <div
                      className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                        isFullySelected
                          ? 'border-amber-500 bg-amber-500'
                          : isPartiallySelected
                          ? 'border-amber-500 bg-amber-500/50'
                          : 'border-theme-secondary'
                      }`}
                    >
                      {(isFullySelected || isPartiallySelected) && (
                        <Check className="w-2.5 h-2.5 text-zinc-900" />
                      )}
                    </div>
                  </button>
                  <button
                    onClick={() => toggleExpanded(job)}
                    className="flex-1 flex items-center justify-between p-1 px-2 rounded-lg hover:bg-theme-hover transition-colors min-h-[30px] gap-1.5"
                    aria-expanded={isExpanded}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs font-semibold leading-tight ${jobColor.textClass}`}>{job}</span>
                      <span className="text-[11px] text-theme-muted">
                        {scheduledCount}/{jobEmployees.length}
                      </span>
                    </div>
                    <ChevronDown
                      className={`w-3 h-3 text-theme-muted transition-transform duration-200 ${
                        isExpanded ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {!isFullySelected && (
                    <button
                      onClick={() => handleSectionToggle(job)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors hover:bg-theme-hover shrink-0"
                      aria-label={`Select all ${job} employees`}
                    >
                      <span className="text-theme-muted hover:text-theme-secondary">All</span>
                    </button>
                  )}
                </div>
                {isExpanded && (
                  <div className="ml-1.5 space-y-0.5 mt-0.5">
                    {jobEmployees.map((employee) => {
                      const isSelected = selectedEmployeeIds.includes(employee.id);
                      const hasShift = hasScheduledShiftInRange(employee.id);

                      return (
                        <div
                          key={`${job}-${employee.id}`}
                          className={`flex items-center gap-1 px-1.5 py-1 rounded-lg text-[11px] transition-colors border-l-2 ${jobColor.borderClass} ${
                            isSelected
                              ? 'bg-theme-tertiary text-theme-primary'
                              : 'text-theme-muted hover:bg-theme-hover hover:text-theme-secondary'
                          }`}
                        >
                          <button
                            onClick={() => toggleEmployee(employee.id)}
                            className="flex items-center gap-1 flex-1 min-h-[28px]"
                          >
                            <div
                              className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center transition-colors shrink-0 ${
                                isSelected ? 'border-amber-500 bg-amber-500' : 'border-theme-secondary'
                              }`}
                            >
                              {isSelected && <Check className="w-2.5 h-2.5 text-zinc-900" />}
                            </div>
                            <div className="flex-1 text-left truncate text-[12px] font-medium leading-tight">
                              {employee.name}
                            </div>
                            {hasShift && (
                              <div className={`w-2 h-2 rounded-full ${jobColor.dotClass} shrink-0`} title="Working today" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="p-1 rounded hover:bg-theme-hover text-theme-muted hover:text-theme-primary transition-colors text-[11px]"
                            title="View Profile"
                            onClick={() => openProfileForEmployee(employee.id)}
                          >
                            <User className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden md:flex ${
          sidebarCollapsed ? 'w-16' : 'w-64'
        } min-h-0 h-full bg-theme-secondary border-r border-theme-primary flex-col shrink-0 transition-[width] duration-200 ease-out overflow-hidden`}
      >
        {sidebarCollapsed ? (
          <div className="flex h-full w-full flex-col items-center justify-center">
            <button
              onClick={toggleSidebarCollapsed}
              className="p-2 rounded-full bg-theme-secondary/60 text-theme-secondary hover:text-theme-primary hover:bg-theme-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500 transition-colors"
              aria-label="Expand sidebar"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex h-full flex-col overflow-hidden">
            {sidebarContent}
          </div>
        )}
      </aside>

      {/* Mobile drawer overlay */}
      {isSidebarOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={`md:hidden fixed inset-y-0 left-0 z-50 w-80 max-w-[85vw] bg-theme-secondary border-r border-theme-primary flex flex-col transition-transform duration-300 ease-out ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Staff sidebar"
      >
        <div className="pt-14 h-full flex flex-col">
          {sidebarContent}
        </div>
      </aside>

      {activeRestaurantId && currentUser && (
        <StaffProfileModal
          isOpen={profileOpen}
          mode="edit"
          user={profileUser}
          isAdmin={isAdmin}
          isManager={isManager}
          organizationId={activeRestaurantId}
          currentAuthUserId={currentUser.authUserId ?? null}
          onClose={() => setProfileOpen(false)}
          onSaved={async () => {
            await loadRestaurantData(activeRestaurantId);
            showToast('Profile updated', 'success');
          }}
          onSuccess={(message) => showToast(message, 'success')}
          onError={(message) => showToast(message, 'error')}
          onAuthError={(message) => showToast(message, 'error')}
        />
      )}
    </>
  );
}
