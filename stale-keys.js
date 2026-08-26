// Is a stale line worth more when the number it froze on is a key one?
//
// Two edges are already established here separately and have never been put
// together. The stale-line rule — back the side the market moved toward, at the
// OLD number — runs 55.4% at a point and 60.0% at two, holdout-tested. And the
// counted margin tables say a game lined at 3 lands exactly on 3 9.2% of the
// time, against 2.5% at 4.
//
// So a two-point move from 5 to 3 and a two-point move from 11 to 9 are the same
// bet to the app today, and they should not be. One of them leaves you holding
// the most valuable number in football.
//
// Run: node stale-keys.js

const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('./nfl-open-close.json', 'utf8')).rows;

const KEYS = [3, 7];

// The stale bet: the market moved, your number did not. You hold the OPEN.
// Back the side the move went toward.
function staleBets(minMove) {
  const out = [];
  for (const r of rows) {
    const move = r.close - r.open;
    if (Math.abs(move) < minMove) continue;
    const backHome = move < 0;               // spread moved toward home
    // Settled at the OPENING number, which is the whole point of the rule.
    const cover = backHome ? (r.margin + r.open) : -(r.margin + r.open);
    if (Math.abs(cover) < 1e-9) continue;    // push — a loss in the pool, excluded here

    // Does the number you are holding sit on the good side of a key number
    // that the market has since crossed? That is the case where the stale line
    // is not just better, but better across a spike.
    const lo = Math.min(Math.abs(r.open), Math.abs(r.close));
    const hi = Math.max(Math.abs(r.open), Math.abs(r.close));
    const crossed = KEYS.filter(k => k > lo && k < hi);
    // Or you are holding the key number itself.
    const holdingKey = KEYS.some(k => Math.abs(Math.abs(r.open) - k) < 1e-9);

    out.push({ won: cover > 0, crossed: crossed.length > 0, holdingKey,
               year: r.year, move: Math.abs(move) });
  }
  return out;
}

const report = (label, bets) => {
  const n = bets.length;
  if (n < 20) { console.log(`  ${label.padEnd(38)} too few (${n})`); return; }
  const w = bets.filter(b => b.won).length;
  const rate = w / n;
  const z = (rate - 0.5) / Math.sqrt(0.25 / n);
  console.log(`  ${label.padEnd(38)} ${String(w).padStart(3)}-${String(n-w).padStart(3)}  ` +
    `${(rate*100).toFixed(1)}%  ${String(n).padStart(3)} bets  ${z>=0?'+':''}${z.toFixed(2)} SD`);
};

console.log(`${rows.length} games with an opening and a closing number\n`);

for (const mv of [1, 1.5, 2]) {
  const bets = staleBets(mv);
  console.log(`MOVE >= ${mv} POINTS  (${bets.length} bets total)`);
  report('all stale bets', bets);
  report('  move CROSSED a 3 or a 7', bets.filter(b => b.crossed));
  report('  move did NOT cross one', bets.filter(b => !b.crossed));
  console.log('');
}

// The other cut: you are sitting ON the key number, whatever the move did.
console.log('HOLDING THE KEY NUMBER ITSELF (your frozen line is exactly 3 or 7)');
for (const mv of [1, 2]) {
  const bets = staleBets(mv);
  report(`move >= ${mv}, holding a 3 or 7`, bets.filter(b => b.holdingKey));
  report(`move >= ${mv}, holding anything else`, bets.filter(b => !b.holdingKey));
}

// Does it replicate across seasons? The single thing that killed every other
// idea this session.
console.log('\nSEASON SPLIT — crossing a key number, move >= 1');
for (const y of [2024, 2025]) {
  report(`${y}`, staleBets(1).filter(b => b.crossed && b.year === y));
}
