// Static safety checks for the social sign-in change. They read source files only: no network, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const code = f => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no code path applies the optional migration implicitly: startup/AUTO_MIGRATE call applyMigrations(p) with no opt-in, and only --with-optional opts in', () => {
  assert.match(code('db.js'), /applyMigrations\(p\)/);
  assert.ok(!/includeOptional/.test(code('db.js')), 'db.js must never opt in');
  assert.ok(!/applyMigrations/.test(code('server.js')) && !/applyMigrations/.test(code('web.js')) && !/applyMigrations/.test(code('oauth.js')));
  const s = code('scripts/migrate.js');
  assert.match(s, /const withOptional = process\.argv\.includes\('--with-optional'\)/);
  assert.match(s, /applyMigrations\(pool, m => console\.log\(m\), \{ includeOptional: withOptional \}\)/);
  assert.ok(s.indexOf("includes('--apply')") < s.indexOf('applyMigrations('), 'nothing is applied before the --apply check');
  assert.match(s, /const pending = await pendingMigrations\(pool, \{ includeOptional: withOptional \}\)/, 'the dry-run list must not show optional migrations without the flag');
});
test('the schema is not changed by startup: 003 is not in the legacy schema.sql and no runtime code creates OAuth tables', () => {
  assert.ok(!/oauth_identities/.test(read('schema.sql')));
  for (const f of ['db.js', 'server.js', 'users.js', 'web.js', 'auth.js', 'oauth.js', 'store.js']) assert.ok(!/CREATE TABLE/i.test(code(f)) || f === 'x', f + ' must not create tables at runtime');
});
test('oauth.js logs only through its own log() (short codes), never raw errors, tokens or request values', () => {
  const s = code('oauth.js');
  assert.ok(!/console\.log/.test(s)); assert.equal((s.match(/console\.error/g) || []).length, 1, 'only the log() helper may print');
  const unexpected = (s.split('\n').find(l => /log\(provider, 'failed'/.test(l)) || '');
  assert.ok(unexpected); assert.ok(!/\.message/.test(unexpected.replace(/\/\/.*$/, '')), 'unexpected errors must not print their message');
});
test('.env.example documents the provider variables without any values, and holds no secrets', () => {
  const s = read('.env.example');
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}|BEGIN (EC )?PRIVATE KEY/.test(s));
  for (const k of ['GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET', 'APPLE_PRIVATE_KEY']) assert.match(s, new RegExp('^# ' + k + '=\\s*(#.*)?$', 'm'), k + ' must be commented out and empty');
});
test('the browser page contains no provider secret and no hard-coded provider host other than the sign-in start route', () => {
  const html = read('index.html');
  assert.ok(!/CLIENT_SECRET|PRIVATE_KEY|client_secret/.test(html));
  assert.ok(!/accounts\.google\.com|appleid\.apple\.com|github\.com\/login/.test(html), 'the browser only ever visits OUR /api/auth/oauth/<provider>/start');
});
