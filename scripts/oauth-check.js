// Shows which social sign-in providers are configured and the exact callback URLs to register. Read-only: it prints NO secret values.
//   npm run oauth:check
require('dotenv').config();
const { describeSetup } = require('../oauth');

const origin = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || null;
console.log('Public address used to build callback URLs: ' + (origin || '(not set: using http://localhost:3000; set PUBLIC_BASE_URL for a deployed site)'));
console.log('');
for (const r of describeSetup(process.env)) {
  console.log(r.label + ': ' + (r.configured ? 'configured' : 'NOT configured'));
  if (r.missing.length) console.log('   missing variables: ' + r.missing.join(', '));
  if (r.invalidKey) console.log('   APPLE_PRIVATE_KEY is set but is not a valid EC private key (.p8)');
  console.log('   register this callback URL: ' + r.callback);
}
console.log('\nNothing was changed. A provider is only live when it is configured here AND migration 003 has been applied to the database.');
