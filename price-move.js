'use strict';
/**
 * Is the PRICE stale as well as the number, in sports where both can move?
 *
 * CHECKED: nhl-holdout.js and nhl-price.js (found the price effect in hockey,
 * where the puckline is fixed so the price is all there is -- +4.29 probability
 * points at the open over three seasons, 4.59 SD), frozen-test.js (the football
 * NUMBER rule, 56.8% at a point), calibrate-sport.js (the NBA number rule,
 * 62.1% at two points).
 *
 * Prompted by the obvious question: hockey forced the price measurement because
 * its number cannot move, and nobody then went back and asked the same thing of
 * football and basketball, where BOTH can move. Number movement was measured in
 * those two and price movement was not.
 *
 * Three questions, and the third is the one that is actually new:
 *
 *   1. Does the price-movement rule work here at all?
 *   2. Does it survive when the NUMBER also moved -- or is it just reading the
 *      number move through the price?
 *   3. And where the NUMBER DID NOT MOVE, does the price still say something?
 *      That is pure price staleness with the number held constant, and it is the
 *      only version that is genuinely independent of what was already known.
 *
 * Measured in PROBABILITY POINTS against the de-vigged price taken, not ROI. ROI
 * depends on the price mix and invented a dog-only story in hockey before this
 * was fixed.
 *
 * Run: node price-move.js <nfl|nba>
 */
const fs = require('fs');

const SPORT = (process.argv[2] || 'nba').toLowerCase();
const CFG = {
  nba: { cache: './cal-nba-cache.json', rows: './cal-nba-rows.json', league: 'basketball/leagues/nba' },
  nfl: { cache: './frozen-cache.json', rows: './frozen-rows.json', league: 'football/leagues/nfl' },
}[SPORT];
if (!CFG) { console.error('usage: node price-move.js <nfl|nba>'); process.exit(1); }

const cache = JSON.parse(fs.readFileSync(CFG.cache, 'utf8'));
const rows = JSON.parse(fs.readFileSync(CFG.rows, 'utf8'));

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = String(v).replace('+', '').trim().toUpperCase();
  if (t === 'EVEN' || t === 'PK') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const implied = (o) => o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);

const prices = new Map();
for (const [url, val] of Object.entries(cache)) {
  const mm = new RegExp(CFG.league.replace(/\//g, '\\/') + '\\/events\\/(\\d+)\\/').exec(url);
  if (!mm || !val || !val.items) continue;
  const it = (val.items || []).find(x => !/live/i.test((x.provider && x.provider.name) || '') &&
                                         x.homeTeamOdds && x.awayTeamOdds);
  if (!it) continue;
  const ml = (side, phase) => {
    const o = it[side] && it[side][phase];
    return (o && o.moneyLine) ? num(o.moneyLine.american) : null;
  };
  const ps = (phase) => {
    const o = it.homeTeamOdds && it.homeTeamOdds[phase];
    return (o && o.pointSpread) ? num(o.pointSpread.american) : null;
  };
  prices.set(mm[1], {
    hOpen: ml('homeTeamOdds', 'open'), hClose: ml('homeTeamOdds', 'current'),
    aOpen: ml('awayTeamOdds', 'open'), aClose: ml('awayTeamOdds', 'current'),
    sOpen: ps('open'), sClose: ps('current'),
  });
}

const games = [];
for (const r of rows) {
  const p = prices.get(String(r.id));
  if (!p) continue;
  if ([p.hOpen, p.hClose, p.aOpen, p.aClose].some(x => x === null)) continue;
  const fair = (h, a) => { const ih = implied(h), ia = implied(a); return ih / (ih + ia); };
  games.push({
    id: r.id, margin: r.margin, homeWon: r.margin > 0,
    openFair: fair(p.hOpen, p.aOpen), closeFair: fair(p.hClose, p.aClose),
    hOpen: p.hOpen, aOpen: p.aOpen, hClose: p.hClose, aClose: p.aClose,
    // the NUMBER, from the same odds item so the two are consistent
    sOpen: p.sOpen, sClose: p.sClose,
    numberMoved: (p.sOpen !== null && p.sClose !== null) ? Math.abs(p.sClose - p.sOpen) : null,
  });
}
console.log(SPORT.toUpperCase() + ' — ' + games.length + ' games with open and close moneylines on both sides\n');
if (games.length < 100) { console.log('too few'); process.exit(0); }

const toward = (g) => (g.closeFair - g.openFair) > 0 ? 1 : -1;
function edge(set, phase = 'open') {
  if (!set.length) return null;
  let impl = 0, act = 0;
  for (const g of set) {
    const s = toward(g);
    const p = phase === 'open' ? (s > 0 ? g.openFair : 1 - g.openFair)
                               : (s > 0 ? g.closeFair : 1 - g.closeFair);
    impl += p; act += ((s > 0) === g.homeWon) ? 1 : 0;
  }
  const n = set.length, ip = impl / n, ap = act / n;
  const se = Math.sqrt(ip * (1 - ip) / n) || 1e-9;
  return { n, ip, ap, d: ap - ip, z: (ap - ip) / se };
}
const line = (lab, e) => {
  if (!e || e.n < 60) { console.log('  ' + lab.padEnd(40) + 'too few (' + (e ? e.n : 0) + ')'); return; }
  console.log('  ' + lab.padEnd(40) + 'implied ' + (e.ip * 100).toFixed(1) +
    '%  actual ' + (e.ap * 100).toFixed(1) + '%  edge ' + (e.d >= 0 ? '+' : '') +
    (e.d * 100).toFixed(2) + ' pts  ' + e.z.toFixed(2) + ' SD  n=' + e.n);
};

const moved1 = games.filter(g => Math.abs(g.closeFair - g.openFair) >= 0.01);
console.log('1. THE PRICE RULE, as measured in hockey (+4.29 pts, 4.59 SD there)');
line('price moved >= 1 pt, at the OPEN', edge(moved1));
line('  the same bets at the CLOSE', edge(moved1, 'close'));
line('  CONTROL: fade the price move', (() => {
  const e = edge(moved1); if (!e) return null;
  return { n: e.n, ip: 1 - e.ip, ap: 1 - e.ap, d: (1 - e.ap) - (1 - e.ip), z: -e.z };
})());
console.log('');

const withNum = games.filter(g => g.numberMoved !== null);
console.log('2. SPLIT BY WHETHER THE NUMBER ALSO MOVED   (' + withNum.length + ' games have both)');
line('number moved too, price rule', edge(withNum.filter(g => g.numberMoved > 0 && Math.abs(g.closeFair - g.openFair) >= 0.01)));
console.log('');
console.log('3. THE NEW QUESTION — number UNCHANGED, price moved anyway');
console.log('   pure price staleness, independent of anything already measured');
const still = withNum.filter(g => g.numberMoved === 0);
console.log('   games where the number did not budge: ' + still.length);
for (const t of [0.01, 0.02, 0.03]) {
  line('number flat, price moved >= ' + (t * 100) + ' pts', edge(still.filter(g => Math.abs(g.closeFair - g.openFair) >= t)));
}
line('  those bets at the CLOSE', edge(still.filter(g => Math.abs(g.closeFair - g.openFair) >= 0.01), 'close'));
console.log('');
const isDog = (g) => (toward(g) > 0) === (g.openFair < 0.5);
console.log('4. BOTH SIDES?');
line('at a DOG', edge(moved1.filter(isDog)));
line('at a FAVOURITE', edge(moved1.filter(g => !isDog(g))));
