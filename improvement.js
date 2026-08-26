// Measure the market's IMPROVEMENT directly, bucket by bucket.
//
// The stale-line rule is usually justified by its win rate. The mechanism
// underneath it is narrower and more useful: the closing spread is a more
// accurate description of the game than the opening spread, so a frozen
// Wednesday number is behind a genuinely better one. Totals fail the rule
// because their close is NOT better than their open.
//
// If that is the mechanism then improvement should be measurable per bucket,
// and the buckets where the market improved most should be where the rule pays
// most. If it is not, the rule is a correlation nobody understands.
//
// Improvement = mean|margin + open| - mean|margin + close|. Positive means the
// closing number described the game better.
//
// Run: node improvement.js

const fs = require('fs');
const sp = JSON.parse(fs.readFileSync('./nfl-open-close.json', 'utf8')).rows;
const tot = JSON.parse(fs.readFileSync('./nfl-totals.json', 'utf8')).rows;

const show = (label, set, errOpen, errClose, betFn) => {
  if (set.length < 25) { console.log(`  ${label.padEnd(26)} too few (${set.length})`); return; }
  const eo = set.reduce((a, r) => a + errOpen(r), 0) / set.length;
  const ec = set.reduce((a, r) => a + errClose(r), 0) / set.length;
  const bets = set.map(betFn).filter(v => v !== null);
  const rate = bets.length ? bets.filter(Boolean).length / bets.length : null;
  console.log(`  ${label.padEnd(26)} ${String(set.length).padStart(4)}   ` +
    `${eo.toFixed(3)}   ${ec.toFixed(3)}   ${(eo - ec >= 0 ? '+' : '')}${(eo - ec).toFixed(3)}      ` +
    (rate === null ? '   -  ' : `${(rate * 100).toFixed(1)}%`));
};

console.log('SPREADS — did the close describe the game better than the open?\n');
console.log('  move size                    n   err@open  err@close  improvement   rule wins');
const sErrO = (r) => Math.abs(r.margin + r.open);
const sErrC = (r) => Math.abs(r.margin + r.close);
const sBet = (r) => {
  const move = r.close - r.open;
  if (Math.abs(move) < 1e-9) return null;
  const backHome = move < 0;
  const cover = backHome ? (r.margin + r.open) : -(r.margin + r.open);
  return Math.abs(cover) < 1e-9 ? false : cover > 0;   // push loses, this pool
};
for (const [lo, hi, label] of [
  [0, 0.5, 'did not move'],
  [0.5, 1, 'moved half a point'],
  [1, 2, 'moved 1 to 1.5'],
  [2, 3, 'moved 2 to 2.5'],
  [3, 99, 'moved 3 or more'],
]) {
  const set = sp.filter(r => { const m = Math.abs(r.close - r.open); return m >= lo && m < hi; });
  show(label, set, sErrO, sErrC, sBet);
}

console.log('\n\nTOTALS — the same question\n');
console.log('  move size                    n   err@open  err@close  improvement   rule wins');
const tErrO = (r) => Math.abs(r.points - r.openTotal);
const tErrC = (r) => Math.abs(r.points - r.closeTotal);
const tBet = (r) => {
  const move = r.closeTotal - r.openTotal;
  if (Math.abs(move) < 1e-9) return null;
  const backOver = move > 0;
  const diff = r.points - r.openTotal;
  return Math.abs(diff) < 1e-9 ? false : (backOver ? diff > 0 : diff < 0);
};
for (const [lo, hi, label] of [
  [0, 0.5, 'did not move'],
  [0.5, 1, 'moved half a point'],
  [1, 2, 'moved 1 to 1.5'],
  [2, 3, 'moved 2 to 2.5'],
  [3, 99, 'moved 3 or more'],
]) {
  const set = tot.filter(r => { const m = Math.abs(r.closeTotal - r.openTotal); return m >= lo && m < hi; });
  show(label, set, tErrO, tErrC, tBet);
}

console.log('\n\nTHE TEST OF THE MECHANISM');
console.log('  If improvement is what pays, the two right-hand columns should move together.');
