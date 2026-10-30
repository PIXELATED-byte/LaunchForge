// Test doubles. The fake hasher and fake sessions exist ONLY in tests; production uses Argon2id and Postgres sessions.
const crypto = require('crypto');
const { makeOriginPolicy } = require('../security');

const ORIGIN = 'https://pixelated-byte.github.io';
const originPolicy = makeOriginPolicy({ origins: [ORIGIN] });

function fakeHasher() {
  const h = { hashCalls: 0, verifyCalls: 0 };
  h.hash = async p => { h.hashCalls++; return 'fakehash$' + Buffer.from(p).toString('base64') + '$' + crypto.randomBytes(4).toString('hex'); };
  h.verify = async (hash, p) => { h.verifyCalls++; return hash.split('$')[1] === Buffer.from(p).toString('base64'); };
  return h;
}

// Server-side session table + per-"browser" cookie (sid). start() issues a NEW sid, like session.regenerate().
function sessionJar() {
  const table = new Map();
  const jar = { table, starts: 0 };
  jar.adapter = client => ({
    async read() { const s = client.sid && table.get(client.sid); return s && !s.expired ? { userId: s.userId, csrf: s.csrf } : null; },
    async start(userId) {
      if (client.sid) table.delete(client.sid);
      client.sid = crypto.randomBytes(16).toString('hex'); jar.starts++;
      const csrf = crypto.randomBytes(16).toString('hex');
      table.set(client.sid, { userId, csrf }); return { csrf };
    },
    async end() { if (client.sid) table.delete(client.sid); client.sid = null; }
  });
  return jar;
}
const req = (jar, client, method, path, body, { origin = ORIGIN, csrf, ip = '9.9.9.9', headers = {} } = {}) => ({
  method, path, body, ip, selfOrigin: 'https://api.example',
  headers: { ...(origin ? { origin } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers },
  session: jar.adapter(client)
});
module.exports = { ORIGIN, originPolicy, fakeHasher, sessionJar, req };
