// Local recovery copies and local -> server migration logic (LOCALSTORE block in index.html).
const test = require('node:test');
const assert = require('node:assert/strict');
const { block } = require('./_extract');

class FakeLS {
  constructor(init = {}) { this.m = { ...init }; this.fail = false; }
  getItem(k) { return k in this.m ? this.m[k] : null; }
  setItem(k, v) { if (this.fail) throw new Error('QuotaExceededError'); this.m[k] = String(v); }
  removeItem(k) { delete this.m[k]; }
}
const load = ls => new Function('localStorage', block('LOCALSTORE') + '; return {jget,jset,importedMap,recoveryRead,recoveryWrite,recoveryClear,sameContent,importItem,runImport};')(ls);
const proj = (i, o = {}) => ({ id: 'p' + i, name: 'Project ' + i, type: 'cafe', desc: 'd', audience: 'a', style: 'Modern', pages: ['Services'], html: '<html>' + i + '</html>', mode: 'demo', generatedAt: 1, created: 2, history: [], ...o });

test('recovery copy: write, read, clear', () => {
  const L = load(new FakeLS());
  assert.equal(L.recoveryRead('abc'), null);
  assert.equal(L.recoveryWrite('abc', { payload: { name: 'x' }, baseVersion: 3, at: 1 }), true);
  assert.equal(L.recoveryRead('abc').baseVersion, 3);
  L.recoveryClear('abc');
  assert.equal(L.recoveryRead('abc'), null);
});

test('recovery copy: corrupted storage does not throw', () => {
  const L = load(new FakeLS({ 'launchforge.recovery.v1': '{not json', 'launchforge.imported.v1': '[1,2' }));
  assert.equal(L.recoveryRead('x'), null);
  assert.deepEqual(L.importedMap(), {});
  assert.doesNotThrow(() => L.recoveryClear('x'));
});

test('recovery copy: a full browser quota is reported, not thrown', () => {
  const ls = new FakeLS(); const L = load(ls); ls.fail = true;
  assert.equal(L.recoveryWrite('abc', { payload: {} }), false);
});

test('sameContent detects real differences only', () => {
  const L = load(new FakeLS());
  assert.equal(L.sameContent(proj(1), { ...proj(1), updated: 99, version: 4 }), true);
  assert.equal(L.sameContent(proj(1), proj(1, { html: '<html>edited</html>' })), false);
  assert.equal(L.sameContent(proj(1), proj(1, { pages: ['Blog'] })), false);
});

test('migration: copies to the server, records ids, never touches local data', async () => {
  const ls = new FakeLS(); const L = load(ls);
  const items = [proj(1), proj(2)]; const snapshot = JSON.stringify(items);
  const sent = [];
  const r = await L.runImport(items, async it => { sent.push(it.localId); return { status: 'imported', id: 'srv-' + it.localId }; });
  assert.deepEqual(r.ok, ['p1', 'p2']); assert.deepEqual(r.bad, []);
  assert.deepEqual(L.importedMap(), { p1: 'srv-p1', p2: 'srv-p2' });
  assert.equal(JSON.stringify(items), snapshot, 'local project objects unchanged');
});

test('migration is idempotent: a second run sends nothing', async () => {
  const L = load(new FakeLS()); let calls = 0; const items = [proj(1), proj(2)];
  const post = async it => { calls++; return { status: 'imported', id: 's' + it.localId }; };
  await L.runImport(items, post); await L.runImport(items, post);
  assert.equal(calls, 2);
});

test('migration: "exists" from the server counts as done (no duplicate, no overwrite)', async () => {
  const L = load(new FakeLS());
  const r = await L.runImport([proj(1)], async () => ({ status: 'exists', id: 'already-there' }));
  assert.deepEqual(r.ok, ['p1']); assert.equal(L.importedMap().p1, 'already-there');
});

test('migration: invalid items are reported and not marked imported; others continue', async () => {
  const L = load(new FakeLS());
  const r = await L.runImport([proj(1), proj(2), proj(3)], async it => it.localId === 'p2' ? { status: 'invalid', message: 'name is required' } : { status: 'imported', id: 's' + it.localId });
  assert.deepEqual(r.ok, ['p1', 'p3']);
  assert.deepEqual(r.bad.map(b => [b.id, b.message]), [['p2', 'name is required']]);
  assert.equal(L.importedMap().p2, undefined);
});

test('migration: a network failure stops the run, keeps progress, and reports the rest as not imported', async () => {
  const L = load(new FakeLS());
  const r = await L.runImport([proj(1), proj(2), proj(3)], async it => {
    if (it.localId === 'p2') { const e = new Error('Could not reach the server.'); e.network = true; throw e; }
    return { status: 'imported', id: 's' + it.localId };
  });
  assert.deepEqual(r.ok, ['p1']); assert.equal(r.bad.length, 1); assert.equal(r.bad[0].id, 'p2');
  assert.deepEqual(Object.keys(L.importedMap()), ['p1']);
  const retry = await L.runImport([proj(1), proj(2), proj(3)], async it => ({ status: 'imported', id: 's' + it.localId }));
  assert.deepEqual(retry.ok, ['p2', 'p3'], 'a retry resumes where it stopped');
});

test('migration: 4xx errors skip one project but 5xx stops the run', async () => {
  const L = load(new FakeLS());
  const r4 = await L.runImport([proj(1), proj(2)], async it => { if (it.localId === 'p1') { const e = new Error('too big'); e.status = 413; throw e; } return { status: 'imported', id: 's2' }; });
  assert.deepEqual(r4.ok, ['p2']);
  const L2 = load(new FakeLS());
  const r5 = await L2.runImport([proj(1), proj(2)], async () => { const e = new Error('Server error'); e.status = 503; throw e; });
  assert.equal(r5.bad.length, 1, 'stopped after the first 503');
});

test('importItem trims history to the last 5 and fills defaults', () => {
  const L = load(new FakeLS());
  const it = L.importItem(proj(1, { html: undefined, history: [1, 2, 3, 4, 5, 6, 7].map(i => ({ id: i })) }));
  assert.equal(it.html, ''); assert.deepEqual(it.history.map(h => h.id), [3, 4, 5, 6, 7]); assert.equal(it.localId, 'p1');
});
