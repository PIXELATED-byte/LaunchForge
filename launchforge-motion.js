'use strict';
// LaunchForge motion: ONE owner for hero entrances and scroll reveals.
//
// Contract: the generated page supplies markup hooks only (data-hero="1".."4", data-reveal="rise|slide|mask|lines|rule") and its own design.
// LaunchForge supplies the single stylesheet and the single script that animate those hooks. applyMotion() is idempotent, so it is safe to call on
// every generate, edit, save and export. Anything the model wrote to animate the same hooks is removed first, because two systems driving one
// element fight each other (see the Oakwell audit: the injected stage rules replaced the model's clip-path animation and left the hero image clipped forever).
//
// Properties: nothing is hidden unless JavaScript is running and motion is allowed; if the runtime fails the page reveals itself after a timeout;
// reduced motion shows everything immediately and makes scrollIntoView instant; only transform, opacity and clip-path (on media) are animated.

const MARK = 'data-launchforge-motion';
const VERSION = '2';

// ---------- the stylesheet ----------
function motionCss() {
  return [
    '@keyframes lf-up{from{opacity:0;transform:translate3d(0,18px,0)}to{opacity:1;transform:none}}',
    '@keyframes lf-line{from{transform:translate3d(0,105%,0)}to{transform:none}}',
    '@keyframes lf-wipe{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}',
    '@keyframes lf-settle{from{transform:scale(1.06)}to{transform:none}}',
    // hero: headline lines, then copy, then calls to action, then the visual (which starts while the buttons are still arriving); about 1.4s in total
    'html.lf-ready [data-hero]{animation:lf-up 800ms cubic-bezier(.22,1,.36,1) both;animation-delay:var(--lf-d,0ms)}',
    'html.lf-ready [data-hero="2"]{--lf-d:200ms}html.lf-ready [data-hero="3"]{--lf-d:340ms}',
    'html.lf-ready [data-hero="4"]{--lf-d:380ms;animation:lf-wipe 1000ms cubic-bezier(.65,0,.35,1) both;animation-delay:380ms}',
    'html.lf-ready [data-hero="4"] :is(img,svg,.art){animation:lf-settle 1300ms cubic-bezier(.22,1,.36,1) both;animation-delay:380ms}',
    'html.lf-ready [data-hero="1"]:has(.line){animation:none}',
    'html.lf-ready [data-hero="1"] .line{display:block;overflow:hidden;padding-bottom:.1em;margin-bottom:-.1em}',
    'html.lf-ready [data-hero="1"] .line>span{display:block;animation:lf-line 900ms cubic-bezier(.22,1,.36,1) both}',
    'html.lf-ready [data-hero="1"] .line:nth-child(2)>span{animation-delay:80ms}html.lf-ready [data-hero="1"] .line:nth-child(3)>span{animation-delay:160ms}html.lf-ready [data-hero="1"] .line:nth-child(n+4)>span{animation-delay:240ms}',
    // reveals: the observed element is never clipped (a fully clipped element never counts as intersecting); masks clip the media inside it
    'html.lf-ready [data-reveal]{transition:opacity 700ms cubic-bezier(.22,1,.36,1),transform 700ms cubic-bezier(.22,1,.36,1);transition-delay:var(--lf-d,0ms)}',
    'html.lf-ready [data-reveal="rise"]:not(.lf-in){opacity:0;transform:translate3d(0,18px,0)}',
    'html.lf-ready [data-reveal="slide"]:not(.lf-in){opacity:0;transform:translate3d(-24px,0,0)}',
    'html.lf-ready [data-reveal="rule"]:not(.lf-in){transform:scaleX(0);transform-origin:left}',
    'html.lf-ready [data-reveal="lines"] .line{display:block;overflow:hidden;padding-bottom:.1em;margin-bottom:-.1em}',
    'html.lf-ready [data-reveal="lines"] .line>span{display:block;transition:transform 900ms cubic-bezier(.22,1,.36,1);transition-delay:var(--lf-d,0ms)}',
    'html.lf-ready [data-reveal="lines"]:not(.lf-in) .line>span{transform:translate3d(0,105%,0)}',
    'html.lf-ready [data-reveal="mask"] [data-lf-media]{transition:clip-path 900ms cubic-bezier(.65,0,.35,1),transform 1200ms cubic-bezier(.22,1,.36,1);transition-delay:var(--lf-d,0ms)}',
    'html.lf-ready [data-reveal="mask"]:not(.lf-in) [data-lf-media]{clip-path:inset(0 0 100% 0);transform:scale(1.05)}',
    'html.lf-ready [data-reveal="mask"]{transition:none}',
    '@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}html.lf-ready [data-hero],html.lf-ready [data-hero] *,html.lf-ready [data-reveal],html.lf-ready [data-reveal] *{animation:none!important;transition:none!important;opacity:1!important;transform:none!important;clip-path:none!important}}'
  ].join('\n');
}

// ---------- the head script: decides whether motion may run, and arms the failsafe ----------
function headBootstrap() {
  return "(function(){var r=document.documentElement,m=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;" +
    "if(m){var o=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(a){return o.call(this,a&&typeof a==='object'?{block:a.block,inline:a.inline,behavior:'auto'}:a)};return}" +
    "if(!('IntersectionObserver' in window))return;r.classList.add('lf-ready');" +
    "window.__lfFailsafe=setTimeout(function(){r.classList.remove('lf-ready')},4000)})();";
}

// ---------- the body script: prepares hooks, observes once, staggers whatever enters together ----------
function motionRuntime() {
  return "(function(){var d=document,r=d.documentElement;if(!r.classList.contains('lf-ready')||r.hasAttribute('data-lf-live'))return;" +
    "function first(el,sel){return el.querySelector(sel)}" +
    // pages with no hooks at all (older saved projects): derive them from the structure
    "var main=d.querySelector('main')||d.body;" +
    "if(!d.querySelector('[data-hero],[data-reveal]')){var h=main.querySelector('h1');if(h){h.setAttribute('data-hero','1');var s=h.closest('section')||main;" +
    "[].forEach.call(s.querySelectorAll('p,ul,.actions,.btn,.button,a.btn,a.button'),function(e){if(!h.contains(e)&&!e.closest('[data-hero]')&&!e.closest('.hero-visual'))e.setAttribute('data-hero',e.matches('p')?'2':'3')});" +
    "var v=s.querySelector('figure,.hero-visual,.visual,svg');if(v&&!v.closest('[data-hero]'))v.setAttribute('data-hero','4')}" +
    "[].forEach.call(main.querySelectorAll('section:not(:first-child) :is(h2,figure,.plate,blockquote)'),function(e){if(!e.closest('[data-reveal]'))e.setAttribute('data-reveal',e.matches('figure,.plate')?'mask':'rise')})}" +
    // each reveal gets a kind it can actually perform
    "var items=[].slice.call(d.querySelectorAll('[data-reveal]'));" +
    "items.forEach(function(e){var k=e.getAttribute('data-reveal');" +
    "if(k==='mask'){var m=first(e,'figure img,.art,img,picture,svg')||first(e,'figure');if(m){m.setAttribute('data-lf-media','')}else e.setAttribute('data-reveal','rise')}" +
    "else if(k==='lines'){if(!first(e,'.line>span'))e.setAttribute('data-reveal','rise')}" +
    "else if(['rise','slide','rule'].indexOf(k)<0)e.setAttribute('data-reveal','rise')});" +
    // one observer; elements that enter in the same frame follow each other 70ms apart (four steps at most), alone they enter at once
    "var io=new IntersectionObserver(function(es){var hit=es.filter(function(x){return x.isIntersecting}).map(function(x){return x.target});" +
    "hit.sort(function(a,b){return a.compareDocumentPosition(b)&2?1:-1});" +
    "hit.forEach(function(e,i){e.style.setProperty('--lf-d',Math.min(i,4)*70+'ms');e.classList.add('lf-in');io.unobserve(e)})},{threshold:0,rootMargin:'0px 0px -8% 0px'});" +
    "items.forEach(function(e){io.observe(e)});" +
    "r.setAttribute('data-lf-live','');clearTimeout(window.__lfFailsafe)})();";
}

// ---------- removing what a previous run or the model wrote ----------
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function stripInjected(html) {
  const re = new RegExp('<(style|script)\\b[^>]*\\b' + escapeRe(MARK) + '\\b[^>]*>[\\s\\S]*?</\\1>\\s*', 'gi');
  return String(html).replace(re, '');
}

// selectors that belong to a reveal/hero animation system
const HOOK = /\[data-(?:hero|reveal|stagger|lf-[\w-]+)\b|\.revealed\b|\.lf-(?:in|ready)\b|\.reveal(?:-[\w-]+)?\b/;
// brace-aware walk over top-level rules; recurses into @media/@supports/@layer/@container
function filterRules(css) {
  let out = '', i = 0;
  const n = css.length;
  while (i < n) {
    // comments pass through
    if (css.startsWith('/*', i)) { const e = css.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; out += css.slice(i, j); i = j; continue; }
    const brace = css.indexOf('{', i), semi = css.indexOf(';', i);
    if (brace < 0 && semi < 0) { out += css.slice(i); break; }
    if (semi >= 0 && (brace < 0 || semi < brace)) { out += css.slice(i, semi + 1); i = semi + 1; continue; }   // @import, @charset, a stray declaration
    // find the matching close brace (strings and comments skipped)
    let depth = 1, j = brace + 1, q = null;
    while (j < n && depth) {
      const c = css[j];
      if (q) { if (c === '\\') j++; else if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (css.startsWith('/*', j)) { const e = css.indexOf('*/', j + 2); j = e < 0 ? n : e + 1; }
      else if (c === '{') depth++; else if (c === '}') depth--;
      j++;
    }
    const prelude = css.slice(i, brace), body = css.slice(brace + 1, j - 1), lead = prelude.match(/^(?:\s|\/\*[\s\S]*?\*\/)*/)[0], head = prelude.slice(lead.length).trim();   // comments before a rule are kept in `lead`
    if (/^@(?:media|supports|layer|container|document)\b/i.test(head)) {
      const inner = filterRules(body);
      if (inner.trim()) out += lead + head + '{' + inner + '}';
    } else if (/^@/.test(head)) {
      out += css.slice(i, j);   // @keyframes, @font-face, @page: handled by the caller
    } else {
      const keep = head.split(',').map(s => s.trim()).filter(s => !HOOK.test(s));
      if (keep.length) out += lead + keep.join(',') + '{' + body + '}';
    }
    i = j;
  }
  return out;
}
function dropUnusedKeyframes(styleTexts) {
  const all = styleTexts.join('\n');
  return styleTexts.map(t => t.replace(/@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, (m, name) => {
    const uses = all.split(name).length - 1;   // the definition itself counts once
    return uses > 1 ? m : '';
  }));
}
// remove the model's own hero/reveal CSS from every non-LaunchForge <style> block; the model keeps all other styling
function neutralizeModelMotion(html) {
  const blocks = [];
  html = html.replace(/(<style\b(?![^>]*\bdata-launchforge-motion\b)[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, c) => { blocks.push(filterRules(css)); return a + '\u0000' + (blocks.length - 1) + '\u0000' + c; });
  const cleaned = dropUnusedKeyframes(blocks);
  return html.replace(/\u0000(\d+)\u0000/g, (m, i) => cleaned[Number(i)]);
}

// ---------- the one entry point ----------
function applyMotion(html) {
  let out = neutralizeModelMotion(stripInjected(String(html)));
  const headEnd = out.search(/<\/head>/i), bodyEnd = out.search(/<\/body>/i) >= 0 ? out.search(/<\/body>/i) : out.search(/<\/html>/i);
  if (headEnd < 0 || bodyEnd < 0) return out;   // not a full page: leave it alone
  const head = '<style ' + MARK + '="' + VERSION + '">\n' + motionCss() + '\n</style>\n<script ' + MARK + '="' + VERSION + '">' + headBootstrap() + '</script>\n';
  const body = '<script ' + MARK + '="' + VERSION + '">' + motionRuntime() + '</script>\n';
  out = out.slice(0, headEnd) + head + out.slice(headEnd);
  const b2 = out.search(/<\/body>/i) >= 0 ? out.search(/<\/body>/i) : out.search(/<\/html>/i);
  return out.slice(0, b2) + body + out.slice(b2);
}

// ---------- advisory checks for the generation validator (same shape as designProblems entries) ----------
function motionProblems(html) {
  const out = [], add = (code, message) => out.push({ code, critical: false, advisory: true, message });
  const css = (String(html).match(/<style\b(?![^>]*\bdata-launchforge-motion\b)[^>]*>[\s\S]*?<\/style>/gi) || []).join('\n');
  const own = filterRules(css) !== css;
  if (/<html\b[^>]*\bclass\s*=\s*["'][^"']*\bjs\b/i.test(html) && /\.js\b[^{}]*(?:\[data-(?:hero|reveal)|\.reveal)/.test(css))
    add('staticjs', 'Never write class="js" on <html>: content that is hidden under .js stays hidden when the script fails. The runtime decides whether motion may run.');
  if (/\[data-reveal\s*=\s*["']?mask["']?\]\s*\{[^}]*clip-path/i.test(css))
    add('maskobserved', 'Do not clip the element that carries data-reveal="mask": a fully clipped element never counts as intersecting. Clip the media inside it.');
  if (own) add('modelmotion', 'Do not write CSS for data-hero, data-reveal or .revealed: LaunchForge supplies the hero and reveal animation for those hooks.');
  const panel = css.match(/\.nav-mobile\s*\{[^}]*\}|\.mobile-(?:menu|nav)\s*\{[^}]*\}/i);
  const hz = (css.match(/header[^{}]*\{[^}]*z-index\s*:\s*(\d+)/i) || [])[1], pz = panel && (panel[0].match(/z-index\s*:\s*(\d+)/) || [])[1];
  if (panel && /position\s*:\s*fixed/.test(panel[0]) && /inset\s*:\s*0\b|top\s*:\s*0\b/.test(panel[0]) && pz && Number(pz) > Number(hz || 0))
    add('navcover', 'The mobile menu panel covers the header, hiding the menu button and its morph into a close icon. Start the panel below the header or give the header a higher z-index.');
  return out;
}

module.exports = { MARK, VERSION, motionCss, headBootstrap, motionRuntime, stripInjected, neutralizeModelMotion, applyMotion, motionProblems };
