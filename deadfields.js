// Which fields does the server send that the interface never looks at?
const fs = require('fs');
const path = process.argv[2];
const d = JSON.parse(fs.readFileSync(path, 'utf8'));
const html = fs.readFileSync('public/index.html', 'utf8');

const g = d.games[0];
const dead = [], used = [];
for (const k of Object.keys(g)) {
  const re = new RegExp('\\.' + k + '\\b');
  (re.test(html) ? used : dead).push(k);
}
console.log(`fields sent: ${Object.keys(g).length}   read by the page: ${used.length}   never read: ${dead.length}`);
console.log('  never read:', dead.join(', ') || '(none)');

const full = JSON.stringify(d).length;
const trimmed = JSON.stringify({
  ...d,
  games: d.games.map(x => { const c = { ...x }; for (const k of dead) delete c[k]; return c; }),
}).length;
console.log(`payload ${(full / 1024).toFixed(0)} KB -> ${(trimmed / 1024).toFixed(0)} KB without them` +
  `  (${(100 - trimmed / full * 100).toFixed(0)}% smaller)`);
