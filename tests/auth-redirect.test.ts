import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveManagerWithoutMembershipDestination,
  resolveNoMembershipDestination,
  resolvePostAuthDestination,
  resolveRoutingPersona,
  shouldRequirePersonaSelection,
} from '../src/lib/authRedirect';

test('resolveRoutingPersona prefers the first valid persona candidate', () => {
  assert.equal(resolveRoutingPersona(null, 'employee', 'manager'), 'employee');
  assert.equal(resolveRoutingPersona(undefined, 'MANAGER'), 'manager');
  assert.equal(resolveRoutingPersona('unknown', ''), null);
});

test('shouldRequirePersonaSelection only gates users without memberships', () => {
  assert.equal(shouldRequirePersonaSelection(0, null), true);
  assert.equal(shouldRequirePersonaSelection(0, 'employee'), false);
  assert.equal(shouldRequirePersonaSelection(2, null), false);
});

test('post-auth routing keeps existing members in the app even without persona', () => {
  assert.equal(resolvePostAuthDestination(1, null, null), '/dashboard');
  assert.equal(resolveNoMembershipDestination(null, 'employee'), '/join');
  assert.equal(resolveNoMembershipDestination('manager', null), '/start');
});

test('post-auth routing sends resumable manager memberships to restaurants before dashboard', () => {
  assert.equal(resolvePostAuthDestination(1, 'manager', 'manager', true, true, false), '/restaurants');
  assert.equal(resolvePostAuthDestination(1, 'manager', 'manager', true, true, true), '/dashboard');
});

test('manager without memberships only goes to dashboard after setup is complete', () => {
  assert.equal(resolveManagerWithoutMembershipDestination('manager', 'manager', false), '/start');
  assert.equal(resolveManagerWithoutMembershipDestination('manager', 'manager', true), '/restaurants');
  assert.equal(resolvePostAuthDestination(0, 'manager', 'manager', true), '/restaurants');
});
