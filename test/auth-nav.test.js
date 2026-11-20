// Runs the REAL page script (index.html) in a tiny simulated DOM with stubbed /api/health and /api/auth/me.
// Covers: Log in / Sign up are never hidden by backend problems, "logged in" is claimed only after /api/auth/me confirms it,
// health and authentication are checked independently, and neither check is repeated needlessly. Not a browser: try the page too.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const START = '<div id="toast"></div>\n<script>';
const SCRIPT = html.slice(html.indexOf(START) + START.length, html.lastIndexOf('</script></body></html>'));
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));
const res = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
const never = () => new Promise(() => {});                                   // a request that never answers
const HEALTH = { ready: res(200, { database: 'connected' }), down: res(200, { database: 'unavailable' }), unconfigured: res(200, { database: 'not_configured' }), unreachable: async () => { throw new TypeError('Failed to fetch'); } };
const USER = { id: 'u1', email: 'ada@example.com' };
const ME = { in: res(200, { user: USER, csrf: 'csrf-1' }), out: res(200, { user: null }), unauthorized: res(401, { error: { code: 'AUTH_REQUIRED', message: 'Log in required' } }), unavailable: res(503, { error: { code: 'DB_UNAVAILABLE', message: 'down' } }), unreachable: async () => { throw new TypeError('Failed to fetch'); } };

// Boots the page with the given stubbed answers (routes: { '/api/health': impl, '/api/auth/me': impl, ... }) and returns a handle.
function boot(routes) {
  const els = {}, calls = {};
  const el = () => ({ value: '', textContent: '', innerHTML: '', style: {}, disabled: false, className: '', dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; }, remove() {}, setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {}, querySelector() { return el(); }, querySelectorAll() { return []; }, focus() {}, scrollIntoView() {}, closest() { return null; } });
  const q = sel => els[sel] || (els[sel] = el());
  const ctx = {
    document: { querySelector: q, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, removeEventListener() {}, body: el(), documentElement: el(), title: '' },
    console, clearTimeout, clearInterval, AbortController, URL, Date, Math, JSON, Promise,
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); if (t.unref) t.unref(); return t; }, setInterval: (f, ms) => { const t = setInterval(f, ms); if (t.unref) t.unref(); return t; },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { protocol: 'http:', hostname: 'localhost', hash: '', href: 'http://localhost:3000/', origin: 'http://localhost:3000', pathname: '/' },
    history: { replaceState() {}, pushState() {} }, navigator: {}, confirm: () => true, alert() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: f => setTimeout(f, 0), getComputedStyle: () => ({}),
    fetch: (url, opts) => { calls[url] = (calls[url] || []).concat([opts || {}]); return routes[url] ? routes[url](url, opts) : never(); }
  };
  ctx.window = ctx; ctx.self = ctx; vm.createContext(ctx);
  const w = { routes, calls, q, run: code => vm.runInContext(code, ctx), n: url => (calls[url] || []).length, nav: () => q('#authnav').innerHTML };
  try { vm.runInContext(SCRIPT, ctx, { timeout: 5000 }); } catch (e) { w.bootError = e; }   // route() may stumble on the simulated DOM; the checks start before it
  return w;
}
const hasLogin = n => n.includes('href="#/login"') && n.includes('href="#/register"');
const hasUser = n => n.includes(USER.email) && n.includes('data-logout');
const hasNotice = n => n.includes('data-srvnote');

test('navigation: logged-out visitors ALWAYS get Log in and Sign up, whatever the backend state', () => {
  const w = boot({});
  for (const srv of ['unknown', 'ready', 'down', 'unconfigured']) for (const auth of ['unknown', 'out']) {
    w.run(`srv.state='${srv}';auth.state='${auth}';auth.user=null;renderAuthNav()`);
    const n = w.nav();
    assert.ok(hasLogin(n), `${srv}/${auth}: ${n}`); assert.ok(!n.includes('data-logout'), `${srv}/${auth}`); assert.ok(!n.includes('@'), `${srv}/${auth}: nothing that looks like an account`);
    assert.equal(hasNotice(n), srv === 'down' || srv === 'unconfigured', `${srv}/${auth}: a notice only when the backend has a problem`);
  }
});
test('navigation: a confirmed user sees their email and Log out (not Log in / Sign up) in every backend state', () => {
  const w = boot({});
  for (const srv of ['unknown', 'ready', 'down', 'unconfigured']) {
    w.run(`srv.state='${srv}';auth.state='in';auth.user=${JSON.stringify(USER)};renderAuthNav()`);
    const n = w.nav();
    assert.ok(hasUser(n), srv); assert.ok(!n.includes('href="#/login"') && !n.includes('href="#/register"'), srv); assert.equal(hasNotice(n), srv === 'down' || srv === 'unconfigured', srv);
  }
});
test('navigation: the notice is subtle, explains itself, and an email is always escaped', () => {
  const w = boot({});
  w.run("srv.state='down';srv.msg='the backend is not reachable (it may be waking up)';auth.state='out';renderAuthNav()");
  assert.match(w.nav(), /class="note hide" data-srvnote title="the backend is not reachable \(it may be waking up\)">Server unavailable</);
  w.run("srv.state='unconfigured';srv.msg='';renderAuthNav()"); assert.match(w.nav(), /title="Server storage is not available">Accounts unavailable</);
  w.run(`srv.state='ready';auth.state='in';auth.user={id:'x',email:'<img src=x onerror=alert(1)>@e.com'};renderAuthNav()`);
  assert.ok(!w.nav().includes('<img') && w.nav().includes('&lt;img'));
  w.run("srv.state='down';srv.msg='\"><script>alert(1)</script>';auth.state='out';renderAuthNav()"); assert.ok(!w.nav().includes('<script'));
});

test('boot: the nav shows Log in / Sign up at once, even while the health check is still waiting (backend waking up)', async () => {
  const w = boot({ '/api/health': never, '/api/auth/me': never });
  assert.ok(hasLogin(w.nav()), 'visible before any answer arrives'); assert.ok(!hasNotice(w.nav()));
  await tick(); assert.ok(hasLogin(w.nav())); assert.equal(w.run('auth.state'), 'unknown'); assert.equal(w.run('srv.state'), 'unknown');
});
test('boot, backend DOWN: Log in / Sign up stay visible with a notice; nobody is called logged in without confirmation', async () => {
  for (const [label, health] of [['unreachable', HEALTH.unreachable], ['database unavailable', HEALTH.down]]) for (const me of [ME.unreachable, ME.unavailable]) {
    const w = boot({ '/api/health': health, '/api/auth/me': me }); await tick();
    assert.equal(w.run('srv.state'), 'down', label); assert.equal(w.run('auth.state'), 'unknown', label + ': not confirmed, so not claimed');
    assert.ok(hasLogin(w.nav()), label); assert.ok(hasNotice(w.nav()), label); assert.ok(!w.nav().includes('data-logout'), label);
  }
});
test('boot, backend UNCONFIGURED: Log in / Sign up stay visible with a notice', async () => {
  const w = boot({ '/api/health': HEALTH.unconfigured, '/api/auth/me': ME.unavailable }); await tick();
  assert.equal(w.run('srv.state'), 'unconfigured'); assert.ok(hasLogin(w.nav())); assert.ok(hasNotice(w.nav())); assert.match(w.nav(), /Accounts unavailable/);
});
test('boot, backend READY: logged out shows Log in / Sign up without a notice; logged in shows email + Log out', async () => {
  let w = boot({ '/api/health': HEALTH.ready, '/api/auth/me': ME.out }); await tick();
  assert.equal(w.run('srv.state'), 'ready'); assert.equal(w.run('auth.state'), 'out'); assert.ok(hasLogin(w.nav())); assert.ok(!hasNotice(w.nav()));
  w = boot({ '/api/health': HEALTH.ready, '/api/auth/me': ME.in }); await tick();
  assert.equal(w.run('auth.state'), 'in'); assert.equal(w.run('auth.csrf'), 'csrf-1'); assert.ok(hasUser(w.nav())); assert.ok(!hasNotice(w.nav()));
  w = boot({ '/api/health': HEALTH.ready, '/api/auth/me': ME.unauthorized }); await tick();
  assert.equal(w.run('auth.state'), 'out', '401 is a definite "not logged in"'); assert.ok(hasLogin(w.nav()));
});

test('independence: a user is recognised even when the health check is down or never answers', async () => {
  for (const health of [HEALTH.down, HEALTH.unreachable, HEALTH.unconfigured, never]) {
    const w = boot({ '/api/health': health, '/api/auth/me': ME.in }); await tick();
    assert.equal(w.run('auth.state'), 'in'); assert.ok(hasUser(w.nav())); assert.ok(!w.nav().includes('href="#/login"'));
  }
});
test('independence: health is reported even when authentication cannot be checked, and the two never call each other', async () => {
  const w = boot({ '/api/health': HEALTH.ready, '/api/auth/me': never }); await tick();
  assert.equal(w.run('srv.state'), 'ready'); assert.equal(w.run('auth.state'), 'unknown'); assert.ok(hasLogin(w.nav()));
  assert.equal(w.n('/api/health'), 1); assert.equal(w.n('/api/auth/me'), 1);
  assert.ok(!/checkAuth/.test(w.run('checkServer.toString()')), 'the health check does not trigger or wait for the auth check');
  assert.ok(!/checkServer/.test(w.run('checkAuth.toString()')), 'the auth check does not depend on the health check');
  const w2 = boot({ '/api/health': HEALTH.down, '/api/auth/me': ME.out }); await tick();
  assert.equal(w2.n('/api/auth/me'), 1, 'asked even though health says down (it used to be skipped)');
});

test('no duplicate requests: concurrent and repeated checks share one request each; a settled "ready + logged in" is never re-fetched', async () => {
  const w = boot({ '/api/health': HEALTH.ready, '/api/auth/me': ME.in });
  await Promise.all([w.run('checkSession()'), w.run('checkSession()'), w.run('checkServer()'), w.run('checkAuth()'), w.run('checkAuth(true)')]);
  assert.equal(w.n('/api/health'), 1); assert.equal(w.n('/api/auth/me'), 1, 'even a forced check joins the one in flight');
  await w.run('checkSession()'); await w.run('checkSession()'); await tick();
  assert.equal(w.n('/api/health'), 1); assert.equal(w.n('/api/auth/me'), 1);
});
test('no polling or storms: while the backend is down repeated checks are throttled; Retry (force) checks both once and recovers the nav', async () => {
  const state = { health: HEALTH.unreachable, me: ME.unreachable };
  const w = boot({ '/api/health': (u, o) => state.health(u, o), '/api/auth/me': (u, o) => state.me(u, o) }); await tick();
  assert.equal(w.n('/api/health'), 1); assert.equal(w.n('/api/auth/me'), 1);
  for (let i = 0; i < 5; i++) await w.run('checkSession()');
  assert.equal(w.n('/api/health'), 1, 'throttled to once per 10 s'); assert.equal(w.n('/api/auth/me'), 1, 'throttled to once per 10 s');
  await tick(60); assert.equal(w.n('/api/health'), 1, 'there is no timer polling in the background');
  state.health = HEALTH.ready; state.me = ME.in;
  await w.run('checkSession(true)');
  assert.equal(w.n('/api/health'), 2); assert.equal(w.n('/api/auth/me'), 2);
  assert.equal(w.run('srv.state'), 'ready'); assert.equal(w.run('auth.state'), 'in'); assert.ok(hasUser(w.nav())); assert.ok(!hasNotice(w.nav()), 'the notice clears when the backend recovers');
});
test('a failed first check is retried later (it used to stay "logged out" forever), but only after the throttle window', async () => {
  const w = boot({ '/api/health': HEALTH.ready, '/api/auth/me': ME.unavailable }); await tick();
  assert.equal(w.run('auth.state'), 'unknown');
  w.routes['/api/auth/me'] = ME.in;
  await w.run('checkAuth()'); assert.equal(w.n('/api/auth/me'), 1, 'inside the 10 s window nothing is re-sent');
  w.run('auth.at=0'); await w.run('checkAuth()');                                   // the window has passed
  assert.equal(w.n('/api/auth/me'), 2); assert.equal(w.run('auth.state'), 'in'); assert.ok(hasUser(w.nav()));
});

test('login state is never claimed without confirmation: only /api/auth/me or a successful login sets "in"', async () => {
  for (const me of [ME.unreachable, ME.unavailable, never, ME.out, ME.unauthorized, res(200, {}), res(200, { user: null, csrf: 'x' })]) {
    const w = boot({ '/api/health': HEALTH.ready, '/api/auth/me': me }); await tick();
    assert.notEqual(w.run('auth.state'), 'in'); assert.equal(w.run('auth.user'), null); assert.ok(hasLogin(w.nav()));
  }
  const src = SCRIPT.match(/auth\.state='in'/g) || [];
  assert.equal(src.length, 2, "exactly two places may set 'in': checkAuth() and the login/register form");
});

test('CSRF recovery is unchanged: a 403 CSRF_INVALID re-checks /api/auth/me once and retries the request with the fresh token', async () => {
  let n = 0;
  const w = boot({ '/api/health': HEALTH.ready, '/api/auth/me': ME.in, '/api/projects': async (u, o) => (++n === 1 ? res(403, { error: { code: 'CSRF_INVALID', message: 'bad token' } })() : res(200, { ok: true })()) });
  await tick(); w.run("auth.csrf='stale'");
  const r = await w.run("api('POST','/api/projects',{a:1})");
  assert.deepEqual(r, { ok: true }); assert.equal(w.n('/api/projects'), 2); assert.equal(w.n('/api/auth/me'), 2, 'the boot check plus exactly one forced re-check');
  assert.equal(w.calls['/api/projects'][0].headers['X-CSRF-Token'], 'stale'); assert.equal(w.calls['/api/projects'][1].headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(w.calls['/api/projects'][1].credentials, 'include');
});
test('an expired session (401 on an API call) still logs the page out and keeps Log in / Sign up visible', async () => {
  const w = boot({ '/api/health': HEALTH.down, '/api/auth/me': ME.in, '/api/projects': res(401, { error: { code: 'AUTH_REQUIRED', message: 'x' } }) }); await tick();
  assert.equal(w.run('auth.state'), 'in');
  await assert.rejects(w.run("api('GET','/api/projects')"), e => e.auth === true);
  assert.equal(w.run('auth.state'), 'out'); assert.ok(hasLogin(w.nav())); assert.ok(hasNotice(w.nav()));
});
