// Social sign-in: start / callback behaviour, security rules and "no secret ever leaks", with a fake provider (no network, no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createOAuthApi, providerConfig, publicOrigin, appleClientSecret, describeSetup, STATE_TTL_MS } = require('../oauth');
const { createAuthApi } = require('../auth');
const { makeOriginPolicy } = require('../security');
const { memoryUsers } = require('../users');
const { listMigrations, pendingMigrations, applyMigrations, OPTIONAL_MIGRATIONS } = require('../migrate');
const { sessionAdapter } = require('../web');

const BASE = 'https://preview.example.test';
const SECRETS = { google: 'g-secret-DO-NOT-LEAK', github: 'gh-secret-DO-NOT-LEAK' };
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const APPLE_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const ENV = {
  PUBLIC_BASE_URL: BASE,
  GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: SECRETS.google,
  GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: SECRETS.github,
  APPLE_CLIENT_ID: 'com.example.web', APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: APPLE_PEM.replace(/\n/g, '\\n')
};
const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const jwt = claims => b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u(claims) + '.' + b64u('sig');

function fakeSession() {
  const data = {}; const s = { userId: null, started: 0 };
  Object.assign(s, {
    async stash(k, v) { data[k] = JSON.parse(JSON.stringify(v)); },
    async take(k) { const v = data[k]; delete data[k]; return v === undefined ? null : v; },
    async start(id) { s.userId = id; s.started++; for (const k of Object.keys(data)) delete data[k]; return { csrf: 'c' }; },
    _data: data
  });
  return s;
}
// A tiny stand-in for Google / GitHub / Apple. It enforces PKCE for real and records every request.
function fakeProviders(world = {}) {
  const log = [];
  const fetch = async (url, init = {}) => {
    const u = String(url); const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    log.push({ url: u, init, body });
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (u === 'https://oauth2.googleapis.com/token' || u === 'https://appleid.apple.com/auth/token') {
      const apple = u.includes('apple');
      const cfg = apple ? world.apple : world.google;
      if (!cfg) return json({ error: 'invalid_grant' }, 400);
      if (!apple) {
        const want = world.challenge; const got = crypto.createHash('sha256').update(String(body.code_verifier)).digest('base64url');
        if (want !== got) return json({ error: 'invalid_grant' }, 400);       // PKCE verifier must match the challenge
        if (body.client_secret !== SECRETS.google) return json({ error: 'invalid_client' }, 401);
      }
      const now = Math.floor((world.now || Date.now()) / 1000);
      return json({ id_token: jwt({ iss: apple ? 'https://appleid.apple.com' : 'https://accounts.google.com', aud: apple ? 'com.example.web' : 'g-id', exp: now + 3600, iat: now, nonce: world.nonce, ...cfg }) });
    }
    if (u === 'https://github.com/login/oauth/access_token') {
      const want = world.challenge; const got = crypto.createHash('sha256').update(String(body.code_verifier)).digest('base64url');
      if (want !== got || body.client_secret !== SECRETS.github) return json({ error: 'bad_verification_code' });
      return json({ access_token: 'gho_ACCESS_TOKEN_DO_NOT_LEAK', token_type: 'bearer' });
    }
    if (u === 'https://api.github.com/user') return json(world.githubUser || { id: 4242, login: 'octo' });
    if (u === 'https://api.github.com/user/emails') return json(world.githubEmails || []);
    return json({ error: 'unexpected url ' + u }, 500);
  };
  return { fetch, log };
}
function setup({ env = ENV, world = {}, users = memoryUsers(), ready = true, clock = { t: 1_800_000_000_000 } } = {}) {
  const prov = fakeProviders(world);
  const u = ready ? users : Object.assign(users, { oauthReady: async () => false });
  const api = createOAuthApi({ users: u, env, fetch: prov.fetch, now: () => clock.t });
  const session = fakeSession();
  const ctx = { session, selfOrigin: 'http://ignored.local', ip: '198.51.100.' + Math.floor(Math.random() * 200) };
  world.now = clock.t;
  // Runs start(), reads what the browser would be sent to, and returns the parameters a provider would echo back.
  async function begin(provider) {
    const r = await api.start({ provider, ...ctx });
    const url = r.redirect && r.redirect.startsWith('http') ? new URL(r.redirect) : null;
    if (url) { world.nonce = url.searchParams.get('nonce'); world.challenge = url.searchParams.get('code_challenge'); }
    return { r, url, state: url && url.searchParams.get('state') };
  }
  return { api, session, ctx, users: u, prov, world, clock, begin };
}
const withLog = async fn => { const lines = []; const orig = console.error; console.error = (...a) => lines.push(a.join(' ')); try { return [await fn(), lines]; } finally { console.error = orig; } };
const loginError = r => new URL(r.redirect, 'http://x').hash;

// ---------------------------------------------------------------- configuration
test('a provider is configured only when ALL its variables are present (Apple also needs a valid EC key)', () => {
  assert.equal(providerConfig('google', {}), null);
  assert.equal(providerConfig('google', { GOOGLE_CLIENT_ID: 'x' }), null);
  assert.ok(providerConfig('google', { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }));
  assert.equal(providerConfig('github', { GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: '  ' }), null);
  assert.ok(providerConfig('apple', ENV));
  assert.equal(providerConfig('apple', { ...ENV, APPLE_TEAM_ID: '' }), null);
  assert.equal(providerConfig('apple', { ...ENV, APPLE_PRIVATE_KEY: 'not a key' }), null);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(providerConfig('apple', { ...ENV, APPLE_PRIVATE_KEY: rsa }), null, 'an RSA key is not an Apple key');
  assert.equal(providerConfig('twitter', ENV), null);
});
test('callback origin comes from the environment first (PUBLIC_BASE_URL, then RENDER_EXTERNAL_URL), then the request; paths are dropped', () => {
  assert.equal(publicOrigin({ PUBLIC_BASE_URL: 'https://a.test/some/path', RENDER_EXTERNAL_URL: 'https://b.test' }, 'http://c.test'), 'https://a.test');
  assert.equal(publicOrigin({ RENDER_EXTERNAL_URL: 'https://b.test' }, 'http://c.test'), 'https://b.test');
  assert.equal(publicOrigin({}, 'http://localhost:3000'), 'http://localhost:3000');
  assert.equal(publicOrigin({ PUBLIC_BASE_URL: 'javascript:alert(1)' }, ''), null);
});
test('providers(): not configured / waiting for the database upgrade / available, and nothing sensitive in the answer', async () => {
  let t = setup({ env: {} }); let p = await t.api.providers();
  assert.deepEqual(p.google, { available: false, reason: 'not_configured' });
  t = setup({ ready: false }); p = await t.api.providers();
  assert.deepEqual(p.github, { available: false, reason: 'needs_database_upgrade' });
  t = setup(); p = await t.api.providers();
  assert.deepEqual(p.apple, { available: true });
  const text = JSON.stringify(p);
  for (const s of [...Object.values(SECRETS), 'g-id', APPLE_PEM.slice(30, 60), 'TEAM123456']) assert.ok(!text.includes(s));
});
test('describeSetup lists missing variable NAMES and callback URLs, never values', () => {
  const r = describeSetup({ PUBLIC_BASE_URL: BASE, GOOGLE_CLIENT_ID: 'g-id', GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' });
  const g = r.find(x => x.provider === 'google'), a = r.find(x => x.provider === 'apple');
  assert.deepEqual(g.missing, ['GOOGLE_CLIENT_SECRET']); assert.equal(g.configured, false);
  assert.equal(a.callback, BASE + '/api/auth/oauth/apple/callback');
  assert.ok(!JSON.stringify(r).includes('"b"'));
});

// ---------------------------------------------------------------- start
test('start: unknown provider is 404; unconfigured or not-yet-upgraded providers never leave the site', async () => {
  const t = setup({ env: {} });
  assert.equal((await t.api.start({ provider: 'twitter', ...t.ctx })).status, 404);
  assert.equal(loginError(await t.api.start({ provider: 'google', ...t.ctx })), '#/login?oauth_error=not_configured');
  assert.deepEqual(t.session._data, {});
  const t2 = setup({ ready: false });
  assert.equal(loginError(await t2.api.start({ provider: 'google', ...t2.ctx })), '#/login?oauth_error=needs_upgrade');
});
test('start: Google URL carries response_type=code, exact redirect_uri, state, nonce, PKCE S256 and no secret; state is stored server-side', async () => {
  const t = setup(); const { url, state } = await t.begin('google');
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = url.searchParams;
  assert.equal(q.get('response_type'), 'code'); assert.equal(q.get('client_id'), 'g-id');
  assert.equal(q.get('redirect_uri'), BASE + '/api/auth/oauth/google/callback');
  assert.equal(q.get('scope'), 'openid email'); assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('nonce').length >= 16 && state.length >= 32 && q.get('code_challenge').length >= 43);
  assert.ok(!url.href.includes(SECRETS.google) && !/client_secret/.test(url.href));
  const saved = t.session._data.oauth;
  assert.equal(saved.state, state); assert.equal(saved.provider, 'google');
  assert.ok(!url.href.includes(saved.verifier), 'the PKCE verifier stays on the server');
});
test('start: GitHub asks only for user:email (no nonce); Apple uses form_post, a nonce and no PKCE', async () => {
  const t = setup();
  const gh = (await t.begin('github')).url.searchParams;
  assert.equal(gh.get('scope'), 'user:email'); assert.equal(gh.get('nonce'), null); assert.equal(gh.get('code_challenge_method'), 'S256');
  const ap = (await t.begin('apple')).url.searchParams;
  assert.equal(ap.get('response_mode'), 'form_post'); assert.equal(ap.get('scope'), 'email'); assert.ok(ap.get('nonce')); assert.equal(ap.get('code_challenge'), null);
  assert.equal(ap.get('redirect_uri'), BASE + '/api/auth/oauth/apple/callback');
});
test('start is rate limited per address', async () => {
  const t = setup(); let last;
  for (let i = 0; i < 45; i++) last = await t.api.start({ provider: 'google', ...t.ctx });
  assert.equal(loginError(last), '#/login?oauth_error=rate_limit');
});

// ---------------------------------------------------------------- callback: success paths
test('Google: a new verified email creates a PASSWORDLESS user, logs in, ends on the dashboard; PKCE verified by the provider', async () => {
  const t = setup(); t.world.google = { sub: 'g-sub-1', email: 'New.Person@Example.com', email_verified: true };
  const { state } = await t.begin('google');
  const r = await t.api.callback({ provider: 'google', params: { code: 'code1', state }, ...t.ctx });
  assert.equal(r.redirect, '/#/dashboard');
  const all = t.users._all(); assert.equal(all.length, 1);
  assert.equal(all[0].email, 'new.person@example.com'); assert.equal(all[0].passwordHash, null);
  assert.equal(t.session.userId, all[0].id); assert.equal(t.session.started, 1);
  const tokenCall = t.prov.log.find(l => l.url.includes('googleapis.com/token'));
  assert.equal(tokenCall.body.client_secret, SECRETS.google); assert.equal(tokenCall.body.redirect_uri, BASE + '/api/auth/oauth/google/callback');
});
test('a returning user is recognised by the provider id (no email needed, no duplicate account)', async () => {
  const t = setup(); t.world.google = { sub: 'g-sub-1', email: 'a@example.com', email_verified: true };
  let { state } = await t.begin('google'); await t.api.callback({ provider: 'google', params: { code: 'c', state }, ...t.ctx });
  const first = t.session.userId; t.session.userId = null;
  t.world.google = { sub: 'g-sub-1', email: 'changed@example.com', email_verified: false };   // even an unverified/changed email cannot matter now
  ({ state } = await t.begin('google'));
  const r = await t.api.callback({ provider: 'google', params: { code: 'c2', state }, ...t.ctx });
  assert.equal(r.redirect, '/#/dashboard'); assert.equal(t.session.userId, first); assert.equal(t.users._all().length, 1);
});
test('GitHub: the PRIMARY VERIFIED email is used and the numeric id is the identity; the access token is never exposed', async () => {
  const t = setup(); t.world.githubEmails = [{ email: 'other@x.com', primary: false, verified: true }, { email: 'Me@Example.com', primary: true, verified: true }];
  const { state } = await t.begin('github');
  const r = await t.api.callback({ provider: 'github', params: { code: 'ghc', state }, ...t.ctx });
  assert.equal(r.redirect, '/#/dashboard'); assert.equal(t.users._all()[0].email, 'me@example.com');
  assert.ok((await t.users.findByIdentity('github', '4242')));
  assert.ok(!JSON.stringify(r).includes('gho_ACCESS_TOKEN'));
  const apiCall = t.prov.log.find(l => l.url === 'https://api.github.com/user');
  assert.equal(apiCall.init.headers.Authorization, 'Bearer gho_ACCESS_TOKEN_DO_NOT_LEAK');
});
test('Apple: the callback uses the form fields, authenticates with a SIGNED client secret (never the raw key) and logs in', async () => {
  const t = setup(); t.world.apple = { sub: 'apple-sub-9', email: 'x@privaterelay.appleid.com', email_verified: 'true' };
  const { state } = await t.begin('apple');
  const r = await t.api.callback({ provider: 'apple', params: { code: 'ac', state, user: '{"name":{"firstName":"A"}}' }, ...t.ctx });
  assert.equal(r.redirect, '/#/dashboard');
  const call = t.prov.log.find(l => l.url === 'https://appleid.apple.com/auth/token');
  const [h, p, s] = call.body.client_secret.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, 'TEAM123456'); assert.equal(claims.sub, 'com.example.web'); assert.equal(claims.aud, 'https://appleid.apple.com');
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + p), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'signature verifies with the matching public key');
  assert.ok(!call.body.client_secret.includes('PRIVATE KEY'));
  assert.ok(appleClientSecret(providerConfig('apple', ENV), Date.now()).split('.').length === 3);
});

// ---------------------------------------------------------------- callback: refusals (each must create no user, no session, call no provider)
async function refused(t, provider, params, expectedCode) {
  const calls = t.prov.log.length, users = t.users._all().length;
  const r = await t.api.callback({ provider, params, ...t.ctx });
  assert.equal(loginError(r), '#/login?oauth_error=' + expectedCode, JSON.stringify(params));
  assert.equal(t.session.userId, null); assert.equal(t.users._all().length, users);
  return t.prov.log.length - calls;     // number of provider calls made
}
test('state is required, must match, is bound to the provider, expires after 10 minutes, and is single use', async () => {
  const t = setup(); t.world.google = { sub: 's', email: 'a@example.com', email_verified: true };
  let { state } = await t.begin('google');
  assert.equal(await refused(t, 'google', { code: 'c' }, 'state'), 0);                                   // missing (also consumed the saved state)
  ({ state } = await t.begin('google'));
  assert.equal(await refused(t, 'google', { code: 'c', state: state + 'x' }, 'state'), 0);               // wrong
  ({ state } = await t.begin('google'));
  assert.equal(await refused(t, 'github', { code: 'c', state }, 'state'), 0);                            // started for google, returned to github
  ({ state } = await t.begin('google'));
  t.clock.t += STATE_TTL_MS + 1000;
  assert.equal(await refused(t, 'google', { code: 'c', state }, 'state'), 0);                            // expired
  t.clock.t -= STATE_TTL_MS + 1000;
  ({ state } = await t.begin('google'));
  const ok = await t.api.callback({ provider: 'google', params: { code: 'c', state }, ...t.ctx });
  assert.equal(ok.redirect, '/#/dashboard');
  t.session.userId = null;
  assert.equal(await refused(t, 'google', { code: 'c', state }, 'state'), 0);                            // replay of the same callback
});
test('a callback with no flow started in this browser session is refused (login CSRF)', async () => {
  const t = setup();
  assert.equal(await refused(t, 'google', { code: 'attacker-code', state: 'attacker-state' }, 'state'), 0);
});
test('provider errors: user cancelling is reported as cancelled, anything else as provider_error; no provider call is made', async () => {
  const t = setup(); await t.begin('google');
  assert.equal(await refused(t, 'google', { error: 'access_denied', state: 'x' }, 'cancelled'), 0);
  await t.begin('apple');
  assert.equal(await refused(t, 'apple', { error: 'user_cancelled_authorize' }, 'cancelled'), 0);
  await t.begin('github');
  assert.equal(await refused(t, 'github', { error: 'server_error' }, 'provider_error'), 0);
});
test('ID token checks: wrong audience, wrong issuer, expired, wrong nonce, unverified email are all refused', async () => {
  const cases = [
    [{ aud: 'someone-else' }, 'provider_error'],
    [{ iss: 'https://evil.example' }, 'provider_error'],
    [{ exp: 1 }, 'provider_error'],
    [{ email_verified: false }, 'no_verified_email'],
    [{ email_verified: 'false' }, 'no_verified_email'],
    [{ email: undefined }, 'no_verified_email'],
    [{ sub: '' }, 'provider_error']
  ];
  for (const [override, code] of cases) {
    const t = setup(); t.world.google = { sub: 's', email: 'a@example.com', email_verified: true, ...override };
    const { state } = await t.begin('google');
    await refused(t, 'google', { code: 'c', state }, code);
  }
  const t = setup(); t.world.google = { sub: 's', email: 'a@example.com', email_verified: true };
  const { state } = await t.begin('google'); t.world.nonce = 'a-different-nonce';
  await refused(t, 'google', { code: 'c', state }, 'state');
});
test('a wrong PKCE verifier or client secret makes the provider refuse; we show provider_error and create nothing', async () => {
  const t = setup(); t.world.google = { sub: 's', email: 'a@example.com', email_verified: true };
  const { state } = await t.begin('google'); t.world.challenge = 'tampered';
  await refused(t, 'google', { code: 'c', state }, 'provider_error');
});
test('GitHub with no verified primary email is refused', async () => {
  const t = setup(); t.world.githubEmails = [{ email: 'a@x.com', primary: true, verified: false }];
  const { state } = await t.begin('github');
  await refused(t, 'github', { code: 'c', state }, 'no_verified_email');
});
test('an existing account with the same email is NEVER merged or logged into; the existing account is untouched', async () => {
  const users = memoryUsers(); const owner = await users.create('victim@example.com', 'argon2-hash-of-victims-password');
  const t = setup({ users }); t.world.google = { sub: 'attacker-sub', email: 'victim@example.com', email_verified: true };
  const { state } = await t.begin('google');
  await refused(t, 'google', { code: 'c', state }, 'account_exists');
  assert.equal((await users.findByEmail('victim@example.com')).passwordHash, 'argon2-hash-of-victims-password');
  assert.equal(await users.findByIdentity('google', 'attacker-sub'), null, 'no identity was linked');
  assert.equal(owner.id, (await users.findByEmail('victim@example.com')).id);
});
test('social sign-in is refused (before any provider call) until the database upgrade is applied', async () => {
  const t = setup({ ready: false }); await t.session.stash('oauth', { provider: 'google', state: 's', verifier: 'v', nonce: 'n', at: t.clock.t });
  assert.equal(await refused(t, 'google', { code: 'c', state: 's' }, 'needs_upgrade'), 0);
});

// ---------------------------------------------------------------- password accounts and social accounts coexist safely
test('a social-only account cannot be entered with a password (and does not crash the hasher); the email cannot be registered again', async () => {
  const users = memoryUsers(); await users.createSocial('social@example.com', 'google', 'sub-1');
  const hasher = { hash: async p => 'h:' + p, verify: async (h, p) => { assert.equal(typeof h, 'string', 'verify must never receive a missing hash'); return h === 'h:' + p; } };
  const handle = createAuthApi({ users, hasher }, { originPolicy: makeOriginPolicy({ origins: [], allowLocalhost: false }) });
  const base = { ip: '203.0.113.5', headers: { origin: BASE }, selfOrigin: BASE, session: { read: async () => null, start: async () => ({ csrf: 'c' }), end: async () => {} } };
  for (const password of ['', 'anything-at-all', 'h:']) {
    const r = await handle({ ...base, method: 'POST', path: '/login', body: { email: 'social@example.com', password } });
    assert.equal(r.status, 401); assert.equal(r.body.error.code, 'INVALID_CREDENTIALS');
  }
  const reg = await handle({ ...base, method: 'POST', path: '/register', body: { email: 'social@example.com', password: 'a-long-enough-password' } });
  assert.equal(reg.status, 409);
});
test('existing password logins still work exactly as before', async () => {
  const users = memoryUsers(); await users.create('pw@example.com', 'h:correct-horse-battery');
  const hasher = { hash: async p => 'h:' + p, verify: async (h, p) => h === 'h:' + p };
  const handle = createAuthApi({ users, hasher }, { originPolicy: makeOriginPolicy({ origins: [], allowLocalhost: false }) });
  const base = { ip: '203.0.113.6', headers: { origin: BASE }, selfOrigin: BASE, session: { read: async () => null, start: async () => ({ csrf: 'c' }), end: async () => {} } };
  assert.equal((await handle({ ...base, method: 'POST', path: '/login', body: { email: 'pw@example.com', password: 'correct-horse-battery' } })).status, 200);
  assert.equal((await handle({ ...base, method: 'POST', path: '/login', body: { email: 'pw@example.com', password: 'wrong-password-here' } })).status, 401);
});

// ---------------------------------------------------------------- nothing sensitive leaks anywhere
test('no secret, token, code or private key appears in any redirect, response or log line, in success or failure', async () => {
  const sensitive = [...Object.values(SECRETS), 'gho_ACCESS_TOKEN_DO_NOT_LEAK', 'BEGIN PRIVATE KEY', APPLE_PEM.split('\n')[1], 'the-auth-code-123'];
  const scenarios = [
    async () => { const t = setup(); t.world.google = { sub: 's', email: 'a@example.com', email_verified: true }; const { r, state } = await t.begin('google'); return [r, await t.api.callback({ provider: 'google', params: { code: 'the-auth-code-123', state }, ...t.ctx })]; },
    async () => { const t = setup(); t.world.google = { sub: 's', email: 'a@example.com', email_verified: false }; const { r, state } = await t.begin('google'); return [r, await t.api.callback({ provider: 'google', params: { code: 'the-auth-code-123', state }, ...t.ctx })]; },
    async () => { const t = setup(); t.world.githubEmails = []; const { r, state } = await t.begin('github'); return [r, await t.api.callback({ provider: 'github', params: { code: 'the-auth-code-123', state }, ...t.ctx })]; },
    async () => { const t = setup(); const { r, state } = await t.begin('apple'); return [r, await t.api.callback({ provider: 'apple', params: { code: 'the-auth-code-123', state }, ...t.ctx })]; },
    async () => { const t = setup(); t.prov.fetch = null; const bad = createOAuthApi({ users: t.users, env: ENV, fetch: async () => { throw Object.assign(new Error('connect ECONNREFUSED https://oauth2.googleapis.com/token?code=the-auth-code-123'), { cause: { code: 'ECONNREFUSED' } }); } }); const { state } = await t.begin('google'); return [await bad.callback({ provider: 'google', params: { code: 'the-auth-code-123', state }, ...t.ctx })]; }
  ];
  const [outs, logs] = await withLog(async () => { const all = []; for (const s of scenarios) all.push(...await s()); return all; });
  const text = JSON.stringify(outs) + logs.join('\n');
  for (const s of sensitive) assert.ok(!text.includes(s), 'leaked: ' + s.slice(0, 12));
  assert.ok(logs.length >= 1, 'failures are logged with a short code');
});
test('every redirect the module can return is a fixed in-app path or the provider URL (never taken from the request)', async () => {
  const t = setup(); t.world.google = { sub: 's', email: 'a@example.com', email_verified: true };
  const { state } = await t.begin('google');
  const evil = { code: 'c', state, redirect: 'https://evil.example', return_to: 'https://evil.example', next: '//evil.example' };
  const r = await t.api.callback({ provider: 'google', params: evil, ...t.ctx });
  assert.equal(r.redirect, '/#/dashboard');
  assert.ok(!/evil/.test(JSON.stringify(await t.api.callback({ provider: 'google', params: { ...evil, state: 'x' }, ...t.ctx }))));
});

// ---------------------------------------------------------------- migration 003 is optional, manual and safe
const fakeClientPool = () => { const sql = []; const client = { query: async t => { sql.push(String(t)); return { rows: [] }; }, release() {} }; return { connect: async () => client, query: client.query, sql }; };
test('migration 003 exists, is additive, and is OPTIONAL: it never counts as pending for the startup check', async () => {
  assert.ok(listMigrations().includes('003_oauth.sql')); assert.ok(OPTIONAL_MIGRATIONS.has('003_oauth.sql'));
  const pool = { query: async () => ({ rows: [{ name: '001_projects.sql' }, { name: '002_auth.sql' }] }) };
  assert.deepEqual(await pendingMigrations(pool), [], '003 must not make the server report "migrations pending"');
  assert.deepEqual(await pendingMigrations(pool, { includeOptional: true }), ['003_oauth.sql']);
  assert.deepEqual(await pendingMigrations({ query: async () => ({ rows: [] }) }), ['001_projects.sql', '002_auth.sql']);
});
test('applyMigrations (used by `npm run migrate -- --apply` AND the AUTO_MIGRATE dev path) never runs 003 unless explicitly asked', async () => {
  const plain = fakeClientPool(); const done = await applyMigrations(plain);
  assert.deepEqual(done, ['001_projects.sql', '002_auth.sql']);
  assert.ok(!plain.sql.some(t => /oauth_identities/.test(t)), 'default apply must not touch the OAuth tables');
  const withOpt = fakeClientPool(); const all = await applyMigrations(withOpt, () => {}, { includeOptional: true });
  assert.deepEqual(all, ['001_projects.sql', '002_auth.sql', '003_oauth.sql']);
  assert.ok(withOpt.sql.some(t => /CREATE TABLE IF NOT EXISTS oauth_identities/.test(t)));
});
test('migration 003 SQL is additive: no row is deleted or rewritten, nothing is dropped', () => {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'migrations', '003_oauth.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.ok(!/(?<!ON\s+)\b(DELETE|TRUNCATE|UPDATE|DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|CONSTRAINT)|ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN)\b/i.test(sql));
  assert.match(sql, /ALTER COLUMN password_hash DROP NOT NULL/); assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_identities/);
});
test('memory user store: createSocial is idempotent per identity and refuses an email that already exists', async () => {
  const u = memoryUsers();
  const a = await u.createSocial('a@example.com', 'github', '1'); const again = await u.createSocial('a@example.com', 'github', '1');
  assert.equal(a.id, again.id);
  await assert.rejects(() => u.createSocial('a@example.com', 'google', '2'), { code: 'EMAIL_TAKEN' });
});

// ---------------------------------------------------------------- the REAL session adapter (web.js), not the fake one
test('session adapter: the OAuth state is saved to the session, can be taken exactly once, and is gone afterwards', async () => {
  let saves = 0; const req = { session: { save: cb => { saves++; cb(null); } } };
  const a = sessionAdapter(req);
  assert.equal(await a.take('oauth'), null);
  await a.stash('oauth', { state: 's1' });
  assert.deepEqual(req.session.oauth, { state: 's1' }); assert.equal(saves, 1);
  assert.deepEqual(await a.take('oauth'), { state: 's1' });
  assert.equal(req.session.oauth, undefined, 'removed from the session itself');
  assert.equal(await a.take('oauth'), null, 'second take finds nothing');
  assert.ok(saves >= 2, 'the removal is persisted, not just held in memory');
});
test('the explicit "email already exists" rule holds even if the store would have allowed a second account', async () => {
  const users = memoryUsers(); await users.create('victim@example.com', 'hash');
  let created = 0; const lenient = Object.assign(Object.create(users), { createSocial: async () => { created++; return { id: 'x', email: 'victim@example.com' }; } });
  const t = setup({ users: lenient }); t.world.google = { sub: 'z', email: 'victim@example.com', email_verified: true };
  const { state } = await t.begin('google');
  await refused(t, 'google', { code: 'c', state }, 'account_exists');
  assert.equal(created, 0);
});
