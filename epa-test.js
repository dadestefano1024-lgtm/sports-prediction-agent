'use strict';
/**
 * Two questions about an EPA model, one of which has never been asked here.
 *
 * CHECKED: efftest.js (rejected yards-per-play -- a crude proxy for EPA, not the
 * same input), frozen-test.js (the 690-game frozen-line harness, and the
 * negative result for the points-based projection), regression-sweep.js (the
 * season-blend parameters), reach.js (what actually reaches a pick).
 *
 * A. Does it beat the CLOSING LINE? Kill criterion, stated in advance: the
 *    market closes at 9.62 mean absolute error on these games and the current
 *    points-based projection is at 11.07. If EPA does not get under 9.62 there
 *    is no bet in it as a game-predictor, and that is the end of it.
 *
 * B. Does it predict the LINE MOVEMENT? This is the question nobody has asked,
 *    and it is a different and easier target. Movement is driven by information
 *    arriving, not by what happens on the field, so a model can in principle
 *    anticipate it without being able to forecast a game. If disagreeing with the
 *    OPENER predicts which way the number then travels, that is monetisable by
 *    betting openers -- and it is measured the way professionals measure it, as
 *    closing line value: did the number we took end up better than the close?
 *
 *    Sustained positive CLV is the only evidence inside one season that anything
 *    real is happening. It is also the honest test, because unlike a win rate it
 *    cannot be rescued by variance.
 *
 * The EPA-to-points scale is fitted on 2023 ONLY and applied to 2024-25, so the
 * number being reported was never fitted on the games it is scored against.
 *
 * Run: node epa-test.js
 */
const fs = require('fs');
const model = require('./model');

const weekly = JSON.parse(fs.readFileSync('./epa-weekly.json', 'utf8'));
const rows = JSON.parse(fs.readFileSync('./frozen-rows.json', 'utf8'));

// nflverse uses abbreviations; the harness uses nicknames. Map via server.js.
const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const i = src.indexOf('const nflTeamIds = {'), j = src.indexOf('\n};', i);
const nflTeamIds = eval('(' + src.slice(i + 'const nflTeamIds = '.length, j + 2) + ')');

const ABBR = {
  '49ers': 'SF', Bears: 'CHI', Bengals: 'CIN', Bills: 'BUF', Broncos: 'DEN',
  Browns: 'CLE', Buccaneers: 'TB', Cardinals: 'ARI', Chargers: 'LAC', Chiefs: 'KC',
  Colts: 'IND', Commanders: 'WAS', Cowboys: 'DAL', Dolphins: 'MIA', Eagles: 'PHI',
  Falcons: 'ATL', Giants: 'NYG', Jaguars: 'JAX', Jets: 'NYJ', Lions: 'DET',
  Packers: 'GB', Panthers: 'CAR', Patriots: 'NE', Raiders: 'LV', Rams: 'LA',
  Ravens: 'BAL', Saints: 'NO', Seahawks: 'SEA', Steelers: 'PIT', Texans: 'HOU',
  Titans: 'TEN', Vikings: 'MIN',
};
const missing = Object.keys(nflTeamIds).filter(n => !ABBR[n]);
if (missing.length) console.error('unmapped nicknames: ' + missing.join(', '));

// season|team -> weeks, so a cutoff can be applied without rescanning
const byTeam = new Map();
for (const r of weekly) {
  const k = r.season + '|' + r.team;
  if (!byTeam.has(k)) byTeam.set(k, []);
  byTeam.get(k).push(r);
}

/** Net EPA per play for a team, over the weeks strictly before `week`. */
function netEpa(season, abbr, week) {
  const v = byTeam.get(season + '|' + abbr);
  if (!v) return null;
  let oe = 0, op = 0, de = 0, dp = 0;
  for (const r of v) {
    if (r.week >= week) continue;
    oe += r.offEpa; op += r.offPlays; de += r.defEpa; dp += r.defPlays;
  }
  if (op < 60 || dp < 60) return null;             // under about a game of plays
  return { off: oe / op, def: de / dp, plays: op };
}

/**
 * The same prior-season blend the points model uses, since regression-sweep.js
 * showed the handover matters more than the rating does early on. Weight on this
 * season rises with plays rather than games, which is the quantity EPA is
 * actually averaged over.
 */
function rating(season, abbr, week) {
  const cur = netEpa(season, abbr, week);
  const prior = netEpa(season - 1, abbr, 99);
  const regress = (r, w) => r ? { off: r.off * w, def: r.def * w } : null;
  if (!cur && !prior) return null;
  if (!cur) return regress(prior, 0.5);
  if (!prior) return cur;
  const w = Math.min(1, cur.plays / (8 * 63));     // eight games of plays
  const p = regress(prior, 0.5);
  return {
    off: cur.off * w + p.off * (1 - w),
    def: cur.def * w + p.def * (1 - w),
  };
}

const HFA = 1.8;
/** Predicted margin, in points, for a given EPA-to-points scale. */
function project(season, hn, an, week, scale) {
  const h = rating(season, ABBR[hn], week);
  const a = rating(season, ABBR[an], week);
  if (!h || !a) return null;
  // Net EPA per play, home minus away. EPA is already in points, so the scale is
  // effectively plays per game.
  const diff = (h.off - h.def) - (a.off - a.def);
  return diff * scale + HFA;
}

// ---- fit the scale on 2023 only -------------------------------------------
const fitRows = rows.filter(r => r.year === 2023);
const testRows = rows.filter(r => r.year >= 2024);
let bestScale = null, bestErr = Infinity;
for (let s = 10; s <= 140; s += 2) {
  let sum = 0, n = 0;
  for (const r of fitRows) {
    const p = project(r.year, r.hn, r.an, r.week, s);
    if (p === null) continue;
    sum += Math.abs(p - r.margin); n++;
  }
  if (n > 50 && sum / n < bestErr) { bestErr = sum / n; bestScale = s; }
}
console.log('scale fitted on 2023 only: ' + bestScale +
  ' plays-equivalent  (in-sample MAE ' + bestErr.toFixed(3) + ', n=' + fitRows.length + ')');
console.log('everything below is 2024-25, never used for fitting\n');

// ---- A. does it beat the closing line? ------------------------------------
let e = { epa: 0, close: 0, open: 0, n: 0 };
const kept = [];
for (const r of testRows) {
  const p = project(r.year, r.hn, r.an, r.week, bestScale);
  if (p === null) continue;
  e.epa += Math.abs(p - r.margin);
  e.close += Math.abs(-r.close - r.margin);
  e.open += Math.abs(-r.open - r.margin);
  e.n++;
  kept.push({ ...r, proj: p });
}
console.log('A. ACCURACY vs THE REAL MARGIN   (n=' + e.n + ')');
console.log('   market closing line      ' + (e.close / e.n).toFixed(3));
console.log('   market opening line      ' + (e.open / e.n).toFixed(3));
console.log('   EPA model                ' + (e.epa / e.n).toFixed(3));
console.log('   points model (reference)  11.07 on the full 690');
const beat = (e.epa / e.n) < (e.close / e.n);
console.log('   ' + (beat ? 'BEATS the close — there may be a bet in this'
  : 'does NOT beat the close — kill criterion met, no bet as a game-predictor'));
console.log('');

// ---- B. does it predict the MOVEMENT? -------------------------------------
// Take the side the model likes at the OPENING number, then ask whether the
// close moved toward it. Positive CLV means the number taken beat the close.
console.log('B. DOES IT PREDICT WHERE THE LINE GOES?');
console.log('   take the side the model likes at the opener; CLV is in points\n');
const clvOf = (r, side) => side > 0 ? (r.open - r.close) : (r.close - r.open);
const report = (label, set) => {
  if (set.length < 25) { console.log('   ' + label.padEnd(34) + 'too few (' + set.length + ')'); return; }
  let sum = 0, plus = 0, minus = 0, level = 0, won = 0;
  for (const x of set) {
    const c = clvOf(x, x.side);
    sum += c;
    if (c > 0.01) plus++; else if (c < -0.01) minus++; else level++;
    const cover = x.margin + x.open;
    if (Math.abs(cover) > 1e-9 && ((x.side > 0) === (cover > 0))) won++;
  }
  // Excess over backing home at the opener ON THE SAME GAMES, because that is
  // free and requires no model.
  const base = set.reduce((a, x) => a + clvOf(x, 1), 0) / set.length;
  const mine = sum / set.length;
  console.log('   ' + label.padEnd(30) + 'CLV ' + (mine >= 0 ? '+' : '') + mine.toFixed(3) +
    '  vs home ' + (base >= 0 ? '+' : '') + base.toFixed(3) +
    '  EXCESS ' + (mine - base >= 0 ? '+' : '') + (mine - base).toFixed(3) +
    '   won ' + (won / set.length * 100).toFixed(1) + '%   n=' + set.length);
};
for (const x of kept) {
  const openMargin = -x.open;
  x.disagree = x.proj - openMargin;            // + = model likes home more than the opener does
  x.side = x.disagree > 0 ? 1 : -1;
}
// THE BASELINE THAT MATTERS. Lines drift toward the home side between open and
// close -- mean (open - close) is +0.228 points on these games -- so betting home
// at every opener collects that as CLV with no model at all. A random side
// collects +0.004, which confirms the drift is real rather than an artefact.
// Reporting raw CLV against zero therefore flatters anything that leans home,
// and the first version of this script did exactly that.
const homeClv = kept.reduce((s, x) => s + clvOf(x, 1), 0) / kept.length;
const randClv = (() => {
  let t = 0; const T = 400;
  for (let k = 0; k < T; k++) {
    let s = 0;
    for (const x of kept) s += clvOf(x, Math.random() < 0.5 ? 1 : -1);
    t += s / kept.length;
  }
  return t / T;
})();
console.log('   BASELINES — what a model has to beat');
console.log('   ' + 'back HOME at every opener'.padEnd(34) + 'CLV +' + homeClv.toFixed(3) + ' pts');
console.log('   ' + 'random side'.padEnd(34) + 'CLV ' + (randClv >= 0 ? '+' : '') + randClv.toFixed(3) + ' pts');
console.log('');
report('every game', kept);
for (const t of [1, 2, 3, 4, 6]) {
  report('disagreement >= ' + t + ' pts', kept.filter(x => Math.abs(x.disagree) >= t));
}
console.log('');
const homeShare = kept.filter(x => x.side > 0).length / kept.length;
console.log('   the model takes the HOME side ' + (homeShare * 100).toFixed(1) + '% of the time,');
console.log('   so any CLV it shows is partly the home drift rather than the model.');
console.log('');
console.log('   Positive CLV is the professional standard for a real edge, and');
console.log('   unlike a win rate it cannot be rescued by variance. Break-even');
console.log('   on a -110 bet needs roughly +0.25 points of CLV to clear the vig.');
