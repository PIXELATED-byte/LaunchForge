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
  async touchLogin(id) { await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]); },
  // Expired sessions are removed here, on login, instead of by a timer: a timer would keep Neon's free compute awake.
  async pruneSessions() { await db.query('DELETE FROM user_sessions WHERE expire < now()'); }
};

function memoryUsers() {
  const m = new Map();
  return {
    async create(email, passwordHash) {
      if ([...m.values()].some(u => u.email === email)) throw takenError();
      const u = { id: crypto.randomUUID(), email, passwordHash, created: Date.now() };
      m.set(u.id, u); return { id: u.id, email: u.email, created: u.created };
    },
    async findByEmail(email) { const u = [...m.values()].find(x => x.email === email); return u ? { ...u } : null; },
    async findById(id) { const u = m.get(id); return u ? { id: u.id, email: u.email, created: u.created } : null; },
    async touchLogin() {},
    async pruneSessions() {},
    _all: () => [...m.values()],
    _remove: id => m.delete(id)
  };
}
module.exports = { pgUsers, memoryUsers };
