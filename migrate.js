// Versioned SQL migrations. Applied only by `npm run migrate -- --apply` (or AUTO_MIGRATE=true in local dev).
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'migrations');

const listMigrations = () => fs.readdirSync(DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
// OPTIONAL migrations (003_oauth.sql = social sign-in) are NEVER applied, and never block the server, unless the operator asks for them
// explicitly: `npm run migrate -- --with-optional ...`. The AUTO_MIGRATE dev path and a plain `--apply` skip them.
const OPTIONAL_MIGRATIONS = new Set(['003_oauth.sql']);
const isWanted = (f, includeOptional) => includeOptional || !OPTIONAL_MIGRATIONS.has(f);

async function appliedNames(pool) {
  try { return new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)); }
  catch (e) { if (e.code === '42P01') return new Set(); throw e; }   // table not created yet
}
async function pendingMigrations(pool, { includeOptional = false } = {}) {
  const done = await appliedNames(pool);
  return listMigrations().filter(f => !done.has(f) && isWanted(f, includeOptional));
}
// Each migration runs in its own transaction together with its bookkeeping row.
async function applyMigrations(pool, log = () => {}, { includeOptional = false } = {}) {
  const c = await pool.connect();
  const applied = [];
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    for (const f of listMigrations()) {
      if (done.has(f) || !isWanted(f, includeOptional)) continue;
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      try {
        await c.query('BEGIN'); await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]); await c.query('COMMIT');
        applied.push(f); log('applied ' + f);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    }
    return applied;
  } finally { c.release(); }
}
module.exports = { listMigrations, pendingMigrations, applyMigrations, OPTIONAL_MIGRATIONS, DIR };
