// Autosave state machine (createSaver in index.html): debounce, one request at a time, failures, conflicts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { block } = require('./_extract');
const createSaver = new Function(block('SAVER') + '; return createSaver;')();
const wait = ms => new Promise(r => setTimeout(r, ms));
const mk = (save, extra = {}) => { const states = []; const s = createSaver({ save, delay: 15, backoff: [15, 15], onState: st => states.push(st), ...extra }); return { s, states }; };

test('debounce: rapid edits produce one save with the latest snapshot', async () => {
  const calls = []; const { s, states } = mk(async snap => { calls.push(snap); });
  s.touch('a'); s.touch('b'); s.touch('c');
  await wait(80);
  assert.deepEqual(calls, ['c']); assert.equal(s.state(), 'saved'); assert.equal(s.isPending(), false);
  assert.deepEqual(states.filter((x, i, arr) => x !== arr[i - 1]), ['dirty', 'saving', 'saved']);
});

test('never reports "saved" before the server confirms', async () => {
  let release; const { s } = mk(() => new Promise(r => { release = r; }));
  s.touch(1); await wait(40);
  assert.equal(s.state(), 'saving'); assert.equal(s.isPending(), true);
  release(); await wait(10);
  assert.equal(s.state(), 'saved');
});

test('edits during a save trigger exactly one follow-up save; requests never overlap', async () => {
  let active = 0, maxActive = 0; const calls = [];
  const { s } = mk(async snap => { active++; maxActive = Math.max(maxActive, active); calls.push(snap); await wait(40); active--; });
  s.touch('v1'); await wait(30); s.touch('v2'); s.touch('v3');
  await wait(200);
  assert.deepEqual(calls, ['v1', 'v3']); assert.equal(maxActive, 1); assert.equal(s.state(), 'saved');
});

test('network failure keeps work pending, retries with backoff, then saves', async () => {
  let n = 0; const calls = [];
  const { s, states } = mk(async snap => { calls.push(snap); if (++n < 3) { const e = new Error('Could not reach the server.'); e.network = true; throw e; } });
  s.touch('x'); await wait(25);
  assert.equal(s.state(), 'failed'); assert.equal(s.isPending(), true, 'failed work must count as unsaved');
  await wait(150);
  assert.equal(s.state(), 'saved'); assert.equal(n, 3); assert.deepEqual(calls, ['x', 'x', 'x']);
  assert.ok(states.includes('failed'));
});

test('retries stop after the backoff list is exhausted but work stays pending', async () => {
  let n = 0; const { s } = mk(async () => { n++; throw new Error('down'); });
  s.touch(1); await wait(200);
  assert.equal(n, 3); assert.equal(s.state(), 'failed'); assert.equal(s.isPending(), true);
});

test('fatal (validation) errors are not retried', async () => {
  let n = 0; const { s } = mk(async () => { n++; const e = new Error('Add a project name to save.'); e.fatal = true; throw e; });
  s.touch(1); await wait(120);
  assert.equal(n, 1); assert.equal(s.state(), 'failed'); assert.equal(s.error().message, 'Add a project name to save.');
});

test('version conflict pauses saving until the user resolves it', async () => {
  let mode = 'conflict', n = 0; const calls = [];
  const { s } = mk(async snap => { n++; calls.push(snap); if (mode === 'conflict') { const e = new Error('conflict'); e.conflict = true; throw e; } });
  s.touch('mine'); await wait(60);
  assert.equal(s.state(), 'conflict'); assert.equal(n, 1, 'no automatic retries on conflict');
  s.touch('mine2'); await wait(60);
  assert.equal(n, 1, 'edits do not trigger saves while the conflict is unresolved'); assert.equal(s.state(), 'conflict');
  mode = 'ok';
  assert.equal(await s.flush(), 'saved');
  assert.deepEqual(calls, ['mine', 'mine2']);
});

test('flush() waits for an in-flight save and resolves with the final state', async () => {
  const { s } = mk(async () => { await wait(30); });
  s.touch(1); await wait(25);
  assert.equal(await s.flush(), 'saved');
});

test('flush() after a failure retries immediately', async () => {
  let n = 0; const { s } = mk(async () => { if (++n === 1) throw new Error('boom'); }, { backoff: [] });
  s.touch(1); await wait(40);
  assert.equal(s.state(), 'failed');
  assert.equal(await s.flush(), 'saved'); assert.equal(n, 2);
});
