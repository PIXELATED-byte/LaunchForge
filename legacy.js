// Operator helper behind scripts/assign-legacy.js. Dry run unless apply is true. Never invents an owner.
async function assignLegacy({ users, store, email, ids = null, apply = false }) {
  const user = email ? await users.findByEmail(String(email).trim().toLowerCase()) : null;
  if (!user) return { ok: false, error: 'No account with that email. Register it first.' };
  const unowned = await store.listUnowned();
  const chosen = ids ? unowned.filter(p => ids.includes(p.id)) : unowned;
  const unknown = ids ? ids.filter(i => !unowned.some(p => p.id === i)) : [];
  if (!apply) return { ok: true, applied: false, user: { id: user.id, email: user.email }, candidates: chosen, unknownIds: unknown };
  const done = await store.assignUnowned(user.id, chosen.map(p => p.id));
  return { ok: true, applied: true, user: { id: user.id, email: user.email }, assigned: done, unknownIds: unknown };
}
module.exports = { assignLegacy };
