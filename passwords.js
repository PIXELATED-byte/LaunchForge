// Password hashing with Argon2id (OWASP-recommended minimum parameters: 19 MiB memory, 2 passes, 1 lane).
let lib = null;
const argon2 = () => lib || (lib = require('argon2'));

const hasher = {
  hash: pw => argon2().hash(pw, { type: argon2().argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
  verify: async (hash, pw) => { try { return await argon2().verify(hash, pw); } catch (e) { return false; } }
};
module.exports = { hasher };
