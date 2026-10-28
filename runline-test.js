'use strict';
/**
 * Grade runLineEdge -- the last untested signal in the codebase.
 *
 * CHECKED: nothing had ever measured it. CLAUDE.md mentions `runLineEdge` once,
 * and only to warn that its `homeEdgePts` is in PROBABILITY points while
 * myBook's is in SPREAD points ("two units under one name is how the bad badge
 * shipped"). No win rate, no SD, no sample size for it anywhere. Also checked:
 * price-move.js and nhl-price.js (moneyline movement over TIME -- a different
 * claim from disagreement at a single moment), bookOfferEdge and
 * bestMarketOffer (across books, not within one), nba-travel.js (whose cache
 * supplied the first, invalid attempt at this).
 *
 * WHAT IT CLAIMS. Inside ONE book, de-vig the two-way moneyline to a win
 * probability, convert that to a cover probability at the same book's puckline,
 * and compare it to what that puckline's own price implies. If they disagree,
 * one is mispriced relative to the other and the side the moneyline likes is the
 * value. One book, no forecast.
 *
 * SPORT MATTERS, and getting this wrong produced a fake verdict. runLineEdge is
 * built on coverProbFromWinProb, which has a counted margin table for MLB and
 * NHL only -- the two sports whose spread is PINNED at 1.5, so the price is the
 * only place an opinion can appear. The first run of this grader pointed it at
 * 3,983 basketball games, got null on every one because the table does not exist
 * for basketball, and printed "Nothing clears. runLineEdge is not a bet". That
 * is a check failing open: a verdict on zero observations, in the same shape as
 * a real result. It now refuses to report one.
 *
 * SCORED IN PROBABILITY POINTS against the de-vigged price taken, not ROI -- ROI
 * on a +200 dog flatters a one-point edge through the multiplier alone, which
 * invented a dog-only story in hockey once. And FADING is scored too: a real
 * effect mirrors, noise does not.
 *
 * Run: node runline-test.js [nhl|mlb]
 */
const fs = require('fs');
const model = require('./model');

const SPORT = (process.argv[2] || 'nhl').toLowerCase();
const SOURCES = { nhl: './nhl-price-rows.json', mlb: './mlb-price-rows.json' };
if (!SOURCES[SPORT]) {
  console.error('runLineEdge applies to mlb and nhl only. ' + SPORT.toUpperCase() +
    ' has no counted margin table, so the signal cannot be computed for it at all' +
    ' -- and a grader that reports "it fails" in that case is lying.');
  process.exit(2);
}
if (!fs.existsSync(SOURCES[SPORT])) {
  console.error('no harvested rows at ' + SOURCES[SPORT] + ' -- run nhl-harvest.js first.');
  process.exit(2);
}

const games = JSON.parse(fs.readFileSync(SOURCES[SPORT], 'utf8'))
  .filter((r) => [r.spread, r.sHome, r.sAway, r.mlHome, r.mlAway, r.margin].every(Number.isFinite))
  .filter((r) => r.sHome !== 0 && r.sAway !== 0);     // parseAmericanValue's EVEN/PK

const impliedProb = (a) => (!Number.isFinite(a) || a === 0 ? null
  : a > 0 ? 100 / (a + 100) : (-a) / (-a + 100));
const covers = (side, spread, margin) =>
  (side === 'home' ? (margin + spread) : -(margin + spread));
const pc = (x) => (x * 100).toFixed(2) + '%';

console.log('');
console.log('RUNLINEEDGE, GRADED -- ' + SPORT.toUpperCase());
console.log('  ' + games.length + ' games from the harvest, no new fetches.');
const books = {};
for (const g of games) books[g.book] = (books[g.book] || 0) + 1;
console.log('  providers: ' + Object.entries(books).sort((a, b) => b[1] - a[1])
  .map(([b, n]) => b + ' ' + n).join(', '));
console.log('  the moneyline and the puckline price always come from the SAME item,');
console.log('  so the comparison is within one book whichever book that is.');

const bets = [];
let noNumber = 0;
for (const g of games) {
  const r = model.runLineEdge({
    sport: SPORT, homeML: g.mlHome, awayML: g.mlAway, spread: g.spread,
    spreadHomePrice: g.sHome, spreadAwayPrice: g.sAway,
  });
  const he = r && Number.isFinite(r.homeEdgePts) ? r.homeEdgePts : null;
  const ae = r && Number.isFinite(r.awayEdgePts) ? r.awayEdgePts : null;
  if (he === null && ae === null) { noNumber++; continue; }
  const side = (he === null ? -99 : he) >= (ae === null ? -99 : ae) ? 'home' : 'away';
  const edge = side === 'home' ? he : ae;
  if (!Number.isFinite(edge)) { noNumber++; continue; }
  const cov = covers(side, g.spread, g.margin);
  if (Math.abs(cov) < 1e-9) continue;                 // a push refunds: nothing to score
  bets.push({ edge, side, won: cov > 0, month: g.month,
    paid: impliedProb(side === 'home' ? g.sHome : g.sAway) });
}
console.log('  signal produced a number on ' + bets.length + ' games (' + noNumber +
  ' with none: no de-vig, or no edge either side)');

function score(list, follow) {
  if (!list.length) return null;
  const n = list.length;
  const w = list.filter((b) => (follow ? b.won : !b.won)).length;
  const p = w / n;
  // the bet must beat the price it PAID, so that is the baseline, not 50%
  const paid = list.reduce((s, b) => s + (b.paid === null ? 0.5 : b.paid), 0) / n;
  const base = follow ? paid : 1 - paid;
  const byMonth = {};
  for (const b of list) {
    byMonth[b.month] = byMonth[b.month] || { n: 0, w: 0 };
    byMonth[b.month].n++;
    if (follow ? b.won : !b.won) byMonth[b.month].w++;
  }
  const months = Object.values(byMonth).filter((x) => x.n >= 20);
  return { n, p, base, pts: (p - base) * 100,
    sd: (p - base) / Math.sqrt(0.25 / n),
    monthsUp: months.filter((x) => x.w / x.n > base).length, monthsTotal: months.length };
}

if (!bets.length) {
  console.log('');
  console.log('  NO VERDICT. The signal produced a number on ZERO games, so nothing here');
  console.log('  has been measured -- least of all that the signal fails. That exact');
  console.log('  false negative is why this guard exists.');
  process.exit(2);
}

console.log('');
console.log('FOLLOWING IT -- back the puckline side the moneyline prefers');
console.log('  threshold      n     win%    price implied   pts vs price      SD   months up');
const THS = [0, 1, 2, 3, 5, 8];
const scored = [];
for (const th of THS) {
  const r = score(bets.filter((b) => b.edge >= th), true);
  if (!r) continue;
  scored.push({ th, r });
  console.log('  >= ' + String(th).padStart(2) + ' pts   ' + String(r.n).padStart(5) +
    '   ' + pc(r.p).padStart(7) + '     ' + pc(r.base).padStart(7) + '     ' +
    (r.pts >= 0 ? '+' : '') + r.pts.toFixed(2).padStart(6) + ' pts   ' +
    (r.sd >= 0 ? '+' : '') + r.sd.toFixed(2).padStart(6) + '   ' +
    r.monthsUp + '/' + r.monthsTotal);
}
console.log('');
console.log('FADING IT -- the mirror. A real effect inverts here; noise does not.');
console.log('  threshold      n     win%    price implied   pts vs price      SD');
for (const th of [0, 2, 5]) {
  const r = score(bets.filter((b) => b.edge >= th), false);
  if (!r) continue;
  console.log('  >= ' + String(th).padStart(2) + ' pts   ' + String(r.n).padStart(5) +
    '   ' + pc(r.p).padStart(7) + '     ' + pc(r.base).padStart(7) + '     ' +
    (r.pts >= 0 ? '+' : '') + r.pts.toFixed(2).padStart(6) + ' pts   ' +
    (r.sd >= 0 ? '+' : '') + r.sd.toFixed(2).padStart(6));
}

console.log('');
console.log('THE THREE GATES');
let anyPass = false;
for (const { th, r } of scored) {
  if (r.n < 100) { console.log('  >= ' + th + ' pts   only ' + r.n + ' bets, not graded'); continue; }
  const g1 = r.pts > 0;
  const g2 = r.monthsTotal > 0 && r.monthsUp === r.monthsTotal;
  const g3 = Math.abs(r.sd) >= 2.5;
  if (g1 && g2 && g3) anyPass = true;
  console.log('  >= ' + String(th).padStart(2) + ' pts   beats its price: ' + (g1 ? 'yes' : 'NO ') +
    '   every month: ' + (g2 ? 'yes' : 'NO ') + ' (' + r.monthsUp + '/' + r.monthsTotal + ')' +
    '   >=2.5 SD: ' + (g3 ? 'yes' : 'NO ') + '   -> ' + (g1 && g2 && g3 ? 'CLEARS' : 'fails'));
}
console.log('');
const graded = scored.filter((x) => x.r.n >= 100).length;
if (!graded) {
  console.log('  NO VERDICT: no threshold had 100 bets behind it.');
  process.exit(2);
}
console.log(anyPass
  ? '  SOMETHING CLEARS. Holdout it on another season before believing it.'
  : '  Nothing clears, across ' + graded + ' thresholds and ' + bets.length +
    ' graded bets.\n  runLineEdge is not a bet, and that is now MEASURED rather than unmeasured.');
console.log('');
