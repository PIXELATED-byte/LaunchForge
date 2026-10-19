// Safety guard for database-backed tests. They run ONLY when TEST_DATABASE_URL points at a different
// database than the one your app uses (DATABASE_URL in the shell or in .env). Use a separate Neon "dev" branch.
const fs = require('fs');
const path = require('path');

function envFileUrl() {
  try {
    const t = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    const m = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m.exec(t);
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  } catch (e) { return null; }
}
// Identity of a database: host (ignoring Neon's "-pooler") + database name. Different branches have different hosts.
function sig(u) {
  try { const x = new URL(u); return x.hostname.replace('-pooler', '') + x.pathname; } catch (e) { return u; }
}
const appUrls = [process.env.DATABASE_URL, envFileUrl()].filter(Boolean); // captured at load, before any test changes env

function testDb() {
  const t = process.env.TEST_DATABASE_URL;
  if (!t) return { skip: 'TEST_DATABASE_URL is not set (database-backed tests could not run)' };
  if (!/^postgres(ql)?:\/\//.test(t)) return { skip: 'REFUSED: TEST_DATABASE_URL is not a postgres:// URL' };
  if (appUrls.some(u => u === t || sig(u) === sig(t))) {
    return { skip: 'REFUSED: TEST_DATABASE_URL is the same database as DATABASE_URL (possibly production). Use a separate Neon dev branch.' };
  }
  return { url: t };
}
module.exports = { testDb };
