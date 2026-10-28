// Static checks on index.html: the auth wiring is present and the insecure Stage 1 identity is gone.
// (These do not replace trying the page in a real browser; see the README checklist.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const js = html.slice(html.indexOf('<div id="toast"></div>\n<script>'));

test('the page parses as JavaScript', () => {
  const a = html.indexOf('<div id="toast"></div>\n<script>') + '<div id="toast"></div>\n<script>'.length, b = html.lastIndexOf('</script></body></html>');
  assert.doesNotThrow(() => new Function(html.slice(a, b)));
});
test('no anonymous bearer token is created or sent any more', () => {
  assert.ok(!/ownerToken|Authorization'?\s*:|'Bearer '/.test(js));
  assert.ok(!/localStorage\.setItem\(OKEY/.test(js), 'the old token must never be written');
});
test('no password or session secret is ever written to browser storage', () => {
  const writes = js.match(/(localStorage|sessionStorage)\.setItem\([^)]*\)/g) || [];
  for (const w of writes) assert.ok(!/pass|csrf|session|token|cookie/i.test(w) || /launchforge\.apiBase/.test(w), 'suspicious storage write: ' + w);
  assert.ok(!/(jset|recoveryWrite)\([^)]*(password|csrf)/i.test(js));
});
test('every API call sends credentials and a CSRF header; the Gemini call also names the project', () => {
  assert.match(js, /fetch\(apiBase\(\)\+path,\{method,credentials:'include'/);
  assert.match(js, /'X-CSRF-Token'/);
  assert.match(js, /\/api\/edit',\{method:'POST',credentials:'include'/);
  assert.match(js, /projectId:cur\.src==='server'/);
  const fetches = js.match(/fetch\(apiBase\(\)[^;]*?\{[^}]*\}/g) || [];
  for (const f of fetches) if (!/\/api\/health/.test(f)) assert.match(f, /credentials:'include'/, f.slice(0, 60));
});
test('login, sign-up, logout, expired-session and legacy-claim flows exist', () => {
  for (const s of ["authPage(", "'/api/auth/'+(reg?'register':'login')", "'/api/auth/logout'", "/api/auth/legacy/claim", "/api/auth/legacy/preview", "markOut()", "data-logout", "data-claim", "AUTH_REQUIRED", "CSRF_INVALID"]) assert.ok(js.includes(s), s);
  assert.match(js, /if\(a==='login'\|\|a==='register'\)return authRoute\(a\)/);
});
test('server projects require login; local-only projects stay reachable without it', () => {
  assert.match(js, /auth\.state!=='in'\)\{auth\.next='#\/project\/'\+id/);
  assert.match(js, /src:\(srv\.state==='ready'&&auth\.state==='in'\?'server':'local'\)/);
});
test('copy no longer claims anonymous tokens or "no accounts"', () => {
  assert.ok(!/no accounts yet|anonymous token kept|There are no accounts/i.test(html));
  assert.match(html, /salted Argon2id hash/);
});

// ---- cross-origin cookie handling ----
const { block } = require('./_extract');
test('isCrossSite: GitHub Pages -> Render is cross-site; Render page -> Render API and localhost are not', () => {
  const isCrossSite = new Function(block('XSITE') + '; return isCrossSite;')();
  assert.equal(isCrossSite('https://launchforge-4a6u.onrender.com', 'https://pixelated-byte.github.io/LaunchForge/'), true);
  assert.equal(isCrossSite('https://launchforge-4a6u.onrender.com', 'https://launchforge-4a6u.onrender.com/'), false);
  assert.equal(isCrossSite('', 'http://localhost:3000/'), false);
  assert.equal(isCrossSite('http://localhost:3000', 'http://localhost:3000/#/login'), false);
  assert.equal(isCrossSite('not a url', 'also bad'), false);
});
test('after login/sign-up the page confirms the session cookie really stuck before showing "logged in"', () => {
  const i = js.indexOf("'/api/auth/'+(reg?'register':'login')");
  const seg = js.slice(i, i + 900);
  assert.ok(seg.indexOf("apiRaw('GET','/api/auth/me')") > 0, 'must call /me after login');
  assert.ok(seg.indexOf("apiRaw('GET','/api/auth/me')") < seg.indexOf("auth.state='in'"), '/me check must come before auth.state is set');
  assert.match(seg, /did not keep the login session/);
});

// ---- sign-in page: social buttons, validation, messages ----
const authui = () => new Function(block('AUTHUI') + '; return { OAUTH_MSG, oauthMessage, providerView, emailProblem, passwordProblem };')();
test('social buttons: a provider is clickable ONLY when the server says it is available; every other state is disabled and explained', () => {
  const { providerView } = authui();
  assert.equal(providerView('google', { available: true }, false).disabled, false);
  const cases = [
    [providerView('google', undefined, false), /Checking/],
    [providerView('github', null, false), /Unavailable/],
    [providerView('apple', { available: false, reason: 'not_configured' }, false), /Not configured/],
    [providerView('apple', { available: false, reason: 'needs_database_upgrade' }, false), /Not available yet/],
    [providerView('google', { available: true }, true), /Unavailable/],          // server down beats everything
    [providerView('google', 'yes', false), /Unavailable/],                        // anything unexpected fails closed
    [providerView('google', { available: 'true' }, false), /Not configured/]      // only a real boolean true enables a button
  ];
  for (const [v, note] of cases) { assert.equal(v.disabled, true); assert.match(v.note, note); }
  assert.match(providerView('apple', { available: false, reason: 'not_configured' }, false).msg, /Apple sign-in is not set up/);
});
test('the page can show a message for EVERY error code the backend can send back', () => {
  const { OAUTH_MSG, oauthMessage } = authui();
  const server = fs.readFileSync(path.join(__dirname, '..', 'oauth.js'), 'utf8');
  const codes = new Set([...server.matchAll(/fail\('([a-z_]+)'/g)].map(m => m[1]));
  codes.add('failed');
  for (const c of codes) assert.ok(OAUTH_MSG[c], 'no message for backend code: ' + c);
  assert.equal(oauthMessage(''), ''); assert.equal(oauthMessage(null), '');
  assert.equal(oauthMessage('<script>'), OAUTH_MSG.failed, 'unknown codes fall back to a generic message');
});
test('client-side validation: email shape, password rules (10+ characters when registering), clear messages', () => {
  const { emailProblem, passwordProblem } = authui();
  assert.match(emailProblem(''), /Enter your email/); assert.match(emailProblem('nope'), /valid email/); assert.match(emailProblem('a@b'), /valid email/);
  assert.equal(emailProblem(' me@example.com '), '');
  assert.equal(passwordProblem('anything', false), ''); assert.match(passwordProblem('', false), /Enter your password/);
  assert.match(passwordProblem('short', true), /at least 10/); assert.equal(passwordProblem('long enough pw', true), '');
  assert.match(passwordProblem('x'.repeat(129), true), /at most 128/);
});
test('the page starts social sign-in only through the server route, builds the address from the API base (no hard-coded host), and holds no secret', () => {
  assert.ok(js.includes("location.assign(apiBase()+'/api/auth/oauth/'+n+'/start')"));
  assert.ok(js.includes("apiRaw('GET','/api/auth/providers'"));
  const i = js.indexOf('if(v.disabled){sm.textContent=v.msg;return}'), j = js.indexOf("location.assign(apiBase()+'/api/auth/oauth/'");
  assert.ok(i > 0 && j > i, 'a disabled button must return before any navigation');
  assert.ok(!/client_secret|CLIENT_SECRET|PRIVATE_KEY|onrender\.com\/api\/auth\/oauth/i.test(js.replace(/https:\/\/launchforge-[a-z0-9]+\.onrender\.com/g, '')), 'no secrets or hard-coded OAuth hosts in the page');
  assert.match(js, /const \[a,b\]=h\.split\('\?'\)\[0\]\.split\('\/'\)/, 'router ignores the ?oauth_error query');
});
test('accessibility basics on the sign-in page: labelled inputs, password toggle state, live regions, tab semantics', () => {
  for (const s of ['<label for="em">', '<label for="pw">', 'aria-pressed', 'aria-label="Show password"', 'role="alert"', 'aria-live="polite"', 'aria-current="page"', 'aria-busy', 'autocomplete="${reg?\'new-password\':\'current-password\'}"', 'aria-invalid']) assert.ok(js.includes(s), s);
  assert.ok(!/<input[^>]*type="password"[^>]*value=/.test(js), 'the password field is never pre-filled');
});
