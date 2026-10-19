// Thin Express wrapper around api.js.
const express = require('express');

function createRouter(handle) {
  const r = express.Router();
  r.use(express.json({ limit: '1200kb' }));
  r.use(async (req, res) => {
    const out = await handle({ method: req.method, path: req.path, headers: req.headers, body: req.body, ip: req.ip });
    if (out.status === 204) return res.status(204).end();
    return res.status(out.status).json(out.body);
  });
  // Body-parser errors (too large / malformed JSON), in the same error format as the rest of the API.
  r.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request is too large.' } });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON.' } });
    console.error('Projects route error:', err && err.message);
    return res.status(500).json({ error: { code: 'SERVER', message: 'Unexpected server error.' } });
  });
  return r;
}

module.exports = { createRouter };
