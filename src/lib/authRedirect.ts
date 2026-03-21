import { normalizePersona, type AccountPersona } from '@/lib/persona';

export type PostAuthDestination = '/dashboard' | '/restaurants' | '/start' | '/join';

function normalizeRole(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function normalizePersonaText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function hasRestaurantManagerCapability(role: unknown, persona: unknown): boolean {
  const normalizedRole = normalizeRole(role);
  const normalizedPersona = normalizePersonaText(persona);
  return (
    normalizedRole === 'admin' ||
    normalizedRole === 'manager' ||
    normalizedRole === 'owner' ||
    normalizedPersona === 'manager'
  );
}

export function resolveNoMembershipDestination(role: unknown, persona: unknown): '/start' | '/join' {
  return hasRestaurantManagerCapability(role, persona) ? '/start' : '/join';
}

export function hasCompletedManagerSetup(
  role: unknown,
  persona: unknown,
  hasCompletedRestaurantSetup: boolean | null | undefined,
): boolean {
  return hasRestaurantManagerCapability(role, persona) && Boolean(hasCompletedRestaurantSetup);
}

export function resolveManagerWithoutMembershipDestination(
  role: unknown,
  persona: unknown,
  hasCompletedRestaurantSetup: boolean | null | undefined,
): '/restaurants' | '/start' | '/join' {
  if (!hasRestaurantManagerCapability(role, persona)) return '/join';
  return hasCompletedManagerSetup(role, persona, hasCompletedRestaurantSetup) ? '/restaurants' : '/start';
}

export function resolveNoMembershipAppDestination(
  role: unknown,
  persona: unknown,
  hasCompletedRestaurantSetup: boolean | null | undefined,
): '/restaurants' | '/join' | null {
  if (!hasRestaurantManagerCapability(role, persona)) return '/join';
  return hasCompletedManagerSetup(role, persona, hasCompletedRestaurantSetup) ? '/restaurants' : null;
}

export function resolveRoutingPersona(...values: unknown[]): AccountPersona | null {
  for (const value of values) {
    const persona = normalizePersona(value);
    if (persona) return persona;
  }
  return null;
}

export function shouldRequirePersonaSelection(
  membershipCount: number,
  ...personaCandidates: unknown[]
): boolean {
  return membershipCount === 0 && !resolveRoutingPersona(...personaCandidates);
}

export function resolvePostAuthDestination(
  membershipCount: number,
  role: unknown,
  persona: unknown,
  hasCompletedRestaurantSetup?: boolean | null,
  hasResumableManagerRestaurant = false,
  hasActiveRestaurantSelection = false,
): PostAuthDestination {
  if (membershipCount > 0) {
    if (hasResumableManagerRestaurant && !hasActiveRestaurantSelection) {
      return '/restaurants';
    }
    return '/dashboard';
  }
  return resolveManagerWithoutMembershipDestination(role, persona, hasCompletedRestaurantSetup);
}
