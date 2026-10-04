'use strict';
/**
 * Render the new card block with REAL slate data and write it to a file I can
 * open, so the change is looked at rather than asserted.
 *
 * CHECKED: card-preview.js (the same numbers as text, via leave-one-out),
 * book-shop.js (the measurement), model.js bestMarketOffer (what the server
 * now calls), public/index.html (the block and CSS are LIFTED from it here,
 * not retyped -- a preview that reimplements the thing it is previewing
 * proves nothing).
 *
 * Run: node render-preview.js  ->  ../card-preview.html
 */
const fs = require('fs');
const model = require('./model');

const html = fs.readFileSync('public/index.html', 'utf8');
const payload = JSON.parse(fs.readFileSync('../shop_nfl.json', 'utf8'));

// Lift the real CSS out of the page rather than writing lookalike styles.
const css = (html.match(/\.board-best \{[\s\S]*?\.bb-cost\.bb-level \{[^}]*\}/) || [''])[0];
if (!css) throw new Error('could not find .board-best css in index.html');

// Lift the real render block and turn it into a function of (g).
const m = html.match(/\$\{\(\(\) => \{\s*\n\s*\/\/ BEST ON THE BOARD[\s\S]*?\n\s*\}\)\(\)\}/);
if (!m) throw new Error('could not find the BEST ON THE BOARD block in index.html');
const body = m[0].replace(/^\$\{\(\(\) => \{/, '').replace(/\}\)\(\)\}$/, '');
// eslint-disable-next-line no-new-func
const renderBest = new Function('g', body);

const sign = (n) => `${n > 0 ? '+' : ''}${n}`;
const toNum = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

// The same shaping server.js does, so the preview exercises that contract.
function bestOfferFor(g) {
  const odds = g.stats.odds || {};
  const mbName = 'DraftKings';
  const pickText = (market, side, point) => {
    if (market === 'total') return side === 'A' ? `Over ${point}` : `Under ${point}`;
    return side === 'A' ? `${g.homeTeam} ${sign(point)}` : `${g.awayTeam} ${sign(-point)}`;
  };
  const shape = (r) => {
    if (!r || !r.reachable || !r.best) return null;
    return {
      market: r.market, books: r.books,
      book: r.best.book, point: r.best.point, price: r.best.price,
      pts: r.best.pts, side: r.best.side,
      pick: pickText(r.market, r.best.side, r.best.point),
      mine: r.mine ? {
        book: r.mine.book, point: r.mine.point, price: r.mine.price,
        pts: r.mine.pts, pick: pickText(r.market, r.mine.side, r.mine.point),
      } : null,
      gapPts: r.gapPts,
    };
  };
  const sq = (odds.spreadQuotes || [])
    .filter(q => model.plausibleSpread('nfl', q.point))
    .map(q => ({ book: q.book, point: q.point,
                 priceA: toNum(q.homePrice), priceB: toNum(q.awayPrice) }));
  const tq = (odds.totalQuotes || [])
    .filter(q => Number.isFinite(q.point) && q.point > 0)
    .map(q => ({ book: q.book, point: q.point,
                 priceA: toNum(q.overPrice), priceB: toNum(q.underPrice) }));
  const sOff = (Number.isFinite(odds.spread) && sq.length) ? shape(model.bestMarketOffer({
    sport: 'nfl', market: 'spread',
    consensusLine: odds.spread,
    consensusPriceA: toNum(odds.spreadHomePrice),
    consensusPriceB: toNum(odds.spreadAwayPrice),
    quotes: sq, myBook: mbName,
  })) : null;
  const tOff = (Number.isFinite(odds.total) && tq.length) ? shape(model.bestMarketOffer({
    sport: 'nfl', market: 'total',
    consensusLine: odds.total,
    consensusPriceA: toNum(odds.overPrice),
    consensusPriceB: toNum(odds.underPrice),
    quotes: tq, myBook: mbName,
  })) : null;
  if (sOff && tOff) return (tOff.pts > sOff.pts + 0.5) ? tOff : sOff;
  return sOff || tOff;
}

const cards = [];
for (const g of payload.games || []) {
  const bestOffer = bestOfferFor(g);
  if (!bestOffer) continue;
  const badge = bestOffer.pts >= model.BET_STRONG_PTS ? 'Strong bet'
              : bestOffer.pts >= model.BET_LEAN_PTS ? 'Slight edge' : null;
  cards.push({ g, bestOffer, badge,
               rendered: renderBest({ bestOffer }) });
}
cards.sort((a, b) => b.bestOffer.pts - a.bestOffer.pts);

const out = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Board card preview</title>
<style>
  body { background:#0d1117; color:#c9d1d9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         margin:0; padding:16px; }
  h1 { font-size:15px; font-weight:600; margin:0 0 4px; }
  .sub { font-size:12px; color:#8b949e; margin-bottom:16px; }
  .card { border:1px solid #21262d; border-radius:8px; background:#161b22;
          margin-bottom:10px; overflow:hidden; max-width:620px; }
  .card-head { padding:10px 12px; border-bottom:1px solid #21262d;
               display:flex; justify-content:space-between; align-items:center; gap:10px; }
  .teams { font-size:13px; font-weight:600; }
  .card-body { padding:12px; }
  .confidence { font-size:10px; font-weight:700; text-transform:uppercase;
                letter-spacing:.5px; padding:2px 6px; border-radius:3px; }
  .confidence.High { background:#1f6feb; color:#fff; }
  .confidence.Medium { background:#9e6a03; color:#fff; }
  .nobet { font-size:11px; color:#6e7681; }
${css}
</style></head><body>
<h1>Board card &mdash; best price across 9 books</h1>
<div class="sub">Real NFL slate, 15 games. The amber figure is what DraftKings costs you on that same bet.
  Badge only where the best available price clears ${model.BET_LEAN_PTS}%.</div>
${cards.map(c => `<div class="card">
  <div class="card-head">
    <span class="teams">${c.g.awayTeam} @ ${c.g.homeTeam}</span>
    ${c.badge
      ? `<span class="confidence ${c.bestOffer.pts >= model.BET_STRONG_PTS ? 'High' : 'Medium'}">${c.badge} +${c.bestOffer.pts.toFixed(2)}%</span>`
      : `<span class="nobet">no bet &mdash; best available ${c.bestOffer.pts >= 0 ? '+' : ''}${c.bestOffer.pts.toFixed(2)}%</span>`}
  </div>
  <div class="card-body">${c.rendered}</div>
</div>`).join('\n')}
</body></html>`;

fs.writeFileSync('../card-preview.html', out, 'utf8');
console.log('wrote ../card-preview.html  (' + cards.length + ' cards)');
console.log('badged: ' + cards.filter(c => c.badge).length);
console.log('');
console.log('cost-to-you spread across the slate:');
const gaps = cards.map(c => c.bestOffer.gapPts).filter(Number.isFinite);
gaps.sort((a, b) => a - b);
console.log('  min ' + gaps[0].toFixed(2) + '%   median ' +
  gaps[Math.floor(gaps.length / 2)].toFixed(2) + '%   max ' +
  gaps[gaps.length - 1].toFixed(2) + '%');
