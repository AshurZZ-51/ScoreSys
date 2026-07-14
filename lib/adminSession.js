const crypto = require('node:crypto');

const ADMIN_SESSION_COOKIE = 'scoresys_admin_session';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function sessionSecret() {
  return process.env.ADMIN_SESSION_SECRET || '';
}

function createAdminSession(reviewer, secret = sessionSecret(), now = new Date()) {
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is required');
  const payload = encode({
    code: String(reviewer?.code || '').trim().toLowerCase(),
    is_admin: reviewer?.is_admin === true,
    exp: new Date(now).getTime() + ADMIN_SESSION_TTL_MS
  });
  return `${payload}.${sign(payload, secret)}`;
}

function readAdminSession(token, secret = sessionSecret(), now = new Date()) {
  if (!token || !secret) return null;
  const [payload, signature, extra] = String(token).split('.');
  if (!payload || !signature || extra) return null;
  const expected = Buffer.from(sign(payload, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const code = String(claims?.code || '').trim().toLowerCase();
    if (!code || claims?.is_admin !== true || !Number.isFinite(claims?.exp) || claims.exp <= new Date(now).getTime()) return null;
    return { code, is_admin: true };
  } catch {
    return null;
  }
}

function requireAdminSession(request) {
  return readAdminSession(request.cookies.get(ADMIN_SESSION_COOKIE)?.value);
}

function isSuperAdminSession(session) {
  return session?.is_admin === true && session.code === 'admin51';
}

function adminSessionCookie(token) {
  return {
    name: ADMIN_SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: ADMIN_SESSION_TTL_MS / 1000
    }
  };
}

module.exports = {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  readAdminSession,
  requireAdminSession,
  isSuperAdminSession,
  adminSessionCookie
};
