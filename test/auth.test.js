// Registration, login, logout, sessions, CSRF/Origin, rate limiting, legacy claiming (framework-free, in-memory).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createAuthApi, normalizeEmail, validatePassword } = require('../auth');
const { createApi } = require('../api');
const { memoryUsers } = require('../users');
const { memoryStore } = require('../store');
const { ORIGIN, originPolicy, fakeHasher, sessionJar, req } = require('./_helpers');

const PW = 'correct horse battery';
function setup(opts = {}) {
  const users = memoryUsers(), store = memoryStore(), hasher = fakeHasher(), jar = sessionJar();
  const auth = createAuthApi({ users, hasher, getStore: () => store }, { originPolicy, ...opts });
  const projects = createApi(store, { originPolicy });
  const browser = () => ({ sid: null });
  const post = (c, path, body, extra) => auth(req(jar, c, 'POST', path, body, extra));
  const get = (c, path) => auth(req(jar, c, 'GET', path));
  const csrfOf = c => (jar.table.get(c.sid) || {}).csrf;
  return { users, store, hasher, jar, auth, projects, browser, post, get, csrfOf };
}

test('normalizeEmail: trims, lowercases, rejects malformed input', () => {
  assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
  for (const bad of ['', 'a', 'no-at.com', 'a@b', 'a b@c.com', 'a@@c.com', '<x>@c.com', 'a@c.com,b@c.com', 123, null, undefined, 'x'.repeat(250) + '@c.com', 'a'.repeat(65) + '@c.com']) assert.equal(normalizeEmail(bad), null, String(bad).slice(0, 20));
});
test('validatePassword: length limits and not-your-email rule', () => {
  assert.equal(validatePassword(PW, 'a@b.co'), null);
  assert.ok(validatePassword('short', 'a@b.co')); assert.ok(validatePassword('x'.repeat(129), 'a@b.co')); assert.ok(validatePassword(undefined, 'a@b.co'));
  assert.ok(validatePassword('alice@example.com', 'alice@example.com')); assert.ok(validatePassword('aliceperson', 'aliceperson@example.com'));
});

test('registration succeeds, signs the user in, and never stores or returns the password or hash', async () => {
  const t = setup(); const c = t.browser();
  const r = await t.post(c, '/register', { email: ' New@Example.com ', password: PW });
  assert.equal(r.status, 201); assert.equal(r.body.user.email, 'new@example.com');
  assert.ok(typeof r.body.csrf === 'string' && r.body.csrf.length >= 16);
  const stored = t.users._all()[0];
  assert.notEqual(stored.passwordHash, PW); assert.ok(!stored.passwordHash.includes(PW));
  const blob = JSON.stringify(r.body);
  assert.ok(!blob.includes(PW) && !blob.includes(stored.passwordHash) && !/password|hash/i.test(blob), 'response must not expose secrets');
  assert.equal((await t.get(c, '/me')).body.user.email, 'new@example.com');
});

test('registration rejects invalid email/password and creates nothing', async () => {
  const t = setup(); const c = t.browser();
  for (const body of [{ email: 'nope', password: PW }, { email: 'a@b.co', password: 'short' }, { email: 'a@b.co' }, {}, { email: ['a@b.co'], password: PW }, { email: 'a@b.co', password: { $ne: 1 } }]) {
    assert.equal((await t.post(c, '/register', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(t.users._all().length, 0); assert.equal(c.sid, null, 'no session without an account');
});

test('duplicate registration is refused (even with different letter case) and does not log in or overwrite', async () => {
  const t = setup();
  await t.post(t.browser(), '/register', { email: 'dup@example.com', password: PW });
  const c2 = t.browser();
  const r = await t.post(c2, '/register', { email: 'DUP@Example.com', password: 'another long password' });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'EMAIL_TAKEN');
  assert.equal(t.users._all().length, 1); assert.equal(c2.sid, null);
  assert.equal((await t.post(t.browser(), '/login', { email: 'dup@example.com', password: PW })).status, 200, 'original password still works');
});

test('login succeeds (case-insensitive email) and starts a NEW session id each time (no fixation)', async () => {
  const t = setup(); await t.post(t.browser(), '/register', { email: 'a@example.com', password: PW });
  const c = t.browser(); c.sid = 'attacker-chosen-or-old-sid';
  t.jar.table.set(c.sid, { userId: 'whoever', csrf: 'x' });
  const r = await t.post(c, '/login', { email: 'A@EXAMPLE.com', password: PW });
  assert.equal(r.status, 200);
  assert.notEqual(c.sid, 'attacker-chosen-or-old-sid'); assert.equal(t.jar.table.has('attacker-chosen-or-old-sid'), false, 'old session destroyed');
  const first = c.sid; await t.post(c, '/login', { email: 'a@example.com', password: PW });
  assert.notEqual(c.sid, first);
});

test('wrong password and unknown email give the same generic error and the same hashing work', async () => {
  const t = setup(); await t.post(t.browser(), '/register', { email: 'a@example.com', password: PW });
  const before = t.hasher.verifyCalls;
  const wrong = await t.post(t.browser(), '/login', { email: 'a@example.com', password: 'wrong password here' });
  const unknown = await t.post(t.browser(), '/login', { email: 'ghost@example.com', password: 'wrong password here' });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body); assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(t.hasher.verifyCalls - before, 2, 'the unknown email still performs a hash verification (timing parity)');
  for (const body of [{}, { email: 'a@example.com' }, { email: 'a@example.com', password: 'x'.repeat(500) }, { email: null, password: null }]) assert.equal((await t.post(t.browser(), '/login', body)).status, 401);
});

test('logout needs a CSRF token, then destroys the session; old session ids stop working', async () => {
  const t = setup(); const c = t.browser();
  await t.post(c, '/register', { email: 'a@example.com', password: PW });
  const sid = c.sid, csrf = t.csrfOf(c);
  assert.equal((await t.post(c, '/logout', {}, { csrf: 'wrong' })).status, 403);
  assert.ok(t.jar.table.has(sid), 'a forged logout does nothing');
  const out = await t.post(c, '/logout', {}, { csrf });
  assert.equal(out.status, 200); assert.equal(out.clearSession, true);
  assert.equal(t.jar.table.has(sid), false);
  const stolen = { sid };                                   // someone replaying the old cookie
  assert.equal((await t.get(stolen, '/me')).body.user, null);
  assert.equal((await t.projects(req(t.jar, stolen, 'GET', '/'))).status, 401);
  assert.equal((await t.post(t.browser(), '/logout', {})).status, 200, 'logging out when logged out is harmless');
});

test('/me: logged-out -> user null; expired session -> user null; deleted user -> session is ended', async () => {
  const t = setup(); const c = t.browser();
  assert.deepEqual((await t.get(c, '/me')).body, { user: null, csrf: null });
  const reg = await t.post(c, '/register', { email: 'a@example.com', password: PW });
  assert.equal((await t.get(c, '/me')).body.csrf, reg.body.csrf);
  t.jar.table.get(c.sid).expired = true;
  assert.equal((await t.get(c, '/me')).body.user, null);
  const c2 = t.browser(); await t.post(c2, '/login', { email: 'a@example.com', password: PW });
  t.users._remove(t.users._all()[0].id);
  const gone = await t.get(c2, '/me');
  assert.equal(gone.body.user, null); assert.equal(gone.clearSession, true);
});

test('Origin protection: login/register/logout from an unlisted or missing Origin are refused', async () => {
  const t = setup();
  for (const origin of ['https://evil.example', null, 'null', 'http://pixelated-byte.github.io', ORIGIN + '.evil.example']) {
    const r = await t.post(t.browser(), '/register', { email: 'x@example.com', password: PW }, { origin });
    assert.equal(r.status, 403, String(origin)); assert.equal(r.body.error.code, 'BAD_ORIGIN');
  }
  assert.equal(t.users._all().length, 0);
  assert.equal((await t.post(t.browser(), '/register', { email: 'x@example.com', password: PW }, { origin: 'https://api.example' })).status, 201, 'same-origin hosting works');
});

test('login brute force is rate limited per account+IP and per IP; a success resets the account counter', async () => {
  const t = setup({ loginFailsPerPair: 3, loginFailsPerIp: 6 });
  await t.post(t.browser(), '/register', { email: 'a@example.com', password: PW });
  for (let i = 0; i < 3; i++) assert.equal((await t.post(t.browser(), '/login', { email: 'a@example.com', password: 'bad password ' + i })).status, 401);
  const blocked = await t.post(t.browser(), '/login', { email: 'a@example.com', password: PW });
  assert.equal(blocked.status, 429, 'even the right password is refused while blocked');
  const other = await t.post(t.browser(), '/login', { email: 'a@example.com', password: PW }, { ip: '8.8.8.8' });
  assert.equal(other.status, 200, 'another IP is not locked out (an attacker cannot lock out the owner)');
  const t2 = setup({ loginFailsPerPair: 2, loginFailsPerIp: 100 });
  await t2.post(t2.browser(), '/register', { email: 'b@example.com', password: PW });
  await t2.post(t2.browser(), '/login', { email: 'b@example.com', password: 'bad password one' });
  assert.equal((await t2.post(t2.browser(), '/login', { email: 'b@example.com', password: PW })).status, 200);
  await t2.post(t2.browser(), '/login', { email: 'b@example.com', password: 'bad password two' });
  assert.equal((await t2.post(t2.browser(), '/login', { email: 'b@example.com', password: PW })).status, 200, 'counter was reset by the success');
  const t3 = setup({ loginFailsPerPair: 100, loginFailsPerIp: 3 });
  for (let i = 0; i < 3; i++) await t3.post(t3.browser(), '/login', { email: `x${i}@example.com`, password: 'bad password ' + i });
  assert.equal((await t3.post(t3.browser(), '/login', { email: 'y@example.com', password: 'bad password' })).status, 429, 'spraying many emails from one IP is limited');
});

test('registration is rate limited per IP', async () => {
  const t = setup({ registerPerHour: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await t.post(t.browser(), '/register', { email: `u${i}@example.com`, password: PW })).status, 201);
  assert.equal((await t.post(t.browser(), '/register', { email: 'u9@example.com', password: PW })).status, 429);
  assert.equal(t.users._all().length, 3);
});

test('a project API call after login works, and a forged CSRF token is refused', async () => {
  const t = setup(); const c = t.browser();
  const r = await t.post(c, '/register', { email: 'a@example.com', password: PW });
  const body = { name: 'P', type: 'cafe', desc: '', audience: '', style: 'Modern', pages: [], html: '', mode: null, generatedAt: null, history: [] };
  assert.equal((await t.projects(req(t.jar, c, 'POST', '/', body, { csrf: r.body.csrf }))).status, 201);
  assert.equal((await t.projects(req(t.jar, c, 'POST', '/', body, { csrf: crypto.randomBytes(16).toString('hex') }))).status, 403);
  const other = t.browser(); const r2 = await t.post(other, '/register', { email: 'b@example.com', password: PW });
  assert.equal((await t.projects(req(t.jar, c, 'POST', '/', body, { csrf: r2.body.csrf }))).status, 403, "another user's CSRF token is not valid for this session");
});

test('legacy claim: the right token moves pre-accounts projects to the caller, once, and nobody else gets them', async () => {
  const t = setup();
  const token = crypto.randomBytes(32).toString('base64url');                    // the old anonymous token in a browser
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const proj = n => ({ name: n, type: 'cafe', desc: '', audience: '', style: 'Modern', pages: [], html: '<html></html>', mode: null, generatedAt: null, history: [] });
  t.store._seedLegacy(hash, proj('Old one'), 'p1'); t.store._seedLegacy(hash, proj('Old two'), 'p2'); t.store._seedLegacy('someone-elses-hash', proj('Not mine'));
  const a = t.browser(), b = t.browser();
  const ra = await t.post(a, '/register', { email: 'founder@example.com', password: PW });
  const rb = await t.post(b, '/register', { email: 'stranger@example.com', password: PW });
  assert.equal((await t.post(a, '/legacy/preview', { token }, { csrf: ra.body.csrf })).body.count, 2);
  assert.equal((await t.post(a, '/legacy/preview', { token: crypto.randomBytes(32).toString('base64url') }, { csrf: ra.body.csrf })).body.count, 0, 'a wrong token reveals nothing');
  assert.equal((await t.post(a, '/legacy/preview', { token }, { csrf: 'bad' })).status, 403);
  assert.equal((await t.post(t.browser(), '/legacy/claim', { token })).status, 401, 'must be logged in');
  assert.equal((await t.post(a, '/legacy/claim', { token: 'short' }, { csrf: ra.body.csrf })).status, 400);
  assert.equal((await t.store.list(rb.body.user.id)).length, 0, 'registering does not expose legacy projects');
  const claim = await t.post(a, '/legacy/claim', { token }, { csrf: ra.body.csrf });
  assert.equal(claim.body.claimed, 2);
  assert.deepEqual((await t.store.list(ra.body.user.id)).map(p => p.name).sort(), ['Old one', 'Old two']);
  assert.equal((await t.post(b, '/legacy/claim', { token }, { csrf: rb.body.csrf })).body.claimed, 0, 'a second account cannot claim what is already owned');
  assert.equal((await t.store.list(rb.body.user.id)).length, 0);
  assert.equal((await t.post(a, '/legacy/claim', { token }, { csrf: ra.body.csrf })).body.claimed, 0, 'repeat is a no-op');
  assert.equal((await t.store.listUnowned()).length, 1, 'the unrelated legacy project is still untouched and unowned');
});

test('legacy claim: two accounts racing with the same token produce exactly one owner', async () => {
  const t = setup(); const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  t.store._seedLegacy(hash, { name: 'X', type: 'cafe', desc: '', audience: '', style: 'Modern', pages: [], html: '', mode: null, generatedAt: null, history: [] });
  const a = t.browser(), b = t.browser();
  const ra = await t.post(a, '/register', { email: 'a@example.com', password: PW }), rb = await t.post(b, '/register', { email: 'b@example.com', password: PW });
  const [x, y] = await Promise.all([t.post(a, '/legacy/claim', { token }, { csrf: ra.body.csrf }), t.post(b, '/legacy/claim', { token }, { csrf: rb.body.csrf })]);
  assert.equal(x.body.claimed + y.body.claimed, 1);
  assert.equal((await t.store.list(ra.body.user.id)).length + (await t.store.list(rb.body.user.id)).length, 1);
});

test('database failures during auth are safe 503s, not leaks', async () => {
  const jar = sessionJar(); const c = { sid: null };
  const boom = code => async () => { const e = new Error('secret internal detail'); e.code = code; throw e; };
  const auth = createAuthApi({ users: { findByEmail: boom('DB_UNAVAILABLE'), create: boom('DB_UNAVAILABLE'), findById: boom('DB_UNAVAILABLE') }, hasher: fakeHasher(), getStore: () => ({}) }, { originPolicy });
  const r = await auth(req(jar, c, 'POST', '/login', { email: 'a@example.com', password: PW }));
  assert.equal(r.status, 503); assert.ok(!JSON.stringify(r.body).includes('secret internal detail'));
  const r2 = await auth(req(jar, c, 'POST', '/register', { email: 'a@example.com', password: PW }));
  assert.equal(r2.status, 503);
  const weird = createAuthApi({ users: { findByEmail: boom('WEIRD') }, hasher: fakeHasher(), getStore: () => ({}) }, { originPolicy });
  const r3 = await weird(req(jar, c, 'POST', '/login', { email: 'a@example.com', password: PW }));
  assert.equal(r3.status, 500); assert.ok(!JSON.stringify(r3.body).includes('secret internal detail'));
});
