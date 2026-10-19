// Pulls marked, browser-independent code blocks out of index.html so they can be tested in Node.
const fs = require('fs');
const path = require('path');
function block(name) {
  const s = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const a = s.indexOf('/* ' + name + '-START */'), b = s.indexOf('/* ' + name + '-END */');
  if (a < 0 || b < 0) throw new Error(name + ' markers not found in index.html');
  return s.slice(a, b);
}
module.exports = { block };
