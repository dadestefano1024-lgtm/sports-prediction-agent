'use strict';
/**
 * The OTHER side of the travel curve: what happens when you back the side the
 * market moved AWAY from, at a partly-absorbed number.
 *
 * CHECKED: travel-test.js (the same sweep, moved-TOWARD side), fade-the-move.js
 * (fades at the CLOSE only, and found 51.9% = noise), CLAUDE.md which records
 * "Fading the move at the frozen number goes 43.5%" as a single figure.
 *
 * WHY: pricing a card needs a number for every pick on it, including the bad
 * ones. The app's week-7 six contains two sides fading five-point moves, and
 * calling them "50%" flatters them while quoting the bare 43.5% assumes they sit
 * at the opener, which they do not. Both cards get priced off measured curves or
 * the comparison is rigged.
 *
 * Conventions match travel-test.js exactly. Push = LOSS.
 */
const fs = require('fs');
const rows = (() => {
  const raw = JSON.parse(fs.readFileSync('./frozen-rows.json', 'utf8'));
  return Array.isArray(raw) ? raw : (raw.rows || raw.games || []);
})();

function run(t, minMove, follow) {
  const bets = [];
  for (const r of rows) {
    const move = r.close - r.open;
    if (!Number.isFinite(move) || Math.abs(move) < minMove || Math.abs(move) < 1e-9) continue;
    const line = r.open + t * move;
    // follow = back the side money came in on; fade = back the other one
    const backHome = follow ? (move < 0) : (move > 0);
    const cover = backHome ? (r.margin + line) : -(r.margin + line);
    bets.push({ won: cover > 0, season: r.year });
  }
  const n = bets.length;
  if (!n) return null;
  const w = bets.filter((b) => b.won).length;
  const by = {};
  for (const b of bets) {
    by[b.season] = by[b.season] || { n: 0, w: 0 };
    by[b.season].n++; if (b.won) by[b.season].w++;
  }
  return { n, p: w / n, sd: (w / n - 0.5) / Math.sqrt(0.25 / n), by };
}

const pc = (x) => (x * 100).toFixed(1) + '%';
const TRAVELS = [0, 0.25, 0.5, 0.75, 1];
console.log('');
console.log('BACKING THE SIDE THE MARKET MOVED AWAY FROM (the fade), by travel');
console.log(rows.length + ' games, push = loss. Travel = how much of the move the number absorbed.');
console.log('');
console.log('  move        n        0%     25%     50%     75%    100%');
console.log('  ' + '-'.repeat(54));
const out = {};
for (const [name, mm] of [['any', 0.5], ['>=2pt', 2], ['>=3pt', 3], ['>=4pt', 4]]) {
  const cells = TRAVELS.map((t) => run(t, mm, false));
  out[name] = cells;
  console.log('  ' + name.padEnd(8) + String(cells[0] ? cells[0].n : 0).padStart(5) + '  ' +
    cells.map((c) => (c ? pc(c.p) : '  --  ').padStart(8)).join(''));
}
console.log('');
console.log('  as SD against 50%:');
for (const name of Object.keys(out)) {
  console.log('  ' + name.padEnd(8) + '       ' +
    out[name].map((c) => (c ? (c.sd >= 0 ? '+' : '') + c.sd.toFixed(2) : ' -- ').padStart(8)).join(''));
}
console.log('');
console.log('  NOTE: fade and follow are not quite mirror images, because a PUSH loses');
console.log('  BOTH of them. The two rows will not sum to 100%.');
console.log('');
const f0 = run(0, 2, false), t0 = run(0, 2, true);
console.log('  sanity, move>=2 at 0% travel:  follow ' + pc(t0.p) + ', fade ' + pc(f0.p) +
  ', sum ' + pc(t0.p + f0.p) + ' (pushes are the shortfall)');
console.log('');
console.log('FOR PRICING THIS WEEK:');
for (const [label, mv, trav] of [['Titans +3 (fades 5.0)', 5, 0.0], ['Giants +11 (fades 5.0)', 5, 0.0]]) {
  const bucket = mv >= 4 ? '>=4pt' : mv >= 3 ? '>=3pt' : '>=2pt';
  const cells = out[bucket];
  let i = 0;
  while (i < TRAVELS.length - 2 && TRAVELS[i + 1] < trav) i++;
  const f = (trav - TRAVELS[i]) / (TRAVELS[i + 1] - TRAVELS[i]);
  const p = cells[i].p + (cells[i + 1].p - cells[i].p) * f;
  console.log('  ' + label.padEnd(26) + pc(p) + '  (' + bucket + ' fade)');
}
console.log('');
