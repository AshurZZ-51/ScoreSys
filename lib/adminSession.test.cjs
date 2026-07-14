const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('./adminSession');

const secret = 'a test-only session secret with more than thirty-two bytes';
const now = new Date('2026-07-14T12:00:00.000Z');

test('creates a signed admin session that derives the operator code', () => {
  const token = session.createAdminSession({ code: 'ADMIN52', is_admin: true }, secret, now);

  assert.deepEqual(session.readAdminSession(token, secret, now), {
    code: 'admin52',
    is_admin: true
  });
});

test('rejects tampered, expired, and non-admin session claims', () => {
  const token = session.createAdminSession({ code: 'admin52', is_admin: true }, secret, now);
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  const expired = session.createAdminSession({ code: 'admin52', is_admin: true }, secret, new Date('2026-07-13T01:00:00.000Z'));
  const reviewer = session.createAdminSession({ code: 'reviewer1', is_admin: false }, secret, now);

  assert.equal(session.readAdminSession(tampered, secret, now), null);
  assert.equal(session.readAdminSession(expired, secret, now), null);
  assert.equal(session.readAdminSession(reviewer, secret, now), null);
});

test('only the authenticated admin51 session has superadmin authority', () => {
  const superadmin = session.readAdminSession(session.createAdminSession({ code: 'ADMIN51', is_admin: true }, secret, now), secret, now);
  const admin = session.readAdminSession(session.createAdminSession({ code: 'admin52', is_admin: true }, secret, now), secret, now);

  assert.equal(session.isSuperAdminSession(superadmin), true);
  assert.equal(session.isSuperAdminSession(admin), false);
});
