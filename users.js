// User accounts. pgUsers talks to Postgres; memoryUsers behaves the same for tests.
const crypto = require('crypto');
const db = require('./db');

const ms = d => (d == null ? null : new Date(d).getTime());
const takenError = () => Object.assign(new Error('Email already registered.'), { code: 'EMAIL_TAKEN' });

const pgUsers = {
  async create(email, passwordHash) {
    await db.ensureSchema();
    try {
      const r = await db.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at', [email, passwordHash]);
      return { id: r.rows[0].id, email: r.rows[0].email, created: ms(r.rows[0].created_at) };
    } catch (e) { if (e.pgCode === '23505') throw takenError(); throw e; }
  },
  async findByEmail(email) {
    await db.ensureSchema();
    const r = await db.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email], { retry: true });
    return r.rows[0] ? { id: r.rows[0].id, email: r.rows[0].email, passwordHash: r.rows[0].password_hash } : null;
  },
  async findById(id) {
    await db.ensureSchema();
    const r = await db.query('SELECT id, email, created_at FROM users WHERE id = $1', [id], { retry: true });
    return r.rows[0] ? { id: r.rows[0].id, email: r.rows[0].email, created: ms(r.rows[0].created_at) } : null;
  },
  // ---- social sign-in (needs migration 003; oauthReady() says whether it has been applied) ----
  _oauthOk: false, _oauthCheckedAt: 0,
  async oauthReady() {
    if (this._oauthOk) return true;
    if (Date.now() - this._oauthCheckedAt < 30000) return false;   // do not hammer the database while it is pending
    this._oauthCheckedAt = Date.now();
    try {
      const r = await db.query("SELECT to_regclass('public.oauth_identities') IS NOT NULL AS has_table, COALESCE((SELECT is_nullable = 'YES' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_hash'), false) AS pw_nullable", [], { retry: true });
      this._oauthOk = Boolean(r.rows[0].has_table && r.rows[0].pw_nullable);
    } catch (e) { this._oauthOk = false; }
    return this._oauthOk;
  },
  async findByIdentity(provider, subject) {
    await db.ensureSchema();
    const r = await db.query('SELECT u.id, u.email, u.created_at FROM oauth_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = $1 AND i.subject = $2', [provider, subject], { retry: true });
    return r.rows[0] ? { id: r.rows[0].id, email: r.rows[0].email, created: ms(r.rows[0].created_at) } : null;
  },
  // Creates a passwordless user and its identity in ONE statement (all or nothing). Never links to an existing user.
  async createSocial(email, provider, subject) {
    await db.ensureSchema();
    try {
      const r = await db.query('WITH u AS (INSERT INTO users (email) VALUES ($1) RETURNING id, email, created_at), i AS (INSERT INTO oauth_identities (provider, subject, user_id, email) SELECT $2, $3, id, $1 FROM u) SELECT id, email, created_at FROM u', [email, provider, subject]);
      return { id: r.rows[0].id, email: r.rows[0].email, created: ms(r.rows[0].created_at) };
    } catch (e) {
      if (e.pgCode === '23505') {
        const again = await this.findByIdentity(provider, subject);   // two callbacks raced: the identity now exists, so just use it
        if (again) return again;
        throw takenError();
      }
      throw e;
    }
  },
  async touchLogin(id) { await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]); },
  // Expired sessions are removed here, on login, instead of by a timer: a timer would keep Neon's free compute awake.
  async pruneSessions() { await db.query('DELETE FROM user_sessions WHERE expire < now()'); }
};

function memoryUsers() {
  const m = new Map(), ids = new Map();
  return {
    async create(email, passwordHash) {
      if ([...m.values()].some(u => u.email === email)) throw takenError();
      const u = { id: crypto.randomUUID(), email, passwordHash, created: Date.now() };
      m.set(u.id, u); return { id: u.id, email: u.email, created: u.created };
    },
    async findByEmail(email) { const u = [...m.values()].find(x => x.email === email); return u ? { ...u } : null; },
    async findById(id) { const u = m.get(id); return u ? { id: u.id, email: u.email, created: u.created } : null; },
    // social sign-in
    async oauthReady() { return true; },
    async findByIdentity(provider, subject) { const id = ids.get(provider + ':' + subject); const u = id && m.get(id); return u ? { id: u.id, email: u.email, created: u.created } : null; },
    async createSocial(email, provider, subject) {
      if (ids.has(provider + ':' + subject)) return this.findByIdentity(provider, subject);
      if ([...m.values()].some(u => u.email === email)) throw takenError();
      const u = { id: crypto.randomUUID(), email, passwordHash: null, created: Date.now() };
      m.set(u.id, u); ids.set(provider + ':' + subject, u.id); return { id: u.id, email: u.email, created: u.created };
    },
    async touchLogin() {},
    async pruneSessions() {},
    _all: () => [...m.values()],
    _remove: id => m.delete(id)
  };
}
module.exports = { pgUsers, memoryUsers };
