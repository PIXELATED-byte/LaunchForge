// Project storage, scoped to a user id. pgStore talks to Postgres; memoryStore behaves the same for tests.
const crypto = require('crypto');
const db = require('./db');

const ms = d => (d == null ? null : new Date(d).getTime());
const rowToProject = r => ({
  id: r.id, name: r.name, type: r.business_type, desc: r.description, audience: r.audience, style: r.style,
  pages: r.pages, html: r.html, mode: r.mode, generatedAt: ms(r.generated_at), history: r.history,
  version: r.version, created: ms(r.created_at), updated: ms(r.updated_at)
});
const toSummary = r => ({
  id: r.id, name: r.name, type: r.business_type, hasHtml: Boolean(r.has_html),
  version: r.version, created: ms(r.created_at), updated: ms(r.updated_at)
});
const fieldVals = v => [v.name, v.type, v.desc, v.audience, v.style, JSON.stringify(v.pages), v.html, v.mode,
  v.generatedAt == null ? null : new Date(v.generatedAt), JSON.stringify(v.history)];

// Every query below filters on user_id, so a project can only be reached by its owner. Rows with user_id NULL
// (legacy, unclaimed) match no user.
const pgStore = {
  async list(userId) {
    await db.ensureSchema();
    const r = await db.query(
      "SELECT id, name, business_type, (html <> '') AS has_html, version, created_at, updated_at FROM projects WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200",
      [userId], { retry: true });
    return r.rows.map(toSummary);
  },
  async get(userId, id) {
    await db.ensureSchema();
    const r = await db.query('SELECT * FROM projects WHERE id = $1 AND user_id = $2', [id, userId], { retry: true });
    return r.rows[0] ? rowToProject(r.rows[0]) : null;
  },
  async create(userId, v) {
    await db.ensureSchema();
    const r = await db.query(
      'INSERT INTO projects (user_id, name, business_type, description, audience, style, pages, html, mode, generated_at, history) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb) RETURNING *',
      [userId, ...fieldVals(v)]);
    return rowToProject(r.rows[0]);
  },
  async update(userId, id, baseVersion, v) {
    await db.ensureSchema();
    const r = await db.query(
      'UPDATE projects SET name=$3, business_type=$4, description=$5, audience=$6, style=$7, pages=$8::jsonb, html=$9, mode=$10, generated_at=$11, history=$12::jsonb, version=version+1, updated_at=now() WHERE id=$1 AND user_id=$2 AND version=$13 RETURNING *',
      [id, userId, ...fieldVals(v), baseVersion]);
    if (r.rows[0]) return { status: 'ok', project: rowToProject(r.rows[0]) };
    const cur = await this.get(userId, id);
    return cur ? { status: 'conflict', project: cur } : { status: 'missing' };
  },
  async rename(userId, id, name) {
    await db.ensureSchema();
    const r = await db.query('UPDATE projects SET name=$3, version=version+1, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *', [id, userId, name]);
    return r.rows[0] ? rowToProject(r.rows[0]) : null;
  },
  async remove(userId, id) {
    await db.ensureSchema();
    const r = await db.query('DELETE FROM projects WHERE id=$1 AND user_id=$2 RETURNING id', [id, userId]);
    return r.rows.length > 0;
  },
  // Insert-only: an existing import for the same (user, localId) is returned untouched.
  async importOne(userId, localId, v, createdMs) {
    await db.ensureSchema();
    const r = await db.query(
      'INSERT INTO projects (user_id, name, business_type, description, audience, style, pages, html, mode, generated_at, history, legacy_local_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,COALESCE($13::timestamptz, now())) ON CONFLICT (user_id, legacy_local_id) WHERE user_id IS NOT NULL AND legacy_local_id IS NOT NULL DO NOTHING RETURNING *',
      [userId, ...fieldVals(v), localId, createdMs == null ? null : new Date(createdMs)]);
    if (r.rows[0]) return { status: 'imported', project: rowToProject(r.rows[0]) };
    const ex = await db.query('SELECT * FROM projects WHERE user_id=$1 AND legacy_local_id=$2', [userId, localId], { retry: true });
    return { status: 'exists', project: rowToProject(ex.rows[0]) };
  },
  async countOwner(userId) {
    await db.ensureSchema();
    return (await db.query('SELECT count(*)::int AS n FROM projects WHERE user_id=$1', [userId], { retry: true })).rows[0].n;
  },
  async countTotal() {
    await db.ensureSchema();
    return (await db.query('SELECT count(*)::int AS n FROM projects', undefined, { retry: true })).rows[0].n;
  },
  // ---- legacy (pre-accounts) projects: owner_id = SHA-256 of the old anonymous token, user_id NULL ----
  async previewLegacy(ownerHash) {
    await db.ensureSchema();
    const r = await db.query('SELECT id, name, created_at FROM projects WHERE owner_id=$1 AND user_id IS NULL ORDER BY created_at', [ownerHash], { retry: true });
    return r.rows.map(x => ({ id: x.id, name: x.name, created: ms(x.created_at) }));
  },
  // One atomic statement: only unowned rows matching the proof can move, and never onto a legacy id the user already has.
  async claimLegacy(userId, ownerHash) {
    await db.ensureSchema();
    const r = await db.query(
      'UPDATE projects p SET user_id=$1, claimed_at=now() WHERE p.owner_id=$2 AND p.user_id IS NULL AND (p.legacy_local_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects q WHERE q.user_id=$1 AND q.legacy_local_id=p.legacy_local_id)) RETURNING p.id',
      [userId, ownerHash]);
    return r.rows.length;
  },
  // Operator tooling (scripts/assign-legacy.js).
  async listUnowned() {
    await db.ensureSchema();
    const r = await db.query('SELECT id, name, created_at, legacy_local_id FROM projects WHERE user_id IS NULL ORDER BY created_at', undefined, { retry: true });
    return r.rows.map(x => ({ id: x.id, name: x.name, created: ms(x.created_at), legacyLocalId: x.legacy_local_id }));
  },
  async assignUnowned(userId, ids) {
    await db.ensureSchema();
    const r = await db.query('UPDATE projects SET user_id=$1, claimed_at=now() WHERE user_id IS NULL AND id = ANY($2::uuid[]) RETURNING id', [userId, ids]);
    return r.rows.map(x => x.id);
  }
};

const notConfiguredStore = new Proxy({}, {
  get: () => async () => { throw new db.DbError('DB_NOT_CONFIGURED', 'DATABASE_URL is not set.'); }
});

function memoryStore() {
  const m = new Map();
  let tick = 0;
  const now = () => Date.now() * 1000 + (tick++ % 1000); // strictly increasing ordering key
  const pub = p => { const { userId, legacyOwner, legacyLocalId, claimedAt, ...rest } = structuredClone(p); return rest; };
  const mine = (u, id) => { const p = m.get(id); return p && p.userId === u ? p : null; };
  return {
    async list(u) {
      return [...m.values()].filter(p => p.userId === u).sort((a, b) => b._ord - a._ord).map(p => ({
        id: p.id, name: p.name, type: p.type, hasHtml: p.html !== '', version: p.version, created: p.created, updated: p.updated }));
    },
    async get(u, id) { const p = mine(u, id); return p ? pub(p) : null; },
    async create(u, v) {
      const t = Date.now();
      const p = { ...structuredClone(v), id: crypto.randomUUID(), userId: u, version: 1, created: t, updated: t, _ord: now() };
      m.set(p.id, p); return pub(p);
    },
    async update(u, id, base, v) {
      const p = mine(u, id);
      if (!p) return { status: 'missing' };
      if (p.version !== base) return { status: 'conflict', project: pub(p) };
      Object.assign(p, structuredClone(v), { version: p.version + 1, updated: Date.now(), _ord: now() });
      return { status: 'ok', project: pub(p) };
    },
    async rename(u, id, name) {
      const p = mine(u, id); if (!p) return null;
      Object.assign(p, { name, version: p.version + 1, updated: Date.now(), _ord: now() }); return pub(p);
    },
    async remove(u, id) { return mine(u, id) ? m.delete(id) : false; },
    async importOne(u, localId, v, createdMs) {
      const ex = [...m.values()].find(p => p.userId === u && p.legacyLocalId === localId);
      if (ex) return { status: 'exists', project: pub(ex) };
      const t = Date.now();
      const p = { ...structuredClone(v), id: crypto.randomUUID(), userId: u, legacyLocalId: localId, version: 1, created: createdMs == null ? t : createdMs, updated: t, _ord: now() };
      m.set(p.id, p); return { status: 'imported', project: pub(p) };
    },
    async countOwner(u) { return [...m.values()].filter(p => p.userId === u).length; },
    async countTotal() { return m.size; },
    async previewLegacy(h) { return [...m.values()].filter(p => !p.userId && p.legacyOwner === h).map(p => ({ id: p.id, name: p.name, created: p.created })); },
    async claimLegacy(u, h) {
      let n = 0;
      for (const p of m.values()) {
        if (p.userId || p.legacyOwner !== h) continue;
        if (p.legacyLocalId && [...m.values()].some(q => q.userId === u && q.legacyLocalId === p.legacyLocalId)) continue;
        p.userId = u; p.claimedAt = Date.now(); n++;
      }
      return n;
    },
    async listUnowned() { return [...m.values()].filter(p => !p.userId).map(p => ({ id: p.id, name: p.name, created: p.created, legacyLocalId: p.legacyLocalId || null })); },
    async assignUnowned(u, ids) { const out = []; for (const id of ids) { const p = m.get(id); if (p && !p.userId) { p.userId = u; p.claimedAt = Date.now(); out.push(id); } } return out; },
    // test helper: a pre-accounts row exactly as production has it (hash owner, no user)
    _seedLegacy(ownerHash, v, legacyLocalId = null) {
      const t = Date.now();
      const p = { ...structuredClone(v), id: crypto.randomUUID(), userId: null, legacyOwner: ownerHash, legacyLocalId, version: 1, created: t, updated: t, _ord: now() };
      m.set(p.id, p); return p.id;
    }
  };
}

const getStore = () => (db.configured() ? pgStore : notConfiguredStore);

module.exports = { pgStore, memoryStore, getStore };
