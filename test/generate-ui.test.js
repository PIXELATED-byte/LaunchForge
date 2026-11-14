// Runs the REAL page script (index.html) inside a tiny simulated DOM and drives the website-generation flow: AI generation, the quick-template fallback,
// every failure path, cancel, and the labels. No browser and no network: fetch is a stub. (It does not replace trying the page in a real browser.)
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const START = '<div id="toast"></div>\n<script>';
const SCRIPT = html.slice(html.indexOf(START) + START.length, html.lastIndexOf('</script></body></html>'));

function makeWorld() {
  const els = {};
  const el = (extra = {}) => Object.assign({
    value: '', textContent: '', innerHTML: '', style: {}, disabled: false, className: '', dataset: {}, children: [], checked: false, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); if (c.id) els['#' + c.id] = c; return c; },
    remove() { this.removed = true; if (this.id) { delete els['#' + this.id]; world.removedIds.push(this.id); } },
    setAttribute(k, v) { this[k] = v; }, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
    querySelector() { return el(); }, querySelectorAll() { return []; }, focus() {}, scrollIntoView() {}, closest() { return null; }
  }, extra);
  const q = sel => els[sel] || (els[sel] = el());
  const fetchCalls = [];
  const world = { els, fetchCalls, fetchImpl: null, removedIds: [], intervals: 0, clearedIntervals: 0 };
  Object.defineProperty(world, 'gen', { get: () => fetchCalls.filter(c => /\/api\/generate$/.test(c.url)) });   // calls to the generation route only
  const document = {
    querySelector: q, querySelectorAll: () => [], createElement: tag => el({ tag }), addEventListener() {}, removeEventListener() {},
    body: el(), documentElement: el(), title: '', cookie: ''
  };
  const ctx = {
    document, console, clearTimeout, clearInterval: t => { world.clearedIntervals++; clearInterval(t); }, AbortController,
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); if (t.unref) t.unref(); return t; },   // the page's own timers must not keep the test process alive
    setInterval: (f, ms) => { world.intervals++; const t = setInterval(f, ms); if (t.unref) t.unref(); return t; }, URL, Date, Math, JSON, Promise,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { protocol: 'http:', hostname: 'localhost', hash: '', href: 'http://localhost:3000/', origin: 'http://localhost:3000', pathname: '/' },
    history: { replaceState() {}, pushState() {} }, navigator: {}, confirm: () => true, alert() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: f => setTimeout(f, 0), getComputedStyle: () => ({}),
    // only /api/generate is simulated; the page's own boot requests (health, session check) stay pending so they cannot change the state under test
    fetch: (url, opts) => { fetchCalls.push({ url, opts }); return /\/api\/generate$/.test(url) ? world.fetchImpl(url, opts) : new Promise(() => {}); }
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  try { vm.runInContext(SCRIPT, ctx, { timeout: 5000 }); } catch (e) { world.bootError = e; }   // boot may stumble on the simulated DOM; the declarations it needs are hoisted
  world.run = code => vm.runInContext(code, ctx);
  world.q = q;
  return world;
}

// a project form that passes read()/validate(), a logged-in user, a healthy AI backend, and an existing draft the tests can check is preserved
function ready(w, { auth = 'in', ai = 'ready', draft = true } = {}) {
  const f = { '#n': 'Brightside Bakery', '#t': 'cafe', '#st': 'Elegant', '#d': 'Family-run bakery in Leeds. Sourdough, celebration cakes and local delivery.', '#a': 'Local families' };
  for (const k of Object.keys(f)) w.q(k).value = f[k];
  w.run(`cur={name:'Brightside Bakery',type:'cafe',style:'Elegant',desc:'x',audience:'',pages:[],history:[],id:null,src:'local',version:0};
         saver=null; aiBusy=false; aiStatus=${JSON.stringify(ai)}; auth.state=${JSON.stringify(auth)}; auth.csrf='csrf-token-1'; auth.user=${auth === 'in' ? "{id:'u1',email:'a@example.com'}" : 'null'};
         draft=${draft ? "{html:'<!DOCTYPE html><html><body>OLD SITE</body></html>',at:1,mode:'demo',saved:true}" : 'null'};`);
  w.q('#genmsg').innerHTML = ''; w.q('#gen').disabled = false;
}
const okJson = body => async () => ({ ok: true, status: 200, json: async () => body });
const errJson = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { code: 'X', message } }) });
const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="generator" content="LaunchForge AI"><title>Brightside Bakery</title></head><body><h1>Sourdough in Leeds</h1></body></html>';
const tick = ms => new Promise(r => setTimeout(r, ms));

test('the page script loads in the simulated DOM and exposes the generation functions', () => {
  const w = makeWorld();
  for (const fn of ['generate', 'generateAi', 'generateTemplate', 'canAiGenerate', 'modeNote', 'genMsg']) assert.equal(w.run('typeof ' + fn), 'function', fn);
});

test('AI generation: calls /api/generate with credentials, CSRF and only the brief; the result becomes the draft; UI returns to normal', async () => {
  const w = makeWorld(); ready(w);
  w.fetchImpl = okJson({ html: PAGE, model: 'm', attempts: 1 });
  await w.run('generate()');
  assert.equal(w.gen.length, 1);
  const { url, opts } = w.gen[0];
  assert.equal(url, '/api/generate'); assert.equal(opts.method, 'POST'); assert.equal(opts.credentials, 'include');
  assert.equal(opts.headers['X-CSRF-Token'], 'csrf-token-1'); assert.equal(opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(opts.body), { name: 'Brightside Bakery', type: 'cafe', style: 'Elegant', desc: 'Family-run bakery in Leeds. Sourdough, celebration cakes and local delivery.', audience: 'Local families', pages: [] });
  assert.equal(w.run('draft.mode'), 'ai'); assert.equal(w.run('draft.saved'), false); assert.equal(w.run('cur.history.length'), 0);
  assert.ok(w.run('draft.html').includes('<h1>Sourdough in Leeds</h1>'));
  assert.ok(w.run('draft.html').includes('scrollIntoView'), 'the preview navigation helper is added when the page has none');
  assert.equal(w.run('aiBusy'), false); assert.equal(w.q('#gen').disabled, false); assert.equal(w.q('#gen').textContent, 'Regenerate with AI');
  assert.match(w.q('#genmsg').innerHTML, /written by AI/); assert.ok(!/Try again/.test(w.q('#genmsg').innerHTML));
  assert.ok(w.removedIds.includes('genov'), 'the progress overlay is removed');
  assert.ok(w.intervals >= 1); assert.equal(w.clearedIntervals, w.intervals, 'the progress timer is always cleared');
});
test('AI generation: a page that already has its own smooth-scroll code is not given a second one', async () => {
  const w = makeWorld(); ready(w);
  w.fetchImpl = okJson({ html: PAGE.replace('</body>', '<script>document.body.scrollIntoView()</script></body>') });
  await w.run('generate()');
  assert.equal((w.run('draft.html').match(/scrollIntoView/g) || []).length, 1);
});
test('a linked project name is sent so the server can check ownership; unsaved or local projects send none', async () => {
  const w = makeWorld(); ready(w); w.run("cur.src='server';cur.id='11111111-1111-4111-8111-111111111111'");
  w.fetchImpl = okJson({ html: PAGE }); await w.run('generate()');
  assert.equal(JSON.parse(w.gen[0].opts.body).projectId, '11111111-1111-4111-8111-111111111111');
  const w2 = makeWorld(); ready(w2); w2.fetchImpl = okJson({ html: PAGE }); await w2.run('generate()');
  assert.equal('projectId' in JSON.parse(w2.gen[0].opts.body), false);
});

test('failure paths keep the current website, say so, offer Try again and the quick template, and leave the page usable', async () => {
  const cases = [
    ['server refused the output', errJson(502, 'The AI could not produce a page that passed our quality and safety checks.'), /could not produce a page/],
    ['rate limit', errJson(429, 'Too many website generations. Wait a minute and try again.'), /Too many website generations/],
    ['not configured', errJson(503, 'GEMINI_API_KEY is missing from .env.'), /GEMINI_API_KEY/],
    ['non-JSON error page', async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }), /unexpected response \(HTTP 500\)/],
    ['ok but no html', okJson({ model: 'm' }), /unexpected response/],
    ['incomplete html', okJson({ html: '<!DOCTYPE html><html><body>cut off' }), /incomplete page/],
    ['network down', async () => { throw new TypeError('Failed to fetch'); }, /Could not reach the AI backend/]
  ];
  for (const [label, impl, re] of cases) {
    const w = makeWorld(); ready(w); w.fetchImpl = impl;
    await w.run('generate()');
    const m = w.q('#genmsg').innerHTML;
    assert.match(m, re, label); assert.match(m, /Your current website was not changed/, label);
    assert.match(m, /id="gm_r"/, label); assert.match(m, /id="gm_t"/, label); assert.match(m, /class="msg err"/, label);
    assert.ok(w.run('draft.html').includes('OLD SITE'), label + ': the existing draft is untouched');
    assert.equal(w.run('draft.mode'), 'demo', label); assert.equal(w.run('aiBusy'), false, label); assert.equal(w.q('#gen').disabled, false, label);
    assert.ok(w.removedIds.includes('genov'), label); assert.equal(w.clearedIntervals, w.intervals, label + ': the progress timer is cleared');
  }
});
test('failure messages are escaped (server text can never inject markup into the page)', async () => {
  const w = makeWorld(); ready(w); w.fetchImpl = errJson(502, '<img src=x onerror=alert(1)>');
  await w.run('generate()');
  assert.ok(!w.q('#genmsg').innerHTML.includes('<img'));
  assert.ok(w.q('#genmsg').innerHTML.includes('&lt;img'));
});
test('an expired session (401) logs the page out of the AI features and says why', async () => {
  const w = makeWorld(); ready(w); w.fetchImpl = errJson(401, 'Log in required');
  await w.run('generate()');
  assert.equal(w.run('auth.state'), 'out');
  assert.match(w.q('#genmsg').innerHTML, /session expired/); assert.ok(w.run('draft.html').includes('OLD SITE'));
});
test('Try again and Use quick template buttons are wired', async () => {
  const w = makeWorld(); ready(w); w.fetchImpl = errJson(502, 'nope');
  await w.run('generate()');
  assert.equal(typeof w.q('#gm_r').onclick, 'function'); assert.equal(typeof w.q('#gm_t').onclick, 'function');
  w.fetchImpl = okJson({ html: PAGE });
  await w.q('#gm_r').onclick();
  assert.equal(w.gen.length, 2); assert.equal(w.run('draft.mode'), 'ai'); assert.match(w.q('#genmsg').innerHTML, /written by AI/);
});
test('Cancel aborts the request, keeps the old site and says it was cancelled (not "timed out")', async () => {
  const w = makeWorld(); ready(w);
  w.fetchImpl = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const p = w.run('generate()');
  await tick(20);
  assert.equal(w.run('aiBusy'), true); assert.equal(w.q('#gen').disabled, true); assert.equal(w.q('#gen').textContent, 'Generating with AI\u2026');
  assert.match(w.q('#gov_s').textContent, /usually 30\u201390 seconds/); assert.match(w.q('#gov_t').textContent, /Planning the page structure/);
  w.q('#gov_x').onclick();
  await p;
  assert.match(w.q('#genmsg').innerHTML, /Generation was cancelled/); assert.ok(!/timed out/.test(w.q('#genmsg').innerHTML));
  assert.ok(w.run('draft.html').includes('OLD SITE')); assert.equal(w.run('aiBusy'), false);
});
test('while one generation runs, a second request is refused (no double spend)', async () => {
  const w = makeWorld(); ready(w); let release;
  w.fetchImpl = () => new Promise(r => { release = () => r({ ok: true, status: 200, json: async () => ({ html: PAGE }) }); });
  const p = w.run('generate()'); await tick(10);
  w.run('generate()'); await tick(10);          // not awaited: a refused request returns at once
  assert.equal(w.gen.length, 1);
  release(); await p;
  assert.equal(w.run('draft.mode'), 'ai');
});

test('quick template: used when logged out, when the backend is down or unconfigured, or when asked for; never calls the AI route', async () => {
  for (const [label, opts, code] of [['logged out', { auth: 'out' }, 'generate()'], ['no api key', { ai: 'noconfig' }, 'generate()'], ['backend down', { ai: 'down' }, 'generate()'],
    ['AI ready but template requested', {}, 'generate({template:true})']]) {
    const w = makeWorld(); ready(w, opts); w.fetchImpl = () => { throw new Error('must not be called'); };
    w.run(code); await tick(650);
    assert.equal(w.gen.length, 0, label); assert.equal(w.run('draft.mode'), 'demo', label);
    assert.ok(!w.run('draft.html').includes('OLD SITE'), label + ': the template replaced the draft as before'); assert.ok(w.run('draft.html').includes('Brightside Bakery'), label);
    assert.equal(w.q('#gen').disabled, false, label);
  }
});

test('mode note and button labels tell the truth in every state', () => {
  const note = (opts) => { const w = makeWorld(); ready(w, opts); w.run('modeNote()'); return { text: w.q('#modeNote').innerHTML, btn: w.q('#gen').textContent, tpl: w.q('#gen_tpl').style.display }; };
  let n = note({}); assert.match(n.text, /<b>AI generation<\/b>/); assert.equal(n.btn, 'Regenerate with AI'); assert.equal(n.tpl, '');
  n = note({ draft: false }); assert.equal(n.btn, 'Generate with AI');
  n = note({ auth: 'out' }); assert.match(n.text, /Quick template/); assert.match(n.text, /Log in/); assert.equal(n.btn, 'Regenerate Website'); assert.equal(n.tpl, 'none');
  n = note({ ai: 'noconfig', draft: false }); assert.match(n.text, /no Gemini API key/); assert.equal(n.btn, 'Generate Website');
  n = note({ ai: 'down' }); assert.match(n.text, /not reachable/);
  n = note({ ai: 'checking' }); assert.match(n.text, /checking/);
  assert.ok(!/Demonstration|not configured/.test(html.match(/id="modeNote"[^>]*>[^<]*/)[0]), 'no stale static claim in the markup');
});

test('the state box and undo recognise an AI-written page by its generator marker', () => {
  const w = makeWorld(); ready(w);
  w.run(`draft={html:${JSON.stringify(PAGE)},at:Date.now(),mode:'ai',saved:false}; stateBox0()`);
  assert.match(w.q('#state').innerHTML, /written by AI/);
  w.run(`draft={html:'<!DOCTYPE html><html><body>x</body></html>',at:Date.now(),mode:'ai',saved:false}; cur.history=[{instruction:'a',prev:'<html></html>',at:1}]; stateBox0()`);
  assert.match(w.q('#state').innerHTML, /template, edited with AI/); assert.match(w.q('#state').innerHTML, /1 edit\(s\)/);
  w.run('draft.mode=\'demo\'; stateBox0()'); assert.match(w.q('#state').innerHTML, /quick template \(not AI\)/);
  w.run(`cur.history=[{instruction:'make it red',prev:${JSON.stringify(PAGE)},at:1}]; draft={html:'<html>edited</html>',at:1,mode:'ai',saved:false}; undoEdit()`);
  assert.equal(w.run('draft.mode'), 'ai', 'undoing back to an AI-written page keeps it labelled as AI');
  w.run(`cur.history=[{instruction:'x',prev:'<html>template</html>',at:1}]; undoEdit()`);
  assert.equal(w.run('draft.mode'), 'demo', 'undoing back to a template page is a template again');
});
