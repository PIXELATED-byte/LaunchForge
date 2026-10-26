// Usage:  node scripts/migrate.js            -> shows what WOULD run (changes nothing)
//         node scripts/migrate.js --apply    -> applies pending migrations
// Uses MIGRATION_DATABASE_URL if set (a direct, non-pooled Neon string), otherwise DATABASE_URL.
require('dotenv').config();
const { Pool } = require('pg');
const { pendingMigrations, applyMigrations } = require('../migrate');

(async () => {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL (or MIGRATION_DATABASE_URL) first.'); process.exit(1); }
  const local = /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: true }, max: 1, connectionTimeoutMillis: 15000 });
  try {
    const host = new URL(url).hostname;           // host only: never print the password
    console.log('Database host:', host);
    const pending = await pendingMigrations(pool);
    if (!pending.length) return console.log('Nothing to do: the database is up to date.');
    console.log('Pending migrations:', pending.join(', '));
    if (!process.argv.includes('--apply')) return console.log('Dry run. Re-run with --apply to execute them.');
    const done = await applyMigrations(pool, m => console.log(m));
    console.log('Done. Applied:', done.join(', '));
  } catch (e) { console.error('Migration failed:', e.code || e.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();
