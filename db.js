// Database access. The connection string comes ONLY from the DATABASE_URL environment variable.
const fs = require('fs');
const path = require('path');

let pool = null;
let schemaPromise = null;

class DbError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const configured = () => Boolean(process.env.DATABASE_URL);

function getPool() {
  if (!configured()) throw new DbError('DB_NOT_CONFIGURED', 'DATABASE_URL is not set.');
  if (!pool) {
    let Pool;
    try { ({ Pool } = require('pg')); }
    catch (e) { throw new DbError('DB_NOT_CONFIGURED', 'The "pg" package is not installed. Run npm install.'); }
    const url = process.env.DATABASE_URL;
    const local = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
    const ssl = process.env.DATABASE_SSL === 'false' || local ? false : { rejectUnauthorized: true };
    pool = new Pool({
      connectionString: url,
      ssl,
      max: Number(process.env.DB_POOL_MAX) || 4,
      idleTimeoutMillis: 30000,
      // Neon's free compute sleeps after 5 idle minutes; allow time for it to wake up.
      connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10000
    });
    // Without this handler an idle connection dropped by Neon would crash the process.
    pool.on('error', e => console.error('Database pool error:', e.code || 'unknown'));
  }
  return pool;
}

const CONN_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE',
  '57P01', '57P02', '57P03', '08000', '08001', '08003', '08006', '53300']);
const isConnError = e => Boolean(e) && (CONN_CODES.has(e.code) ||
  /timeout exceeded when trying to connect|Connection terminated|connection timeout|ECONN/i.test(e.message || ''));

function wrap(e) {
  if (e instanceof DbError) return e;
  if (isConnError(e)) return new DbError('DB_UNAVAILABLE', 'The database is unreachable.');
  const d = new DbError('DB_ERROR', 'Database error.');
  d.pgCode = e && e.code;
  return d;
}

// Only reads (and idempotent setup) are retried. Writes are never retried automatically,
// so a retry can never double-apply a change; the client's autosave retries instead.
async function query(text, params, { retry = false } = {}) {
  const p = getPool();
  try { return await p.query(text, params); }
  catch (e) {
    if (retry && isConnError(e)) {
      await new Promise(r => setTimeout(r, 500));
      try { return await p.query(text, params); } catch (e2) { throw wrap(e2); }
    }
    throw wrap(e);
  }
}

function ensureSchema() {
  if (!schemaPromise) {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    schemaPromise = query(sql, undefined, { retry: true }).then(() => true).catch(e => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new DbError('DB_UNAVAILABLE', 'timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// 'not_configured' | 'connected' | 'unavailable'. Running SELECT 1 also wakes a sleeping Neon compute.
async function status() {
  if (!configured()) return 'not_configured';
  // Capped at 5s in total so /api/health stays fast even when the database is down or waking up.
  try { await withTimeout((async () => { await query('SELECT 1', undefined, { retry: true }); await ensureSchema(); })(), 5000); return 'connected'; }
  catch (e) { return e.code === 'DB_NOT_CONFIGURED' ? 'not_configured' : 'unavailable'; }
}

async function close() {
  const p = pool; pool = null; schemaPromise = null;
  if (p) await p.end();
}

module.exports = { DbError, configured, query, ensureSchema, status, close };
