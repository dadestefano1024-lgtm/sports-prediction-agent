'use strict';
/**
 * Do the NFL key-number weights match the margins that actually happened?
 *
 * CHECKED: calibrateMarginWeights in model.js (exists for exactly this and was
 * used to fit 3, 4, 6 and 7 against their CONDITIONAL rates), calibrate.js,
 * calibrate2.js, fit-total-sigma.js, NHL_MARGIN_WEIGHTS and MLB_MARGIN_WEIGHTS
 * (both derived as observed-share-over-normal, which is the method reused here).
 *
 * WHY, and it is not idle. The weights at 3, 4, 6 and 7 are FITTED -- the table's
 * own note gives the games behind each (1,112 / 324 / 338 / 469) and says
 * "numbers with fewer than 300 games behind them are left at their hand-set
 * values". Everything else in that table is a round number somebody chose.
 *
 * Danny's week-7 sheet lines four games at 5 and one at 11. Both weights are
 * hand-set: 0.85 and 0.90. And because the pool posts WHOLE numbers with a push
 * LOSING, the weight at the line is precisely what sets the dead mass -- the
 * probability that lands on the number and kills BOTH tickets. A wrong weight at
 * 5 misprices eight of this week's twenty-six sides.
 *
 * This measures the pooled observed share against the model's own PMF. The
 * table's note says a pooled fit was tried and rejected because it wanted a
 * weight of 2.32 at a margin of 24 on a handful of games -- true, and it is a
 * TAIL problem. At a common margin like 5 the pooled count is not thin, so the
 * comparison is informative there and is reported with its game count so the
 * thin ones can be ignored rather than believed.
 *
 * Run: node weights-audit.js
 */
const fs = require('fs');
const model = require('./model');

const rows = (() => {
  const raw = JSON.parse(fs.readFileSync('./frozen-rows.json', 'utf8'));
  return (Array.isArray(raw) ? raw : (raw.rows || raw.games || []))
    .filter(r => Number.isFinite(r.margin) && Number.isFinite(r.close));
})();

// Observed |margin| distribution.
const obs = new Map();
for (const r of rows) {
  const a = Math.abs(r.margin);
  obs.set(a, (obs.get(a) || 0) + 1);
}
const N = rows.length;

// What the model says, pooled the same way: for each game, the PMF centred on
// its OWN closing line, then averaged. That is the apples-to-apples comparison
// -- comparing against one PMF centred on zero would be a different question.
const modelShare = new Map();
for (const r of rows) {
  const pmf = model.marginPmf({ mean: -r.close, sigma: 10.82, sport: 'nfl', centre: 'mean' });
  for (const [m, w] of pmf) {
    const a = Math.abs(m);
    modelShare.set(a, (modelShare.get(a) || 0) + w / N);
  }
}

console.log('');
console.log('NFL MARGIN DISTRIBUTION: what happened vs what the model says');
console.log('  ' + N + ' games, each PMF centred on its own closing line.');
console.log('');
console.log('  |margin|  games   observed   model    obs/model   weight in model   fitted?');
console.log('  ' + '-'.repeat(76));
const FITTED = new Set([3, 4, 6, 7]);
const TABLE = { 0: 0.45, 1: 0.90, 2: 0.90, 3: 2.834, 4: 0.709, 5: 0.85, 6: 1.122,
                7: 1.897, 8: 0.90, 9: 0.85, 10: 1.25, 11: 0.90, 13: 0.95, 14: 1.20,
                17: 1.10, 20: 1.05, 21: 1.05 };
const flags = [];
for (let a = 0; a <= 17; a++) {
  const g = obs.get(a) || 0;
  const o = g / N;
  const m = modelShare.get(a) || 0;
  if (!m && !g) continue;
  const ratio = m > 0 ? o / m : null;
  const w = TABLE[a];
  const thin = g < 25;
  const off = ratio !== null && !thin && (ratio < 0.75 || ratio > 1.33);
  if (off) flags.push({ a, g, o, m, ratio, w });
  console.log('  ' + String(a).padStart(6) + '   ' + String(g).padStart(5) + '   ' +
    (o * 100).toFixed(2).padStart(6) + '%  ' + (m * 100).toFixed(2).padStart(6) + '%   ' +
    (ratio === null ? '   --' : ratio.toFixed(2).padStart(6)) + '      ' +
    (w === undefined ? '  1 (default)' : String(w).padStart(7) + '     ') +
    '   ' + (FITTED.has(a) ? 'fitted' : (w === undefined ? '-' : 'HAND-SET')) +
    (thin ? '   (thin: ' + g + ' games)' : (off ? '   <-- OFF' : '')));
}

console.log('');
if (!flags.length) {
  console.log('  Nothing off by more than a third on a non-thin bucket.');
} else {
  console.log('  OFF BY MORE THAN A THIRD, on buckets with 25+ games:');
  for (const f of flags) {
    console.log('    |margin| ' + f.a + ': observed ' + (f.o * 100).toFixed(2) +
      '% against the model\'s ' + (f.m * 100).toFixed(2) + '%  (ratio ' +
      f.ratio.toFixed(2) + ', weight ' + f.w + ', ' + f.g + ' games)');
  }
}

// ---- the number that actually matters for the Pick 6 -----------------------
console.log('');
console.log('WHAT THIS COSTS ON A WHOLE-NUMBER POOL LINE');
console.log('  A push LOSES, so the mass ON the number comes off BOTH sides.');
console.log('  Danny lined 4 games at 5 and 1 at 11 this week.');
console.log('');
console.log('  line   model push%   observed push%   games lined there   both-sides cost');
for (const k of [2, 3, 4, 5, 7, 11]) {
  // EXACTLY k, not within half a point of it. The first version used a +/-0.5
  // window and reported 16.61% at line 3 -- against the 9.2% the fitted note
  // measured on 1,112 games lined at exactly 3. The window caught lines of 2.5
  // and 3.5, where a margin of 3 is a WIN for one side and not a push at all,
  // so it was counting "how often the margin is 3 near this line" and calling it
  // a push rate. Only a whole-number line can push.
  const at = rows.filter(r => Math.abs(Math.abs(r.close) - k) < 1e-9);
  const landed = at.filter(r => Math.abs(r.margin) === k).length;
  const obsPush = at.length ? landed / at.length : null;
  // the model's push mass at that line
  const pmf = model.marginPmf({ mean: -k, sigma: 10.82, sport: 'nfl', centre: 'mean' });
  let mp = 0;
  for (const [m, w] of pmf) if (m === k) mp += w;
  console.log('  ' + String(k).padStart(4) + '   ' + (mp * 100).toFixed(2).padStart(9) + '%   ' +
    (obsPush === null ? '      --     ' : (obsPush * 100).toFixed(2).padStart(10) + '%  ') +
    '   ' + String(at.length).padStart(10) + '        ' +
    (obsPush === null ? '--' : ((obsPush - mp) * 100).toFixed(2) + ' pts' +
      (at.length < 25 ? '  (thin)' : '')));
}
console.log('');
console.log('  A positive cost means the real dead zone is BIGGER than the model thinks,');
console.log('  so every side at that number is being quoted too high.');
console.log('');
