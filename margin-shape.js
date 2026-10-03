'use strict';
/**
 * Is a sport's margin distribution the shape the model assumes?
 *
 * CHECKED: nhl-shape.js, which this GENERALISES rather than duplicates -- it was
 * written for hockey and the same question now applies to baseball, so the sport
 * is a parameter. nhl-shape.js stays because its header records the hockey
 * result; new sports come here. Also calibrate-sport.js (harvests the seasons and
 * fits sigma), keynumbers.js and calibrate-keys.js (the football version of the
 * same idea), model.js MARGIN_WEIGHTS_BY_SPORT.
 *
 * The hockey lesson, which is why this exists: the sigma was the least of it.
 * Hockey has no ties, overtime forces one-goal games, and empty-net goals make
 * three-goal margins commoner than two-goal ones. The BEST POSSIBLE sigma still
 * missed "win by one or more" by 7.5 points, because a unimodal curve cannot
 * express any of that. Counted weights took it to 2.2.
 *
 * Baseball is the same structural situation: the runline is fixed at 1.5, extra
 * innings mean a 0-run margin is impossible, and one-run games are the single
 * commonest result. So the only question ever asked of the distribution --
 * P(win by 2+) -- again sits right on the edge of a spike.
 *
 * Reports the weights to install if the shape is wrong, and says so plainly if
 * it is not.
 *
 * Run: node margin-shape.js <nhl|mlb|nba|nfl>
 */
const fs = require('fs');
const model = require('./model');

const SPORT = (process.argv[2] || 'mlb').toLowerCase();
const FILE = process.argv[3] || `./cal-${SPORT}-rows.json`;
if (!fs.existsSync(FILE)) { console.error('no rows file: ' + FILE); process.exit(1); }
const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const cfg = model.sportConfig(SPORT);

console.log(`${SPORT.toUpperCase()} — ${rows.length} completed regular-season games`);
console.log(`config: sigma ${cfg.sigma}, totalSigma ${cfg.totalSigma}, hfa ${cfg.hfa}` +
  (cfg.fixedSpread ? ', fixedSpread (the line never moves)' : '') + '\n');

const abs = rows.map(r => Math.abs(r.margin));
const n = abs.length;
const share = (k) => abs.filter(m => m === k).length / n;
const MAXK = SPORT === 'nba' ? 24 : SPORT === 'nfl' ? 20 : 8;

console.log('ACTUAL MARGIN DISTRIBUTION');
let cum = 0;
for (let k = 0; k <= Math.min(MAXK, 9); k++) {
  const s = share(k); cum += s;
  console.log('  by ' + String(k).padEnd(3) + (s * 100).toFixed(1).padStart(5) + '%  ' +
    '#'.repeat(Math.round(s * 80)));
}
console.log('  ' + (Math.min(MAXK, 9) + 1) + '+  ' + ((1 - cum) * 100).toFixed(1).padStart(5) + '%');
console.log('');
console.log('  a margin of ZERO: ' + (share(0) * 100).toFixed(2) + '%');
console.log('  the commonest margin: ' + (() => {
  let best = 0, bs = -1;
  for (let k = 0; k <= MAXK; k++) if (share(k) > bs) { bs = share(k); best = k; }
  return best + ' (' + (bs * 100).toFixed(1) + '%)';
})());
// A dip then a rise is the signature of something mechanical, like the empty net
// in hockey. Worth naming because no smooth curve produces it.
const bumps = [];
for (let k = 2; k <= MAXK - 1; k++) if (share(k) < share(k + 1)) bumps.push(k + 1);
console.log('  margins commoner than the one below them: ' + (bumps.length ? bumps.join(', ') : 'none'));
console.log('');

const homeM = rows.map(r => r.margin);
const meanMargin = homeM.reduce((a, b) => a + b, 0) / rows.length;
const realHome = (k) => homeM.filter(m => m >= k).length / rows.length;
const THRESH = SPORT === 'nba' ? [3, 6, 9, 12] : SPORT === 'nfl' ? [3, 7, 10, 14] : [1, 2, 3, 4];

console.log('WHAT THE MODEL BELIEVES vs WHAT HAPPENS');
console.log('  mean home margin: ' + meanMargin.toFixed(3) + '   (config hfa ' + cfg.hfa + ')');
console.log('  threshold   real      model at sigma ' + cfg.sigma);
for (const k of THRESH) {
  const mdl = model.coverOutcomes({ predictedMargin: meanMargin, spread: -(k - 0.5),
                                    sigma: cfg.sigma, sport: SPORT }).win;
  console.log('  win by ' + String(k).padEnd(3) + '+ ' + (realHome(k) * 100).toFixed(1).padStart(7) + '%' +
    (mdl * 100).toFixed(1).padStart(14) + '%' + ((mdl - realHome(k)) * 100).toFixed(1).padStart(8));
}
console.log('');

// Is the SHAPE wrong, or just the parameter? Find the best sigma and see what
// error survives it.
let best = null;
const lo = SPORT === 'nba' ? 8 : SPORT === 'nfl' ? 8 : 1;
const hi = SPORT === 'nba' ? 20 : SPORT === 'nfl' ? 16 : 6;
for (let sg = lo; sg <= hi; sg += 0.01) {
  let err = 0;
  for (const k of THRESH) {
    const mdl = model.coverOutcomes({ predictedMargin: meanMargin, spread: -(k - 0.5),
                                      sigma: sg, sport: SPORT }).win;
    err += (mdl - realHome(k)) ** 2;
  }
  if (!best || err < best.err) best = { sg: +sg.toFixed(2), err };
}
let worst = 0;
console.log('BEST POSSIBLE SIGMA: ' + best.sg + '   (config has ' + cfg.sigma + ')');
for (const k of THRESH) {
  const mdl = model.coverOutcomes({ predictedMargin: meanMargin, spread: -(k - 0.5),
                                    sigma: best.sg, sport: SPORT }).win;
  worst = Math.max(worst, Math.abs(mdl - realHome(k)));
  console.log('  win by ' + String(k).padEnd(3) + '+ ' + (realHome(k) * 100).toFixed(1).padStart(7) + '%' +
    (mdl * 100).toFixed(1).padStart(11) + '%');
}
console.log('  worst error surviving the best sigma: ' + (worst * 100).toFixed(2) + ' points');
console.log('  ' + (worst > 0.03
  ? 'THE SHAPE IS WRONG. No single parameter fixes it — count the weights.'
  : 'the shape is close enough; the parameter is the whole story here.'));
console.log('');

if (worst > 0.03) {
  // Weights relative to an unweighted normal of the same spread, the same way
  // the hockey and football tables were built.
  const flat = model.marginPmf({ mean: 0, sigma: best.sg, sport: 'other' });
  const expect = (k) => k === 0 ? (flat.get(0) || 0) : ((flat.get(k) || 0) + (flat.get(-k) || 0));
  const W = {};
  console.log('WEIGHTS TO INSTALL — observed / normal');
  console.log('  |margin|   observed   normal   weight');
  for (let k = 0; k <= Math.min(MAXK, 6); k++) {
    const o = share(k), e = expect(k), w = e > 0 ? o / e : 0;
    W[k] = +w.toFixed(3);
    console.log('   ' + String(k).padEnd(10) + (o * 100).toFixed(1).padStart(7) + '%' +
      (e * 100).toFixed(1).padStart(9) + '%' + w.toFixed(3).padStart(9));
  }
  console.log('');
  console.log('  ' + JSON.stringify(W));
}

const tot = rows.filter(r => Number.isFinite(r.closeTotal));
if (tot.length > 100) {
  const res = tot.map(r => r.total - r.closeTotal);
  const mean = res.reduce((a, b) => a + b, 0) / res.length;
  const sd = Math.sqrt(res.reduce((a, b) => a + (b - mean) ** 2, 0) / (res.length - 1));
  console.log('');
  console.log('THE TOTAL  (n=' + tot.length + ')');
  console.log('  mean residual ' + (mean >= 0 ? '+' : '') + mean.toFixed(3) +
    '   sd ' + sd.toFixed(3) + '   config totalSigma ' + cfg.totalSigma);
  const lines = {};
  for (const r of tot) lines[r.closeTotal] = (lines[r.closeTotal] || 0) + 1;
  const top = Object.entries(lines).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log('  commonest closing totals: ' + top.map(([k, v]) => k + ' (' + v + ')').join(', '));
}
