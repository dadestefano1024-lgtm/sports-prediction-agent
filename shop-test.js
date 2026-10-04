'use strict';
/**
 * Run renderShop() -- the real one, lifted out of index.html -- against real
 * slate data shaped the way the server shapes it.
 *
 * CHECKED: render-preview.js (same lift-don't-retype approach for the card
 * block it replaced), card-preview.js and book-shop.js (the numbers),
 * model.js bestMarketOffer (what the server calls).
 *
 * A preview that reimplements the function it is previewing proves nothing, so
 * the function is extracted from the page rather than copied.
 *
 * Run: node shop-test.js
 */
const fs = require('fs');
const model = require('./model');

const html = fs.readFileSync('public/index.html', 'utf8');
const m = html.match(/function renderShop\(\) \{[\s\S]*?\n    \}/);
if (!m) throw new Error('could not find renderShop in index.html');

// Build the payload the way server.js does, so the contract is exercised.
const payload = JSON.parse(fs.readFileSync('../shop_nfl.json', 'utf8'));
const sign = (n) => `${n > 0 ? '+' : ''}${n}`;
const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function bestOfferFor(g) {
  const odds = g.stats.odds || {};
  const pickText = (market, side, point) => {
    if (market === 'total') return side === 'A' ? `Over ${point}` : `Under ${point}`;
    return side === 'A' ? `${g.homeTeam} ${sign(point)}` : `${g.awayTeam} ${sign(-point)}`;
  };
  const shape = (r) => {
    if (!r || !r.reachable || !r.best) return null;
    return {
      market: r.market, books: r.books, book: r.best.book, point: r.best.point,
      price: r.best.price, pts: r.best.pts, side: r.best.side,
      pick: pickText(r.market, r.best.side, r.best.point),
      mine: r.mine ? {
        book: r.mine.book, point: r.mine.point, price: r.mine.price,
        pts: r.mine.pts, pick: pickText(r.market, r.mine.side, r.mine.point),
      } : null,
      gapPts: r.gapPts,
    };
  };
  const sq = (odds.spreadQuotes || []).filter(q => model.plausibleSpread('nfl', q.point))
    .map(q => ({ book: q.book, point: q.point, priceA: toNum(q.homePrice), priceB: toNum(q.awayPrice) }));
  const tq = (odds.totalQuotes || []).filter(q => Number.isFinite(q.point) && q.point > 0)
    .map(q => ({ book: q.book, point: q.point, priceA: toNum(q.overPrice), priceB: toNum(q.underPrice) }));
  const sOff = (Number.isFinite(odds.spread) && sq.length) ? shape(model.bestMarketOffer({
    sport: 'nfl', market: 'spread', consensusLine: odds.spread,
    consensusPriceA: toNum(odds.spreadHomePrice), consensusPriceB: toNum(odds.spreadAwayPrice),
    quotes: sq, myBook: 'DraftKings' })) : null;
  const tOff = (Number.isFinite(odds.total) && tq.length) ? shape(model.bestMarketOffer({
    sport: 'nfl', market: 'total', consensusLine: odds.total,
    consensusPriceA: toNum(odds.overPrice), consensusPriceB: toNum(odds.underPrice),
    quotes: tq, myBook: 'DraftKings' })) : null;
  if (sOff && tOff) return (tOff.pts > sOff.pts + 0.5) ? tOff : sOff;
  return sOff || tOff;
}

const games = (payload.games || []).map(g => ({
  homeTeam: g.homeTeam, awayTeam: g.awayTeam, bestOffer: bestOfferFor(g),
}));

function run(cacheObj, label) {
  let out = null;
  const document = { getElementById: () => ({ set innerHTML(v) { out = v; } }) };
  // eslint-disable-next-line no-new-func
  const fn = new Function('cache', 'document', m[0] + '\nreturn renderShop();');
  fn(cacheObj, document);
  const txt = String(out).replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '.')
    .replace(/&mdash;/g, '-').replace(/\s+/g, ' ').trim();
  console.log('--- ' + label + ' ---');
  console.log('  ' + txt.slice(0, 260) + (txt.length > 260 ? ' ...' : ''));
  console.log('  cards: ' + (String(out).match(/class="shop-card"/g) || []).length
    + '   edges: ' + (String(out).match(/shop-edge/g) || []).length
    + '   costs: ' + (String(out).match(/costs you/g) || []).length
    + '   level: ' + (String(out).match(/level with the board/g) || []).length
    + '   unrendered: ' + (String(out).match(/\$\{/g) || []).length);
  console.log('');
  return String(out);
}

run({ nfl: { games } }, 'the real NFL slate');
run({}, 'nothing loaded yet');
run({ nba: { games: [] } }, 'a sport loaded but no games');
run({ nfl: { games: games.map(g => ({ ...g, bestOffer: null })) } }, 'games with no quotes');
// games[0] is Pittsburgh @ Cleveland, the one fixture with NO odds feed, so it
// is correctly dropped -- an earlier version of this case used it and read as a
// lost row. Pick ones that actually carry quotes.
const withOffer = games.filter(g => g.bestOffer && g.bestOffer.pick);
run({ nfl: { games: [withOffer[0]] },
      nba: { games: [{ homeTeam: 'Lakers', awayTeam: 'Suns',
                       bestOffer: { ...withOffer[1].bestOffer } }] } }, 'two sports at once');
run({ nfl: { games: [games[0]] } }, 'the one fixture with no odds feed');
