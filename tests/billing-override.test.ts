import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isBillingOverrideActive,
  normalizeBillingOverrideType,
} from '../src/lib/billing/override';
import {
  parseBillingCookie,
  serializeBillingCookie,
} from '../src/lib/billing/cookie';

test('normalizeBillingOverrideType accepts supported values', () => {
  assert.equal(normalizeBillingOverrideType('comped'), 'comped');
  assert.equal(normalizeBillingOverrideType('MANUAL_EXCEPTION'), 'manual_exception');
  assert.equal(normalizeBillingOverrideType('other'), null);
});

test('isBillingOverrideActive requires an active supported override', () => {
  const now = new Date('2026-03-21T12:00:00.000Z');

  assert.equal(isBillingOverrideActive(null, now), false);
  assert.equal(isBillingOverrideActive({ billing_override_active: false, billing_override_type: 'comped' }, now), false);
  assert.equal(isBillingOverrideActive({ billing_override_active: true, billing_override_type: 'comped' }, now), true);
  assert.equal(
    isBillingOverrideActive(
      {
        billing_override_active: true,
        billing_override_type: 'manual_exception',
        billing_override_expires_at: '2026-03-22T00:00:00.000Z',
      },
      now,
    ),
    true,
  );
  assert.equal(
    isBillingOverrideActive(
      {
        billing_override_active: true,
        billing_override_type: 'manual_exception',
        billing_override_expires_at: '2026-03-20T00:00:00.000Z',
      },
      now,
    ),
    false,
  );
});

test('billing cookie expires when override-backed access expires', () => {
  const now = new Date('2026-03-21T12:00:00.000Z');
  const cookie = serializeBillingCookie({
    status: 'active',
    validUntil: '2026-03-21T12:05:00.000Z',
    now,
  });

  assert.match(cookie.value, /^active:\d+$/);
  assert.equal(cookie.maxAge, 300);
  assert.deepEqual(parseBillingCookie(cookie.value, new Date('2026-03-21T12:04:59.000Z')), {
    status: 'active',
    stale: false,
  });
  assert.deepEqual(parseBillingCookie(cookie.value, new Date('2026-03-21T12:05:00.000Z')), {
    status: 'active',
    stale: true,
  });
});

test('billing cookie falls back safely for invalid values', () => {
  assert.deepEqual(parseBillingCookie('', new Date('2026-03-21T12:00:00.000Z')), {
    status: 'none',
    stale: false,
  });
  assert.deepEqual(parseBillingCookie('active:not-a-number', new Date('2026-03-21T12:00:00.000Z')), {
    status: 'none',
    stale: true,
  });
});
