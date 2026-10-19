// Database layer behaviour that needs no real database (and never touches one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

delete process.env.DATABASE_URL;   // these tests assume "not configured" unless they set a fake local URL themselves
const db = require('../db');
const { getStore } = require('../store');
const { createApi } = require('../api');
let hasPg = true; try { require.resolve('pg'); } catch (e) { hasPg = false; }
const hdr = { authorization: 'Bearer ' + 'b'.repeat(43) };

test('without DATABASE_URL: status() is "not_configured" and queries fail with DB_NOT_CONFIGURED', async () => {
  assert.equal(db.configured(), false);
  assert.equal(await db.status(), 'not_configured');
  await assert.rejects(() => db.query('SELECT 1'), e => e.code === 'DB_NOT_CONFIGURED');
});

test('without DATABASE_URL: every store operation rejects and the API answers 503 DB_NOT_CONFIGURED', async () => {
  const store = getStore();
  for (const op of ['list', 'get', 'create', 'update', 'rename', 'remove', 'importOne', 'countOwner', 'countTotal']) {
    await assert.rejects(() => store[op]('o', 'id', 1, {}), e => e.code === 'DB_NOT_CONFIGURED', op);
  }
  const api = createApi(getStore);
  const r = await api({ method: 'GET', path: '/', headers: hdr, ip: 'x' });
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'DB_NOT_CONFIGURED');
});

test('schema.sql is additive only: every CREATE is IF NOT EXISTS and nothing destructive is present', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.ok(!/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(sql), 'schema must not drop, delete or rewrite data');
  const creates = sql.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)[^;]*/gi) || [];
  assert.ok(creates.length >= 3);
  for (const c of creates) assert.match(c, /IF NOT EXISTS/i, c.slice(0, 60));
});

test('unreachable database (fake local URL): status() is "unavailable" and the API answers 503 DB_UNAVAILABLE',
  { skip: hasPg ? false : 'pg is not installed (run npm install)' }, async () => {
  process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';   // nothing listens on port 1; not a real database
  process.env.DATABASE_SSL = 'false'; process.env.DB_CONNECT_TIMEOUT_MS = '1500';
  try {
    assert.equal(await db.status(), 'unavailable');
    const r = await createApi(getStore)({ method: 'GET', path: '/', headers: hdr, ip: 'x' });
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'DB_UNAVAILABLE');
  } finally {
    await db.close();
    delete process.env.DATABASE_URL; delete process.env.DATABASE_SSL; delete process.env.DB_CONNECT_TIMEOUT_MS;
  }
});
