// Project API logic. Framework-free: handle({method, path, headers, body, ip}) -> {status, body}.
// Identity comes ONLY from the server-side session (see security.authenticate). Every store call is scoped to that user id;
// ids or owners sent in a request body are ignored.
const { authenticate } = require('./security');

const DEFAULTS = {
  maxPerOwner: Number(process.env.MAX_PROJECTS_PER_OWNER) || 50,
  maxTotal: Number(process.env.MAX_TOTAL_PROJECTS) || 1000,
  writePerMin: Number(process.env.WRITE_RATE_PER_MINUTE) || 120,
  maxChars: 1000000
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ['cafe', 'consulting', 'portfolio', 'restaurant', 'fitness', 'other'];
const STYLES = ['Modern', 'Minimal', 'Elegant', 'Playful', 'Dark'];
const PAGES = ['Services', 'Pricing', 'Gallery', 'Blog'];
const MAX_HTML = 300000;
const MAX_TS = 4102444800000; // year 2100

const E = (status, code, message, extra) => ({ status, body: { error: { code, message }, ...extra } });
const bad = m => ({ err: E(400, 'VALIDATION', m) });
const text = (v, max) => (v == null ? '' : typeof v === 'string' && v.length <= max ? v : null);
const ts = v => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TS);

function validate(b, maxChars) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('Body must be a JSON object.');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 60) return bad('name is required (1-60 characters).');
  const type = b.type == null ? 'other' : b.type;
  if (!TYPES.includes(type)) return bad('type is not a valid business type.');
  const style = b.style == null ? 'Modern' : b.style;
  if (!STYLES.includes(style)) return bad('style is not a valid style.');
  const desc = text(b.desc, 500); if (desc === null) return bad('desc must be text up to 500 characters.');
  const audience = text(b.audience, 120); if (audience === null) return bad('audience must be text up to 120 characters.');
  const html = text(b.html, MAX_HTML); if (html === null) return bad('html must be text up to ' + MAX_HTML + ' characters.');
  let pages = [];
  if (b.pages != null) {
    if (!Array.isArray(b.pages) || b.pages.length > 8 || !b.pages.every(p => PAGES.includes(p))) return bad('pages contains an unknown page.');
    pages = [...new Set(b.pages)];
  }
  const mode = b.mode == null ? null : b.mode;
  if (mode !== null && mode !== 'demo' && mode !== 'ai') return bad('mode must be "demo" or "ai".');
  if (!ts(b.generatedAt)) return bad('generatedAt must be a timestamp in milliseconds.');
  let history = [];
  if (b.history != null) {
    if (!Array.isArray(b.history)) return bad('history must be a list.');
    for (const h of b.history) {
      if (!h || typeof h !== 'object' || typeof h.instruction !== 'string' || h.instruction.length > 1000 ||
          typeof h.prev !== 'string' || h.prev.length > MAX_HTML || !Number.isFinite(h.id) || !Number.isFinite(h.at)) return bad('history contains an invalid entry.');
    }
    history = b.history.slice(-5).map(h => ({ id: h.id, instruction: h.instruction, at: h.at, prev: h.prev }));
  }
  if (html.length + history.reduce((n, h) => n + h.prev.length, 0) > maxChars) {
    return { err: E(413, 'PROJECT_TOO_LARGE', 'This project is too large to save.') };
  }
  return { value: { name, type, desc, audience, style, pages, html, mode, generatedAt: b.generatedAt == null ? null : b.generatedAt, history } };
}

function mapError(e) {
  if (e && e.code === 'DB_NOT_CONFIGURED') return E(503, 'DB_NOT_CONFIGURED', 'Server storage is not configured.');
  if (e && e.code === 'DB_UNAVAILABLE') return E(503, 'DB_UNAVAILABLE', 'Server storage is temporarily unavailable.');
  if (e && e.code === 'SCHEMA_OUTDATED') return E(503, 'SCHEMA_OUTDATED', 'The database needs a migration before this can be used.');
  console.error('Projects API error:', (e && (e.pgCode || e.code || e.message)) || 'unknown');
  return E(500, 'SERVER', 'Unexpected server error.');
}

function createApi(storeOrGetter, options = {}) {
  const L = { ...DEFAULTS, ...options };
  const hits = new Map();
  function allowWrite(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
    if (recent.length >= L.writePerMin) { hits.set(ip, recent); return false; }
    recent.push(now); hits.set(ip, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k);
    return true;
  }
  async function capCheck(store, owner) {
    if (await store.countOwner(owner) >= L.maxPerOwner) return E(403, 'PROJECT_LIMIT', `You have reached the limit of ${L.maxPerOwner} projects.`);
    if (await store.countTotal() >= L.maxTotal) return E(503, 'STORAGE_FULL', 'Server storage is full right now. Download a backup and try again later.');
    return null;
  }

  return async function handle(req) {
    try {
      const method = String(req.method || '').toUpperCase();
      const parts = String(req.path || '/').split('/').filter(Boolean);
      // Runs before routing, so every path under /api/projects (including unknown ones) requires a logged-in user.
      const auth = await authenticate(req, { originPolicy: L.originPolicy || (() => false) });
      if (auth.err) return auth.err;
      const owner = auth.userId;
      if (method !== 'GET' && !allowWrite(owner)) return E(429, 'RATE_LIMIT', 'Too many save requests. Wait a moment and try again.');
      const store = typeof storeOrGetter === 'function' ? storeOrGetter() : storeOrGetter;

      if (parts.length === 0) {
        if (method === 'GET') return { status: 200, body: { projects: await store.list(owner) } };
        if (method === 'POST') {
          const v = validate(req.body, L.maxChars); if (v.err) return v.err;
          const cap = await capCheck(store, owner); if (cap) return cap;
          return { status: 201, body: { project: await store.create(owner, v.value) } };
        }
        return E(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      }

      if (parts.length === 1 && parts[0] === 'import') {
        if (method !== 'POST') return E(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
        const list = req.body && req.body.projects;
        if (!Array.isArray(list) || list.length < 1 || list.length > 10) return E(400, 'VALIDATION', 'projects must be a list of 1-10 items.');
        const results = [];
        for (const item of list) {
          const localId = item && typeof item.localId === 'string' && item.localId.length <= 64 ? item.localId : null;
          if (!localId) { results.push({ localId: null, status: 'invalid', message: 'localId is required.' }); continue; }
          const v = validate(item, L.maxChars);
          if (v.err) { results.push({ localId, status: 'invalid', message: v.err.body.error.message }); continue; }
          const cap = await capCheck(store, owner);
          const r = cap ? null : await store.importOne(owner, localId, v.value, ts(item.created) ? item.created : null);
          if (r && r.status === 'exists') results.push({ localId, status: 'exists', id: r.project.id, version: r.project.version });
          else if (r) results.push({ localId, status: 'imported', id: r.project.id, version: r.project.version });
          else results.push({ localId, status: 'limit', message: cap.body.error.message });
        }
        return { status: 200, body: { results } };
      }

      if (parts.length === 1) {
        const id = parts[0];
        if (!UUID.test(id)) return E(400, 'BAD_ID', 'Project id is not valid.');
        if (method === 'GET') {
          const p = await store.get(owner, id);
          return p ? { status: 200, body: { project: p } } : E(404, 'NOT_FOUND', 'Project not found.');
        }
        if (method === 'PUT') {
          const bv = req.body && req.body.baseVersion;
          if (!Number.isInteger(bv) || bv < 1) return E(400, 'VALIDATION', 'baseVersion is required (the version you last loaded or saved).');
          const v = validate(req.body, L.maxChars); if (v.err) return v.err;
          const r = await store.update(owner, id, bv, v.value);
          if (r.status === 'ok') return { status: 200, body: { project: r.project } };
          if (r.status === 'conflict') return E(409, 'VERSION_CONFLICT', 'This project changed on the server since you loaded it. Nothing was overwritten.', { current: r.project });
          return E(404, 'NOT_FOUND', 'Project not found.');
        }
        if (method === 'PATCH') {
          const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
          if (!name || name.length > 60) return E(400, 'VALIDATION', 'name is required (1-60 characters).');
          const p = await store.rename(owner, id, name);
          return p ? { status: 200, body: { project: p } } : E(404, 'NOT_FOUND', 'Project not found.');
        }
        if (method === 'DELETE') {
          return (await store.remove(owner, id)) ? { status: 204, body: null } : E(404, 'NOT_FOUND', 'Project not found.');
        }
        return E(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      }
      return E(404, 'NOT_FOUND', 'No such route.');
    } catch (e) { return mapError(e); }
  };
}

// Used by /api/edit: when a project id is supplied, the caller must own it (404 otherwise, never revealing other users' ids).
async function authorizeEdit(store, userId, projectId) {
  if (projectId == null) return null;
  if (typeof projectId !== 'string' || !UUID.test(projectId)) return E(400, 'BAD_ID', 'Project id is not valid.');
  return (await store.get(userId, projectId)) ? null : E(404, 'NOT_FOUND', 'Project not found.');
}

module.exports = { createApi, validate, mapError, authorizeEdit };
