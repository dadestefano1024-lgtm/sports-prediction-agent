'use strict';
/**
 * Hockey margins are not a bell curve, and the model prices them as one.
 *
 * CHECKED: calibrate-sport.js (built the season this reads, and fits sigma),
 * model.js DISCRETE_MARGIN_SPORTS (holds nfl and nba only), keynumbers.js and
 * calibrate-keys.js (football key numbers, same idea, different sport).
 *
 * Two facts about the NHL that a continuous normal cannot express:
 *
 *   1. A margin of ZERO is impossible. There have been no ties since 2005.
 *   2. Every game decided in overtime or a shootout is a ONE-goal game by rule,
 *      and roughly a quarter of games go there. So mass piles at exactly 1 in a
 *      way nothing else in the schedule explains.
 *
 * That is the same shape as football's spike on 3 and 7, except larger and
 * structural rather than behavioural, and football has a counted PMF for it
 * while hockey has a normal. The puckline is fixed at 1.5, so the one question
 * ever asked of this distribution is P(margin >= 2) -- which is exactly the
 * quantity a spike at 1 distorts.
 *
 * Run: node nhl-shape.js
 */
const fs = require('fs');
const model = require('./model');

const rows = JSON.parse(fs.readFileSync('./cal-nhl-rows.json', 'utf8'));
console.log(`${rows.length} completed NHL regular-season games\n`);

const margins = rows.map(r => Math.abs(r.margin));
const n = margins.length;
const share = (k) => margins.filter(m => m === k).length / n;

console.log('ACTUAL MARGIN DISTRIBUTION (absolute goal difference)');
let cum = 0;
for (let k = 0; k <= 7; k++) {
  const s = share(k);
  cum += s;
  const bar = '#'.repeat(Math.round(s * 80));
  console.log('  by ' + k + '  ' + (s * 100).toFixed(1).padStart(5) + '%  ' + bar);
}
console.log('  8+   ' + ((1 - cum) * 100).toFixed(1).padStart(5) + '%');
console.log('');
console.log('  margin of ZERO: ' + (share(0) * 100).toFixed(2) + '%  (no ties since 2005)');
console.log('  margin of ONE : ' + (share(1) * 100).toFixed(1) + '%  <- overtime forces this');
console.log('');

// What the model actually believes, through the function that prices the puckline.
const cfg = model.sportConfig('nhl');
console.log('WHAT THE MODEL BELIEVES vs WHAT HAPPENS');
console.log('  the puckline is fixed at 1.5, so the only question is P(win by 2+)\n');
const realAtLeast = (k) => margins.filter(m => m >= k).length / n;

// Home-side version, since that is how the model is asked.
const homeMargins = rows.map(r => r.margin);
const realHome = (k) => homeMargins.filter(m => m >= k).length / rows.length;
const meanMargin = homeMargins.reduce((a, b) => a + b, 0) / rows.length;
console.log('  mean home margin: ' + meanMargin.toFixed(3) + ' goals');
console.log('');
console.log('  threshold   real      model at sigma ' + cfg.sigma);
for (const k of [1, 2, 3, 4]) {
  // P(home margin >= k) == P(margin > k - 0.5)
  const mdl = model.coverOutcomes({
    predictedMargin: meanMargin, spread: -(k - 0.5), sigma: cfg.sigma, sport: 'nhl',
  }).win;
  console.log('  win by ' + k + '+   ' + (realHome(k) * 100).toFixed(1).padStart(6) + '%' +
    (mdl * 100).toFixed(1).padStart(14) + '%' +
    ((mdl - realHome(k)) * 100 >= 0 ? '   +' : '   ') +
    ((mdl - realHome(k)) * 100).toFixed(1));
}
console.log('');

// Does ANY sigma fix it, or is the shape wrong?
let best = null;
for (let sg = 1.0; sg <= 4.0; sg += 0.01) {
  let err = 0;
  for (const k of [1, 2, 3, 4]) {
    const mdl = model.coverOutcomes({
      predictedMargin: meanMargin, spread: -(k - 0.5), sigma: sg, sport: 'nhl',
    }).win;
    err += (mdl - realHome(k)) ** 2;
  }
  if (!best || err < best.err) best = { sg: +sg.toFixed(2), err };
}
console.log('BEST POSSIBLE SIGMA, and whether it is enough');
console.log('  fitted sigma: ' + best.sg + '  (config has ' + cfg.sigma + ')');
console.log('  threshold   real      at ' + best.sg);
let worst = 0;
for (const k of [1, 2, 3, 4]) {
  const mdl = model.coverOutcomes({
    predictedMargin: meanMargin, spread: -(k - 0.5), sigma: best.sg, sport: 'nhl',
  }).win;
  worst = Math.max(worst, Math.abs(mdl - realHome(k)));
  console.log('  win by ' + k + '+   ' + (realHome(k) * 100).toFixed(1).padStart(6) + '%' +
    (mdl * 100).toFixed(1).padStart(11) + '%');
}
console.log('  worst remaining miss: ' + (worst * 100).toFixed(2) + ' percentage points');
console.log('');
console.log('  If a miss survives the best possible sigma, the SHAPE is wrong and no');
console.log('  single parameter fixes it -- which is the argument for giving hockey a');
console.log('  counted PMF, the way football has one for 3 and 7.');
console.log('');

// The totals market, which is the live one in hockey.
const tot = rows.filter(r => Number.isFinite(r.closeTotal));
if (tot.length > 50) {
  const res = tot.map(r => r.total - r.closeTotal);
  const mean = res.reduce((a, b) => a + b, 0) / res.length;
  const sd = Math.sqrt(res.reduce((a, b) => a + (b - mean) ** 2, 0) / (res.length - 1));
  console.log('THE TOTAL, which is the live market in hockey  (n=' + tot.length + ')');
  console.log('  mean residual ' + (mean >= 0 ? '+' : '') + mean.toFixed(3) +
    '   sd ' + sd.toFixed(3) + '   config totalSigma ' + cfg.totalSigma);
  const lines = {};
  for (const r of tot) lines[r.closeTotal] = (lines[r.closeTotal] || 0) + 1;
  const top = Object.entries(lines).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('  commonest closing totals: ' + top.map(([k, v]) => k + ' (' + v + ')').join(', '));
}
