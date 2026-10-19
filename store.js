// Project storage. pgStore talks to Postgres; memoryStore has the same behaviour for tests.
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

const pgStore = {
  async list(owner) {
    await db.ensureSchema();
    const r = await db.query(
      "SELECT id, name, business_type, (html <> '') AS has_html, version, created_at, updated_at FROM projects WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 200",
      [owner], { retry: true });
    return r.rows.map(toSummary);
  },
  async get(owner, id) {
    await db.ensureSchema();
    const r = await db.query('SELECT * FROM projects WHERE id = $1 AND owner_id = $2', [id, owner], { retry: true });
    return r.rows[0] ? rowToProject(r.rows[0]) : null;
  },
  async create(owner, v) {
    await db.ensureSchema();
    const r = await db.query(
      'INSERT INTO projects (owner_id, name, business_type, description, audience, style, pages, html, mode, generated_at, history) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb) RETURNING *',
      [owner, ...fieldVals(v)]);
    return rowToProject(r.rows[0]);
  },
  async update(owner, id, baseVersion, v) {
    await db.ensureSchema();
    const r = await db.query(
      'UPDATE projects SET name=$3, business_type=$4, description=$5, audience=$6, style=$7, pages=$8::jsonb, html=$9, mode=$10, generated_at=$11, history=$12::jsonb, version=version+1, updated_at=now() WHERE id=$1 AND owner_id=$2 AND version=$13 RETURNING *',
      [id, owner, ...fieldVals(v), baseVersion]);
    if (r.rows[0]) return { status: 'ok', project: rowToProject(r.rows[0]) };
    const cur = await this.get(owner, id);
    return cur ? { status: 'conflict', project: cur } : { status: 'missing' };
  },
  async rename(owner, id, name) {
    await db.ensureSchema();
    const r = await db.query('UPDATE projects SET name=$3, version=version+1, updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *', [id, owner, name]);
    return r.rows[0] ? rowToProject(r.rows[0]) : null;
  },
  async remove(owner, id) {
    await db.ensureSchema();
    const r = await db.query('DELETE FROM projects WHERE id=$1 AND owner_id=$2 RETURNING id', [id, owner]);
    return r.rows.length > 0;
  },
  // Insert-only: an existing import for the same (owner, localId) is returned untouched.
  async importOne(owner, localId, v, createdMs) {
    await db.ensureSchema();
    const r = await db.query(
      'INSERT INTO projects (owner_id, name, business_type, description, audience, style, pages, html, mode, generated_at, history, legacy_local_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,COALESCE($13::timestamptz, now())) ON CONFLICT (owner_id, legacy_local_id) WHERE legacy_local_id IS NOT NULL DO NOTHING RETURNING *',
      [owner, ...fieldVals(v), localId, createdMs == null ? null : new Date(createdMs)]);
    if (r.rows[0]) return { status: 'imported', project: rowToProject(r.rows[0]) };
    const ex = await db.query('SELECT * FROM projects WHERE owner_id=$1 AND legacy_local_id=$2', [owner, localId], { retry: true });
    return { status: 'exists', project: rowToProject(ex.rows[0]) };
  },
  async countOwner(owner) {
    await db.ensureSchema();
    return (await db.query('SELECT count(*)::int AS n FROM projects WHERE owner_id=$1', [owner], { retry: true })).rows[0].n;
  },
  async countTotal() {
    await db.ensureSchema();
    return (await db.query('SELECT count(*)::int AS n FROM projects', undefined, { retry: true })).rows[0].n;
  }
};

const notConfiguredStore = new Proxy({}, {
  get: () => async () => { throw new db.DbError('DB_NOT_CONFIGURED', 'DATABASE_URL is not set.'); }
});

function memoryStore() {
  const m = new Map();
  let tick = 0;
  const now = () => Date.now() * 1000 + (tick++ % 1000); // strictly increasing ordering key
  const pub = p => { const { owner, legacy, ...rest } = structuredClone(p); return rest; };
  const mine = (o, id) => { const p = m.get(id); return p && p.owner === o ? p : null; };
  return {
    async list(o) {
      return [...m.values()].filter(p => p.owner === o).sort((a, b) => b._ord - a._ord).map(p => ({
        id: p.id, name: p.name, type: p.type, hasHtml: p.html !== '', version: p.version, created: p.created, updated: p.updated }));
    },
    async get(o, id) { const p = mine(o, id); return p ? pub(p) : null; },
    async create(o, v) {
      const t = Date.now();
      const p = { ...structuredClone(v), id: crypto.randomUUID(), owner: o, version: 1, created: t, updated: t, _ord: now() };
      m.set(p.id, p); return pub(p);
    },
    async update(o, id, base, v) {
      const p = mine(o, id);
      if (!p) return { status: 'missing' };
      if (p.version !== base) return { status: 'conflict', project: pub(p) };
      Object.assign(p, structuredClone(v), { version: p.version + 1, updated: Date.now(), _ord: now() });
      return { status: 'ok', project: pub(p) };
    },
    async rename(o, id, name) {
      const p = mine(o, id); if (!p) return null;
      Object.assign(p, { name, version: p.version + 1, updated: Date.now(), _ord: now() }); return pub(p);
    },
    async remove(o, id) { return mine(o, id) ? m.delete(id) : false; },
    async importOne(o, localId, v, createdMs) {
      const ex = [...m.values()].find(p => p.owner === o && p.legacy === localId);
      if (ex) return { status: 'exists', project: pub(ex) };
      const t = Date.now();
      const p = { ...structuredClone(v), id: crypto.randomUUID(), owner: o, legacy: localId, version: 1, created: createdMs == null ? t : createdMs, updated: t, _ord: now() };
      m.set(p.id, p); return { status: 'imported', project: pub(p) };
    },
    async countOwner(o) { return [...m.values()].filter(p => p.owner === o).length; },
    async countTotal() { return m.size; },
    _owners() { return [...new Set([...m.values()].map(p => p.owner))]; }
  };
}

const getStore = () => (db.configured() ? pgStore : notConfiguredStore);

module.exports = { pgStore, memoryStore, getStore };
