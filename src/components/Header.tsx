'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useScheduleStore } from '../store/scheduleStore';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { useUIStore } from '../store/uiStore';
import {
  Calendar,
  Plus,
  Sun,
  Moon,
  MessageSquare,
  User,
  LogOut,
  CalendarOff,
  ArrowLeftRight,
  BarChart3,
  Users,
  Clock,
  ClipboardList,
  Menu,
  X,
  MoreHorizontal,
  CreditCard,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { getUserRole, isManagerRole } from '../utils/role';
import { getAppHomeHref } from '../lib/routing/getAppHomeHref';

type HeaderProps = {
  /** If true, renders a minimal header without schedule-specific actions */
  minimal?: boolean;
  /** If true, renders onboarding-only actions (theme + logout) */
  onboardingMode?: boolean;
};

export function Header({ minimal = false, onboardingMode = false }: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [moreMenuPosition, setMoreMenuPosition] = useState({ top: 0, left: 0 });
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuButtonRef = useRef<HTMLButtonElement>(null);
  
  const { 
    openModal,
    getPendingTimeOffRequests,
    getPendingBlockedDayRequests,
    scheduleMode,
    selectedDate,
    viewMode,
  } = useScheduleStore();

  const { currentUser, signOut, accessibleRestaurants, pendingInvitations, activeRestaurantId } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const currentRole = getUserRole(currentUser?.role);
  const {
    openProfileModal,
    openTimeOffModal,
    toggleSidebar,
    isSubscriptionBlocked,
    uiLockedForOnboarding,
  } = useUIStore();

  const handleLogout = () => {
    signOut();
    router.push('/login');
  };

  const handleReportsClick = () => {
    const view = viewMode === 'week' || viewMode === 'month' ? 'weekly' : 'roster';
    const date = toYMD(selectedDate);
    router.push(`/reports?view=${view}&date=${date}`);
  };

  const pendingRequests = getPendingTimeOffRequests();
  const pendingBlockedRequests = getPendingBlockedDayRequests();
  const pendingReviewCount = pendingRequests.length + pendingBlockedRequests.length;
  const hasRestaurants = (accessibleRestaurants?.length ?? 0) > 0;
  const hasActiveRestaurant = Boolean(activeRestaurantId);
  const noRestaurants = !hasRestaurants;
  const onboardingWithoutOrg =
    !hasActiveRestaurant
    && (pathname.startsWith('/setup') || pathname.startsWith('/onboarding') || pathname.startsWith('/persona'));
  const hideNavLinks = noRestaurants || onboardingWithoutOrg;
  const showReports = hasRestaurants && hasActiveRestaurant && isManagerRole(currentRole);
  // Always allow access to Restaurants/Site Manager for signed-in users
  const showRestaurantsLink = Boolean(currentUser);
  const activeRestaurantName =
    accessibleRestaurants.find((restaurant) => restaurant.id === activeRestaurantId)?.name ?? null;

  // Close menu when clicking outside or pressing Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (moreMenuRef.current?.contains(target)) return;
      if (moreMenuButtonRef.current?.contains(target)) return;
      setMoreMenuOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreMenuOpen(false);
      }
    };
    if (moreMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [moreMenuOpen]);

  // Close menu on route change
  useEffect(() => {
    const timer = setTimeout(() => setMoreMenuOpen(false), 0);
    return () => clearTimeout(timer);
  }, [pathname]);

  // Position menu using button rect (portal-friendly)
  useEffect(() => {
    if (!moreMenuOpen) return;
    const updatePosition = () => {
      const button = moreMenuButtonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const menuWidth = 224;
      const margin = 8;
      let left = rect.right - menuWidth;
      if (left < margin) {
        left = margin;
      }
      const maxLeft = window.innerWidth - menuWidth - margin;
      if (left > maxLeft) {
        left = maxLeft;
      }
      const top = rect.bottom + 8;
      setMoreMenuPosition({ top, left });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [moreMenuOpen]);

  const appHomeHref = getAppHomeHref();
  const isOnDashboard = pathname === '/dashboard';
  const showAddShift =
    pathname === appHomeHref
    || (appHomeHref !== '/' && pathname.startsWith(`${appHomeHref}/`));
  const isEmployeeNavPage =
    pathname === '/dashboard' ||
    pathname === '/shift-exchange' ||
    pathname === '/review-requests' ||
    pathname === '/profile' ||
    pathname === '/chat';
  const locked = onboardingMode || uiLockedForOnboarding || hideNavLinks;
  const isEmployee = currentRole === 'EMPLOYEE';
  const isRestrictedHeader = isSubscriptionBlocked && !locked;
  const showEmployeeMobileHeader = !locked && isEmployee && isEmployeeNavPage && !minimal;
  const logoHref = currentUser ? appHomeHref : (locked || isRestrictedHeader ? '/setup' : appHomeHref);

  function toYMD(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-14 sm:h-16 bg-theme-secondary border-b border-theme-primary transition-theme">
      <div className="h-full px-2 sm:px-4 lg:px-6 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-4 relative">
        {/* Left: Logo + Mobile sidebar toggle + Primary nav */}
        <div className="flex items-center gap-1 sm:gap-2 min-w-0">
          {/* Mobile sidebar toggle - only on dashboard */}
          {!locked && !minimal && !isRestrictedHeader && isOnDashboard && !showEmployeeMobileHeader && (
            <button
              onClick={toggleSidebar}
              className="md:hidden p-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
              aria-label="Toggle staff sidebar"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          <Link href={logoHref} className="flex items-center gap-2 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center">
              <Calendar className="w-4 h-4 text-zinc-900" />
            </div>
            {showEmployeeMobileHeader && (
              <span className="sm:hidden font-semibold text-theme-primary">CrewShyft</span>
            )}
            <span className="hidden sm:inline font-semibold text-theme-primary">CrewShyft</span>
          </Link>

          {/* Primary nav - hidden in minimal mode */}
          {!locked && !minimal && !isRestrictedHeader && (
            <nav className={`flex items-center gap-1 sm:gap-2 ${showEmployeeMobileHeader ? 'hidden md:flex' : ''}`}>
              <Link
                href={appHomeHref}
                className="inline-flex items-center gap-1.5 px-2 sm:px-3 py-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors text-sm font-medium"
                aria-label="Schedule"
              >
                <Calendar className="w-4 h-4" />
                <span className="hidden sm:inline">Schedule</span>
              </Link>

              {/* Review Requests - visible on tablet+ */}
              <Link
                href="/review-requests"
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors text-sm font-medium"
                aria-label="Review Requests"
              >
                <ClipboardList className="w-4 h-4" />
                <span className="hidden lg:inline">Review Requests</span>
                {isManagerRole(currentRole) && pendingReviewCount > 0 && (
                  <span className="w-5 h-5 bg-amber-500 text-zinc-900 text-xs font-bold rounded-full flex items-center justify-center">
                    {pendingReviewCount}
                  </span>
                )}
              </Link>
            </nav>
          )}

        </div>

        {/* Center: Restaurant name */}
        <div className="flex items-center justify-center min-w-0">
          {!locked && !minimal && !isRestrictedHeader && activeRestaurantName && (
            <span className="text-sm sm:text-base md:text-lg font-semibold text-theme-primary truncate max-w-[50vw] sm:max-w-[40vw]">
              {activeRestaurantName}
            </span>
          )}
        </div>

        {/* Right: Actions + More menu */}
        <div className="flex items-center gap-1 sm:gap-2 min-w-0 w-full justify-end">
          {/* Add Shift - hidden in minimal mode */}
          {!locked && !minimal && !isRestrictedHeader && isManagerRole(currentRole) && showAddShift && (
            <button
              onClick={() => openModal('addShift')}
              className="inline-flex items-center gap-1.5 px-2 sm:px-3 py-2 rounded-lg bg-amber-500 text-zinc-900 hover:bg-amber-400 transition-all hover:shadow-lg text-sm font-medium"
              aria-label="Add Shift"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Add Shift</span>
            </button>
          )}

          {/* Copy Schedule - hidden in minimal mode */}
          {!locked && !minimal && !isRestrictedHeader && isManagerRole(currentRole) && isOnDashboard && scheduleMode !== 'draft' && (
            <button
              onClick={() => openModal('copySchedule')}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-400 transition-colors text-sm font-medium"
              aria-label="Copy Schedule"
            >
              <ArrowLeftRight className="w-4 h-4" />
              <span className="hidden sm:inline">Copy Schedule</span>
            </button>
          )}

          {/* Reports - placeholder action */}
          {!locked && !isRestrictedHeader && showReports && (
            <button
              onClick={handleReportsClick}
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors text-sm font-medium"
              aria-label="Reports"
            >
              <BarChart3 className="w-4 h-4" />
              <span className="hidden lg:inline">Reports</span>
            </button>
          )}

          {/* More menu */}
          <div className="relative">
            <button
              onClick={() => setMoreMenuOpen(!moreMenuOpen)}
              className="inline-flex items-center gap-1.5 p-2 rounded-lg bg-theme-tertiary text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
              aria-label="More options"
              aria-expanded={moreMenuOpen}
              ref={moreMenuButtonRef}
            >
              {moreMenuOpen && !locked ? <X className="w-5 h-5" /> : <MoreHorizontal className="w-5 h-5" />}
            </button>

            {moreMenuOpen && typeof document !== 'undefined' && createPortal(
              <div
                ref={moreMenuRef}
                className="w-56 bg-theme-secondary border border-theme-primary rounded-xl shadow-xl py-2 animate-slide-in"
                style={{
                  position: 'fixed',
                  top: moreMenuPosition.top,
                  left: moreMenuPosition.left,
                  zIndex: 1100,
                }}
              >
                {locked ? (
                  <>
                    <button
                      onClick={toggleTheme}
                      className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                    >
                      {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                      {theme === 'dark' ? 'Light Theme' : 'Dark Theme'}
                    </button>
                    <button
                      onClick={handleLogout}
                      className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Logout
                    </button>
                  </>
                ) : isRestrictedHeader ? (
                  <>
                    <Link
                      href="/restaurants"
                      onClick={() => setMoreMenuOpen(false)}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                    >
                      <Users className="w-4 h-4" />
                      Restaurants
                    </Link>
                    <div className="border-t border-theme-primary pt-2 mt-2">
                      <button
                        onClick={toggleTheme}
                        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                      >
                        {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                        {theme === 'dark' ? 'Light Theme' : 'Dark Theme'}
                      </button>
                      <button
                        onClick={handleLogout}
                        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <LogOut className="w-4 h-4" />
                        Logout
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Mobile-only items - hidden in minimal mode */}
                    {!minimal && (
                      <div className="sm:hidden border-b border-theme-primary pb-2 mb-2">
                        <Link
                          href="/review-requests"
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                        >
                          <ClipboardList className="w-4 h-4" />
                          Review Requests
                          {isManagerRole(currentRole) && pendingReviewCount > 0 && (
                            <span className="ml-auto w-5 h-5 bg-amber-500 text-zinc-900 text-xs font-bold rounded-full flex items-center justify-center">
                              {pendingReviewCount}
                            </span>
                          )}
                        </Link>
                      </div>
                    )}

                    {currentUser && (
                      <button
                        onClick={() => { openProfileModal(); setMoreMenuOpen(false); }}
                        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                      >
                        <User className="w-4 h-4" />
                        My Profile
                      </button>
                    )}

                    {/* Schedule actions - hidden in minimal mode */}
                    {!minimal && currentUser && (
                      <div className="border-b border-theme-primary pb-2 mb-2">
                        <button
                          onClick={() => { openTimeOffModal({ employeeId: currentUser.id }); setMoreMenuOpen(false); }}
                          className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-emerald-500 hover:bg-emerald-500/10 transition-colors"
                        >
                          <CalendarOff className="w-4 h-4" />
                          Request Time Off
                        </button>
                        <Link
                          href="/shift-exchange"
                          onClick={() => setMoreMenuOpen(false)}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                        >
                          <ArrowLeftRight className="w-4 h-4" />
                          Swap Shift
                        </Link>
                      </div>
                    )}

                    {/* Back to Schedule - shown in minimal mode */}
                    {minimal && (
                      <Link
                        href={appHomeHref}
                        onClick={() => setMoreMenuOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                      >
                        <Calendar className="w-4 h-4" />
                        Back to Schedule
                      </Link>
                    )}

                    {!minimal && showRestaurantsLink && (
                      <Link
                        href="/restaurants"
                        onClick={() => setMoreMenuOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                      >
                        <Users className="w-4 h-4" />
                        Restaurants
                        {pendingInvitations.length > 0 && (
                          <span className="ml-auto w-5 h-5 bg-emerald-500 text-zinc-900 text-xs font-bold rounded-full flex items-center justify-center">
                            {pendingInvitations.length}
                          </span>
                        )}
                      </Link>
                    )}

                    {!minimal && (
                      <Link
                        href="/chat"
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                      >
                        <MessageSquare className="w-4 h-4" />
                        Team Chat
                      </Link>
                    )}

                    {!minimal && isManagerRole(currentRole) && (
                      <>
                        <Link
                          href="/staff"
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                        >
                          <Users className="w-4 h-4" />
                          Manage Staff
                        </Link>
                        <Link
                          href="/blocked-days"
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                        >
                          <CalendarOff className="w-4 h-4" />
                          Blocked Days
                        </Link>
                        <Link
                          href="/business-hours"
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                        >
                          <Clock className="w-4 h-4" />
                          Schedule Settings
                        </Link>
                        {currentRole === 'ADMIN' && (
                          <Link
                            href="/billing"
                            className="flex items-center gap-3 px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                          >
                            <CreditCard className="w-4 h-4" />
                            Billing
                          </Link>
                        )}
                      </>
                    )}

                    <div className="border-t border-theme-primary pt-2 mt-2">
                      <button
                        onClick={toggleTheme}
                        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-theme-secondary hover:bg-theme-hover hover:text-theme-primary transition-colors"
                      >
                        {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                        {theme === 'dark' ? 'Light Theme' : 'Dark Theme'}
                      </button>

                      <button
                        onClick={handleLogout}
                        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <LogOut className="w-4 h-4" />
                        Logout
                      </button>
                    </div>
                  </>
                )}
              </div>,
              document.body
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
