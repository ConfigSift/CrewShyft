export type PostAuthDestination = '/dashboard' | '/start' | '/join';

function normalizeRole(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function normalizePersona(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function hasRestaurantManagerCapability(role: unknown, persona: unknown): boolean {
  const normalizedRole = normalizeRole(role);
  const normalizedPersona = normalizePersona(persona);
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

export function resolvePostAuthDestination(
  membershipCount: number,
  role: unknown,
  persona: unknown,
): PostAuthDestination {
  if (membershipCount > 0) return '/dashboard';
  return resolveNoMembershipDestination(role, persona);
}
