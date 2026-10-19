// Project API tests. They always run against the in-memory store.
// If TEST_DATABASE_URL is set they ALSO run against real Postgres (use a throwaway Neon branch, never production).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApi } = require('../api');
const { memoryStore } = require('../store');
const db = require('../db');
const { testDb } = require('./_guard');

const G = testDb();            // refuses anything that looks like the app's own database
const TEST_DB = G.url;
const tok = () => crypto.randomBytes(32).toString('base64url');
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const sample = (o = {}) => ({ name: 'Roast & Co', type: 'cafe', desc: 'A cozy cafe for neighbours', audience: 'locals', style: 'Modern',
  pages: ['Services', 'Gallery'], html: '<!DOCTYPE html><html><body>hi</body></html>', mode: 'demo', generatedAt: 1700000000000, history: [], ...o });
const ID0 = '00000000-0000-4000-8000-000000000000';

const suites = [['memory', () => ({ store: memoryStore(), owners: [] })]];
if (TEST_DB) suites.push(['postgres', () => { process.env.DATABASE_URL = TEST_DB; return { store: require('../store').pgStore, owners: [] }; }]);
else test('postgres suite', { skip: G.skip }, () => {});

for (const [label, make] of suites) {
  const setup = (opts) => {
    const ctx = make();
    const api = createApi(ctx.store, opts);
    const owner = () => { const t = tok(); ctx.owners.push(t); return t; };
    const call = (t, method, path, body) => api({ method, path, headers: t ? { authorization: 'Bearer ' + t } : {}, body, ip: '1.1.1.1' });
    return { call, owner, ctx };
  };
  const cleanup = async ctx => { if (label === 'postgres') for (const o of ctx.owners) await db.query('DELETE FROM projects WHERE owner_id=$1', [hash(o)]); };

  test(`[${label}] create then get round-trips every field`, async () => {
    const { call, owner, ctx } = setup(); const a = owner();
    const c = await call(a, 'POST', '/', sample());
    assert.equal(c.status, 201);
    const p = c.body.project;
    assert.match(p.id, /^[0-9a-f-]{36}$/);
    assert.equal(p.version, 1);
    const g = await call(a, 'GET', '/' + p.id);
    assert.equal(g.status, 200);
    for (const k of ['name', 'type', 'desc', 'audience', 'style', 'html', 'mode', 'generatedAt']) assert.deepEqual(g.body.project[k], sample()[k], k);
    assert.deepEqual(g.body.project.pages, ['Services', 'Gallery']);
    assert.ok(g.body.project.created > 0 && g.body.project.updated > 0);
    await cleanup(ctx);
  });

  test(`[${label}] list returns only the owner's projects, without html`, async () => {
    const { call, owner, ctx } = setup(); const a = owner(), b = owner();
    await call(a, 'POST', '/', sample({ name: 'A1' })); await call(a, 'POST', '/', sample({ name: 'A2', html: '' })); await call(b, 'POST', '/', sample({ name: 'B1' }));
    const l = await call(a, 'GET', '/');
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.projects.map(p => p.name).sort(), ['A1', 'A2']);
    assert.ok(l.body.projects.every(p => p.html === undefined));
    assert.equal(l.body.projects.find(p => p.name === 'A2').hasHtml, false);
    assert.equal(l.body.projects.find(p => p.name === 'A1').hasHtml, true);
    await cleanup(ctx);
  });

  test(`[${label}] update bumps version; a stale save gets 409 and overwrites nothing`, async () => {
    const { call, owner, ctx } = setup(); const a = owner();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    const u1 = await call(a, 'PUT', '/' + p.id, { ...sample({ name: 'First edit', html: '<html>v2</html>' }), baseVersion: 1 });
    assert.equal(u1.status, 200); assert.equal(u1.body.project.version, 2);
    const stale = await call(a, 'PUT', '/' + p.id, { ...sample({ name: 'Stale edit' }), baseVersion: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.equal(stale.body.current.version, 2);
    assert.equal(stale.body.current.name, 'First edit');
    const g = await call(a, 'GET', '/' + p.id);
    assert.equal(g.body.project.name, 'First edit'); assert.equal(g.body.project.html, '<html>v2</html>');
    const ok = await call(a, 'PUT', '/' + p.id, { ...sample({ name: 'Resolved' }), baseVersion: 2 });
    assert.equal(ok.status, 200); assert.equal(ok.body.project.version, 3);
    await cleanup(ctx);
  });

  test(`[${label}] rename persists, bumps version, and later stale saves conflict`, async () => {
    const { call, owner, ctx } = setup(); const a = owner();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    const r = await call(a, 'PATCH', '/' + p.id, { name: '  Renamed  ' });
    assert.equal(r.status, 200); assert.equal(r.body.project.name, 'Renamed'); assert.equal(r.body.project.version, 2);
    assert.equal((await call(a, 'GET', '/' + p.id)).body.project.name, 'Renamed');
    assert.equal((await call(a, 'PUT', '/' + p.id, { ...sample(), baseVersion: 1 })).status, 409);
    assert.equal((await call(a, 'PATCH', '/' + p.id, { name: '' })).status, 400);
    await cleanup(ctx);
  });

  test(`[${label}] delete removes the project; deleting again is 404`, async () => {
    const { call, owner, ctx } = setup(); const a = owner();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    assert.equal((await call(a, 'DELETE', '/' + p.id)).status, 204);
    assert.equal((await call(a, 'GET', '/' + p.id)).status, 404);
    assert.equal((await call(a, 'DELETE', '/' + p.id)).status, 404);
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 0);
    await cleanup(ctx);
  });

  test(`[${label}] ownership isolation: another owner cannot read, change, rename or delete`, async () => {
    const { call, owner, ctx } = setup(); const a = owner(), b = owner();
    const p = (await call(a, 'POST', '/', sample({ name: 'Private-ish' }))).body.project;
    assert.equal((await call(b, 'GET', '/' + p.id)).status, 404);
    assert.equal((await call(b, 'PUT', '/' + p.id, { ...sample({ name: 'Hijack' }), baseVersion: 1 })).status, 404);
    assert.equal((await call(b, 'PATCH', '/' + p.id, { name: 'Hijack' })).status, 404);
    assert.equal((await call(b, 'DELETE', '/' + p.id)).status, 404);
    assert.deepEqual((await call(b, 'GET', '/')).body.projects, []);
    const g = await call(a, 'GET', '/' + p.id);
    assert.equal(g.body.project.name, 'Private-ish'); assert.equal(g.body.project.version, 1);
    await cleanup(ctx);
  });

  test(`[${label}] invalid input is rejected with meaningful statuses`, async () => {
    const { call, owner, ctx } = setup(); const a = owner();
    assert.equal((await call(a, 'POST', '/', sample({ name: '' }))).status, 400);
    assert.equal((await call(a, 'POST', '/', sample({ name: 'x'.repeat(61) }))).status, 400);
    assert.equal((await call(a, 'POST', '/', sample({ type: 'spaceship' }))).status, 400);
    assert.equal((await call(a, 'POST', '/', sample({ pages: ['Hacking'] }))).status, 400);
    assert.equal((await call(a, 'POST', '/', sample({ mode: 'evil' }))).status, 400);
    assert.equal((await call(a, 'POST', '/', sample({ generatedAt: 'yesterday' }))).status, 400);
    assert.equal((await call(a, 'POST', '/', sample({ html: 'x'.repeat(300001) }))).status, 400);
    assert.equal((await call(a, 'POST', '/', 'not an object')).status, 400);
    const big = await call(a, 'POST', '/', sample({ html: 'x'.repeat(290000), history: [1, 2, 3, 4].map(i => ({ id: i, at: i, instruction: 'x', prev: 'y'.repeat(290000) })) }));
    assert.equal(big.status, 413); assert.equal(big.body.error.code, 'PROJECT_TOO_LARGE');
    assert.equal((await call(a, 'GET', '/not-a-uuid')).status, 400);
    assert.equal((await call(a, 'PUT', '/' + ID0, sample())).status, 400); // baseVersion missing
    assert.equal((await call(a, 'PUT', '/' + ID0, { ...sample(), baseVersion: 1 })).status, 404);
    assert.equal((await call(a, 'GET', '/' + ID0)).status, 404);
    assert.equal((await call(a, 'PUT', '/', sample())).status, 405);
    assert.equal((await call(null, 'GET', '/')).status, 401);
    assert.equal((await call('short', 'GET', '/')).status, 401);
    assert.equal((await call('bad token with spaces and symbols!!!!!!!!!!!!!!!!', 'GET', '/')).status, 401);
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 0, 'nothing should have been stored');
    await cleanup(ctx);
  });

  test(`[${label}] SQL injection text is stored literally`, async () => {
    const { call, owner, ctx } = setup(); const a = owner();
    const evil = "x'); DROP TABLE projects; --";
    const p = (await call(a, 'POST', '/', sample({ name: evil, desc: evil }))).body.project;
    assert.equal((await call(a, 'GET', '/' + p.id)).body.project.name, evil);
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 1);
    await cleanup(ctx);
  });

  test(`[${label}] history is capped at 5 entries (newest kept) and pages are de-duplicated`, async () => {
    const { call, owner, ctx } = setup(); const a = owner();
    const history = [1, 2, 3, 4, 5, 6, 7].map(i => ({ id: i, at: i, instruction: 'edit ' + i, prev: '<html>' + i + '</html>' }));
    const p = (await call(a, 'POST', '/', sample({ history, pages: ['Blog', 'Blog', 'Pricing'] }))).body.project;
    const g = (await call(a, 'GET', '/' + p.id)).body.project;
    assert.deepEqual(g.history.map(h => h.id), [3, 4, 5, 6, 7]);
    assert.deepEqual(g.pages, ['Blog', 'Pricing']);
    await cleanup(ctx);
  });

  test(`[${label}] per-owner project limit and free-tier total limit`, async () => {
    const { call, owner, ctx } = setup({ maxPerOwner: 2, maxTotal: 3 }); const a = owner(), b = owner();
    assert.equal((await call(a, 'POST', '/', sample())).status, 201);
    assert.equal((await call(a, 'POST', '/', sample())).status, 201);
    const lim = await call(a, 'POST', '/', sample());
    assert.equal(lim.status, 403); assert.equal(lim.body.error.code, 'PROJECT_LIMIT');
    assert.equal((await call(b, 'POST', '/', sample())).status, 201);
    if (label === 'memory') { // total counts every owner in the table; only meaningful on an isolated store
      const full = await call(b, 'POST', '/', sample());
      assert.equal(full.status, 503); assert.equal(full.body.error.code, 'STORAGE_FULL');
    }
    await cleanup(ctx);
  });

  test(`[${label}] write rate limit returns 429`, async () => {
    const { call, owner, ctx } = setup({ writePerMin: 3 }); const a = owner();
    for (let i = 0; i < 3; i++) assert.equal((await call(a, 'POST', '/', sample())).status, 201);
    assert.equal((await call(a, 'POST', '/', sample())).status, 429);
    assert.equal((await call(a, 'GET', '/')).status, 200, 'reads are not rate limited');
    await cleanup(ctx);
  });

  test(`[${label}] import is idempotent, insert-only, and reports invalid items`, async () => {
    const { call, owner, ctx } = setup(); const a = owner(), b = owner();
    const item = (id, o = {}) => ({ localId: id, ...sample(o), created: 1600000000000 });
    const r1 = await call(a, 'POST', '/import', { projects: [item('p1', { name: 'Local one' }), item('p2', { name: '' }), item('p3', { name: 'Local three' })] });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.results.map(x => x.status), ['imported', 'invalid', 'imported']);
    const id1 = r1.body.results[0].id;
    assert.equal((await call(a, 'GET', '/' + id1)).body.project.created, 1600000000000);
    // server copy is edited, then the stale local copy is imported again: it must NOT overwrite
    await call(a, 'PUT', '/' + id1, { ...sample({ name: 'Newer on server' }), baseVersion: 1 });
    const r2 = await call(a, 'POST', '/import', { projects: [item('p1', { name: 'Stale local' })] });
    assert.equal(r2.body.results[0].status, 'exists'); assert.equal(r2.body.results[0].id, id1);
    const g = (await call(a, 'GET', '/' + id1)).body.project;
    assert.equal(g.name, 'Newer on server'); assert.equal(g.version, 2);
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 2, 'no duplicates created');
    // the same localId under another owner is a separate project
    assert.equal((await call(b, 'POST', '/import', { projects: [item('p1')] })).body.results[0].status, 'imported');
    assert.equal((await call(a, 'POST', '/import', { projects: [] })).status, 400);
    await cleanup(ctx);
  });

  test(`[${label}] list is ordered by most recently updated`, async () => {
    const { call, owner, ctx } = setup(); const a = owner();
    const p1 = (await call(a, 'POST', '/', sample({ name: 'first' }))).body.project;
    await new Promise(r => setTimeout(r, 15));
    await call(a, 'POST', '/', sample({ name: 'second' }));
    await new Promise(r => setTimeout(r, 15));
    await call(a, 'PUT', '/' + p1.id, { ...sample({ name: 'first (edited)' }), baseVersion: 1 });
    assert.deepEqual((await call(a, 'GET', '/')).body.projects.map(p => p.name), ['first (edited)', 'second']);
    await cleanup(ctx);
  });

  test(`[${label}] two saves based on the same version: exactly one wins, the other gets 409`, async () => {
    const { call, owner, ctx } = setup(); const a = owner();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    const [r1, r2] = await Promise.all([
      call(a, 'PUT', '/' + p.id, { ...sample({ name: 'tab one' }), baseVersion: 1 }),
      call(a, 'PUT', '/' + p.id, { ...sample({ name: 'tab two' }), baseVersion: 1 })]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    const winner = r1.status === 200 ? 'tab one' : 'tab two';
    const g = (await call(a, 'GET', '/' + p.id)).body.project;
    assert.equal(g.name, winner); assert.equal(g.version, 2);
    await cleanup(ctx);
  });
}

// ---- database failure handling (store-independent) ----
const failing = code => new Proxy({}, { get: () => async () => { const e = new Error('boom'); e.code = code; throw e; } });
test('database not configured -> 503 DB_NOT_CONFIGURED', async () => {
  const api = createApi(failing('DB_NOT_CONFIGURED'));
  const r = await api({ method: 'GET', path: '/', headers: { authorization: 'Bearer ' + tok() }, ip: 'x' });
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'DB_NOT_CONFIGURED');
});
test('database unreachable -> 503 DB_UNAVAILABLE on every operation', async () => {
  const api = createApi(failing('DB_UNAVAILABLE')); const t = tok();
  for (const [method, path, body] of [['GET', '/'], ['POST', '/', sample()], ['GET', '/' + ID0], ['PUT', '/' + ID0, { ...sample(), baseVersion: 1 }], ['PATCH', '/' + ID0, { name: 'x' }], ['DELETE', '/' + ID0]]) {
    const r = await api({ method, path, headers: { authorization: 'Bearer ' + t }, body, ip: 'x' });
    assert.equal(r.status, 503, method + ' ' + path); assert.equal(r.body.error.code, 'DB_UNAVAILABLE');
  }
});
test('unexpected errors -> 500 without leaking internals', async () => {
  const api = createApi(failing('WEIRD'));
  const r = await api({ method: 'GET', path: '/', headers: { authorization: 'Bearer ' + tok() }, ip: 'x' });
  assert.equal(r.status, 500); assert.ok(!JSON.stringify(r.body).includes('boom'));
});

// ---- real Postgres only ----
if (TEST_DB) {
  test('[postgres] data persists across a "restart" (pool closed and recreated)', async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { pgStore } = require('../store'); const t = tok(); const o = hash(t);
    const api = createApi(pgStore);
    const c = await api({ method: 'POST', path: '/', headers: { authorization: 'Bearer ' + t }, body: sample({ name: 'Survives restart' }), ip: 'x' });
    await db.close();
    const g = await api({ method: 'GET', path: '/' + c.body.project.id, headers: { authorization: 'Bearer ' + t }, ip: 'x' });
    assert.equal(g.status, 200); assert.equal(g.body.project.name, 'Survives restart');
    await db.query('DELETE FROM projects WHERE owner_id=$1', [o]);
  });
  test('[postgres] unreachable database is reported as DB_UNAVAILABLE', async () => {
    await db.close();
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';
    process.env.DATABASE_SSL = 'false';
    const r = await createApi(require('../store').pgStore)({ method: 'GET', path: '/', headers: { authorization: 'Bearer ' + tok() }, ip: 'x' });
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'DB_UNAVAILABLE');
    await db.close(); process.env.DATABASE_URL = saved; delete process.env.DATABASE_SSL;
  });
  test('[postgres] creating the schema repeatedly is safe and keeps existing rows', async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { pgStore } = require('../store'); const t = tok(); const o = hash(t);
    const api = createApi(pgStore);
    const c = await api({ method: 'POST', path: '/', headers: { authorization: 'Bearer ' + t }, body: sample({ name: 'Keep me' }), ip: 'x' });
    await db.ensureSchema(); await db.close(); await db.ensureSchema();
    const g = await api({ method: 'GET', path: '/' + c.body.project.id, headers: { authorization: 'Bearer ' + t }, ip: 'x' });
    assert.equal(g.body.project.name, 'Keep me');
    await db.query('DELETE FROM projects WHERE owner_id=$1', [o]);
  });
  test.after(async () => { await db.close(); });
}
