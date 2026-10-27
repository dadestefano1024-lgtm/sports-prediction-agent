'use strict';
/**
 * Is Vegas right with the OPENING line? Danny's hypothesis, tested directly.
 *
 * CHECKED: fade-the-move.js (measured fading at the CLOSE: 51.9%, noise),
 * frozen-test.js (the football number rule), travel-test.js and nba-travel.js
 * (the travel sweeps, whose row files this reuses), price-move.js. CLAUDE.md
 * records one line on this -- "the closing line is a better forecast than the
 * open (9.714 vs 9.878)" -- for FOOTBALL only, as a parenthesis inside a
 * different argument. Nothing tested it for basketball, and nothing tested the
 * part that decides Danny's idea: whether the opener is better on the games
 * that MOVED A LOT.
 *
 * WHY IT MATTERS. If the opener is the better estimate, then a market that has
 * moved away from it is now wrong, and the play is to back the side the market
 * moved AWAY from -- the opposite of what this app does. If the close is
 * better, the move carries information and the app's rule is right for the
 * reason it claims.
 *
 * His observation is not silly: an opener that lands within ~10 points of an NFL
 * margin is genuinely impressive. The question is only whether the close is
 * better still, and by how much on the games where they disagree most.
 *
 * Run: node opener-right.js
 */
const fs = require('fs');

const NFL = (() => {
  const raw = JSON.parse(fs.readFileSync('./frozen-rows.json', 'utf8'));
  return (Array.isArray(raw) ? raw : (raw.rows || raw.games || []))
    .filter(r => Number.isFinite(r.open) && Number.isFinite(r.close) && Number.isFinite(r.margin));
})();
const NBA = JSON.parse(fs.readFileSync('./nba-travel-rows.json', 'utf8'))
  .filter(r => Number.isFinite(r.open) && Number.isFinite(r.close) && Number.isFinite(r.margin));

// A spread of L for the home side predicts a home margin of -L. The error is
// how far the actual margin fell from that.
const err = (line, margin) => Math.abs(margin + line);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

function compare(rows, label) {
  console.log('');
  console.log('=== ' + label + ' (' + rows.length + ' games) ===');
  console.log('');
  const buckets = [
    ['every game', () => true],
    ['moved <1pt', (r) => Math.abs(r.close - r.open) < 1],
    ['moved 1-2pt', (r) => { const m = Math.abs(r.close - r.open); return m >= 1 && m < 2; }],
    ['moved 2-4pt', (r) => { const m = Math.abs(r.close - r.open); return m >= 2 && m < 4; }],
    ['moved 4pt+', (r) => Math.abs(r.close - r.open) >= 4],
  ];
  console.log('  bucket          n     open err   close err   close better by   opener closer in');
  console.log('  ' + '-'.repeat(78));
  for (const [name, fn] of buckets) {
    const set = rows.filter(fn);
    if (!set.length) { console.log('  ' + name.padEnd(14) + '    0'); continue; }
    const eo = mean(set.map(r => err(r.open, r.margin)));
    const ec = mean(set.map(r => err(r.close, r.margin)));
    // how often each number was the closer one, ties excluded
    let openWins = 0, closeWins = 0, ties = 0;
    for (const r of set) {
      const a = err(r.open, r.margin), b = err(r.close, r.margin);
      if (Math.abs(a - b) < 1e-9) ties++;
      else if (a < b) openWins++;
      else closeWins++;
    }
    const decided = openWins + closeWins;
    console.log('  ' + name.padEnd(14) + String(set.length).padStart(5) + '     ' +
      eo.toFixed(3).padStart(6) + '      ' + ec.toFixed(3).padStart(6) + '     ' +
      ((eo - ec) >= 0 ? '+' : '') + (eo - ec).toFixed(3).padStart(6) + ' pts' +
      '        ' + (decided ? (100 * openWins / decided).toFixed(1) + '%' : '--').padStart(6) +
      (ties ? '  (' + ties + ' ties)' : ''));
  }

  // DANNY'S BET, scored. If the opener is the truth, back the side the market
  // moved AWAY from, at the CURRENT number -- you are buying the side the
  // opener liked at a price that has drifted in your favour.
  console.log('');
  console.log('  HIS RULE, scored: back the side the market moved AWAY from, at the close');
  console.log('  (if the opener is right, that side is the one now going cheap)');
  for (const [name, mm] of [['any move', 0.5], ['moved 2pt+', 2], ['moved 4pt+', 4]]) {
    const bets = [];
    for (const r of rows) {
      const move = r.close - r.open;
      if (Math.abs(move) < mm) continue;
      // move < 0 = market moved toward HOME, so the faded side is AWAY
      const backHome = move > 0;
      const cover = backHome ? (r.margin + r.close) : -(r.margin + r.close);
      if (Math.abs(cover) < 1e-9) continue;           // push refunds
      bets.push(cover > 0);
    }
    if (!bets.length) { console.log('    ' + name.padEnd(12) + 'no games'); continue; }
    const w = bets.filter(Boolean).length;
    const p = w / bets.length;
    const sd = (p - 0.5) / Math.sqrt(0.25 / bets.length);
    console.log('    ' + name.padEnd(12) + w + '-' + (bets.length - w) + '   ' +
      (p * 100).toFixed(1) + '%   ' + (sd >= 0 ? '+' : '') + sd.toFixed(2) + ' SD   n=' +
      bets.length + (p > 0.5238 ? '   beats break-even' : '   below the 52.4% break-even'));
  }
}

console.log('IS THE OPENING LINE THE BETTER ESTIMATE?');
console.log('Mean absolute error against the actual margin. Lower is better.');
compare(NFL, 'NFL, 2023-25');
compare(NBA, 'NBA, 2023-26');
console.log('');
