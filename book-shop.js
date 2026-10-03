'use strict';
/**
 * What is multi-book line shopping actually worth, in probability points?
 *
 * CHECKED: pricegap.js, which measures how far apart books are on PRICE at the
 * SAME line and is deliberately not duplicated here -- it answers the price
 * half, in implied-probability points, and found the -210..+166 spread behind
 * an identical 1.5 puckline. What it does not do is convert a better POINT into
 * probability, or compare either against the de-vigged consensus, so it cannot
 * say whether the best offer on the board is a BET or merely a cheaper way to
 * lose. That is the question here. Also model.js deVigTwoWay / deVigTwoWayShin
 * (used rather than hand-rolled -- taking the median of each side
 * independently is exactly the error that produced a +53% EV and a +Infinity
 * on the first pass at this), coverOutcomes + marginPmf (the counted NFL key
 * numbers, which are the whole reason a half-point off 3 is not worth the same
 * as a half-point off 8), frozen-test.js and price-move.js (the stale-number
 * and stale-price rules, a DIFFERENT edge -- those hold an old number, this one
 * takes the best of nine current ones).
 *
 * METHOD. Per game, every book's quote is de-vigged to a push-adjusted
 * P(home covers ITS point). Those quotes sit at different points, so they are
 * not averaged: a single margin distribution is fitted to all of them at once,
 * and that fitted distribution is the consensus.
 *
 * LEAVE-ONE-OUT, and this is not a detail. Scoring a book against a consensus
 * that INCLUDES its own quote pulls the consensus toward the book and shrinks
 * the edge it appears to have -- and for the book that is the outlier, which is
 * precisely the one that wins the shopping comparison, that is the whole
 * measurement. Each book is therefore priced against a consensus fitted from
 * the OTHER books only.
 *
 * A PUSH IS A REFUND here, not a loss -- so every probability is win/(win+loss)
 * and a whole-number line is not penalised. The Pick 6 pool is the only place a
 * push loses, and the pool line is frozen, so shopping does not arise there.
 *
 * THREE NUMBERS THAT GET CONFUSED, kept apart on purpose:
 *   - best vs CONSENSUS -- is the best offer on the board a +EV bet at all?
 *   - best vs MY BOOK   -- what shopping saves against betting DraftKings
 *                          blind. Real money, but NOT an edge against the
 *                          market; it is a smaller tax.
 *   - WHICH books        -- a gain you can only collect at an offshore book is
 *                          not the same gain as one you can collect at four
 *                          regulated US apps. Reported separately because the
 *                          first pass found one reduced-juice book holding the
 *                          best side 19 times in 30, which is not "shopping"
 *                          at all -- it is one cheaper book.
 *
 * SHIN vs PROPORTIONAL de-vigging makes no difference on spreads and both are
 * run anyway: positive-controlled at -500/+400, where they differ by 1.02 pts,
 * so the agreement here is a property of near-even spread prices and not an
 * inert parameter.
 *
 * Costs ZERO odds-API credits: reads a saved predictions payload.
 *
 * Run: node book-shop.js <saved-payload.json> [sport]
 */
const fs = require('fs');
const model = require('./model');

const FILE = process.argv[2] || '../shop_nfl.json';
const SPORT = (process.argv[3] || 'nfl').toLowerCase();
const MY_BOOK = process.env.MY_BOOK || 'DraftKings';

// Regulated US apps vs offshore. Membership decides whether a measured gain is
// something Danny can actually collect, so it is stated here rather than
// inferred from a name.
const US_REGULATED = new Set(['DraftKings', 'FanDuel', 'BetMGM', 'BetRivers',
                              'Caesars', 'ESPN BET', 'Fanatics', 'PointsBet']);

const payload = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const games = payload.games || [];
const cfg = model.sportConfig(SPORT);
const implied = (o) => model.americanToImpliedProb(o);

/**
 * PRECOMPUTED centre grid. Fitting per game by brute force rebuilt the margin
 * PMF 1.6 million times and did not finish in two minutes. The slate only ever
 * uses a handful of distinct points, so the table is built once -- one PMF per
 * centre, every point read off it -- and each fit becomes a scan.
 */
const POINTS = [...new Set(games.flatMap(g =>
  (((g.stats || {}).odds || {}).spreadQuotes || []).map(q => q.point)))];
const TABLE = [];
for (let mu = -30; mu <= 30 + 1e-9; mu += 0.05) {
  // centre: 'mean' IS THE WHOLE MEASUREMENT. With the default median centring
  // the push-adjusted probability at a key number is a STEP: at point -3 it
  // reads 44.92% for every centre in [2.80, 2.95] and jumps to 55.08% at 3.00,
  // 10.16 points per 0.01 of centre. The market's 50.00% is unreachable -- the
  // fit misses it by 5.08 points and lands on whichever side of the step is
  // nearer, which FLIPS depending on which book is held out. That manufactured
  // a +5.08 pt edge on Houston -3 and a +4.10 pt edge on Dallas +3 in the same
  // game: a 9-point arbitrage that does not exist. Mean centring moves 0.04
  // points per 0.01 and reaches 50% to within 0.005.
  const pmf = model.marginPmf({ mean: mu, sigma: cfg.sigma, sport: SPORT,
                                centre: 'mean' });
  const p = new Map();
  for (const point of POINTS) {
    const threshold = -point;           // home covers when margin > -point
    let win = 0, push = 0;
    for (const [m, pr] of pmf) {
      if (m > threshold) win += pr;
      else if (m === threshold) push += pr;
    }
    const loss = Math.max(0, 1 - win - push);
    const d = win + loss;
    p.set(point, d > 0 ? win / d : 0.5);
  }
  TABLE.push({ mu: +mu.toFixed(2), p });
}

/** Fit one margin centre to a game's books, optionally holding one out. */
function fitConsensus(quotes, devig, exclude) {
  const use = quotes.filter(q => q.book !== exclude);
  let best = null;
  for (const row of TABLE) {
    let err = 0;
    for (const q of use) err += (row.p.get(q.point) - devig.get(q.book)) ** 2;
    if (!best || err < best.err) best = { mu: row.mu, p: row.p, err };
  }
  return best;
}

const sane = (q) => {
  const s = implied(q.homePrice) + implied(q.awayPrice);
  return Number.isFinite(s) && s > 1.0 && s < 1.15;
};

const rows = [];
for (const g of games) {
  const quotes = (((g.stats || {}).odds || {}).spreadQuotes || []).filter(sane);
  if (quotes.length < 5) continue;      // leave-one-out needs something left
  for (const method of ['prop', 'shin']) {
    const devig = new Map();
    for (const q of quotes) {
      devig.set(q.book, model.deVigTwoWayShin(q.homePrice, q.awayPrice, method).probA);
    }
    for (const q of quotes) {
      const fit = fitConsensus(quotes, devig, q.book);
      const fair = fit.p.get(q.point);
      // The artifact above ANNOUNCED itself as a 5-point fit residual and
      // nothing was looking at it. A consensus that cannot reproduce the
      // market's own de-vigged price to within half a point is not a
      // consensus, and every "edge" measured against it is the miss.
      const resid = Math.sqrt(fit.err / Math.max(1, quotes.length - 1));
      rows.push({
        resid, target: devig.get(q.book),
        game: (g.awayTeam || '?') + ' @ ' + (g.homeTeam || '?'),
        method, book: q.book, point: q.point,
        homeEdge: fair - implied(q.homePrice),
        awayEdge: (1 - fair) - implied(q.awayPrice),
        hold: implied(q.homePrice) + implied(q.awayPrice) - 1,
      });
    }
  }
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const pp = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2);
const groupByGame = (rs) => {
  const m = new Map();
  for (const r of rs) {
    if (!m.has(r.game)) m.set(r.game, []);
    m.get(r.game).push(r);
  }
  return m;
};

// REPRESENTABILITY, which is the check that would have caught the median-centring
// artifact. The first version of this guard used the fit residual ACROSS books,
// and that conflates two different things: the model being unable to express the
// market (an artifact, which is what median centring was) and the books
// genuinely disagreeing on price (the signal -- 0.60 pts even in games where all
// nine hold the SAME point, which is Bovada's +100/-120 against everyone else's
// -110/-110). The honest test is per quote: can the model reach THIS book's own
// de-vigged price at THIS book's point? Under median centring that missed by
// 5.08 pts at a -3 line. It must be ~0.
let worstReach = 0;
for (const r of rows) {
  let closest = Infinity;
  for (const row of TABLE) closest = Math.min(closest, Math.abs(row.p.get(r.point) - r.target));
  worstReach = Math.max(worstReach, closest);
}
console.log('representability check: worst quote the model cannot reach is ' +
  (worstReach * 100).toFixed(3) + ' pts off' +
  (worstReach > 0.005 ? '   <== ARTIFACT, every edge below is that miss' : '   (ok)'));
console.log('');

const ALL_BOOKS = [...new Set(rows.map(r => r.book))];
console.log(SPORT.toUpperCase() + ' line shopping — ' +
  new Set(rows.map(r => r.game)).size + ' games, ' + ALL_BOOKS.length +
  ' books, 0 API credits');
console.log('  regulated US: ' + ALL_BOOKS.filter(b => US_REGULATED.has(b)).join(', '));
console.log('  offshore:     ' + ALL_BOOKS.filter(b => !US_REGULATED.has(b)).join(', ') + '\n');

const shin = rows.filter(r => r.method === 'shin');
const byGame = groupByGame(shin);
const hold = mean(shin.map(r => r.hold));
console.log('  mean book hold ' + (hold * 100).toFixed(2) + '%  ->  ' +
  (hold * 50).toFixed(2) + ' pts per side is the tax to beat');
console.log('  across-book price dispersion: ' +
  (mean(rows.filter(r => r.method === 'shin').map(r => r.resid)) * 100).toFixed(2) +
  ' pts  (real disagreement, and the thing being harvested)');
console.log('  distinct points per game: ' +
  mean([...byGame.values()].map(rs => new Set(rs.map(r => r.point)).size)).toFixed(2) +
  ',  widest gap ' +
  mean([...byGame.values()].map(rs => Math.max(...rs.map(r => r.point)) -
                                      Math.min(...rs.map(r => r.point)))).toFixed(2) +
  ' pts avg\n');

/** Score a restricted set of books you are allowed to bet. */
function scoreSet(label, allowed) {
  const bestEdges = [], gain = [], mineAbs = [];
  let plusEV = 0, sides = 0;
  for (const [, rs] of byGame) {
    for (const side of ['homeEdge', 'awayEdge']) {
      const pool = rs.filter(r => allowed.has(r.book));
      if (!pool.length) continue;
      sides++;
      const best = pool.reduce((a, b) => b[side] > a[side] ? b : a);
      const mine = rs.find(r => r.book === MY_BOOK);
      bestEdges.push(best[side]);
      if (mine) { gain.push(best[side] - mine[side]); mineAbs.push(mine[side]); }
      if (best[side] > 0) plusEV++;
    }
  }
  console.log('  ' + label.padEnd(30) +
    'best ' + pp(mean(bestEdges)).padStart(6) + ' pts' +
    '   gain vs ' + MY_BOOK + ' ' + pp(mean(gain)).padStart(6) + ' pts' +
    '   +EV ' + plusEV + '/' + sides);
}

console.log('WHAT YOU GET, BY WHICH BOOKS YOU CAN ACTUALLY BET');
scoreSet('all ' + ALL_BOOKS.length + ' books', new Set(ALL_BOOKS));
scoreSet('regulated US only', new Set(ALL_BOOKS.filter(b => US_REGULATED.has(b))));
scoreSet(MY_BOOK + ' alone (no shopping)', new Set([MY_BOOK]));
console.log('');
console.log('  each book on its own:');
for (const b of ALL_BOOKS) scoreSet('    ' + b, new Set([b]));
console.log('');

const wins = {};
for (const [, rs] of byGame) {
  for (const side of ['homeEdge', 'awayEdge']) {
    const best = rs.reduce((a, b) => b[side] > a[side] ? b : a);
    wins[best.book] = (wins[best.book] || 0) + 1;
  }
}
console.log('WHICH BOOK HOLDS THE BEST SIDE   (' + (byGame.size * 2) + ' sides)');
console.log('  concentration matters: if one book wins most sides, the gain is');
console.log('  "use a cheaper book", not "shop nine books every week".');
for (const [b, n] of Object.entries(wins).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + b.padEnd(14) + String(n).padStart(3) +
    (US_REGULATED.has(b) ? ' US ' : ' off') + '  ' + '#'.repeat(n));
}

const propRows = rows.filter(r => r.method === 'prop');
const dv = Math.abs(mean(shin.map(r => r.homeEdge)) - mean(propRows.map(r => r.homeEdge)));
console.log('');
console.log('de-vig method sensitivity: ' + (dv * 100).toFixed(3) +
  ' pts between shin and proportional');
console.log('  (controlled: the two differ by 1.02 pts at -500/+400, so this is');
console.log('   near-even spread prices agreeing, not a dead parameter)');
