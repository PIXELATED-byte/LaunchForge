// Registration, login, logout, session info and legacy-project claiming. Framework-free:
// handle({method, path, headers, body, ip, session, selfOrigin}) -> {status, body, clearSession?}
// `session` is an adapter: read() -> {userId, csrf}|null, start(userId) -> {csrf} (regenerates the id), end().
const crypto = require('crypto');
const { E, isUnsafe, checkOrigin, checkCsrf, authenticate, createLimiter } = require('./security');

function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.normalize('NFKC').trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(e)) return null;
  return e;
}
function validatePassword(pw, email) {
  if (typeof pw !== 'string') return 'Enter a password.';
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  const local = String(email || '').split('@')[0];
  if (pw.toLowerCase() === String(email || '').toLowerCase() || (local.length >= 4 && pw.toLowerCase() === local)) return 'Do not use your email as your password.';
  return null;
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const LEGACY_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const pub = u => ({ id: u.id, email: u.email });

function createAuthApi(deps, { originPolicy, registerPerHour = 10, loginFailsPerPair = 8, loginFailsPerIp = 30 } = {}) {
  const regLimit = createLimiter(registerPerHour, 3600000);
  const pairLimit = createLimiter(loginFailsPerPair, 900000);
  const ipLimit = createLimiter(loginFailsPerIp, 900000);
  let dummy = null; // hash of a random value, so unknown emails cost the same time as known ones
  const getDummy = async () => dummy || (dummy = await deps.hasher.hash(crypto.randomBytes(16).toString('hex')));

  return async function handle(req) {
    try {
      const method = String(req.method || '').toUpperCase();
      const path = '/' + String(req.path || '/').split('/').filter(Boolean).join('/');
      const ip = req.ip || 'unknown';
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (isUnsafe(method)) { const o = checkOrigin(req, originPolicy); if (o) return o; }

      if (method === 'GET' && path === '/me') {
        const s = await req.session.read();
        if (!s) return { status: 200, body: { user: null, csrf: null } };
        const u = await deps.users.findById(s.userId);
        if (!u) { await req.session.end(); return { status: 200, body: { user: null, csrf: null }, clearSession: true }; }
        return { status: 200, body: { user: pub(u), csrf: s.csrf } };
      }

      if (method === 'POST' && path === '/register') {
        if (regLimit.blocked(ip)) return E(429, 'RATE_LIMIT', 'Too many sign-up attempts. Try again later.');
        regLimit.add(ip);
        const email = normalizeEmail(body.email);
        if (!email) return E(400, 'VALIDATION', 'Enter a valid email address.');
        const pe = validatePassword(body.password, email);
        if (pe) return E(400, 'VALIDATION', pe);
        const hash = await deps.hasher.hash(body.password);
        let user;
        try { user = await deps.users.create(email, hash); }
        catch (e) { if (e && e.code === 'EMAIL_TAKEN') return E(409, 'EMAIL_TAKEN', 'An account with this email may already exist. Try logging in.'); throw e; }
        const { csrf } = await req.session.start(user.id);
        return { status: 201, body: { user: pub(user), csrf } };
      }

      if (method === 'POST' && path === '/login') {
        const email = normalizeEmail(body.email);
        const k1 = ip + '|' + (email || ''), k2 = ip;
        if (pairLimit.blocked(k1) || ipLimit.blocked(k2)) return E(429, 'RATE_LIMIT', 'Too many login attempts. Try again in a few minutes.');
        const pw = typeof body.password === 'string' && body.password.length <= 128 ? body.password : '';
        const user = email ? await deps.users.findByEmail(email) : null;
        const hasPw = Boolean(user && user.passwordHash);
        const ok = await deps.hasher.verify(hasPw ? user.passwordHash : await getDummy(), pw);   // same cost for unknown emails and social-only accounts
        if (!hasPw || !ok) { pairLimit.add(k1); ipLimit.add(k2); return E(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.'); }
        pairLimit.reset(k1);
        const { csrf } = await req.session.start(user.id);   // new session id on every login (prevents fixation)
        await deps.users.touchLogin(user.id);
        await deps.users.pruneSessions().catch(() => {});
        return { status: 200, body: { user: pub(user), csrf } };
      }

      if (method === 'POST' && path === '/logout') {
        const s = await req.session.read();
        if (!s) return { status: 200, body: { ok: true }, clearSession: true };
        const c = checkCsrf(req, s); if (c) return c;
        await req.session.end();
        return { status: 200, body: { ok: true }, clearSession: true };
      }

      if (method === 'POST' && (path === '/legacy/preview' || path === '/legacy/claim')) {
        const a = await authenticate(req, { originPolicy }); if (a.err) return a.err;
        if (typeof body.token !== 'string' || !LEGACY_TOKEN.test(body.token)) return E(400, 'VALIDATION', 'That is not a valid pre-accounts token.');
        const store = deps.getStore();
        const hash = sha256(body.token);
        if (path === '/legacy/preview') {
          const list = await store.previewLegacy(hash);
          return { status: 200, body: { count: list.length, projects: list.map(p => ({ name: p.name, created: p.created })) } };
        }
        return { status: 200, body: { claimed: await store.claimLegacy(a.userId, hash) } };
      }
      return E(404, 'NOT_FOUND', 'No such route.');
    } catch (e) { return require('./api').mapError(e); }
  };
}
module.exports = { createAuthApi, normalizeEmail, validatePassword };
