// Express-level checks of the REAL wiring: cookies, CORS with credentials, CSRF/Origin, sessions, ownership, the Gemini route.
// Uses in-memory users/projects/sessions and a fake password hasher, so it needs no database and never calls Gemini.
// Needs `npm install` (express, express-session, cors, dotenv, @google/genai, pg, ...). Skipped automatically if missing.
// NOTE: this proves the wiring on localhost with simulated production headers. It cannot prove how Safari/Chrome treat
// third-party cookies between github.io and onrender.com; that must be checked in real browsers (see README).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.NODE_ENV = 'production';                       // exercise the production cookie/CORS settings
process.env.SESSION_SECRET = 'test-only-secret-'.padEnd(48, 'x');
process.env.ALLOWED_ORIGINS = 'https://pixelated-byte.github.io';
const ORIGIN = 'https://pixelated-byte.github.io';
const OTHER = 'https://evil.example';
let app = null, loadError = null;
try {
  app = require('../server');
  const session = require('express-session');
  const { memoryUsers } = require('../users'); const { memoryStore } = require('../store'); const { fakeHasher } = require('./_helpers');
  Object.assign(app.deps, { users: memoryUsers(), store: memoryStore(), hasher: fakeHasher(), sessionStore: new session.MemoryStore(), injected: true });
  delete process.env.DATABASE_URL;                        // never touch a real database from these tests
} catch (e) { loadError = String(e.message).split('\n')[0]; }
const skip = app ? false : 'dependencies not installed (' + loadError + ')';

async function withServer(fn) {
  const srv = http.createServer(app); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try { return await fn(srv.address().port); } finally { await new Promise(r => srv.close(r)); }
}
// A minimal "browser": keeps cookies, always claims to be behind an HTTPS proxy like Render.
function browser(port) {
  let cookie = '';
  const api = {
    get cookie() { return cookie; }, set cookie(v) { cookie = v; },
    call(method, path, { body, origin = ORIGIN, csrf, raw, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
        const h = { 'x-forwarded-proto': 'https', ...(origin ? { origin } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...(payload !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(cookie ? { cookie } : {}), ...headers };
        const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, res => {
          let d = ''; res.on('data', c => (d += c));
          res.on('end', () => {
            const sc = res.headers['set-cookie'] || [];
            for (const c of sc) { const [pair] = c.split(';'); const [n, v] = pair.split('='); if (/expires=Thu, 01 Jan 1970/i.test(c) || !v) cookie = ''; else cookie = n + '=' + v; }
            let json = null; try { json = JSON.parse(d); } catch (e) {}
            resolve({ status: res.statusCode, body: json, headers: res.headers, setCookie: sc });
          });
        });
        r.on('error', reject); if (payload !== null) r.write(payload); r.end();
      });
    }
  };
  return api;
}
const PW = 'correct horse battery';
let n = 0;
const reg = (b, email = `u${Date.now()}${n++}@example.com`) => b.call('POST', '/api/auth/register', { body: { email, password: PW } });
const proj = (o = {}) => ({ name: 'P', type: 'cafe', desc: '', audience: '', style: 'Modern', pages: [], html: '<html></html>', mode: null, generatedAt: null, history: [], ...o });

test('health keeps its existing fields and reports database/auth status', { skip }, () => withServer(async port => {
  const r = await browser(port).call('GET', '/api/health', { origin: null });
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.provider, 'Gemini');
  assert.equal(typeof r.body.model, 'string'); assert.equal(typeof r.body.aiConfigured, 'boolean');
  assert.equal(r.body.database, 'not_configured'); assert.equal(r.body.authConfigured, true);
  assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
}));

test('CORS: credentials are allowed for the Pages origin only; never a wildcard; localhost is NOT allowed in production', { skip }, () => withServer(async port => {
  const b = browser(port);
  const pre = o => b.call('OPTIONS', '/api/projects/x', { origin: o, headers: { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,x-csrf-token' } });
  const ok = await pre(ORIGIN);
  assert.equal(ok.status, 204); assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(ok.headers['access-control-allow-credentials'], 'true');
  assert.match(ok.headers['access-control-allow-methods'], /PUT/); assert.match(ok.headers['access-control-allow-methods'], /DELETE/);
  assert.match(ok.headers['access-control-allow-headers'].toLowerCase(), /x-csrf-token/);
  for (const o of [OTHER, 'http://localhost:3000', 'null']) {
    const r = await pre(o); assert.equal(r.headers['access-control-allow-origin'], undefined, o); assert.equal(r.headers['access-control-allow-credentials'], undefined, o);
  }
}));

test('unauthenticated callers are rejected and receive no session cookie', { skip }, () => withServer(async port => {
  const b = browser(port);
  assert.equal((await b.call('GET', '/api/projects')).status, 401);
  assert.equal((await b.call('GET', '/api/projects/anything/else')).status, 401);
  const edit = await b.call('POST', '/api/edit', { body: { html: '<html></html>', instruction: 'x' } });
  assert.equal(edit.status, 401); assert.equal(edit.body.error.code, 'AUTH_REQUIRED');
  const e2 = await b.call('POST', '/api/edit', { body: { html: '<html></html>', instruction: 'x' }, origin: OTHER });
  assert.equal(e2.status, 401);
  assert.equal(b.cookie, ''); assert.deepEqual((await b.call('GET', '/api/auth/me')).setCookie, []);
}));

test('registration sets a hardened cookie and exposes no secrets', { skip }, () => withServer(async port => {
  const b = browser(port); const r = await reg(b);
  assert.equal(r.status, 201); assert.ok(r.body.csrf);
  const c = r.setCookie.join(';');
  assert.match(c, /^__Host-lf\.sid=/); assert.match(c, /HttpOnly/i); assert.match(c, /Secure/i); assert.match(c, /SameSite=None/i); assert.match(c, /Path=\//i);
  assert.ok(!/Domain=/i.test(c), '__Host- cookies must not set Domain');
  assert.ok(!JSON.stringify(r.body).match(/hash|password/i));
  assert.equal(r.headers['cache-control'], 'no-store');
}));

test('full flow: create -> list -> isolation between users -> logout invalidates the session', { skip }, () => withServer(async port => {
  const A = browser(port), B = browser(port);
  const ra = await reg(A), rb = await reg(B);
  const csrfA = ra.body.csrf, csrfB = rb.body.csrf;
  assert.equal((await A.call('GET', '/api/auth/me')).body.user.email, ra.body.user.email);
  assert.equal((await A.call('POST', '/api/projects', { body: proj() })).body.error.code, 'CSRF_INVALID');
  const made = await A.call('POST', '/api/projects', { body: proj({ name: 'A-only' }), csrf: csrfA });
  assert.equal(made.status, 201);
  const id = made.body.project.id;
  assert.equal((await A.call('GET', '/api/projects')).body.projects.length, 1);
  assert.deepEqual((await B.call('GET', '/api/projects')).body.projects, []);
  assert.equal((await B.call('GET', '/api/projects/' + id)).status, 404);
  assert.equal((await B.call('PUT', '/api/projects/' + id, { body: { ...proj({ name: 'x' }), baseVersion: 1, userId: 'x' }, csrf: csrfB })).status, 404);
  assert.equal((await B.call('DELETE', '/api/projects/' + id, { csrf: csrfB })).status, 404);
  assert.equal((await A.call('GET', '/api/projects/' + id)).body.project.name, 'A-only');
  const stolenCookie = A.cookie;
  const out = await A.call('POST', '/api/auth/logout', { csrf: csrfA });
  assert.equal(out.status, 200); assert.ok(out.setCookie.some(c => /__Host-lf\.sid=;|Expires=Thu, 01 Jan 1970/i.test(c)), 'cookie is cleared');
  const replay = browser(port); replay.cookie = stolenCookie;
  assert.equal((await replay.call('GET', '/api/projects')).status, 401, 'the old session id no longer works');
  assert.equal((await replay.call('GET', '/api/auth/me')).body.user, null);
}));

test('login creates a NEW session id (fixation) and the old one is dead', { skip }, () => withServer(async port => {
  const b = browser(port); const email = `fix${Date.now()}@example.com`;
  await reg(b, email); const first = b.cookie;
  const r = await b.call('POST', '/api/auth/login', { body: { email, password: PW } });
  assert.equal(r.status, 200); assert.notEqual(b.cookie, first);
  const old = browser(port); old.cookie = first;
  assert.equal((await old.call('GET', '/api/auth/me')).body.user, null);
  const bad = await browser(port).call('POST', '/api/auth/login', { body: { email, password: 'wrong password here' } });
  assert.equal(bad.status, 401); assert.deepEqual(bad.setCookie, []);
}));

test('cross-site request forgery: a valid cookie from a disallowed or missing Origin is refused', { skip }, () => withServer(async port => {
  const b = browser(port); const r = await reg(b);
  const evil = await b.call('POST', '/api/projects', { body: proj(), csrf: r.body.csrf, origin: OTHER });
  assert.equal(evil.status, 403); assert.equal(evil.body.error.code, 'BAD_ORIGIN');
  assert.equal((await b.call('POST', '/api/projects', { body: proj(), csrf: r.body.csrf, origin: null })).status, 403);
  assert.equal((await b.call('POST', '/api/auth/logout', { origin: OTHER })).status, 403);
  assert.equal((await b.call('POST', '/api/auth/login', { body: { email: 'a@example.com', password: PW }, origin: OTHER })).status, 403);
  assert.equal((await b.call('GET', '/api/projects')).body.projects.length, 0);
}));

test('a garbled session cookie is just "logged out", not a server error', { skip }, () => withServer(async port => {
  const b = browser(port); b.cookie = '__Host-lf.sid=s%3Anot-a-real-session.invalidsignature';
  assert.equal((await b.call('GET', '/api/projects')).status, 401);
  assert.equal((await b.call('GET', '/api/auth/me')).body.user, null);
}));

test('Gemini route: login + CSRF required, ownership enforced, validation unchanged (no Gemini call is made)', { skip }, () => withServer(async port => {
  const A = browser(port), B = browser(port); const ra = await reg(A), rb = await reg(B);
  const mine = (await A.call('POST', '/api/projects', { body: proj(), csrf: ra.body.csrf })).body.project.id;
  const post = (who, csrf, body) => who.call('POST', '/api/edit', { body, csrf });
  const html = '<html><body>x</body></html>';
  delete process.env.GEMINI_API_KEY;
  assert.equal((await post(A, ra.body.csrf, { html, instruction: 'x' })).body.error.code, 'NOT_CONFIGURED');
  assert.equal((await post(A, undefined, { html, instruction: 'x' })).body.error.code, 'CSRF_INVALID');
  process.env.GEMINI_API_KEY = 'test-key-not-real';
  try {
    assert.equal((await post(A, ra.body.csrf, { html, instruction: '   ' })).body.error.code, 'EMPTY_INSTRUCTION');
    assert.equal((await post(A, ra.body.csrf, { html: 'no page', instruction: 'x' })).body.error.code, 'BAD_HTML');
    assert.equal((await post(B, rb.body.csrf, { html, instruction: 'x', projectId: mine })).status, 404, "cannot edit another user's project");
    assert.equal((await post(A, ra.body.csrf, { html, instruction: 'x', projectId: 'not-a-uuid' })).status, 400);
  } finally { delete process.env.GEMINI_API_KEY; }
}));

test('oversized bodies are rejected in the API error format', { skip }, () => withServer(async port => {
  const b = browser(port); const r = await reg(b);
  const big = await b.call('POST', '/api/projects', { csrf: r.body.csrf, raw: JSON.stringify({ name: 'x', html: 'y'.repeat(1300000) }) });
  assert.equal(big.status, 413); assert.equal(big.body.error.code, 'TOO_LARGE');
  const bigAuth = await browser(port).call('POST', '/api/auth/login', { raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(30000) }) });
  assert.equal(bigAuth.status, 413);
  const bad = await b.call('POST', '/api/projects', { csrf: r.body.csrf, raw: '{not json' });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'BAD_JSON');
}));

// ---------------------------------------------------------------- social sign-in wiring (the real Express routes)
// No provider account and no network call are needed: these prove routing, the state/session binding, and that nothing secret is exposed.
const withEnv = async (vars, fn) => {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};
// server.js loads your real .env. Blank every provider variable so these tests behave the same whatever you have configured locally.
const NO_OAUTH = { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', APPLE_CLIENT_ID: '', APPLE_TEAM_ID: '', APPLE_KEY_ID: '', APPLE_PRIVATE_KEY: '', APPLE_DOMAIN_ASSOCIATION: '', PUBLIC_BASE_URL: '', RENDER_EXTERNAL_URL: '' };
const oauthServer = fn => withServer(port => withEnv(NO_OAUTH, () => fn(port)));
const GOOGLE_ENV = { GOOGLE_CLIENT_ID: 'test-google-id', GOOGLE_CLIENT_SECRET: 'test-google-secret-DO-NOT-LEAK' };

test('providers endpoint: lists all three, none available when nothing is configured, no configuration values exposed', { skip }, () => oauthServer(async port => {
  const r = await browser(port).call('GET', '/api/auth/providers', { origin: null });
  assert.equal(r.status, 200); assert.equal(r.headers['cache-control'], 'no-store');
  for (const p of ['google', 'github', 'apple']) assert.deepEqual(r.body[p], { available: false, reason: 'not_configured' });
}));
test('providers endpoint: a configured provider is reported available, and only as a boolean', { skip }, () => oauthServer(port => withEnv(GOOGLE_ENV, async () => {
  const r = await browser(port).call('GET', '/api/auth/providers', { origin: null });
  assert.deepEqual(r.body.google, { available: true }); assert.equal(r.body.github.available, false);
  assert.ok(!JSON.stringify(r.body).includes('test-google'));
})));
test('start: unknown provider is 404; an unconfigured one goes back to the login page with a clear code and never to a provider', { skip }, () => oauthServer(async port => {
  const b = browser(port);
  assert.equal((await b.call('GET', '/api/auth/oauth/twitter/start', { origin: null })).status, 404);
  const r = await b.call('GET', '/api/auth/oauth/github/start', { origin: null });
  assert.equal(r.status, 303); assert.equal(r.headers.location, '/#/login?oauth_error=not_configured');
}));
test('start: a configured provider redirects with state + PKCE, sets a hardened session cookie, and never exposes the secret', { skip }, () => oauthServer(port => withEnv(GOOGLE_ENV, async () => {
  const r = await browser(port).call('GET', '/api/auth/oauth/google/start', { origin: null });
  assert.equal(r.status, 303);
  const u = new URL(r.headers.location);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), 'test-google-id'); assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256'); assert.ok(u.searchParams.get('state').length >= 32);
  assert.equal(u.searchParams.get('redirect_uri'), `https://127.0.0.1:${port}/api/auth/oauth/google/callback`);
  assert.ok(!r.headers.location.includes('test-google-secret'));
  const c = r.setCookie.join(';'); assert.match(c, /__Host-lf\.sid=/); assert.match(c, /HttpOnly/i); assert.match(c, /Secure/i);
})));
test('callback: no matching state means no login (a forged callback cannot sign anyone in)', { skip }, () => oauthServer(async port => {
  const b = browser(port);
  const r = await b.call('GET', '/api/auth/oauth/google/callback?code=attacker&state=forged', { origin: null });
  assert.equal(r.status, 303); assert.equal(r.headers.location, '/#/login?oauth_error=state');
  assert.equal((await b.call('GET', '/api/auth/me', { origin: null })).body.user, null);
}));
test('callback: the state belongs to the browser that started the flow; another browser cannot finish it', { skip }, () => oauthServer(port => withEnv(GOOGLE_ENV, async () => {
  const victim = browser(port), attacker = browser(port);
  const s = await victim.call('GET', '/api/auth/oauth/google/start', { origin: null });
  const state = new URL(s.headers.location).searchParams.get('state');
  const r = await attacker.call('GET', '/api/auth/oauth/google/callback?code=x&state=' + encodeURIComponent(state), { origin: null });
  assert.equal(r.headers.location, '/#/login?oauth_error=state');
})));
test('callback: a provider error (user pressed Cancel) returns to the login page with a friendly code', { skip }, () => oauthServer(async port => {
  const r = await browser(port).call('GET', '/api/auth/oauth/google/callback?error=access_denied', { origin: null });
  assert.equal(r.headers.location, '/#/login?oauth_error=cancelled');
}));
test('Apple answers with a cross-site form POST: it is accepted (no Origin/CSRF header rule) but still needs a valid state', { skip }, () => oauthServer(async port => {
  const r = await browser(port).call('POST', '/api/auth/oauth/apple/callback', { origin: 'https://appleid.apple.com', raw: 'code=abc&state=forged', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 303); assert.equal(r.headers.location, '/#/login?oauth_error=state');
}));
test('Apple domain-verification file is served only when configured', { skip }, () => oauthServer(async port => {
  const b = browser(port);
  assert.equal((await b.call('GET', '/.well-known/apple-developer-domain-association.txt', { origin: null })).status, 404);
  await withEnv({ APPLE_DOMAIN_ASSOCIATION: 'abc123' }, async () => assert.equal((await b.call('GET', '/.well-known/apple-developer-domain-association.txt', { origin: null })).status, 200));
}));
test('email/password still works end to end alongside the social routes (register, session, logout)', { skip }, () => oauthServer(async port => {
  const b = browser(port); const r = await reg(b); assert.equal(r.status, 201);
  const me = await b.call('GET', '/api/auth/me', { origin: null }); assert.equal(me.body.user.email, r.body.user.email);
  assert.equal((await b.call('POST', '/api/auth/logout', { body: {}, csrf: r.body.csrf })).status, 200);
  assert.equal((await b.call('GET', '/api/auth/me', { origin: null })).body.user, null);
}));
