// Safety guard for database-backed tests. They write to the database (they create tables and test users), so they run ONLY when
//   1) TEST_DATABASE_URL is a postgres:// address on THIS computer (localhost / 127.0.0.1 / ::1), and
//   2) it is a different database from the one your app uses (DATABASE_URL or MIGRATION_DATABASE_URL, in the shell or in .env).
// Rule 1 means a pasted cloud/production address is refused even if it appears nowhere on this machine (for example, if it only lives on Render).
// There is NO override for rule 1: no environment variable or setting can allow a remote test database.
const fs = require('fs');
const path = require('path');

function envFileUrl(name) {
  try {
    const t = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = new RegExp('^\\s*' + name + '\\s*=\\s*(.+?)\\s*$', 'm').exec(t);
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  } catch (e) { return null; }
}
// Identity of a database: host (ignoring Neon's "-pooler") + database name. Different branches have different hosts.
function sig(u) {
  try { const x = new URL(u); return x.hostname.replace('-pooler', '') + x.pathname; } catch (e) { return u; }
}
const isLocalHost = h => /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(h);

// Pure decision (unit-tested): returns { url } when allowed, otherwise { skip: reason }. It reads no environment variables.
function decide(t, appUrls) {
  if (!t) return { skip: 'TEST_DATABASE_URL is not set (database-backed tests could not run)' };
  if (!/^postgres(ql)?:\/\//.test(t)) return { skip: 'REFUSED: TEST_DATABASE_URL is not a postgres:// URL' };
  let host;
  try { host = new URL(t).hostname; } catch (e) { return { skip: 'REFUSED: TEST_DATABASE_URL is not a valid address' }; }
  if (!isLocalHost(host)) {
    return { skip: 'REFUSED: TEST_DATABASE_URL is not on this computer (it must use localhost, e.g. postgres://YOURNAME@localhost:5432/launchforge_test). Never use a cloud or production database.' };
  }
  if (appUrls.filter(Boolean).some(u => u === t || sig(u) === sig(t))) {
    return { skip: 'REFUSED: TEST_DATABASE_URL is the same database as DATABASE_URL / MIGRATION_DATABASE_URL (possibly production).' };
  }
  return { url: t };
}

// Captured at load, before any test changes the environment.
const appUrls = [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL, envFileUrl('DATABASE_URL'), envFileUrl('MIGRATION_DATABASE_URL')].filter(Boolean);
const testDb = () => decide(process.env.TEST_DATABASE_URL, appUrls);
module.exports = { testDb, decide, isLocalHost };
