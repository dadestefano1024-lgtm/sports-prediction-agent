// How far apart are books on PRICE, at the same line?
//
// The app grades an offer by comparing the line's POINT against consensus. In
// baseball and hockey every book posts 1.5, so that comparison is always zero
// and the verdict reads "at market" on every game — while the prices behind
// that identical line run from -210 to +166. This measures the gap so a
// threshold can come from the distribution rather than from taste.
//
// Everything is expressed in percentage points of implied probability, which is
// the only unit in which a price difference and a line difference are
// comparable to one another.

const model = require('./model');

const BASE = process.env.BASE || 'https://sports-prediction-agent.onrender.com';
const MY_BOOK = 'DraftKings';

const impliedPct = (american) => {
  try { return model.americanToImpliedProb(american) * 100; } catch (e) { return null; }
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

(async () => {
  const rows = [];

  for (const sport of ['mlb', 'nhl', 'nfl']) {
    let data;
    try {
      const r = await fetch(`${BASE}/api/debug/shop/${sport}`);
      data = await r.json();
    } catch (e) { console.log(sport, 'fetch failed:', e.message); continue; }

    for (const g of data.sample || []) {
      // Group every book's quote by market and side, at the line it posts.
      const sides = {};   // key -> [{book, price, point}]
      for (const b of g.books || []) {
        for (const q of b.spreads || []) {
          const m = q.match(/^(.*?)\s+(-?\d+(?:\.\d+)?)\s+@\s+(-?\d+)$/);
          if (!m) continue;
          const key = `spread|${m[1]}|${m[2]}`;
          (sides[key] = sides[key] || []).push({ book: b.book, price: Number(m[3]) });
        }
        for (const q of b.totals || []) {
          const m = q.match(/^(Over|Under)\s+(-?\d+(?:\.\d+)?)\s+@\s+(-?\d+)$/i);
          if (!m) continue;
          const key = `total|${m[1]}|${m[2]}`;
          (sides[key] = sides[key] || []).push({ book: b.book, price: Number(m[3]) });
        }
      }

      for (const [key, quotes] of Object.entries(sides)) {
        if (quotes.length < 3) continue;   // need a market to compare against
        const mine = quotes.find(q => q.book === MY_BOOK);
        if (!mine) continue;
        const others = quotes.filter(q => q.book !== MY_BOOK).map(q => impliedPct(q.price)).filter(x => x !== null);
        const myPct = impliedPct(mine.price);
        if (myPct === null || others.length < 2) continue;

        const med = median(others);
        const best = Math.min(...others);          // lowest implied prob = best price elsewhere
        rows.push({
          sport, key,
          myPrice: mine.price,
          // Positive means MY book is offering the better price.
          vsMedian: +(med - myPct).toFixed(2),
          vsBest: +(best - myPct).toFixed(2),
          books: quotes.length,
        });
      }
    }
  }

  console.log(`${rows.length} side-quotes where ${MY_BOOK} and at least two other books post the same line\n`);

  for (const sport of ['mlb', 'nhl', 'nfl']) {
    const r = rows.filter(x => x.sport === sport);
    if (!r.length) { console.log(`${sport.toUpperCase()}: no comparable quotes`); continue; }
    const gaps = r.map(x => x.vsMedian);
    const abs = gaps.map(Math.abs);
    console.log(`${sport.toUpperCase()}  (${r.length} quotes)`);
    console.log(`   ${MY_BOOK} vs median, in probability points:`);
    console.log(`     min ${Math.min(...gaps).toFixed(2)}   median ${median(gaps).toFixed(2)}   max ${Math.max(...gaps).toFixed(2)}`);
    console.log(`   absolute gap: median ${median(abs).toFixed(2)}   75th ${pct(abs, 0.75).toFixed(2)}   90th ${pct(abs, 0.90).toFixed(2)}   max ${Math.max(...abs).toFixed(2)}`);
    const better = gaps.filter(x => x > 0).length;
    console.log(`   ${MY_BOOK} better than median on ${better}/${r.length}, worse on ${gaps.filter(x => x < 0).length}, level on ${gaps.filter(x => x === 0).length}`);
    for (const t of [0.5, 1, 1.5, 2, 3]) {
      const n = gaps.filter(x => x >= t).length;
      console.log(`     >= ${t} pts better: ${n} (${(n / r.length * 100).toFixed(0)}%)`);
    }
    console.log('');
  }

  console.log('largest advantages found:');
  rows.sort((a, b) => b.vsMedian - a.vsMedian).slice(0, 8).forEach(r =>
    console.log(`   ${r.sport}  ${r.key.padEnd(34)} ${MY_BOOK} ${String(r.myPrice).padStart(5)}  +${r.vsMedian} pts vs median of ${r.books - 1} books`));
})();
