// Does the moneyline know something the spread does not?
//
// 1,087 NFL games, 2022 through 2025, each with a closing spread, both closing
// moneylines and a final score.
//
// The claim under test: two books posting the same -7.5 while their moneylines
// say -350 and -180 are telling you something, because those two markets
// describe one game and only one pair is consistent. If that is true, then a
// moneyline that is RICH relative to what its spread usually carries should
// mean the spread is cheap — and backing that spread should beat 52.4%.
//
// RESULT: NEGATIVE. The disagreement is real and it does not predict.
//
//   gap >= 0   50.6% on 1064 bets   +0.37 SD
//   gap >= 1   51.1% on  650 bets   +0.55 SD
//   gap >= 2   50.4% on  335 bets   +0.16 SD
//   gap >= 3   50.3% on  151 bets   +0.08 SD
//   gap >= 4   56.3% on   64 bets   +1.00 SD   <- 64 bets, one SD, noise
//
// Break-even is 52.4%. Season by season at gap >= 2: 54.5, 49.2, 48.1, 49.5 —
// no consistency. Split by spread size: 53.1% on small spreads and 47.9% on
// mid, pointing opposite ways. Fading it does no better than backing it.
//
// The likely reason is that the disagreement is not an error. A -7.5 favourite
// in a low-scoring game really does win outright more often than a -7.5
// favourite in a shootout, and books price both markets accordingly. What the
// gap measured was the single-sigma curve failing to capture that, not the
// market contradicting itself. Fourth negative result of this kind here, and
// recorded so it does not get rebuilt.
//
// What DID come out of it is in the model now: nfl sigma, measured at 10.82
// for this use against the 13.5 the file carried.
//
// The test does not need a model of football. For every game it measures how
// far that game's moneyline sits from the moneyline a spread of that size
// usually gets, which is a residual against the market's own curve, and then
// asks what happened against the spread.

const fs = require('fs');
const model = require('./model');

const { games } = JSON.parse(fs.readFileSync('./nfl-history.json', 'utf8'));
const usable = games.filter(g =>
  Number.isFinite(g.spread) && Number.isFinite(g.margin) &&
  Number.isFinite(g.homeML) && Number.isFinite(g.awayML));

console.log(`${usable.length} games with a closing spread, both moneylines and a score`);
const years = {};
for (const g of usable) years[g.year] = (years[g.year] || 0) + 1;
console.log(`  by season: ${JSON.stringify(years)}\n`);

// ---------------------------------------------------------------------------
// 1. What a closing spread was actually worth
// ---------------------------------------------------------------------------
console.log('  how often the favourite won OUTRIGHT, by closing spread:');
const bands = [[0, 1.6], [1.6, 3.6], [3.6, 6.6], [6.6, 9.6], [9.6, 13.6], [13.6, 99]];
const points = [];
for (const [lo, hi] of bands) {
  const inB = usable.filter(g => Math.abs(g.spread) >= lo && Math.abs(g.spread) < hi);
  if (inB.length < 20) continue;
  const favWon = inB.filter(g => (g.spread < 0 ? g.margin > 0 : g.margin < 0)).length;
  const meanSpread = inB.reduce((s, g) => s + Math.abs(g.spread), 0) / inB.length;
  const rate = favWon / inB.length;
  points.push({ meanSpread, rate, n: inB.length });
  const normal = model.normalCdf(meanSpread / model.SPORTS.nfl.sigma);
  console.log(`    ${String(lo).padStart(4)}-${String(hi === 99 ? '+' : hi).padStart(4)} ` +
    `(mean ${meanSpread.toFixed(1)}): ${String(inB.length).padStart(4)} games   ` +
    `won ${(rate * 100).toFixed(1)}%   normal says ${(normal * 100).toFixed(1)}%   ` +
    `${rate - normal >= 0 ? '+' : ''}${((rate - normal) * 100).toFixed(1)}`);
}
let best = null;
for (let sg = 8; sg <= 20; sg += 0.05) {
  let err = 0;
  for (const p of points) err += p.n * Math.pow(p.rate - model.normalCdf(p.meanSpread / sg), 2);
  if (!best || err < best.err) best = { sigma: +sg.toFixed(2), err };
}
console.log(`\n  sigma that best reproduces those outcomes: ${best.sigma} (file carries ${model.SPORTS.nfl.sigma})`);

// ---------------------------------------------------------------------------
// 2. The market's own spread-to-moneyline curve
// ---------------------------------------------------------------------------
// Every game gives a (spread, de-vigged home win probability) pair. The curve
// through them is what a spread of each size USUALLY carries. A game sitting
// off that curve is one where the two markets disagree with each other.
const withP = [];
for (const g of usable) {
  let p;
  try { p = model.deVigTwoWayShin(g.homeML, g.awayML).probA; } catch (e) { continue; }
  if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;
  withP.push({ ...g, pML: p });
}

// Fit the sigma that best maps spread -> moneyline across the whole set. This
// is describing the MARKET, not football: it is the shape books price to.
let curve = null;
for (let sg = 8; sg <= 20; sg += 0.02) {
  let err = 0;
  for (const g of withP) err += Math.pow(g.pML - model.normalCdf(-g.spread / sg), 2);
  if (!curve || err < curve.err) curve = { sigma: +sg.toFixed(2), err };
}
console.log(`  sigma the market itself prices moneylines to: ${curve.sigma}`);

for (const g of withP) {
  g.expectedP = model.normalCdf(-g.spread / curve.sigma);
  g.gap = (g.pML - g.expectedP) * 100;      // + means the ML likes home more than the spread does
  g.homeCovered = (g.margin + g.spread) > 0;
  g.push = Math.abs(g.margin + g.spread) < 1e-9;
}
const gaps = withP.map(g => g.gap).sort((a, b) => a - b);
console.log(`  disagreement between the two markets, in probability points:`);
console.log(`    median ${gaps[gaps.length >> 1].toFixed(2)}   ` +
  `10th ${gaps[Math.floor(gaps.length * 0.1)].toFixed(2)}   90th ${gaps[Math.floor(gaps.length * 0.9)].toFixed(2)}   ` +
  `max |gap| ${Math.max(...gaps.map(Math.abs)).toFixed(2)}`);

// ---------------------------------------------------------------------------
// 3. THE TEST. Back the side the disagreement points at, against the spread.
// ---------------------------------------------------------------------------
console.log('\n  backing the spread the moneyline says is cheap:');
console.log('    (positive gap -> back HOME spread; negative -> back AWAY spread)');
const thresholds = [0, 1, 2, 3, 4];
for (const t of thresholds) {
  const bets = withP.filter(g => Math.abs(g.gap) >= t && !g.push);
  if (bets.length < 30) continue;
  let w = 0;
  for (const g of bets) {
    const backHome = g.gap > 0;
    if (backHome ? g.homeCovered : !g.homeCovered) w++;
  }
  const rate = w / bets.length;
  const se = Math.sqrt(0.25 / bets.length);
  const z = (rate - 0.5) / se;
  console.log(`    gap >= ${t}: ${String(w).padStart(4)}-${String(bets.length - w).padStart(4)}  ` +
    `${(rate * 100).toFixed(1)}%   ${bets.length} bets   ${z >= 0 ? '+' : ''}${z.toFixed(2)} SD from a coin flip` +
    `   ${rate > 0.524 ? '<-- beats the vig' : ''}`);
}

console.log('\n  and the reverse, in case the signal points the other way:');
for (const t of [2, 3]) {
  const bets = withP.filter(g => Math.abs(g.gap) >= t && !g.push);
  if (bets.length < 30) continue;
  let w = 0;
  for (const g of bets) {
    const backHome = g.gap < 0;
    if (backHome ? g.homeCovered : !g.homeCovered) w++;
  }
  const rate = w / bets.length;
  console.log(`    fading, gap >= ${t}: ${(rate * 100).toFixed(1)}% on ${bets.length} bets`);
}

// A control: does the signal survive when the spread is held roughly fixed?
console.log('\n  same test inside single spread bands, so the gap cannot just be proxying the spread:');
for (const [lo, hi] of [[0, 3.6], [3.6, 7.6], [7.6, 99]]) {
  const inB = withP.filter(g => Math.abs(g.spread) >= lo && Math.abs(g.spread) < hi && Math.abs(g.gap) >= 2 && !g.push);
  if (inB.length < 30) continue;
  let w = 0;
  for (const g of inB) { const bh = g.gap > 0; if (bh ? g.homeCovered : !g.homeCovered) w++; }
  console.log(`    spread ${lo}-${hi === 99 ? '+' : hi}, gap >= 2: ${w}-${inB.length - w}  ` +
    `${(w / inB.length * 100).toFixed(1)}% on ${inB.length} bets`);
}

// Season by season, because one season can say anything.
console.log('\n  by season at gap >= 2, since a single year proves nothing:');
for (const y of Object.keys(years).sort()) {
  const inY = withP.filter(g => g.year === Number(y) && Math.abs(g.gap) >= 2 && !g.push);
  if (!inY.length) continue;
  let w = 0;
  for (const g of inY) { const bh = g.gap > 0; if (bh ? g.homeCovered : !g.homeCovered) w++; }
  console.log(`    ${y}: ${w}-${inY.length - w}  ${(w / inY.length * 100).toFixed(1)}%`);
}
