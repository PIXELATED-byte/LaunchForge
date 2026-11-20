// Social sign-in: start / callback behaviour, security rules and "no secret ever leaks", with a fake provider (no network, no database).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createOAuthApi, providerConfig, publicOrigin, appleClientSecret, describeSetup, JWKS_URLS, STATE_TTL_MS } = require('../oauth');
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
// Offline guarantee: if anything tried to reach a real network (for example jose downloading Google's or Apple's keys) the test would fail loudly.
globalThis.fetch = () => { throw new Error('network access is not allowed in tests'); };

const seg = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

// ---- Genuine, locally signed ID tokens. Nothing here touches the network.
// Keys are made with Node's crypto (an oracle independent of jose) and tokens are signed by hand. The code under test verifies them with the REAL jose;
// only its key LOOKUP is replaced by a local key set (see testJose). jose v6 is ESM-only, so it is imported lazily, exactly as oauth.js does.
let J = null, KEYS = null;
async function ensureCrypto() {
  if (J) return;
  const mod = await import('jose');
  const rsa = (alg, kid) => { const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' } }; };
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  KEYS = {
    google: rsa('RS256', 'google-key-1'), google2: rsa('RS256', 'google-key-2'), apple: rsa('RS256', 'apple-key-1'),
    attacker: rsa('RS256', 'attacker-key'), rs384: rsa('RS384', 'rs384-key'),
    es256: { privateKey: p256.privateKey, jwk: { ...p256.publicKey.export({ format: 'jwk' }), kid: 'es256-key', alg: 'ES256', use: 'sig' } }
  };
  // What each provider "publishes": its own RS256 key(s) plus an RS384 and an ES256 key, so algorithm confusion has something to aim at.
  KEYS.published = { google: [KEYS.google.jwk, KEYS.google2.jwk, KEYS.rs384.jwk, KEYS.es256.jwk], apple: [KEYS.apple.jwk, KEYS.rs384.jwk, KEYS.es256.jwk] };
  J = mod;
}
// sign = { key, kid ('@trusted' = the provider's real key id), alg, header (extra/overriding header fields), mutate(token), raw, omit }
async function mintIdToken(provider, claims, sign = {}) {
  await ensureCrypto();
  if (sign.omit) return undefined;
  if (typeof sign.raw === 'string') return sign.raw;
  const entry = KEYS[sign.key || provider], alg = sign.alg || 'RS256';
  const kid = sign.kid === '@trusted' ? KEYS[provider].jwk.kid : sign.kid !== undefined ? sign.kid : entry.jwk.kid;
  const input = seg({ alg, typ: 'JWT', kid, ...sign.header }) + '.' + seg(claims);
  if (alg === 'none') return input + '.';
  let sig;
  if (alg === 'HS256') sig = crypto.createHmac('sha256', 'x'.repeat(32)).update(input).digest();
  else if (alg === 'ES256') sig = crypto.sign('sha256', Buffer.from(input), { key: entry.privateKey, dsaEncoding: 'ieee-p1363' });
  else sig = crypto.sign(alg === 'RS384' ? 'sha384' : 'sha256', Buffer.from(input), entry.privateKey);
  const token = input + '.' + sig.toString('base64url');
  return sign.mutate ? sign.mutate(token) : token;
}
const flipSignature = t => { const [h, p, s] = t.split('.'); return [h, p, s.slice(0, 10) + (s[10] === 'A' ? 'B' : 'A') + s.slice(11)].join('.'); };
const swapPayload = patch => t => { const [h, p, s] = t.split('.'); return [h, seg({ ...JSON.parse(Buffer.from(p, 'base64url')), ...patch }), s].join('.'); };
// The real jose, with exactly one difference: createRemoteJWKSet never goes to the network. It records the address it was given, refuses any
// address other than the two fixed ones, and answers from the local key sets above. rec.verifies keeps the options oauth.js passes to jwtVerify.
function testJose(world, rec) {
  return {
    decodeProtectedHeader: token => J.decodeProtectedHeader(token),
    jwtVerify: (token, key, options) => { rec.verifies.push(options); return J.jwtVerify(token, key, options); },
    createRemoteJWKSet: (url, options) => {
      const href = String(url), which = href === JWKS_URLS.google ? 'google' : href === JWKS_URLS.apple ? 'apple' : null;
      if (!which) throw new Error('refusing an unexpected JWKS address: ' + href);
      rec.jwks.push({ href, options });
      const set = J.createLocalJWKSet({ keys: KEYS.published[which] });
      return async (header, token) => { if (world.jwksDown) throw Object.assign(new Error('JWKS endpoint unreachable'), { code: 'ERR_JWKS_TIMEOUT' }); return set(header, token); };
    }
  };
}

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
      const claims = { iss: apple ? 'https://appleid.apple.com' : 'https://accounts.google.com', aud: apple ? 'com.example.web' : 'g-id', exp: now + 3600, iat: now, nonce: world.nonce, ...cfg };
      const token = await mintIdToken(apple ? 'apple' : 'google', claims, world.sign);   // a really RSA-signed token (see world.sign for forgeries)
      world.lastToken = token;
      return json(token === undefined ? {} : { id_token: token });
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
  const rec = { jwks: [], verifies: [] };
  const u = ready ? users : Object.assign(users, { oauthReady: async () => false });
  const api = createOAuthApi({ users: u, env, fetch: prov.fetch, now: () => clock.t, jose: testJose(world, rec) });
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
  return { api, session, ctx, users: u, prov, world, clock, begin, rec };
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
async function refused(t, provider, params, expectedCode, label = '') {
  const calls = t.prov.log.length, users = t.users._all().length, started = t.session.started;
  const sub = t.world[provider] && t.world[provider].sub, linked = sub ? await t.users.findByIdentity(provider, String(sub)) : null;
  const r = await t.api.callback({ provider, params, ...t.ctx });
  assert.equal(loginError(r), '#/login?oauth_error=' + expectedCode, label + ' ' + JSON.stringify(params));
  assert.equal(t.session.userId, null, label); assert.equal(t.session.started, started, label + ': no session was established');
  assert.equal(t.users._all().length, users, label + ': no user was created');
  if (sub) assert.equal(((await t.users.findByIdentity(provider, String(sub))) || {}).id, (linked || {}).id, label + ': no identity was linked or changed');
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
// ---------------------------------------------------------------- ID token SIGNATURE verification (real RSA signatures, local keys, offline)
const BASE_CLAIMS = {
  google: { sub: 'sub-1', email: 'a@example.com', email_verified: true },
  apple: { sub: 'apple-sub-1', email: 'a@example.com', email_verified: 'true' }
};
const validFlow = async (provider, claims, sign) => {
  const t = setup(); t.world[provider] = claims; if (sign) t.world.sign = sign;
  const { state } = await t.begin(provider);
  const r = await t.api.callback({ provider, params: { code: 'c', state }, ...t.ctx });
  assert.equal(r.redirect, '/#/dashboard', provider + ' ' + JSON.stringify(sign || {}) + ' ' + JSON.stringify(claims));
  return t;
};
test('genuine RS256 tokens are accepted (Google with either issuer spelling and either published key, and Apple); keys are looked up only at the two fixed addresses', async () => {
  assert.deepEqual(JWKS_URLS, { google: 'https://www.googleapis.com/oauth2/v3/certs', apple: 'https://appleid.apple.com/auth/keys' });
  assert.ok(Object.isFrozen(JWKS_URLS));
  let t = await validFlow('google', BASE_CLAIMS.google);
  assert.deepEqual(t.rec.jwks.map(j => j.href), [JWKS_URLS.google]);
  assert.equal(t.users._all().length, 1); assert.ok(await t.users.findByIdentity('google', 'sub-1')); assert.equal(t.session.started, 1);
  t.session.userId = null; const again = await t.begin('google');       // same app instance: the key set is created once and reused
  await t.api.callback({ provider: 'google', params: { code: 'c2', state: again.state }, ...t.ctx });
  assert.equal(t.rec.jwks.length, 1); assert.equal(t.users._all().length, 1);
  await validFlow('google', { ...BASE_CLAIMS.google, iss: 'accounts.google.com' });
  await validFlow('google', BASE_CLAIMS.google, { key: 'google2' });    // the provider rotated: a token signed by its second published key
  t = await validFlow('apple', BASE_CLAIMS.apple);
  assert.deepEqual(t.rec.jwks.map(j => j.href), [JWKS_URLS.apple]);
  assert.ok(await t.users.findByIdentity('apple', 'apple-sub-1'));
});
test('jwtVerify is called with RS256 only, the provider\'s issuer(s) and audience, the required claims, a small tolerance and the injected clock', async () => {
  const g = (await validFlow('google', BASE_CLAIMS.google)).rec.verifies[0];
  assert.deepEqual(g.algorithms, ['RS256']);
  assert.deepEqual(g.issuer, ['https://accounts.google.com', 'accounts.google.com']);
  assert.equal(g.audience, 'g-id');
  assert.deepEqual([...g.requiredClaims].sort(), ['aud', 'exp', 'iat', 'iss', 'sub']);
  assert.ok(typeof g.clockTolerance === 'number' && g.clockTolerance <= 60);
  assert.equal(g.currentDate.getTime(), 1_800_000_000_000);
  const a = (await validFlow('apple', BASE_CLAIMS.apple)).rec.verifies[0];
  assert.deepEqual(a.algorithms, ['RS256']); assert.deepEqual(a.issuer, ['https://appleid.apple.com']); assert.equal(a.audience, 'com.example.web');
});
const FORGERIES = [
  { label: 'tampered signature', sign: { mutate: flipSignature } },
  { label: 'payload changed after signing (sub swapped), original signature kept', sign: { mutate: swapPayload({ sub: 'victim-sub' }) } },
  { label: 'unknown key id', sign: { kid: 'no-such-key' } },
  { label: 'signed by an attacker key under the real key id', sign: { key: 'attacker', kid: '@trusted' } },
  { label: 'signed by an attacker key under its own key id', sign: { key: 'attacker' } },
  { label: 'alg none', sign: { alg: 'none' } },
  { label: 'HS256', sign: { alg: 'HS256' } },
  { label: 'RS384 with a key the provider really published', sign: { alg: 'RS384', key: 'rs384' } },
  { label: 'ES256 with a key the provider really published', sign: { alg: 'ES256', key: 'es256' } },
  { label: 'valid signature but a jku header (attacker key location)', sign: { header: { jku: 'https://evil.example/keys' } } },
  { label: 'valid signature but an embedded jwk header', sign: { header: { jwk: { kty: 'RSA', n: 'sXch', e: 'AQAB' } } } },
  { label: 'valid signature but an x5u header', sign: { header: { x5u: 'https://evil.example/cert.pem' } } },
  { label: 'valid signature but an x5c header', sign: { header: { x5c: ['MIIB'] } } },
  { label: 'wrong issuer', claims: () => ({ iss: 'https://evil.example' }) },
  { label: 'issuer lookalike', claims: () => ({ iss: 'accounts.google.com.evil.example' }) },
  { label: 'wrong audience', claims: () => ({ aud: 'someone-else' }) },
  { label: 'expired an hour ago', claims: n => ({ exp: n - 3600 }) },
  { label: 'expired 60 seconds ago (outside the tolerance)', claims: n => ({ exp: n - 60 }) },
  { label: 'issued an hour in the future', claims: n => ({ iat: n + 3600, exp: n + 7200 }) },
  ...['iss', 'aud', 'exp', 'iat', 'sub'].map(k => ({ label: 'missing required claim ' + k, claims: () => ({ [k]: undefined }) })),
  { label: 'empty subject', claims: () => ({ sub: '' }) },
  { label: 'wrong nonce', nonce: 'a-different-nonce', code: 'state' },
  { label: 'no nonce in the token', claims: () => ({ nonce: undefined }), code: 'state' },
  { label: 'token response has no id_token', sign: { omit: true } },
  { label: 'id_token is not a JWT', sign: { raw: 'not-a-jwt' } },
  { label: 'the provider\'s key set cannot be fetched (fails closed)', jwksDown: true }
];
test('forged or invalid ID tokens are refused for Google AND Apple: no user, no session, no linked identity, and the token never reaches a log line', async () => {
  for (const provider of ['google', 'apple']) {
    for (const f of FORGERIES) {
      const label = provider + ': ' + f.label;
      const t = setup(); const n = Math.floor(t.clock.t / 1000);
      t.world[provider] = { ...BASE_CLAIMS[provider], ...(f.claims ? f.claims(n) : {}) };
      if (f.sign) t.world.sign = f.sign;
      t.world.jwksDown = Boolean(f.jwksDown);
      const { state } = await t.begin(provider);
      if (f.nonce) t.world.nonce = f.nonce;
      const [providerCalls, lines] = await withLog(() => refused(t, provider, { code: 'c', state }, f.code || 'provider_error', label));
      assert.equal(providerCalls, 1, label + ': only the token exchange was made');
      assert.equal(await t.users.findByIdentity(provider, 'victim-sub'), null, label);
      assert.equal(t.users._all().length, 0, label);
      assert.ok(lines.length >= 1, label + ': the refusal is logged with a short code');
      if (t.world.lastToken) assert.ok(!lines.join('\n').includes(t.world.lastToken), label + ': the token must never be logged');
    }
  }
});
test('REGRESSION: a forged ID token naming an already-linked identity cannot sign that user in, and nothing is created, linked or changed', async () => {
  const users = memoryUsers(); const t = setup({ users });
  t.world.google = { sub: 'linked-sub', email: 'owner@example.com', email_verified: true };       // 1. the real owner signs in once, with a genuine token
  let { state } = await t.begin('google');
  assert.equal((await t.api.callback({ provider: 'google', params: { code: 'c', state }, ...t.ctx })).redirect, '/#/dashboard');
  const owner = await users.findByIdentity('google', 'linked-sub'); assert.ok(owner);
  assert.equal(t.session.userId, owner.id);
  t.session.userId = null; const started = t.session.started;                                      // a different, signed-out browser from here on
  const attempts = [                                                                                 // 2. forged tokens, each aimed at the owner's identity
    ['signed with an attacker key', { sub: 'linked-sub' }, { key: 'attacker' }],
    ['attacker key under the real key id', { sub: 'linked-sub' }, { key: 'attacker', kid: '@trusted' }],
    ['alg none', { sub: 'linked-sub' }, { alg: 'none' }],
    ['HS256', { sub: 'linked-sub' }, { alg: 'HS256' }],
    ['genuinely signed for another account, payload edited to the owner\'s sub', { sub: 'attacker-sub' }, { mutate: swapPayload({ sub: 'linked-sub' }) }],
    ['forged token with a NEW sub and the owner\'s email (would link a second identity)', { sub: 'brand-new-sub' }, { key: 'attacker' }]
  ];
  for (const [label, claims, sign] of attempts) {
    t.world.google = { email: 'owner@example.com', email_verified: true, ...claims }; t.world.sign = sign;
    ({ state } = await t.begin('google'));
    await withLog(() => refused(t, 'google', { code: 'c', state }, 'provider_error', label));
    assert.equal(users._all().length, 1, label);
    assert.equal(((await users.findByIdentity('google', 'linked-sub')) || {}).id, owner.id, label);
    assert.equal(await users.findByIdentity('google', 'brand-new-sub'), null, label);
    assert.equal(((await users.findByEmail('owner@example.com')) || {}).id, owner.id, label);
  }
  delete t.world.sign; t.world.google = { sub: 'linked-sub', email: 'owner@example.com', email_verified: true };   // 3. control: the genuine token still works
  ({ state } = await t.begin('google'));
  assert.equal((await t.api.callback({ provider: 'google', params: { code: 'c', state }, ...t.ctx })).redirect, '/#/dashboard');
  assert.equal(t.session.userId, owner.id); assert.equal(t.session.started, started + 1); assert.equal(users._all().length, 1);
});
test('oauth.js has no unverified ID-token decoding left and exports no way to trust an unverified token', () => {
  const mod = require('../oauth');
  assert.equal(mod.decodeJwtPayload, undefined); assert.equal(mod.checkIdToken, undefined);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'oauth.js'), 'utf8');
  assert.ok(!/decodeJwtPayload|checkIdToken/.test(src));
  assert.match(src, /jwtVerify\(/); assert.match(src, /algorithms:\s*\['RS256'\]/);
  assert.ok(!/createRemoteJWKSet\([^)]*(header|token|jku|jwk)/.test(src), 'key locations never come from a token');
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
