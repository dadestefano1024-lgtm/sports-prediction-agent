'use strict';
/**
 * In hockey the NUMBER cannot go stale, but the PRICE can. Does it pay?
 *
 * CHECKED: calibrate-sport.js (built the 1,312-game season this reads, and now
 * correctly refuses to run the spread version here), frozen-test.js (the
 * football stale-NUMBER rule this is the analogue of), nhl-shape.js (the margin
 * distribution).
 *
 * The correction that prompted this: saying "there is no spread in hockey" was
 * wrong. The puckline IS a spread and you can bet it. What is true is that the
 * NUMBER is fixed at 1.5 and never moves, so there is nothing to hold at a
 * better number. What moves instead is the price -- a team stays at -1.5 while
 * its moneyline goes from -125 to -190 -- and a stale PRICE is worth exactly as
 * much as a stale number.
 *
 * ESPN carries open and current moneyLine for both sides and leaves spreadOdds
 * empty, so the moneyline is what can be measured.
 *
 * Scored in UNITS OF PROFIT, not win rate. A moneyline bet at -190 and one at
 * +150 have different break-evens, so a win percentage across mixed prices means
 * nothing. One unit risked per bet; the result is what a flat stake returned.
 *
 * Run: node nhl-price.js
 */
const fs = require('fs');

// Takes a rows file so one season can be tested against another. The cache is
// keyed by URL and holds every season harvested, so it needs no argument.
const ROWS = process.argv[2] || './cal-nhl-rows.json';
const rows = JSON.parse(fs.readFileSync(ROWS, 'utf8'));
console.log('rows file: ' + ROWS);
const cache = JSON.parse(fs.readFileSync('./cal-nhl-cache.json', 'utf8'));

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace('+', '').trim());
  return Number.isFinite(n) ? n : null;
};

// Pull the open and current moneyline for both sides out of the cached odds.
const prices = new Map();
for (const [url, val] of Object.entries(cache)) {
  const mm = /hockey\/leagues\/nhl\/events\/(\d+)\//.exec(url);
  if (!mm || !val || !val.items) continue;
  const it = (val.items || []).find(x => !/live/i.test((x.provider && x.provider.name) || '') &&
                                         x.homeTeamOdds && x.awayTeamOdds);
  if (!it) continue;
  const ml = (side, phase) => {
    const o = it[side] && it[side][phase];
    return (o && o.moneyLine) ? num(o.moneyLine.american) : null;
  };
  prices.set(mm[1], {
    hOpen: ml('homeTeamOdds', 'open'), hClose: ml('homeTeamOdds', 'current'),
    aOpen: ml('awayTeamOdds', 'open'), aClose: ml('awayTeamOdds', 'current'),
  });
}

/** American odds -> profit on a one-unit stake. */
const profitOf = (odds) => odds > 0 ? odds / 100 : 100 / Math.abs(odds);
/** American odds -> implied probability, with the vig still in. */
const implied = (odds) => odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);

const games = [];
for (const r of rows) {
  const p = prices.get(String(r.id));
  if (!p) continue;
  if ([p.hOpen, p.hClose, p.aOpen, p.aClose].some(x => x === null)) continue;
  // De-vig each phase so the two sides sum to one, then movement is the change
  // in the home side's fair probability. Comparing raw implied numbers would
  // read a change in the book's margin as a change of opinion.
  const fair = (h, a) => {
    const ih = implied(h), ia = implied(a);
    return ih / (ih + ia);
  };
  games.push({
    ...r,
    openFair: fair(p.hOpen, p.aOpen),
    closeFair: fair(p.hClose, p.aClose),
    hOpen: p.hOpen, aOpen: p.aOpen, hClose: p.hClose, aClose: p.aClose,
    homeWon: r.margin > 0,
  });
}
console.log(`${games.length} games with open and close moneylines on both sides, of ${rows.length}\n`);
if (games.length < 100) { console.log('too few'); process.exit(0); }

const drift = games.map(g => g.closeFair - g.openFair);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log('HOW MUCH DOES THE PRICE MOVE?');
console.log('  mean change in the home side fair probability: ' +
  (mean(drift) * 100).toFixed(2) + ' points');
const sizes = [0.01, 0.02, 0.03, 0.05];
for (const t of sizes) {
  console.log('  moved >= ' + (t * 100) + ' points: ' +
    games.filter(g => Math.abs(g.closeFair - g.openFair) >= t).length + ' games');
}
console.log('');

/**
 * Back a side at a given phase's price and report flat-stake profit.
 * sideOf returns +1 for home, -1 for away, 0 to pass.
 */
function run(label, set, sideOf, phase) {
  const bets = set.filter(g => sideOf(g) !== 0);
  if (bets.length < 40) { console.log('  ' + label.padEnd(46) + 'too few (' + bets.length + ')'); return; }
  let staked = 0, ret = 0, won = 0;
  for (const g of bets) {
    const side = sideOf(g);
    const odds = side > 0 ? (phase === 'open' ? g.hOpen : g.hClose)
                          : (phase === 'open' ? g.aOpen : g.aClose);
    staked += 1;
    const win = (side > 0) === g.homeWon;
    if (win) { ret += profitOf(odds); won++; } else { ret -= 1; }
  }
  const roi = ret / staked;
  console.log('  ' + label.padEnd(46) + (roi >= 0 ? '+' : '') + (roi * 100).toFixed(2) +
    '% ROI   ' + won + '-' + (bets.length - won) + '  n=' + bets.length +
    (roi > 0.02 ? '   <== profitable' : ''));
}

const toward = (g) => (g.closeFair - g.openFair) > 0 ? 1 : -1;

console.log('BACK THE SIDE THE PRICE MOVED TOWARD, AT THE OPENING PRICE');
console.log('  (the hockey analogue of holding a stale number)\n');
for (const t of [0, 0.01, 0.02, 0.03, 0.05]) {
  const set = games.filter(g => Math.abs(g.closeFair - g.openFair) >= t);
  run('price moved >= ' + (t * 100) + ' pts, at the OPEN', set, toward, 'open');
}
console.log('');
console.log('THE SAME BETS AT THE CLOSING PRICE — if the edge is the stale price,');
console.log('this should be much worse\n');
for (const t of [0.02, 0.03]) {
  const set = games.filter(g => Math.abs(g.closeFair - g.openFair) >= t);
  run('price moved >= ' + (t * 100) + ' pts, at the CLOSE', set, toward, 'close');
}
console.log('');
console.log('CONTROLS\n');
run('fade the move instead, at the open', games.filter(g => Math.abs(g.closeFair - g.openFair) >= 0.02),
  (g) => -toward(g), 'open');
run('back HOME every game, at the open', games, () => 1, 'open');
run('back the FAVOURITE every game, at the open', games,
  (g) => g.openFair > 0.5 ? 1 : -1, 'open');
console.log('');
console.log('');
console.log('THE SPLIT THAT DECIDES IT — does the move work on BOTH sides?');
const isDogBet = (g) => {
  const s = toward(g);
  const homeIsDog = g.openFair < 0.5;
  return (s > 0) === homeIsDog;
};
run('price moves at a DOG, back it', games.filter(isDogBet), toward, 'open');
run('price moves at a FAVOURITE, back it', games.filter(g => !isDogBet(g)), toward, 'open');
console.log('');
console.log('  and the baseline with no selection at all:');
run('back the UNDERDOG every game', games, (g) => g.openFair > 0.5 ? -1 : 1, 'open');
console.log('');
console.log('SEASON GATE — every month must point the same way');
const byMonth = {};
for (const g of games.filter(isDogBet)) (byMonth[g.date.slice(0, 6)] = byMonth[g.date.slice(0, 6)] || []).push(g);
let allPositive = true;
for (const mth of Object.keys(byMonth).sort()) {
  const set = byMonth[mth];
  let ret = 0;
  for (const g of set) {
    const side = toward(g);
    const odds = side > 0 ? g.hOpen : g.aOpen;
    ret += ((side > 0) === g.homeWon) ? profitOf(odds) : -1;
  }
  const roi = ret / set.length;
  if (roi <= 0) allPositive = false;
  console.log('  ' + mth + '  ' + (roi >= 0 ? '+' : '') + (roi * 100).toFixed(2) +
    '% ROI  n=' + set.length);
}
console.log('  every month positive: ' + (allPositive ? 'YES' : 'NO'));
console.log('');
console.log('A flat-stake ROI above about +2% is the bar. Three gates as everywhere');
console.log('else: it must work on BOTH sides, hold direction every month, and clear');
console.log('the bar. One season cannot settle it -- run the previous one and compare.');
