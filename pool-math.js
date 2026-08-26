// What a 6-0, 300-entrant, split-pot pool actually rewards.
//
// The app ranks Pick 6 candidates by cover probability, which is the right
// number for six separate bets into a book. It is the wrong number here, for
// two reasons that both cut deep:
//
//   1. You need 6-0. A push does not cost you one pick, it ends the week. So
//      the quantity that matters per pick is P(win outright), and the quantity
//      that matters per CARD is the product of six of them.
//   2. The pot splits. With 300 entrants, going 6-0 alongside forty other
//      people pays a fortieth of going 6-0 alone.
//
// Run: node pool-math.js

const m = require('./model');

const ENTRANTS = 300;
const pct = (x) => (x * 100).toFixed(2) + '%';

console.log('WHAT A CARD IS WORTH, by per-pick win rate\n');
console.log('  per pick   P(6-0)     1 in');
for (const p of [0.50, 0.524, 0.55, 0.58, 0.60, 0.65]) {
  const six = Math.pow(p, 6);
  console.log(`  ${(p*100).toFixed(1)}%      ${pct(six).padStart(7)}   ${Math.round(1/six)}`);
}

// ---------------------------------------------------------------------------
// The push problem, priced.
// ---------------------------------------------------------------------------
console.log('\n\nTHE COST OF ONE WHOLE NUMBER ON YOUR CARD');
console.log('  (a push is a loss here, so it comes straight off the pick)\n');
console.log('  line    P(push)   best case P(win)   card P(6-0)   vs all half-points');

// A whole-number line, priced at the market's own view so the two sides are
// near even. Whatever is left after the push splits between the two sides.
const base = 0.58;                       // five half-point picks at the stale-line rate
const allHalf = Math.pow(base, 6);
for (const L of [3, 7, 6, 4, 10]) {
  const o = m.coverOutcomes({ predictedMargin: L, spread: -L, sigma: 10.82, sport: 'nfl' });
  const push = o.push;
  // Even a perfectly chosen side can only have (1 - push) / 2 + edge.
  const win = (1 - push) / 2 + (base - 0.5);
  const card = Math.pow(base, 5) * win;
  console.log(`  ${String(L).padStart(4)}    ${pct(push).padStart(6)}    ${pct(win).padStart(8)}         ` +
    `${pct(card).padStart(7)}      ${((card/allHalf - 1) * 100).toFixed(1)}%`);
}
const halfO = { push: 0 };
console.log(`  any .5   ${pct(halfO.push).padStart(6)}    ${pct(base).padStart(8)}         ${pct(allHalf).padStart(7)}      baseline`);

// ---------------------------------------------------------------------------
// Splitting the pot.
// ---------------------------------------------------------------------------
console.log('\n\nWHO ELSE GOES 6-0 WITH YOU');
console.log(`  ${ENTRANTS} entrants. If another entry shares a game with you and took the`);
console.log('  OTHER side, they cannot go 6-0 when you do. If they took your side,');
console.log('  that win is already banked for them too.\n');
console.log('  your picks are      co-winners    your share of the pot');
// Crude but directionally right: an entry that agrees with you on k of your six
// games needs its remaining 6-k picks to land. Agreement is what ownership
// measures; the popular side is where agreement concentrates.
for (const [label, agreeRate] of [
  ['the popular side (85%)', 0.85],
  ['moderately popular (60%)', 0.60],
  ['a coin flip (50%)', 0.50],
  ['contrarian (25%)', 0.25],
  ['heavily contrarian (10%)', 0.10],
]) {
  // P(a given other entry also goes 6-0) ~ P(they agree with you everywhere
  // they overlap) x P(their non-overlapping picks land). Held simple: agreement
  // on all six is the dominant term for a co-winner.
  const together = Math.pow(agreeRate, 6);
  const co = ENTRANTS * together;
  console.log(`  ${label.padEnd(24)} ${co.toFixed(1).padStart(7)}      ${pct(1 / (1 + co)).padStart(7)}`);
}

console.log('\n\nTHE TRADE, PUT TOGETHER');
console.log('  a contrarian pick at a LOWER win rate can still be worth more,');
console.log('  because the pot stops splitting six ways.\n');
console.log('  strategy                    P(6-0)    co-winners   expected share');
for (const [label, p, agree] of [
  ['six popular favourites', 0.60, 0.85],
  ['six moderate picks', 0.58, 0.60],
  ['six contrarian picks', 0.55, 0.25],
  ['four popular, two contrarian', 0.585, 0.55],
]) {
  const six = Math.pow(p, 6);
  const co = ENTRANTS * Math.pow(agree, 6);
  const value = six / (1 + co);
  console.log(`  ${label.padEnd(28)} ${pct(six).padStart(6)}   ${co.toFixed(1).padStart(8)}     ${(value * 10000).toFixed(2)}`);
}
console.log('\n  (expected share is relative, x10,000 — bigger is better)');
