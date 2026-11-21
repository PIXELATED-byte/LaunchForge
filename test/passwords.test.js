// Real Argon2id hashing. Skipped (with the reason) if the argon2 package is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
let has = true; try { require.resolve('argon2'); } catch (e) { has = false; }
const skip = has ? false : 'argon2 is not installed (run npm install)';
const { hasher } = require('../passwords');

test('hashes with Argon2id at the configured cost and never contains the password', { skip }, async () => {
  const h = await hasher.hash('correct horse battery');
  assert.match(h, /^\$argon2id\$/); assert.match(h, /m=19456,t=2,p=1/); assert.ok(!h.includes('correct horse'));
});
test('verifies the right password and rejects wrong ones and garbage hashes', { skip }, async () => {
  const h = await hasher.hash('correct horse battery');
  assert.equal(await hasher.verify(h, 'correct horse battery'), true);
  assert.equal(await hasher.verify(h, 'Correct horse battery'), false);
  assert.equal(await hasher.verify('not-a-hash', 'x'), false);
  assert.equal(await hasher.verify('', ''), false);
});
test('the same password gets a different salt every time', { skip }, async () => {
  assert.notEqual(await hasher.hash('same password 123'), await hasher.hash('same password 123'));
});
