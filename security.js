// Framework-free request guards shared by the project API and the Gemini route.
const crypto = require('crypto');

const E = (status, code, message, extra) => ({ status, body: { error: { code, message }, ...extra } });
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isUnsafe = m => UNSAFE.has(String(m || '').toUpperCase());

// Exact-match origin allowlist (never a wildcard). Same-origin requests are allowed so the backend can also host the page.
function makeOriginPolicy({ origins = [], allowLocalhost = false } = {}) {
  const set = new Set(origins.filter(o => o && o !== '*'));
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  return (origin, selfOrigin) => Boolean(origin) && origin !== 'null' && (set.has(origin) || origin === selfOrigin || (allowLocalhost && local.test(origin)));
}
function checkOrigin(req, policy) {
  const origin = req.headers && req.headers.origin;
  if (!policy(origin, req.selfOrigin)) return E(403, 'BAD_ORIGIN', 'This request did not come from an allowed site.');
  return null;
}
function checkCsrf(req, sess) {
  const sent = req.headers && req.headers['x-csrf-token'];
  const want = sess && sess.csrf;
  if (typeof sent !== 'string' || typeof want !== 'string' || !want) return E(403, 'CSRF_INVALID', 'Security token missing or invalid. Reload the page and try again.');
  const a = Buffer.from(sent), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return E(403, 'CSRF_INVALID', 'Security token missing or invalid. Reload the page and try again.');
  return null;
}
// Returns { userId, csrf } for a logged-in caller, or { err } (401 / 403). The user id ONLY ever comes from the server-side session.
async function authenticate(req, { originPolicy }) {
  const s = req.session ? await req.session.read() : null;
  if (!s || !s.userId) return { err: E(401, 'AUTH_REQUIRED', 'Log in to continue.') };
  if (isUnsafe(req.method)) {
    const o = checkOrigin(req, originPolicy); if (o) return { err: o };
    const c = checkCsrf(req, s); if (c) return { err: c };
  }
  return { userId: s.userId, csrf: s.csrf };
}
function createLimiter(max, windowMs) {
  const m = new Map();
  const recent = k => { const now = Date.now(); const a = (m.get(k) || []).filter(t => now - t < windowMs); m.set(k, a); return a; };
  return {
    blocked: k => recent(k).length >= max,
    add: k => { recent(k).push(Date.now()); if (m.size > 5000) for (const [key, v] of m) if (!v.some(t => Date.now() - t < windowMs)) m.delete(key); },
    reset: k => m.delete(k)
  };
}
module.exports = { E, isUnsafe, makeOriginPolicy, checkOrigin, checkCsrf, authenticate, createLimiter };
