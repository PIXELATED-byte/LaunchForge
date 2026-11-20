// The database-test guard: local only, never the app's own database, never a cloud address by accident.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { decide } = require('./_guard');

const LOCAL = 'postgres://me@localhost:5432/launchforge_test';
const PROD_POOLED = 'postgresql://u:p@ep-cool-123-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const PROD_DIRECT = 'postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/neondb?sslmode=require';

test('a local postgres address is allowed', () => {
  assert.deepEqual(decide(LOCAL, []), { url: LOCAL });
  assert.equal(decide('postgres://me@127.0.0.1:5432/t', []).url, 'postgres://me@127.0.0.1:5432/t');
  assert.ok(decide('postgresql://me@[::1]:5432/t', []).url);
});
test('nothing set, or not a postgres address, or garbage: not run', () => {
  assert.match(decide('', []).skip, /not set/);
  assert.match(decide(undefined, []).skip, /not set/);
  assert.match(decide('mysql://me@localhost/x', []).skip, /REFUSED/);
  assert.match(decide('postgres://', []).skip, /REFUSED/);
});
test('a cloud / production address is refused even when it appears nowhere on this computer (e.g. it only lives on Render)', () => {
  for (const u of [PROD_POOLED, PROD_DIRECT]) assert.match(decide(u, []).skip, /not on this computer/);
});
test('a remote address is ALWAYS refused: there is no override', () => {
  for (const u of [PROD_DIRECT, PROD_POOLED, 'postgres://u:p@db.example.com:5432/throwaway', 'postgres://u@203.0.113.9/db']) {
    assert.match(decide(u, []).skip, /not on this computer/, u);
    assert.match(decide(u, [], { ALLOW_REMOTE_TEST_DB: 'yes' }).skip, /not on this computer/, 'an extra argument changes nothing: ' + u);
  }
});
test('end to end: a remote TEST_DATABASE_URL is refused even when environment variables try to permit it', () => {
  const root = path.join(__dirname, '..');
  const run = env => JSON.parse(execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./test/_guard').testDb()))"], { cwd: root, env, encoding: 'utf8' }));
  for (const flag of ['yes', 'true', '1', 'YES', 'allow']) {
    const r = run({ TEST_DATABASE_URL: PROD_DIRECT, ALLOW_REMOTE_TEST_DB: flag, ALLOW_REMOTE_TEST_DATABASE: flag, FORCE: flag });
    assert.equal(r.url, undefined, 'must not be allowed with flag ' + flag); assert.match(r.skip, /REFUSED: .*not on this computer/);
  }
});
test('the guard has no bypass in its code: it never reads an ALLOW_* style variable and decide() takes no environment', () => {
  const src = fs.readFileSync(path.join(__dirname, '_guard.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/ALLOW_|process\.env\.(?!TEST_DATABASE_URL|DATABASE_URL|MIGRATION_DATABASE_URL)/.test(src), 'unexpected environment variable in _guard.js');
  assert.equal(decide.length, 2);
});
test('the same local database as the app (DATABASE_URL or MIGRATION_DATABASE_URL) is refused', () => {
  assert.match(decide(LOCAL, [LOCAL]).skip, /same database/);
  assert.match(decide(LOCAL, ['postgres://other@localhost:5432/launchforge_test']).skip, /same database/);
  assert.equal(decide(LOCAL, ['postgres://me@localhost:5432/launchforge_dev']).url, LOCAL);
});
test('lookalike hosts are not treated as local', () => {
  for (const h of ['localhost.evil.example', 'notlocalhost', 'my-localhost.neon.tech', '127.0.0.10']) {
    assert.match(decide(`postgres://u:p@${h}/db`, []).skip, /not on this computer/, h);
  }
});
