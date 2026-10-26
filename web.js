// Express-side session, cookie and header wiring.
const crypto = require('crypto');
const db = require('./db');

const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;
const isProd = () => process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const authConfigured = () => !isProd() || (process.env.SESSION_SECRET || '').length >= 32;

function cookieSettings() {
  const prod = isProd();
  // Pages and Render are different sites, so production needs SameSite=None (which requires Secure).
  return { name: prod ? '__Host-lf.sid' : 'lf.sid', secure: prod, sameSite: String(process.env.COOKIE_SAMESITE || (prod ? 'none' : 'lax')).toLowerCase() };
}

function buildSession(deps) {
  let secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (isProd()) {
      return { middleware: (req, res) => res.status(503).json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'Login is not configured on the server.' } }) };
    }
    secret = crypto.randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET is not set: using a temporary secret (sessions end when the server restarts).');
  }
  const session = require('express-session');
  let store = deps.sessionStore;
  if (!store) {
    const PgStore = require('connect-pg-simple')(session);
    // No pruning timer: it would keep Neon's free compute awake. Expired sessions are pruned on login instead.
    store = new PgStore({ pool: db.getPool(), tableName: 'user_sessions', createTableIfMissing: false, pruneSessionInterval: false });
  }
  const c = cookieSettings();
  return {
    middleware: session({
      name: c.name, secret, store, resave: false, saveUninitialized: false, rolling: false,
      cookie: { httpOnly: true, secure: c.secure, sameSite: c.sameSite, maxAge: SESSION_DAYS * 86400000, path: '/' }
    })
  };
}

function sessionAdapter(req) {
  return {
    async read() { const s = req.session; return s && s.userId ? { userId: s.userId, csrf: s.csrf } : null; },
    start(userId) {
      return new Promise((resolve, reject) => {
        req.session.regenerate(err => {
          if (err) return reject(err);
          const csrf = crypto.randomBytes(32).toString('base64url');
          req.session.userId = userId; req.session.csrf = csrf;
          req.session.save(e => (e ? reject(e) : resolve({ csrf })));
        });
      });
    },
    end() { return new Promise((resolve, reject) => req.session.destroy(err => (err ? reject(err) : resolve()))); }
  };
}
function clearSessionCookie(res) {
  const c = cookieSettings();
  res.clearCookie(c.name, { path: '/', httpOnly: true, secure: c.secure, sameSite: c.sameSite });
}
function securityHeaders(req, res, next) {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');   // private data must not be cached
  next();
}
// Stops auth/project requests early with a clear 503 when the database is missing, down, or not migrated.
function dbGate(deps) {
  return (req, res, next) => {
    if (deps.injected) return next();
    const fail = (code, message) => res.status(503).json({ error: { code, message } });
    if (!db.configured()) return fail('DB_NOT_CONFIGURED', 'Server storage is not configured.');
    db.ensureSchema().then(() => next(), e => (e.code === 'SCHEMA_OUTDATED'
      ? fail('SCHEMA_OUTDATED', 'The database needs a migration before accounts can be used.')
      : fail('DB_UNAVAILABLE', 'Server storage is temporarily unavailable.')));
  };
}
module.exports = { isProd, authConfigured, cookieSettings, buildSession, sessionAdapter, clearSessionCookie, securityHeaders, dbGate };
