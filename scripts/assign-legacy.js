// One-time, operator-run: attach pre-accounts ("legacy") projects to an existing account.
//   node scripts/assign-legacy.js --email you@example.com                  -> lists unowned projects (dry run)
//   node scripts/assign-legacy.js --email you@example.com --ids ID1,ID2 --apply
// Only projects with no owner can be assigned. Uses DATABASE_URL. Never run against production without approval.
require('dotenv').config();
const { pgStore } = require('../store');
const { pgUsers } = require('../users');
const { assignLegacy } = require('../legacy');
const db = require('../db');

const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
(async () => {
  try {
    const email = arg('email');
    if (!email) { console.error('Usage: --email <address> [--ids a,b] [--apply]'); process.exit(1); }
    const ids = arg('ids') ? arg('ids').split(',').map(s => s.trim()).filter(Boolean) : null;
    const r = await assignLegacy({ users: pgUsers, store: pgStore, email, ids, apply: process.argv.includes('--apply') });
    if (!r.ok) { console.error(r.error); process.exitCode = 1; return; }
    console.log('Account:', r.user.email);
    if (!r.applied) {
      console.log(r.candidates.length + ' unowned project(s):');
      for (const p of r.candidates) console.log(' ', p.id, '|', p.name, '|', new Date(p.created).toISOString(), '| legacy id:', p.legacyLocalId || '-');
      console.log('Dry run. Add --ids ... --apply to assign.');
    } else console.log('Assigned:', r.assigned.length ? r.assigned.join(', ') : 'none');
    if (r.unknownIds.length) console.log('Ignored (not found or already owned):', r.unknownIds.join(', '));
  } catch (e) { console.error('Failed:', e.code || e.message); process.exitCode = 1; }
  finally { await db.close(); }
})();
