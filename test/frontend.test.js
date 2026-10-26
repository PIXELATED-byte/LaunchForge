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
