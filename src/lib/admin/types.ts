// ---------------------------------------------------------------------------
// Activation stages — how far along an organization is in onboarding/usage
// ---------------------------------------------------------------------------

/**
 * 0 = Org created, no employees
 * 1 = Has employees, no shifts
 * 2 = Has shifts, but below activity threshold
 * 3 = Active — meets the shift-activity threshold
 * 4 = Active + paid subscription
 */
export type ActivationStage = 0 | 1 | 2 | 3 | 4;

// ---------------------------------------------------------------------------
// Restaurant (organization) row returned by admin queries
// ---------------------------------------------------------------------------

export interface RestaurantRow {
  orgId: string;
  name: string;
  restaurantCode: string;
  timezone: string;
  ownerAuthUserId: string | null;
  ownerName: string | null;
  subscriptionStatus: string | null;
  billingOverrideType: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean | null;
  priceId: string | null;
  locationsCount: number;
  employeesCount: number;
  activeEmployeesCount: number;
  shifts7d: number;
  shifts30d: number;
  timeOff30d: number;
  exchange30d: number;
  activationStage: ActivationStage;
}

// ---------------------------------------------------------------------------
// Account (billing owner) row returned by admin queries
// ---------------------------------------------------------------------------

export interface AccountRow {
  authUserId: string;
  email: string | null;
  ownerName: string | null;
  profileState: ProfileState;
  isOrphaned?: boolean;
  billingStatus: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  quantity: number | null;
  ownedOrganizationsCount: number;
  locationsCount: number;
  employeesCount: number;
  lastShiftCreatedAt: string | null;
}

export type ProfileState = 'ok' | 'missing_name' | 'orphaned';

// ---------------------------------------------------------------------------
// Overview KPIs — top-level platform metrics
// ---------------------------------------------------------------------------

export interface OverviewKpis {
  totalOrganizations: number;
  totalLocations: number;
  totalUsers: number;
  activeSubscriptions: number;
  newIntents7d: number;
  newIntents30d: number;
  newOrgs7d: number;
  newOrgs30d: number;
  shiftsCreated7d: number;
  shiftsCreated30d: number;
}

// ---------------------------------------------------------------------------
// Alert items — provisioning errors, incomplete subscriptions, etc.
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'error';

export type AlertCategory =
  | 'provisioning_error'
  | 'subscription_incomplete'
  | 'subscription_past_due'
  | 'intent_stalled'
  | 'org_inactive';

export interface AlertItem {
  id: string;
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  description: string;
  /** ISO-8601 timestamp of when the alert condition was detected */
  timestamp: string;
  /** Optional reference to the related entity */
  entityId: string | null;
  entityType: 'organization' | 'account' | 'intent' | null;
}
