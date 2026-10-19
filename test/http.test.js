// End-to-end HTTP checks through the real Express app: preserved AI endpoint, health, CORS, storage-off behaviour.
// Needs `npm install` (express, cors, dotenv, @google/genai). Skipped automatically if dependencies are missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.ALLOWED_ORIGINS = 'https://pixelated-byte.github.io';
let app = null, loadError = null;
try { app = require('../server'); } catch (e) { loadError = e.message.split('\n')[0]; }
const skip = app ? false : 'dependencies not installed (' + loadError + ')';

async function withServer(fn) {
  const srv = http.createServer(app); await new Promise(r => srv.listen(0, r));
  try { return await fn('http://127.0.0.1:' + srv.address().port); } finally { await new Promise(r => srv.close(r)); }
}
const auth = { authorization: 'Bearer ' + 'a'.repeat(43) };

test('health keeps its existing fields and reports database status', { skip }, async () => {
  delete process.env.DATABASE_URL;
  await withServer(async base => {
    const j = await (await fetch(base + '/api/health')).json();
    assert.equal(j.ok, true); assert.equal(j.provider, 'Gemini'); assert.equal(typeof j.model, 'string'); assert.equal(typeof j.aiConfigured, 'boolean');
    assert.equal(j.database, 'not_configured');
  });
});

test('without DATABASE_URL the project routes answer 503 and the server keeps running', { skip }, async () => {
  delete process.env.DATABASE_URL;
  await withServer(async base => {
    const r = await fetch(base + '/api/projects', { headers: auth });
    assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'DB_NOT_CONFIGURED');
    assert.equal((await fetch(base + '/api/projects')).status, 401);
  });
});

test('/api/edit is unchanged: key check, then validation (no Gemini call is made)', { skip }, async () => {
  await withServer(async base => {
    const post = body => fetch(base + '/api/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    delete process.env.GEMINI_API_KEY;
    let r = await post({ html: '<html></html>', instruction: 'x' });
    assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'NOT_CONFIGURED');
    process.env.GEMINI_API_KEY = 'test-key-not-real';
    r = await post({ html: '<html></html>', instruction: '   ' });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'EMPTY_INSTRUCTION');
    r = await post({ html: 'no page', instruction: 'x' });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'BAD_HTML');
    delete process.env.GEMINI_API_KEY;
  });
});

test('CORS preflight allows PUT/PATCH/DELETE with the Authorization header from GitHub Pages only', { skip }, async () => {
  await withServer(async base => {
    const pre = (origin, method) => fetch(base + '/api/projects/x', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type' } });
    const ok = await pre('https://pixelated-byte.github.io', 'PUT');
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://pixelated-byte.github.io');
    assert.match(ok.headers.get('access-control-allow-methods'), /PUT/); assert.match(ok.headers.get('access-control-allow-methods'), /DELETE/);
    assert.match(ok.headers.get('access-control-allow-headers').toLowerCase(), /authorization/);
    const evil = await pre('https://evil.example', 'PUT');
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });
});

test('oversized project body is rejected in the API error format', { skip }, async () => {
  await withServer(async base => {
    const r = await fetch(base + '/api/projects', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', html: 'y'.repeat(1300000) }) });
    assert.equal(r.status, 413); assert.equal((await r.json()).error.code, 'TOO_LARGE');
  });
});
