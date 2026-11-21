// Project API: CRUD, ownership/authorization, conflicts, limits, import, failures.
// Always runs against the in-memory store. If TEST_DATABASE_URL points at a throwaway database (see _guard.js)
// the same tests ALSO run against real Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi, authorizeEdit } = require('../api');
const { memoryStore } = require('../store');
const { memoryUsers, pgUsers } = require('../users');
const db = require('../db');
const { testDb } = require('./_guard');
const { ORIGIN, originPolicy, sessionJar, req } = require('./_helpers');

const G = testDb();
const TEST_DB = G.url;
const sample = (o = {}) => ({ name: 'Roast & Co', type: 'cafe', desc: 'A cozy cafe for neighbours', audience: 'locals', style: 'Modern',
  pages: ['Services', 'Gallery'], html: '<!DOCTYPE html><html><body>hi</body></html>', mode: 'demo', generatedAt: 1700000000000, history: [], ...o });
const ID0 = '00000000-0000-4000-8000-000000000000';
let n = 0;

const suites = [['memory', () => ({ store: memoryStore(), users: memoryUsers(), made: [] })]];
if (TEST_DB) suites.push(['postgres', () => { process.env.DATABASE_URL = TEST_DB; return { store: require('../store').pgStore, users: pgUsers, made: [] }; }]);
else test('postgres suite', { skip: G.skip }, () => {});

if (TEST_DB) test.before(async () => { process.env.DATABASE_URL = TEST_DB; await require('../migrate').applyMigrations(db.getPool()); });

for (const [label, make] of suites) {
  const setup = opts => {
    const ctx = make(); const jar = sessionJar();
    const api = createApi(ctx.store, { originPolicy, ...opts });
    // a logged-in user: real user row + a session with a CSRF token
    const user = async () => {
      const u = await ctx.users.create(`u${Date.now()}${n++}@example.com`, 'x'); ctx.made.push(u.id);
      const client = { sid: null }; const { csrf } = await jar.adapter(client).start(u.id);
      return { id: u.id, client, csrf };
    };
    const call = (u, method, path, body, extra = {}) => {
      const client = u ? u.client : { sid: null };
      return api(req(jar, client, method, path, body, { csrf: u && u.csrf, ...extra }));
    };
    return { call, user, ctx, jar, api };
  };
  const cleanup = async ctx => {
    if (label !== 'postgres') return;
    for (const id of ctx.made) { await db.query('DELETE FROM projects WHERE user_id=$1', [id]); await db.query('DELETE FROM users WHERE id=$1', [id]); }
  };

  test(`[${label}] create then get round-trips every field`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const c = await call(a, 'POST', '/', sample());
    assert.equal(c.status, 201);
    const p = c.body.project;
    assert.match(p.id, /^[0-9a-f-]{36}$/); assert.equal(p.version, 1);
    const g = await call(a, 'GET', '/' + p.id);
    assert.equal(g.status, 200);
    for (const k of ['name', 'type', 'desc', 'audience', 'style', 'html', 'mode', 'generatedAt']) assert.deepEqual(g.body.project[k], sample()[k], k);
    assert.deepEqual(g.body.project.pages, ['Services', 'Gallery']);
    assert.ok(g.body.project.created > 0 && g.body.project.updated > 0);
    for (const k of ['userId', 'user_id', 'owner', 'ownerId', 'owner_id']) assert.equal(g.body.project[k], undefined, 'owner details must not be exposed: ' + k);
    await cleanup(ctx);
  });

  test(`[${label}] list returns only the caller's projects, without html`, async () => {
    const { call, user, ctx } = setup(); const a = await user(), b = await user();
    await call(a, 'POST', '/', sample({ name: 'A1' })); await call(a, 'POST', '/', sample({ name: 'A2', html: '' })); await call(b, 'POST', '/', sample({ name: 'B1' }));
    const l = await call(a, 'GET', '/');
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.projects.map(p => p.name).sort(), ['A1', 'A2']);
    assert.ok(l.body.projects.every(p => p.html === undefined));
    assert.equal(l.body.projects.find(p => p.name === 'A2').hasHtml, false);
    await cleanup(ctx);
  });

  test(`[${label}] unauthenticated requests are rejected on EVERY route, including unknown ones`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    for (const [m, path, body] of [['GET', '/'], ['POST', '/', sample()], ['GET', '/' + p.id], ['PUT', '/' + p.id, { ...sample(), baseVersion: 1 }],
      ['PATCH', '/' + p.id, { name: 'x' }], ['DELETE', '/' + p.id], ['POST', '/import', { projects: [] }],
      ['POST', '/' + p.id + '/publish', {}], ['GET', '/admin/everything'], ['PUT', '/', {}]]) {
      const r = await call(null, m, path, body);
      assert.equal(r.status, 401, m + ' ' + path); assert.equal(r.body.error.code, 'AUTH_REQUIRED');
    }
    assert.equal((await call(a, 'GET', '/' + p.id)).body.project.name, 'Roast & Co', 'nothing was changed');
    await cleanup(ctx);
  });

  test(`[${label}] there is no publish route, and a logged-in user cannot reach one`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    const r = await call(a, 'POST', '/' + p.id + '/publish', {});
    assert.equal(r.status, 404);
    await cleanup(ctx);
  });

  test(`[${label}] an expired or revoked session is rejected`, async () => {
    const { call, user, jar, ctx } = setup(); const a = await user();
    assert.equal((await call(a, 'GET', '/')).status, 200);
    jar.table.get(a.client.sid).expired = true;
    assert.equal((await call(a, 'GET', '/')).status, 401);
    jar.table.delete(a.client.sid);
    assert.equal((await call(a, 'POST', '/', sample())).status, 401);
    await cleanup(ctx);
  });

  test(`[${label}] writes need an allowed Origin and a valid CSRF token; reads do not`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    assert.equal((await call(a, 'POST', '/', sample(), { csrf: 'wrong' })).body.error.code, 'CSRF_INVALID');
    assert.equal((await call(a, 'POST', '/', sample(), { csrf: '' })).status, 403);
    assert.equal((await call(a, 'POST', '/', sample(), { origin: 'https://evil.example' })).body.error.code, 'BAD_ORIGIN');
    assert.equal((await call(a, 'POST', '/', sample(), { origin: null })).status, 403);
    assert.equal((await call(a, 'POST', '/', sample(), { origin: 'null' })).status, 403);
    assert.equal((await call(a, 'DELETE', '/' + ID0, undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(a, 'GET', '/', undefined, { origin: 'https://evil.example', csrf: '' })).status, 200);
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 0, 'rejected writes stored nothing');
    assert.equal((await call(a, 'POST', '/', sample(), { origin: 'https://api.example' })).status, 201, 'same-origin is allowed');
    await cleanup(ctx);
  });

  test(`[${label}] ownership isolation: another user cannot read, change, rename or delete (IDOR)`, async () => {
    const { call, user, ctx } = setup(); const a = await user(), b = await user();
    const p = (await call(a, 'POST', '/', sample({ name: 'Private' }))).body.project;
    assert.equal((await call(b, 'GET', '/' + p.id)).status, 404);
    assert.equal((await call(b, 'PUT', '/' + p.id, { ...sample({ name: 'Hijack' }), baseVersion: 1 })).status, 404);
    assert.equal((await call(b, 'PATCH', '/' + p.id, { name: 'Hijack' })).status, 404);
    assert.equal((await call(b, 'DELETE', '/' + p.id)).status, 404);
    assert.deepEqual((await call(b, 'GET', '/')).body.projects, []);
    const missing = await call(b, 'GET', '/' + ID0);
    const foreign = await call(b, 'GET', '/' + p.id);
    assert.deepEqual(foreign.body, missing.body, "a foreign project is indistinguishable from a missing one");
    const g = await call(a, 'GET', '/' + p.id);
    assert.equal(g.body.project.name, 'Private'); assert.equal(g.body.project.version, 1);
    await cleanup(ctx);
  });

  test(`[${label}] a user id forged in the request body never changes ownership`, async () => {
    const { call, user, ctx } = setup(); const a = await user(), b = await user();
    const forged = { userId: b.id, user_id: b.id, ownerId: b.id, owner_id: b.id, owner: b.id };
    const p = (await call(a, 'POST', '/', { ...sample(), ...forged })).body.project;
    assert.equal((await call(b, 'GET', '/' + p.id)).status, 404, 'B must not gain access');
    assert.equal((await call(b, 'GET', '/')).body.projects.length, 0);
    assert.equal((await call(a, 'GET', '/' + p.id)).status, 200, 'A still owns it');
    const u = await call(a, 'PUT', '/' + p.id, { ...sample({ name: 'edited' }), ...forged, baseVersion: 1 });
    assert.equal(u.status, 200);
    assert.equal((await call(b, 'GET', '/' + p.id)).status, 404, 'a forged id in an update does not transfer the project');
    const imp = await call(a, 'POST', '/import', { projects: [{ localId: 'p1', ...sample(), ...forged }] });
    assert.equal(imp.body.results[0].status, 'imported');
    assert.equal((await call(b, 'GET', '/')).body.projects.length, 0);
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 2);
    await cleanup(ctx);
  });

  test(`[${label}] AI edit authorization: a project id must belong to the caller`, async () => {
    const { call, user, ctx } = setup(); const a = await user(), b = await user();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    assert.equal(await authorizeEdit(ctx.store, a.id, p.id), null);
    assert.equal(await authorizeEdit(ctx.store, a.id, undefined), null, 'unsaved projects can be edited without an id');
    assert.equal((await authorizeEdit(ctx.store, b.id, p.id)).status, 404);
    assert.equal((await authorizeEdit(ctx.store, a.id, ID0)).status, 404);
    assert.equal((await authorizeEdit(ctx.store, a.id, 'not-a-uuid')).status, 400);
    assert.equal((await authorizeEdit(ctx.store, a.id, { $ne: 1 })).status, 400);
    await cleanup(ctx);
  });

  test(`[${label}] pre-accounts (legacy) projects are invisible to every account`, async () => {
    if (label !== 'memory') return;               // Postgres variant lives in migrations.test.js
    const { call, user, ctx } = setup(); const a = await user(), b = await user();
    const legacyId = ctx.store._seedLegacy('abc123hash', sample({ name: 'Old project' }));
    for (const u of [a, b]) {
      assert.deepEqual((await call(u, 'GET', '/')).body.projects, []);
      assert.equal((await call(u, 'GET', '/' + legacyId)).status, 404);
      assert.equal((await call(u, 'PUT', '/' + legacyId, { ...sample(), baseVersion: 1 })).status, 404);
      assert.equal((await call(u, 'DELETE', '/' + legacyId)).status, 404);
    }
    assert.equal((await ctx.store.listUnowned()).length, 1, 'still preserved');
  });

  test(`[${label}] update bumps version; a stale save gets 409 and overwrites nothing`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    const u1 = await call(a, 'PUT', '/' + p.id, { ...sample({ name: 'First edit', html: '<html>v2</html>' }), baseVersion: 1 });
    assert.equal(u1.status, 200); assert.equal(u1.body.project.version, 2);
    const stale = await call(a, 'PUT', '/' + p.id, { ...sample({ name: 'Stale edit' }), baseVersion: 1 });
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.equal(stale.body.current.version, 2); assert.equal(stale.body.current.name, 'First edit');
    const g = await call(a, 'GET', '/' + p.id);
    assert.equal(g.body.project.name, 'First edit'); assert.equal(g.body.project.html, '<html>v2</html>');
    assert.equal((await call(a, 'PUT', '/' + p.id, { ...sample({ name: 'Resolved' }), baseVersion: 2 })).body.project.version, 3);
    await cleanup(ctx);
  });

  test(`[${label}] two saves based on the same version: exactly one wins, the other gets 409`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    const [r1, r2] = await Promise.all([
      call(a, 'PUT', '/' + p.id, { ...sample({ name: 'tab one' }), baseVersion: 1 }),
      call(a, 'PUT', '/' + p.id, { ...sample({ name: 'tab two' }), baseVersion: 1 })]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    const g = (await call(a, 'GET', '/' + p.id)).body.project;
    assert.equal(g.name, r1.status === 200 ? 'tab one' : 'tab two'); assert.equal(g.version, 2);
    await cleanup(ctx);
  });

  test(`[${label}] rename persists, bumps version, and later stale saves conflict`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    const r = await call(a, 'PATCH', '/' + p.id, { name: '  Renamed  ' });
    assert.equal(r.status, 200); assert.equal(r.body.project.name, 'Renamed'); assert.equal(r.body.project.version, 2);
    assert.equal((await call(a, 'PUT', '/' + p.id, { ...sample(), baseVersion: 1 })).status, 409);
    assert.equal((await call(a, 'PATCH', '/' + p.id, { name: '' })).status, 400);
    await cleanup(ctx);
  });

  test(`[${label}] delete removes the project; deleting again is 404`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const p = (await call(a, 'POST', '/', sample())).body.project;
    assert.equal((await call(a, 'DELETE', '/' + p.id)).status, 204);
    assert.equal((await call(a, 'GET', '/' + p.id)).status, 404);
    assert.equal((await call(a, 'DELETE', '/' + p.id)).status, 404);
    await cleanup(ctx);
  });

  test(`[${label}] invalid input is rejected with meaningful statuses`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    for (const bad of [{ name: '' }, { name: 'x'.repeat(61) }, { type: 'spaceship' }, { pages: ['Hacking'] }, { mode: 'evil' }, { generatedAt: 'yesterday' }, { html: 'x'.repeat(300001) }]) {
      assert.equal((await call(a, 'POST', '/', sample(bad))).status, 400, JSON.stringify(bad).slice(0, 40));
    }
    assert.equal((await call(a, 'POST', '/', 'not an object')).status, 400);
    const big = await call(a, 'POST', '/', sample({ html: 'x'.repeat(290000), history: [1, 2, 3, 4].map(i => ({ id: i, at: i, instruction: 'x', prev: 'y'.repeat(290000) })) }));
    assert.equal(big.status, 413); assert.equal(big.body.error.code, 'PROJECT_TOO_LARGE');
    assert.equal((await call(a, 'GET', '/not-a-uuid')).status, 400);
    assert.equal((await call(a, 'PUT', '/' + ID0, sample())).status, 400);
    assert.equal((await call(a, 'PUT', '/' + ID0, { ...sample(), baseVersion: 1 })).status, 404);
    assert.equal((await call(a, 'PUT', '/', sample())).status, 405);
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 0, 'nothing should have been stored');
    await cleanup(ctx);
  });

  test(`[${label}] SQL injection text is stored literally`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const evil = "x'); DROP TABLE projects; --";
    const p = (await call(a, 'POST', '/', sample({ name: evil, desc: evil }))).body.project;
    assert.equal((await call(a, 'GET', '/' + p.id)).body.project.name, evil);
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 1);
    await cleanup(ctx);
  });

  test(`[${label}] history is capped at 5 entries (newest kept) and pages are de-duplicated`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const history = [1, 2, 3, 4, 5, 6, 7].map(i => ({ id: i, at: i, instruction: 'edit ' + i, prev: '<html>' + i + '</html>' }));
    const p = (await call(a, 'POST', '/', sample({ history, pages: ['Blog', 'Blog', 'Pricing'] }))).body.project;
    const g = (await call(a, 'GET', '/' + p.id)).body.project;
    assert.deepEqual(g.history.map(h => h.id), [3, 4, 5, 6, 7]); assert.deepEqual(g.pages, ['Blog', 'Pricing']);
    await cleanup(ctx);
  });

  test(`[${label}] list is ordered by most recently updated`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const p1 = (await call(a, 'POST', '/', sample({ name: 'first' }))).body.project;
    await new Promise(r => setTimeout(r, 15)); await call(a, 'POST', '/', sample({ name: 'second' }));
    await new Promise(r => setTimeout(r, 15)); await call(a, 'PUT', '/' + p1.id, { ...sample({ name: 'first (edited)' }), baseVersion: 1 });
    assert.deepEqual((await call(a, 'GET', '/')).body.projects.map(p => p.name), ['first (edited)', 'second']);
    await cleanup(ctx);
  });

  test(`[${label}] per-user project limit (and the free-tier total limit)`, async () => {
    const { call, user, ctx } = setup({ maxPerOwner: 2, maxTotal: 3 }); const a = await user(), b = await user();
    assert.equal((await call(a, 'POST', '/', sample())).status, 201); assert.equal((await call(a, 'POST', '/', sample())).status, 201);
    const lim = await call(a, 'POST', '/', sample());
    assert.equal(lim.status, 403); assert.equal(lim.body.error.code, 'PROJECT_LIMIT');
    assert.equal((await call(b, 'POST', '/', sample())).status, 201);
    if (label === 'memory') { const full = await call(b, 'POST', '/', sample()); assert.equal(full.status, 503); assert.equal(full.body.error.code, 'STORAGE_FULL'); }
    await cleanup(ctx);
  });

  test(`[${label}] write rate limit is per user and returns 429`, async () => {
    const { call, user, ctx } = setup({ writePerMin: 3 }); const a = await user(), b = await user();
    for (let i = 0; i < 3; i++) assert.equal((await call(a, 'POST', '/', sample())).status, 201);
    assert.equal((await call(a, 'POST', '/', sample())).status, 429);
    assert.equal((await call(a, 'GET', '/')).status, 200, 'reads are not rate limited');
    assert.equal((await call(b, 'POST', '/', sample())).status, 201, 'another user is unaffected');
    await cleanup(ctx);
  });

  test(`[${label}] import is idempotent, insert-only, and reports invalid items`, async () => {
    const { call, user, ctx } = setup(); const a = await user(), b = await user();
    const item = (id, o = {}) => ({ localId: id, ...sample(o), created: 1600000000000 });
    const r1 = await call(a, 'POST', '/import', { projects: [item('p1', { name: 'Local one' }), item('p2', { name: '' }), item('p3', { name: 'Local three' })] });
    assert.deepEqual(r1.body.results.map(x => x.status), ['imported', 'invalid', 'imported']);
    const id1 = r1.body.results[0].id;
    assert.equal((await call(a, 'GET', '/' + id1)).body.project.created, 1600000000000);
    await call(a, 'PUT', '/' + id1, { ...sample({ name: 'Newer on server' }), baseVersion: 1 });
    const r2 = await call(a, 'POST', '/import', { projects: [item('p1', { name: 'Stale local' })] });
    assert.equal(r2.body.results[0].status, 'exists'); assert.equal(r2.body.results[0].id, id1);
    assert.equal((await call(a, 'GET', '/' + id1)).body.project.name, 'Newer on server');
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 2, 'no duplicates created');
    assert.equal((await call(b, 'POST', '/import', { projects: [item('p1')] })).body.results[0].status, 'imported', 'same local id under another user is separate');
    assert.equal((await call(a, 'POST', '/import', { projects: [] })).status, 400);
    await cleanup(ctx);
  });

  test(`[${label}] repeated parallel imports create exactly one project`, async () => {
    const { call, user, ctx } = setup(); const a = await user();
    const body = { projects: [{ localId: 'same', ...sample() }] };
    const rs = await Promise.all([1, 2, 3].map(() => call(a, 'POST', '/import', body).catch(e => ({ status: 500, e }))));
    assert.ok(rs.some(r => r.status === 200 && r.body.results[0].status === 'imported'));
    assert.equal((await call(a, 'GET', '/')).body.projects.length, 1);
    await cleanup(ctx);
  });
}

// ---- database failure handling (store-independent) ----
const failing = code => new Proxy({}, { get: () => async () => { const e = new Error('boom'); e.code = code; throw e; } });
async function asUser(store) {
  const jar = sessionJar(), client = { sid: null }; const { csrf } = await jar.adapter(client).start('11111111-1111-4111-8111-111111111111');
  const api = createApi(store, { originPolicy });
  return (m, p, b) => api(req(jar, client, m, p, b, { csrf }));
}
test('database not configured -> 503 DB_NOT_CONFIGURED', async () => {
  const r = await (await asUser(failing('DB_NOT_CONFIGURED')))('GET', '/');
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'DB_NOT_CONFIGURED');
});
test('migration pending -> 503 SCHEMA_OUTDATED (not a vague 500)', async () => {
  const r = await (await asUser(failing('SCHEMA_OUTDATED')))('GET', '/');
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'SCHEMA_OUTDATED');
});
test('database unreachable -> 503 DB_UNAVAILABLE on every operation', async () => {
  const call = await asUser(failing('DB_UNAVAILABLE'));
  const id = '22222222-2222-4222-8222-222222222222';
  for (const [m, p, b] of [['GET', '/'], ['POST', '/', sample()], ['GET', '/' + id], ['PUT', '/' + id, { ...sample(), baseVersion: 1 }], ['PATCH', '/' + id, { name: 'x' }], ['DELETE', '/' + id]]) {
    const r = await call(m, p, b); assert.equal(r.status, 503, m + ' ' + p); assert.equal(r.body.error.code, 'DB_UNAVAILABLE');
  }
});
test('unexpected errors -> 500 without leaking internals', async () => {
  const r = await (await asUser(failing('WEIRD')))('GET', '/');
  assert.equal(r.status, 500); assert.ok(!JSON.stringify(r.body).includes('boom'));
});

// ---- real Postgres only ----
if (TEST_DB) {
  test('[postgres] data persists across a "restart" (pool closed and recreated)', async () => {
    process.env.DATABASE_URL = TEST_DB;
    const { pgStore } = require('../store'); const u = await pgUsers.create(`persist${Date.now()}@example.com`, 'x');
    const c = await pgStore.create(u.id, { name: 'Survives restart', type: 'cafe', desc: '', audience: '', style: 'Modern', pages: [], html: '<html></html>', mode: null, generatedAt: null, history: [] });
    await db.close();
    assert.equal((await pgStore.get(u.id, c.id)).name, 'Survives restart');
    await db.query('DELETE FROM projects WHERE user_id=$1', [u.id]); await db.query('DELETE FROM users WHERE id=$1', [u.id]);
  });
  test('[postgres] an unreachable database is reported as DB_UNAVAILABLE', async () => {
    await db.close();
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none'; process.env.DATABASE_SSL = 'false'; process.env.DB_CONNECT_TIMEOUT_MS = '1500';
    await assert.rejects(() => db.query('SELECT 1'), e => e.code === 'DB_UNAVAILABLE');
    await db.close(); process.env.DATABASE_URL = saved; delete process.env.DATABASE_SSL; delete process.env.DB_CONNECT_TIMEOUT_MS;
  });
  test.after(async () => { await db.close(); });
}
