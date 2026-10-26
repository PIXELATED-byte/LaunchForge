// Operator tool for assigning legacy projects: dry run by default, only unowned projects, only to an existing account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assignLegacy } = require('../legacy');
const { memoryStore } = require('../store');
const { memoryUsers } = require('../users');

const proj = n => ({ name: n, type: 'cafe', desc: '', audience: '', style: 'Modern', pages: [], html: '<html></html>', mode: null, generatedAt: null, history: [] });
async function world() {
  const store = memoryStore(), users = memoryUsers();
  const me = await users.create('founder@example.com', 'h'), other = await users.create('other@example.com', 'h');
  const ids = [store._seedLegacy('h1', proj('Roast'), 'p1'), store._seedLegacy('h1', proj('Northline'), 'p2')];
  const owned = (await store.create(other.id, { ...proj('Theirs') })).id;
  return { store, users, me, other, ids, owned };
}
test('dry run lists unowned projects and changes nothing', async () => {
  const w = await world();
  const r = await assignLegacy({ users: w.users, store: w.store, email: 'Founder@Example.com' });
  assert.equal(r.applied, false); assert.deepEqual(r.candidates.map(p => p.name).sort(), ['Northline', 'Roast']);
  assert.equal((await w.store.list(w.me.id)).length, 0); assert.equal((await w.store.listUnowned()).length, 2);
});
test('apply assigns only the chosen unowned projects to the named account', async () => {
  const w = await world();
  const r = await assignLegacy({ users: w.users, store: w.store, email: 'founder@example.com', ids: [w.ids[0], w.owned, 'nope'], apply: true });
  assert.deepEqual(r.assigned, [w.ids[0]]); assert.deepEqual(r.unknownIds.sort(), [w.owned, 'nope'].sort());
  assert.deepEqual((await w.store.list(w.me.id)).map(p => p.name), ['Roast']);
  assert.equal((await w.store.list(w.other.id)).length, 1, "someone else's project was not touched");
  assert.equal((await w.store.listUnowned()).length, 1, 'the other legacy project remains unowned');
});
test('an account that does not exist is refused (no invented owner)', async () => {
  const w = await world();
  const r = await assignLegacy({ users: w.users, store: w.store, email: 'ghost@example.com', apply: true });
  assert.equal(r.ok, false); assert.equal((await w.store.listUnowned()).length, 2);
});
test('assigning twice does not move an already-owned project', async () => {
  const w = await world();
  await assignLegacy({ users: w.users, store: w.store, email: 'founder@example.com', apply: true });
  const r = await assignLegacy({ users: w.users, store: w.store, email: 'other@example.com', ids: w.ids, apply: true });
  assert.deepEqual(r.assigned, []); assert.equal((await w.store.list(w.me.id)).length, 2);
});
