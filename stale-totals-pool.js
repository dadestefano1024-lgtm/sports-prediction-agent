// Does a stale TOTAL work the way a stale spread does?
//
// The pool tab sorts every spread above every total, on the grounds that the
// stale-line rule is holdout-tested on spreads and measured at 51.4% on totals.
// That number predates today's work and was counted the standard way, with
// pushes dropped. This pool loses pushes, so it deserves measuring on its own
// terms — and totals move as much as spreads, so the question is fair.
//
// The rule, identical to the spread version: the market total moved between
// open and close, you still hold the OPENING number, back the side the market
// moved toward.
//
// Run: node stale-totals-pool.js

const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('./nfl-totals.json', 'utf8')).rows;

const report = (label, bets) => {
  const n = bets.length;
  if (n < 25) { console.log(`    ${label.padEnd(30)} too few (${n})`); return; }
  const w = bets.filter(b => b.won).length;
  const p = bets.filter(b => b.push).length;
  const rate = w / n;
  const z = (rate - 0.5) / Math.sqrt(0.25 / n);
  console.log(`    ${label.padEnd(30)} ${String(w).padStart(3)}-${String(n - w).padStart(3)}  ` +
    `${(rate * 100).toFixed(1)}%  ${String(n).padStart(3)} bets` +
    (p ? `  (${p} pushed)` : '          ') +
    `  ${z >= 0 ? '+' : ''}${z.toFixed(2)} SD`);
};

// pushAsLoss = this pool. pushDropped = the standard way it was measured before.
const bets = (minMove, { pushAsLoss, fade = false, control = false }) => {
  const out = [];
  for (const r of rows) {
    const move = r.closeTotal - r.openTotal;
    if (Math.abs(move) < minMove) continue;
    let backOver;
    if (control) backOver = true;                 // always take the over, ignore the move
    else backOver = fade ? move < 0 : move > 0;   // follow the move, or fade it
    // Settled at the OPENING total — the frozen number.
    const diff = r.points - r.openTotal;
    const push = Math.abs(diff) < 1e-9;
    if (push && !pushAsLoss) continue;
    out.push({ won: push ? false : (backOver ? diff > 0 : diff < 0), push, year: r.year });
  }
  return out;
};

console.log(`${rows.length} games with an opening and a closing total\n`);

console.log('FOLLOWING the move, at your frozen opening number');
console.log('  counted the standard way (pushes dropped) — how it was measured before:');
for (const t of [1, 1.5, 2, 3]) report(`move >= ${t}`, bets(t, { pushAsLoss: false }));
console.log('\n  counted the way YOUR pool works (a push is a loss):');
for (const t of [1, 1.5, 2, 3]) report(`move >= ${t}`, bets(t, { pushAsLoss: true }));

console.log('\n  by season, move >= 1, pushes as losses:');
for (const y of [2024, 2025]) {
  report(`${y}`, bets(1, { pushAsLoss: true }).filter(b => b.year === y));
}

console.log('\nCONTROLS');
report('always take the over', bets(1, { pushAsLoss: true, control: true }));
report('fade the move instead', bets(1, { pushAsLoss: true, fade: true }));

// The comparison that decides whether the gate is right.
console.log('\n\nSIDE BY SIDE WITH SPREADS, same rule, same seasons');
const sp = JSON.parse(fs.readFileSync('./nfl-open-close.json', 'utf8')).rows;
const spreadBets = (minMove) => {
  const out = [];
  for (const r of sp) {
    const move = r.close - r.open;
    if (Math.abs(move) < minMove) continue;
    const backHome = move < 0;
    const cover = backHome ? (r.margin + r.open) : -(r.margin + r.open);
    const push = Math.abs(cover) < 1e-9;
    out.push({ won: push ? false : cover > 0, push, year: r.year });
  }
  return out;
};
console.log('  (both counted this pool\'s way — a push loses)\n');
console.log('    move     spreads              totals');
for (const t of [1, 2, 3]) {
  const s = spreadBets(t), o = bets(t, { pushAsLoss: true });
  const pc = (b) => b.length ? (b.filter(x => x.won).length / b.length * 100).toFixed(1) + '%' : '  -  ';
  console.log(`    >= ${t}    ${pc(s).padStart(6)} (${String(s.length).padStart(3)} bets)    ` +
    `${pc(o).padStart(6)} (${String(o.length).padStart(3)} bets)`);
}
