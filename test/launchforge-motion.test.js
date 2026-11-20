'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const m = require('../launchforge-motion');

const PAGE = (head = '', body = '', script = '') => '<!DOCTYPE html><html lang="en" class="js"><head><meta charset="utf-8"><title>T</title><style>' + head + '</style></head><body><main>' + body + '</main><script>' + script + '</script></body></html>';
const MODEL_CSS = `
:root{--dur-slow:900ms;--ease-out:cubic-bezier(.22,1,.36,1)}
.btn:hover{transform:translateY(-2px)}
/* Scroll reveal */
.js [data-reveal="rise"]{opacity:0;transform:translateY(18px);transition:opacity var(--dur-slow) var(--ease-out)}
.js [data-reveal="mask"]{clip-path:inset(0 0 100% 0)}
.js [data-reveal].revealed{opacity:1;clip-path:inset(0)}
.js [data-hero="1"],.js [data-hero="2"]{opacity:0;animation:heroRise 900ms forwards}
@keyframes heroRise{from{opacity:0}to{opacity:1}}
@keyframes spin{to{transform:rotate(1turn)}}
.spinner{animation:spin 1s linear infinite}
/* Reduced Motion */
@media(prefers-reduced-motion: reduce){:root{--dur-fast:1ms}.js [data-reveal]{opacity:1!important}.js [data-hero="1"]{animation:none!important}}
.card,.js [data-reveal=slide]{border:1px solid #ddd}
`;
const motionStyle = html => (html.match(/<style data-launchforge-motion[^>]*>[\s\S]*?<\/style>/) || [''])[0];
const modelStyle = html => (html.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');

test('both scripts are valid JavaScript and use none of the APIs the generated-page safety checks forbid', () => {
  for (const [name, src] of [['head', m.headBootstrap()], ['runtime', m.motionRuntime()]]) {
    assert.doesNotThrow(() => new vm.Script(src), name + ' must parse (the previous injector shipped a missing quote and never ran)');
    for (const bad of [/\bfetch\b/, /XMLHttpRequest/, /\beval\b/, /document\.write/, /\bcookie/, /localStorage|sessionStorage/, /window\.open/, /\blocation\b/, /\bimport\b/, /new Function/, /https?:\/\//]) assert.ok(!bad.test(src), name + ' contains ' + bad);
  }
});
test('applyMotion adds exactly one stylesheet, one head script and one body script, in the right places, after the page\'s own script', () => {
  const out = m.applyMotion(PAGE('.a{color:red}', '<h1>x</h1>', 'var own=1'));
  assert.equal((out.match(/data-launchforge-motion/g) || []).length, 3);
  assert.ok(out.indexOf('<style data-launchforge-motion') < out.indexOf('</head>') && out.indexOf('</head>') < out.indexOf('<body>'));
  assert.ok(out.indexOf('var own=1') < out.lastIndexOf('<script data-launchforge-motion'), 'runtime runs after the page script');
  assert.ok(out.trim().endsWith('</body></html>') || out.trimEnd().endsWith('</html>'));
  assert.equal((out.match(/new IntersectionObserver/g) || []).length, 1, 'LaunchForge adds exactly one observer');
  assert.equal(m.applyMotion('<p>fragment</p>'), '<p>fragment</p>', 'a fragment is left alone');
});
test('applyMotion is idempotent and upgrades a previous injection in place instead of stacking another system', () => {
  const once = m.applyMotion(PAGE(MODEL_CSS, '<h1 data-hero="1">x</h1><div data-reveal="rise">a</div>', 'var a=1'));
  assert.equal(m.applyMotion(once), once);
  assert.equal((m.applyMotion(m.applyMotion(once)).match(/data-launchforge-motion/g) || []).length, 3);
  // a page that carries the OLD injected runtime (data-lf-*, .lf-in, html.lf-motion-ready) plus the model's own system: exactly one system remains
  const old = PAGE(MODEL_CSS, '<h1 data-hero="1">x</h1><div data-reveal="rise">a</div>').replace('</head>', '<style data-launchforge-motion="1">html.lf-motion-ready [data-lf-reveal]{opacity:0}[data-hero="2"]{animation:lf-enter 1s}</style></head>').replace('</body>', '<script data-launchforge-motion="1">(function(){var io=new IntersectionObserver(function(){});r.classList.add("lf-motion-ready")})();</script></body>');
  const fixed = m.applyMotion(old);
  assert.ok(!/lf-motion-ready|lf-enter|data-lf-reveal|lf-in\b/.test(fixed.replace(m.motionCss(), '').replace(m.motionRuntime(), '')), 'nothing of the old injection survives');
  assert.equal((fixed.match(/data-launchforge-motion/g) || []).length, 3); assert.equal((fixed.match(/new IntersectionObserver/g) || []).length, 1);
  assert.equal(m.stripInjected(fixed).includes('data-launchforge-motion'), false, 'stripInjected returns the page without LaunchForge blocks (for the edit prompt)');
});
test('the model\'s own hero/reveal CSS is removed, everything else it styled is kept', () => {
  const css = modelStyle(m.applyMotion(PAGE(MODEL_CSS, '<h1 data-hero="1">x</h1>')));
  assert.ok(!/data-hero|data-reveal|\.revealed|heroRise/.test(css), css);
  assert.match(css, /\.btn:hover\{transform:translateY\(-2px\)\}/); assert.match(css, /--dur-slow:900ms/);
  assert.match(css, /@keyframes spin/); assert.match(css, /\.spinner\{animation:spin/);
  assert.match(css, /@media\(prefers-reduced-motion: reduce\)\{:root\{--dur-fast:1ms\}\}/, 'the model\'s reduced-motion tokens survive; only its hook rules go');
  assert.match(css, /\.card\{border:1px solid #ddd\}/, 'a selector list keeps its non-hook selectors');
  assert.match(css, /\/\* Reduced Motion \*\/\s*@media/, 'comments in front of kept rules are preserved');
  assert.ok(m.applyMotion(PAGE('.a{color:red}')).includes('<style>.a{color:red}</style>'), 'a page with no motion CSS keeps its CSS byte for byte');
  // strings and nested braces do not confuse the walker
  const tricky = modelStyle(m.applyMotion(PAGE('.x::after{content:"}{ [data-reveal]"}@supports (display:grid){.js [data-reveal]{opacity:0}.g{display:grid}}@font-face{font-family:F;src:local(x)}')));
  assert.match(tricky, /content:"\}\{ \[data-reveal\]"/); assert.match(tricky, /@supports \(display:grid\)\{\.g\{display:grid\}\}/); assert.match(tricky, /@font-face/);
  assert.match(modelStyle(m.applyMotion(PAGE('.reveal{opacity:0}.js .reveal.in{opacity:1}.reveals-title{margin:0}.is-visible{opacity:1}'))), /^<style>\.reveals-title\{margin:0\}\.is-visible\{opacity:1\}<\/style>$/, 'legacy .reveal rules go; look-alike names stay');
});
test('nothing can be hidden unless the runtime is armed: every hero/reveal rule sits under html.lf-ready', () => {
  const css = m.motionCss();
  for (const rule of css.match(/[^{}]+\{[^{}]*\}/g)) { const sel = rule.slice(0, rule.indexOf('{')).trim(); if (/data-hero|data-reveal/.test(sel) && !/^@keyframes/.test(sel)) assert.ok(sel.split(/,(?![^(]*\))/).every(s => /^html\.lf-ready /.test(s.trim())), sel); }
  assert.ok(!/^\[data-/m.test(css), 'no bare data-hero/data-reveal selector');
  assert.match(m.headBootstrap(), /r\.classList\.add\('lf-ready'\)/); assert.match(m.headBootstrap(), /if\(!\('IntersectionObserver' in window\)\)return/);
});
test('masks clip the media inside the observed element, never the observed element (a fully clipped element never counts as intersecting)', () => {
  const rules = m.motionCss().match(/[^{}]+\{[^{}]*\}/g).filter(r => /clip-path/.test(r.slice(r.indexOf('{'))) && !/@keyframes|^from|^to/.test(r));
  assert.ok(rules.length >= 3);
  for (const r of rules.filter(r => !/clip-path:\s*none\s*!important/.test(r))) { const sel = r.slice(0, r.indexOf('{')); assert.ok(/data-lf-media|data-hero="4"|prefers/.test(sel + r), 'clip-path only on media or the hero wipe: ' + sel); assert.ok(!/\[data-reveal="mask"\]\s*(\{|,|:not\(\.lf-in\)\s*\{)/.test(sel), 'observed element clipped: ' + sel); }
});
test('only compositor-friendly properties are animated, with natural easing and no transition: all', () => {
  const css = m.motionCss(), props = new Set();
  for (const t of css.match(/transition:[^;}]+/g)) t.slice(11).split(/,(?![^(]*\))/).forEach(p => props.add(p.trim().split(/\s+/)[0]));
  assert.deepEqual([...props].filter(p => !p.startsWith('none')).sort(), ['clip-path', 'opacity', 'transform']);
  assert.ok(!/transition:\s*all|scroll-behavior:\s*smooth|infinite|bounce|elastic|parallax/.test(css));
  const d = [...css.matchAll(/(\d+)ms/g)].map(x => Number(x[1])); assert.ok(Math.max(...d) <= 1300 && d.filter(x => x >= 400).length >= 4);
  assert.ok([...new Set(d.filter(x => x > 0))].length >= 6, 'durations are varied, not one uniform value');
  for (const e of css.match(/cubic-bezier\([^)]*\)/g)) { const n = e.match(/-?[\d.]+/g).map(Number); assert.ok(n[1] >= 0 && n[3] <= 1.001, 'no overshoot: ' + e); }
  assert.match(css, /prefers-reduced-motion:reduce\)\{html\{scroll-behavior:auto\}/);
});
// run the real head script against a stub DOM
function runHead({ reduce, io = true }) {
  const classes = new Set(), timers = []; let removed = false;
  const el = { prototype: { scrollIntoView(a) { el.last = a; } } };
  const win = { matchMedia: () => ({ matches: reduce }), setTimeout: (f, t) => { timers.push([f, t]); return 1; } };
  if (io) win.IntersectionObserver = function () {};
  const ctx = { document: { documentElement: { classList: { add: c => classes.add(c), remove: c => { classes.delete(c); removed = true; } } } }, window: win, Element: el, setTimeout: win.setTimeout };
  vm.runInNewContext(m.headBootstrap(), Object.assign(ctx, { window: Object.assign(win, ctx) }));
  return { classes, timers, el, win };
}
test('head script: armed only when motion is allowed and IntersectionObserver exists; arms a 4 second failsafe; reduced motion makes scrolling instant', () => {
  const on = runHead({ reduce: false }); assert.ok(on.classes.has('lf-ready')); assert.equal(on.timers.length, 1); assert.equal(on.timers[0][1], 4000);
  on.timers[0][0](); assert.ok(!on.classes.has('lf-ready'), 'the failsafe un-arms the page');
  const noIo = runHead({ reduce: false, io: false }); assert.ok(!noIo.classes.has('lf-ready')); assert.equal(noIo.timers.length, 0);
  const rm = runHead({ reduce: true }); assert.ok(!rm.classes.has('lf-ready')); assert.equal(rm.timers.length, 0);
  rm.el.prototype.scrollIntoView({ behavior: 'smooth', block: 'start' }); assert.equal(rm.el.last.behavior, 'auto'); assert.equal(rm.el.last.block, 'start');
  rm.el.prototype.scrollIntoView(true); assert.equal(rm.el.last, true);
});
test('runtime: one observer, observes the reveal hooks, staggers only what enters together (four steps at most), clears the failsafe', () => {
  const rt = m.motionRuntime();
  assert.equal((rt.match(/new IntersectionObserver/g) || []).length, 1); assert.match(rt, /io\.unobserve\(e\)/); assert.match(rt, /Math\.min\(i,4\)\*70/);
  assert.match(rt, /if\(!r\.classList\.contains\('lf-ready'\)\|\|r\.hasAttribute\('data-lf-live'\)\)return/, 'does nothing when not armed or already running');
  assert.match(rt, /clearTimeout\(window\.__lfFailsafe\)/); assert.match(rt, /threshold:0/);
  assert.match(rt, /data-lf-media/); assert.match(rt, /else e\.setAttribute\('data-reveal','rise'\)/, 'a mask without media or lines without .line falls back to rise');
  assert.match(rt, /section:not\(:first-child\) :is\(h2,figure,\.plate,blockquote\)/, 'pages without hooks (older saved projects) still get a hero and reveals');
});
test('advisory checks catch the failure modes found in real generated pages and are silent on a clean page', () => {
  const codes = h => m.motionProblems(h).map(p => p.code);
  const bad = PAGE(MODEL_CSS + '.nav-mobile{position:fixed;inset:0;z-index:55}header{position:fixed;z-index:50}', '<h1>x</h1>');
  assert.deepEqual(codes(bad).sort(), ['maskobserved', 'modelmotion', 'navcover', 'staticjs']);
  for (const p of m.motionProblems(bad)) { assert.equal(p.critical, false); assert.equal(p.advisory, true); assert.ok(p.message.length > 40); }
  assert.deepEqual(codes(PAGE('.nav-mobile{position:fixed;inset:0;z-index:55}header{position:fixed;z-index:60}')), [], 'header above the panel is fine');
  assert.deepEqual(codes(PAGE('.a{color:red}').replace(' class="js"', '')), []);
  assert.deepEqual(codes(m.applyMotion(bad)).sort(), ['navcover'], 'applyMotion resolves the motion problems; the menu layering stays a prompt/validator matter');
});
test('a motion-injected page still passes the generated-page safety validators', () => {
  let ai; try { ai = require('../site-ai'); } catch { return; }
  if (!ai.validateOutput || !ai.generationProblems) return;
  const sections = ['home', 'services', 'about', 'contact'].map((id, i) => '<section id="' + id + '">' + (i ? '<h2>' + id + ' heading</h2>' : '<h1 data-hero="1">Furniture made to be lived with</h1>') + '<p data-reveal="rise">Copy for ' + id + ' written from the description.</p></section>').join('');
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio</title><meta name="description" content="d"><style>body{margin:0}' + MODEL_CSS + '</style></head><body><header><a href="#home">Studio</a><nav><a href="#services">Services</a><a href="#about">About</a><a href="#contact">Contact</a></nav></header><main>' + sections.replace(/<h2>/g, '<h2 data-reveal="lines">') + '</main><footer>Studio, Generated with LaunchForge</footer><script>document.documentElement.classList.add("x")</script></body></html>';
  const out = m.applyMotion(html);
  assert.equal(ai.validateOutput(out, 150000), null);
  assert.deepEqual(ai.generationProblems(out, { name: 'Studio', type: 'other', style: 'Modern', desc: 'A furniture studio', audience: '', pages: [] }).filter(p => p.critical), []);
});

// Run the real runtime against a small stand-in DOM, so the behaviour (not just the source text) is tested.
function runRuntime(spec) {
  const mk = (kind, o = {}) => { const a = { 'data-reveal': kind }; return { a, style: { vars: {}, setProperty(k, v) { this.vars[k] = v; } }, classes: new Set(), classList: { add(c) { this._s.add(c); }, _s: null }, getAttribute: n => (n in a ? a[n] : null), setAttribute: (n, v) => { a[n] = v; }, hasAttribute: n => n in a, querySelector: sel => (o.children && o.children[sel]) || null, order: o.order || 0 }; };
  const els = spec.map((s, i) => { const e = mk(s.kind, { children: s.children, order: i }); e.classList._s = e.classes; return e; });
  let cb, observed = [], unobserved = [];
  const root = { classList: { contains: c => c === 'lf-ready' }, hasAttribute: () => false, setAttribute() { root.live = true; } };
  const main = {};
  const doc = { documentElement: root, body: main, querySelector: s => (s === 'main' ? main : s.includes('data-hero') ? {} : null), querySelectorAll: s => (s === '[data-reveal]' ? els : []) };
  els.forEach(e => { e.compareDocumentPosition = o => (o.order > e.order ? 4 : 2); });
  const win = { IntersectionObserver: function (f) { cb = f; this.observe = e => observed.push(e); this.unobserve = e => unobserved.push(e); }, clearTimeout: () => { win.cleared = true; } };
  vm.runInNewContext(m.motionRuntime(), { document: doc, window: win, IntersectionObserver: win.IntersectionObserver, clearTimeout: win.clearTimeout });
  return { els, observed, unobserved, fire: entries => cb(entries.map(e => ({ target: e, isIntersecting: true }))), root, win };
}
test('runtime behaviour: each hook keeps the treatment it can perform, masks mark their media, everything is observed once and staggers by entry order', () => {
  const media = { attrs: {}, setAttribute(n, v) { this.attrs[n] = v; } };
  const run = runRuntime([{ kind: 'lines', children: { '.line>span': {} } }, { kind: 'lines' }, { kind: 'mask', children: { 'figure img,.art,img,picture,svg': media } }, { kind: 'mask' }, { kind: 'slide' }, { kind: 'rule' }, { kind: 'rise' }, { kind: 'wiggle' }]);
  assert.deepEqual(run.els.map(e => e.a['data-reveal']), ['lines', 'rise', 'mask', 'rise', 'slide', 'rule', 'rise', 'rise'], 'lines survive when the headline has .line spans; impossible or unknown kinds fall back to rise');
  assert.equal('data-lf-media' in media.attrs, true, 'the media inside a mask is marked, never the observed element');
  assert.ok(!('data-lf-media' in run.els[2].a));
  assert.equal(run.observed.length, 8); assert.ok(run.root.live && run.win.cleared, 'marks itself live and cancels the failsafe');
  run.fire([run.els[3], run.els[0], run.els[5], run.els[1], run.els[2], run.els[4], run.els[6]]);
  assert.deepEqual(run.els.filter(e => e.classes.has('lf-in')).map(e => e.order), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(run.els.slice(0, 7).map(e => e.style.vars['--lf-d']), ['0ms', '70ms', '140ms', '210ms', '280ms', '280ms', '280ms'], 'document order, four steps at most');
  assert.equal(run.unobserved.length, 7, 'each element is unobserved after it has been revealed');
  const solo = runRuntime([{ kind: 'rise' }, { kind: 'rise' }]); solo.fire([solo.els[1]]); assert.equal(solo.els[1].style.vars['--lf-d'], '0ms', 'an element entering alone is not delayed');
});
