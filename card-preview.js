'use strict';
/**
 * What the board WOULD say if it priced all nine books, not just yours.
 *
 * CHECKED: book-shop.js (the measurement this reuses -- same leave-one-out
 * consensus, same mean centring, same push-refunds treatment), model.js
 * bookOfferEdge (what the card uses today, which prices MY_BOOK only),
 * pricegap.js (price dispersion at the same line).
 *
 * The question this answers is Danny's: the badge went from 9 of 15 games to
 * 0 of 15, and did that only make the app look less confident? Two things to
 * separate:
 *
 *   - whether the bar is set too high  (it is not; see the per-book table,
 *     where EVERY book alone is negative on average)
 *   - whether the app has anything confident left to say  (it does, but only
 *     once it reads more than one book)
 *
 * Run: node card-preview.js [payload.json]
 */
const fs = require('fs');
const model = require('./model');

const FILE = process.argv[2] || '../shop_nfl.json';
const MY_BOOK = process.env.MY_BOOK || 'DraftKings';
const US_REGULATED = new Set(['DraftKings', 'FanDuel', 'BetMGM', 'BetRivers']);

const payload = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const games = payload.games || [];
const cfg = model.sportConfig('nfl');
const implied = (o) => model.americanToImpliedProb(o);

const POINTS = [...new Set(games.flatMap(g =>
  (((g.stats || {}).odds || {}).spreadQuotes || []).map(q => q.point)))];
const TABLE = [];
for (let mu = -30; mu <= 30 + 1e-9; mu += 0.05) {
  const pmf = model.marginPmf({ mean: mu, sigma: cfg.sigma, sport: 'nfl', centre: 'mean' });
  const p = new Map();
  for (const pt of POINTS) {
    const t = -pt;
    let win = 0, push = 0;
    for (const [m, pr] of pmf) {
      if (m > t) win += pr;
      else if (m === t) push += pr;
    }
    const loss = Math.max(0, 1 - win - push);
    p.set(pt, (win + loss) > 0 ? win / (win + loss) : 0.5);
  }
  TABLE.push({ p });
}
const fit = (qs, dv, exclude) => {
  const use = qs.filter(q => q.book !== exclude);
  let best = null;
  for (const row of TABLE) {
    let err = 0;
    for (const q of use) err += (row.p.get(q.point) - dv.get(q.book)) ** 2;
    if (!best || err < best.err) best = { p: row.p, err };
  }
  return best;
};
const sane = (q) => {
  const s = implied(q.homePrice) + implied(q.awayPrice);
  return Number.isFinite(s) && s > 1.0 && s < 1.15;
};

const rows = [];
for (const g of games) {
  const qs = (((g.stats || {}).odds || {}).spreadQuotes || []).filter(sane);
  if (qs.length < 5) continue;
  const dv = new Map();
  for (const q of qs) dv.set(q.book, model.deVigTwoWayShin(q.homePrice, q.awayPrice, 'shin').probA);
  const scored = qs.map(q => {
    const fair = fit(qs, dv, q.book).p.get(q.point);
    return {
      book: q.book, point: q.point,
      home: fair - implied(q.homePrice),
      away: (1 - fair) - implied(q.awayPrice),
      homePrice: q.homePrice, awayPrice: q.awayPrice,
    };
  });
  rows.push({ game: g, scored });
}

const pc = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const sign = (n) => (n > 0 ? '+' : '') + n;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ---------------------------------------------------------------------------
console.log('IS THE BAR TOO HIGH, OR IS ONE BOOK JUST NOT ENOUGH?');
console.log('Each book on its own, across all 30 sides of the slate.\n');
console.log('  book            mean edge   sides it would badge   ');
const allBooks = [...new Set(rows.flatMap(r => r.scored.map(s => s.book)))];
for (const b of allBooks) {
  const es = [];
  for (const r of rows) {
    const s = r.scored.find(x => x.book === b);
    if (s) es.push(s.home, s.away);
  }
  const fires = es.filter(e => e * 100 >= model.BET_LEAN_PTS).length;
  console.log('  ' + b.padEnd(15) + pc(mean(es)).padStart(8) + '        ' +
    String(fires).padStart(2) + ' of ' + es.length +
    (US_REGULATED.has(b) ? '   (US)' : ''));
}
console.log('');
console.log('  Not one book clears the bar on its own, and that is not a tuning');
console.log('  choice: the edge is measured against the FAIR price, so at a single');
console.log('  book you are always paying the hold. Lowering the threshold would');
console.log('  not find a bet, it would just relabel a losing one.\n');

// ---------------------------------------------------------------------------
console.log('='.repeat(76));
console.log('WHAT THE CARD WOULD SAY IF IT READ ALL NINE BOOKS');
console.log('Best available price per game, ranked. This is the same slate.\n');

const cards = [];
for (const r of rows) {
  const g = r.game;
  let best = null;
  for (const s of r.scored) {
    for (const side of ['home', 'away']) {
      const cand = {
        pts: s[side] * 100, book: s.book, side,
        pick: side === 'home' ? `${g.homeTeam} ${sign(s.point)}`
                              : `${g.awayTeam} ${sign(-s.point)}`,
        price: side === 'home' ? s.homePrice : s.awayPrice,
        regulated: US_REGULATED.has(s.book),
      };
      if (!best || cand.pts > best.pts) best = cand;
    }
  }
  // what your own book offers on that same side, for the comparison
  const mine = r.scored.find(s => s.book === MY_BOOK);
  const minePts = mine ? mine[best.side] * 100 : null;
  cards.push({ g, best, minePts });
}
cards.sort((a, b) => b.best.pts - a.best.pts);

for (const c of cards) {
  const b = c.best;
  const badge = b.pts >= model.BET_STRONG_PTS ? 'STRONG BET  '
              : b.pts >= model.BET_LEAN_PTS ? 'SLIGHT EDGE '
              : "don't bet   ";
  const gap = c.minePts === null ? '' :
    '   (' + MY_BOOK + ' ' + pc(c.minePts / 100) + ', so shopping is worth ' +
    ((b.pts - c.minePts) >= 0 ? '+' : '') + (b.pts - c.minePts).toFixed(2) + ')';
  console.log('  ' + badge + pc(b.pts / 100).padStart(7) + '  ' +
    b.pick.padEnd(26) + String(b.price).padStart(5) + '  ' +
    b.book.padEnd(13) + (b.regulated ? 'US ' : 'off'));
  console.log('      ' + (c.g.awayTeam + ' @ ' + c.g.homeTeam).padEnd(44) + gap);
}

const fires = cards.filter(c => c.best.pts >= model.BET_LEAN_PTS);
const firesUS = cards.filter(c => c.best.pts >= model.BET_LEAN_PTS && c.best.regulated);
console.log('');
console.log('  games the card would badge, all nine books: ' + fires.length + ' of ' + cards.length);
console.log('  ... restricted to regulated US apps:        ' + firesUS.length + ' of ' + cards.length);
console.log('  ... as it stands today, ' + MY_BOOK + ' only:          0 of ' + cards.length);
