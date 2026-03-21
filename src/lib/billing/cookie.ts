export const BILLING_COOKIE_NAME = 'sf_billing_ok';
export const BILLING_COOKIE_MAX_AGE_SECONDS = 3600;

export type BillingCookieStatus = 'active' | 'past_due' | 'none';

function parseTimestamp(value: string | null | undefined) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) return null;
  return timestamp;
}

export function serializeBillingCookie(params: {
  status: Exclude<BillingCookieStatus, 'none'>;
  validUntil?: string | null;
  now?: Date;
}) {
  const nowMs = (params.now ?? new Date()).getTime();
  const expiresAtMs = parseTimestamp(params.validUntil);

  if (params.status !== 'active' || !expiresAtMs) {
    return {
      value: params.status,
      maxAge: BILLING_COOKIE_MAX_AGE_SECONDS,
    };
  }

  const remainingSeconds = Math.floor((expiresAtMs - nowMs) / 1000);
  if (remainingSeconds <= 0) {
    return {
      value: params.status,
      maxAge: 0,
    };
  }

  return {
    value: `${params.status}:${expiresAtMs}`,
    maxAge: Math.min(BILLING_COOKIE_MAX_AGE_SECONDS, remainingSeconds),
  };
}

export function parseBillingCookie(
  value: string | null | undefined,
  now: Date = new Date(),
): { status: BillingCookieStatus; stale: boolean } {
  const normalized = String(value ?? '').trim();
  if (!normalized) return { status: 'none', stale: false };

  if (normalized === 'past_due') {
    return { status: 'past_due', stale: false };
  }

  if (normalized === 'active') {
    return { status: 'active', stale: false };
  }

  if (normalized.startsWith('active:')) {
    const expiresAtMs = Number(normalized.slice('active:'.length));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
      return { status: 'none', stale: true };
    }
    return {
      status: 'active',
      stale: now.getTime() >= expiresAtMs,
    };
  }

  return { status: 'none', stale: true };
}

export function getEarliestBillingOverrideExpiry(
  expiresAtValues: Array<string | null | undefined>,
): string | null {
  let earliest: number | null = null;
  for (const value of expiresAtValues) {
    const expiresAtMs = parseTimestamp(value);
    if (expiresAtMs === null) continue;
    if (earliest === null || expiresAtMs < earliest) {
      earliest = expiresAtMs;
    }
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}
