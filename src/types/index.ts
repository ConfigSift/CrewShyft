// Section type for organizing employees
export type Section = 'kitchen' | 'front' | 'bar' | 'management';

// User role for permissions
export type UserRole = 'ADMIN' | 'MANAGER' | 'EMPLOYEE';
export type UserPersona = 'manager' | 'employee';

export interface EmployeeProfile {
  phone?: string;
  email?: string;
  notes?: string;
}

export interface Employee {
  id: string;
  name: string;
  section: Section;
  userRole: UserRole;
  restaurantId?: string;
  profile: EmployeeProfile;
  isActive: boolean;
  jobs?: string[];
  hourlyPay?: number;
  jobPay?: Record<string, number>; // Per-job hourly pay rates
  email?: string | null;
  phone?: string | null;
  employeeNumber?: number | null;
  realEmail?: string | null;
}

export interface Restaurant {
  id: string;
  name: string;
  restaurantCode: string;
  createdAt: string;
  createdByUserId: string;
}

export interface UserProfile {
  id: string;
  authUserId: string;
  organizationId: string;
  email: string | null;
  phone: string | null;
  fullName: string;
  role: UserRole;
  accountType?: 'owner' | 'employee';
  ownerName?: string | null;
  jobs: string[];
  hourlyPay?: number;
  jobPay?: Record<string, number>; // Per-job hourly pay rates
  employeeNumber?: number | null;
  realEmail?: string | null;
  persona?: UserPersona;
  hasCompletedRestaurantSetup?: boolean;
}

export interface Shift {
  id: string;
  employeeId: string;
  restaurantId: string;
  date: string; // YYYY-MM-DD
  startHour: number; // 0-24 decimal (e.g., 9.5 = 9:30am)
  endHour: number;
  notes?: string;
  isBlocked?: boolean;
  job?: string;
  locationId?: string | null;
  payRate?: number; // Hourly rate for this shift (set by DB trigger)
  paySource?: string; // Source of pay rate: 'job_pay', 'hourly_pay', or 'default'
  scheduleState?: 'draft' | 'published';
  swapStatus?: 'none' | 'offered' | 'claimed';
}

export type TimeOffStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELED';

export interface TimeOffRequest {
  id: string;
  employeeId: string;
  organizationId?: string;
  startDate: string;
  endDate: string;
  reason?: string;
  status: TimeOffStatus;
  createdAt: string;
  updatedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  managerNote?: string;
  canceledAt?: string;
  canceled_at?: string;
}

export interface BlockedPeriod {
  id: string;
  startDate: string;
  endDate: string;
  startHour?: number;
  endHour?: number;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export type DropRequestStatus = 'open' | 'accepted' | 'cancelled';

export interface DropShiftRequest {
  id: string;
  shiftId: string;
  fromEmployeeId: string;
  status: DropRequestStatus;
  createdAt: string;
  acceptedByEmployeeId?: string;
  acceptedAt?: string;
}

export type ChatMessageType = 'message' | 'drop_request' | 'system';

export interface ChatMessage {
  id: string;
  senderId: string;
  createdAt: string;
  text: string;
  type: ChatMessageType;
  dropRequestId?: string;
}

export interface ChatRoom {
  id: string;
  organizationId: string;
  name: string;
  createdByAuthUserId: string;
  createdAt: string;
}

export interface ChatMessageRecord {
  id: string;
  roomId: string;
  organizationId: string;
  authorAuthUserId: string;
  body: string;
  createdAt: string;
}

export type BlockedDayStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED';
export type BlockedDayScope = 'ORG_BLACKOUT' | 'EMPLOYEE';

export interface BlockedDayRequest {
  id: string;
  organizationId: string;
  userId?: string;
  scope: BlockedDayScope;
  startDate: string;
  endDate: string;
  reason: string;
  status: BlockedDayStatus;
  managerNote?: string;
  requestedByAuthUserId: string;
  reviewedByAuthUserId?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface BusinessHour {
  id: string;
  organizationId: string;
  dayOfWeek: number;
  openTime?: string;
  closeTime?: string;
  enabled: boolean;
  sortOrder?: number;
}

export type ScheduleHourMode = 'business' | 'full24' | 'custom';

export interface ScheduleViewSettings {
  id: string;
  organizationId: string;
  hourMode: ScheduleHourMode;
  customStartHour: number; // 0-23
  customEndHour: number;   // 1-24
  weekStartDay: WeekStartDay;
  minStaffPerHour: number;            // global fallback minimum staff threshold
  coverageEnabled: boolean;           // whether coverage tracking is active
  minStaffByHour: Record<number, number>; // per-hour overrides for minimum staff
}

export type WeekStartDay = 'sunday' | 'monday';

export interface Location {
  id: string;
  organizationId: string;
  name: string;
  sortOrder: number;
  createdAt: string;
}

export type ShiftExchangeStatus = 'OPEN' | 'CLAIMED' | 'CANCELLED';

export interface ShiftExchangeRequest {
  id: string;
  organizationId: string;
  shiftId: string;
  requestedByAuthUserId: string;
  status: ShiftExchangeStatus;
  claimedByAuthUserId?: string | null;
  createdAt: string;
  claimedAt?: string | null;
  cancelledAt?: string | null;
}

export interface SectionConfig {
  id: Section;
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
}

export const SECTIONS: Record<Section, SectionConfig> = {
  kitchen: {
    id: 'kitchen',
    label: 'Kitchen',
    color: '#f97316',
    bgColor: 'rgba(249, 115, 22, 0.15)',
    borderColor: 'rgba(249, 115, 22, 0.4)',
  },
  front: {
    id: 'front',
    label: 'Front of House',
    color: '#3b82f6',
    bgColor: 'rgba(59, 130, 246, 0.15)',
    borderColor: 'rgba(59, 130, 246, 0.4)',
  },
  bar: {
    id: 'bar',
    label: 'Bar',
    color: '#a855f7',
    bgColor: 'rgba(168, 85, 247, 0.15)',
    borderColor: 'rgba(168, 85, 247, 0.4)',
  },
  management: {
    id: 'management',
    label: 'Management',
    color: '#10b981',
    bgColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
};

export const HOURS_START = 0;
export const HOURS_END = 24;
export const TOTAL_HOURS = HOURS_END - HOURS_START;

export const JOB_OPTIONS = [
  'Admin',
  'Bartender',
  'Bartender Training',
  'BOH Train',
  'Busser',
  'Cook',
  'Dishwasher',
  'FOH Train',
  'Food Run',
  'Food Runner',
  'Ghost Bar1',
  'Ghost Bar 2',
  'Host',
  'Manager',
  'Server',
  'Server Training',
] as const;
