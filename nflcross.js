// Do the NFL spread and the NFL moneyline agree with each other?
//
// A -7.5 favourite priced at -350 and a -7.5 favourite priced at -180 are not
// the same team, whatever the spread says. Those two markets describe one game
// and only one pair of numbers is consistent; where a book posts a pair that is
// not, one of the two is wrong and the cheap one is worth taking. Same argument
// as the baseball run line, except football's spread is a real number rather
// than a fixed 1.5, which makes it the better target.
//
// Part one measures what a closing spread ACTUALLY implied, from 272 games of
// 2025 held in the backtest cache: the spread, the final margin, and therefore
// how often each spread won outright. Part two reads the live board and finds
// the games whose moneyline disagrees with their own spread.

const fs = require('fs');
const model = require('./model');

const BASE = process.env.BASE || 'https://sports-prediction-agent.onrender.com';
const cache = JSON.parse(fs.readFileSync('./sharptest-cache.json', 'utf8'));

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-+]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------
// Part one: what a closing spread actually did
// ---------------------------------------------------------------------------
const games = [];
for (const key of Object.keys(cache)) {
  if (!key.startsWith('sb:')) continue;
  const board = cache[key];
  for (const ev of board.events || []) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const cs = comp.competitors || [];
    const home = cs.find(c => c.homeAway === 'home');
    const away = cs.find(c => c.homeAway === 'away');
    if (!home || !away) continue;
    const readScore = (c) => {
      const raw = typeof c.score === 'object' ? (c.score && c.score.value) : c.score;
      return (raw === null || raw === undefined || raw === '') ? null : Number(raw);
    };
    const hs = readScore(home), as = readScore(away);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    const odds = cache[`o:${ev.id}`];
    const close = odds ? num(odds.close) : null;
    if (close === null) continue;
    games.push({ id: ev.id, spread: close, margin: hs - as });
  }
}

console.log(`2025 closing spreads with a final score: ${games.length} games\n`);

// The residual is what a normal curve is standing in for. Count it instead.
const resid = new Map();
for (const g of games) {
  const r = g.margin + g.spread;          // >0 means the home side covered
  resid.set(r, (resid.get(r) || 0) + 1);
}
const marginCount = new Map();
for (const g of games) {
  const m = Math.abs(g.margin);
  marginCount.set(m, (marginCount.get(m) || 0) + 1);
}
console.log('  most common winning margins (the key numbers, if they are real):');
[...marginCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([m, n]) =>
  console.log(`    by ${String(m).padStart(2)}: ${String(n).padStart(3)} games  ${(n / games.length * 100).toFixed(1)}%`));

// How often did each spread band win outright?
console.log('\n  how often the favourite won the game outright, by closing spread:');
const bands = [[0, 1.5], [1.5, 3.5], [3.5, 6.5], [6.5, 9.5], [9.5, 13.5], [13.5, 99]];
const observed = [];
for (const [lo, hi] of bands) {
  const inB = games.filter(g => Math.abs(g.spread) >= lo && Math.abs(g.spread) < hi);
  if (inB.length < 10) continue;
  const favWon = inB.filter(g => (g.spread < 0 ? g.margin > 0 : g.margin < 0)).length;
  const meanSpread = inB.reduce((s, g) => s + Math.abs(g.spread), 0) / inB.length;
  const rate = favWon / inB.length;
  observed.push({ meanSpread, rate, n: inB.length });
  // What a normal at the file's sigma would have said.
  const predicted = model.normalCdf(meanSpread / model.SPORTS.nfl.sigma);
  console.log(`    ${String(lo).padStart(4)}-${String(hi === 99 ? '+' : hi).padStart(4)} ` +
    `(mean ${meanSpread.toFixed(1)}): ${String(inB.length).padStart(3)} games   ` +
    `won outright ${(rate * 100).toFixed(1)}%   a normal says ${(predicted * 100).toFixed(1)}%   ` +
    `${rate - predicted >= 0 ? '+' : ''}${((rate - predicted) * 100).toFixed(1)}`);
}

// Fit the sigma that best reproduces what happened.
let bestSigma = null;
for (let sg = 8; sg <= 20; sg += 0.05) {
  let err = 0;
  for (const o of observed) err += o.n * Math.pow(o.rate - model.normalCdf(o.meanSpread / sg), 2);
  if (!bestSigma || err < bestSigma.err) bestSigma = { sigma: +sg.toFixed(2), err };
}
console.log(`\n  sigma that best reproduces these outcomes: ${bestSigma.sigma}` +
  `   (the file carries ${model.SPORTS.nfl.sigma})`);

// ---------------------------------------------------------------------------
// Part two: does the live board contradict itself?
// ---------------------------------------------------------------------------
(async () => {
  const r = await fetch(`${BASE}/api/debug/shop/nfl?limit=100`);
  const data = await r.json();
  const norm = (x) => (x || '').toLowerCase().replace(/[^a-z]/g, '');
  const parseSpread = (q) => {
    const m = q.match(/^(.*?)\s+(-?\d+(?:\.\d+)?)\s+@\s+(-?\d+)$/);
    return m ? { team: m[1], point: Number(m[2]), price: Number(m[3]) } : null;
  };
  const parseML = (q) => {
    const m = q.match(/^(.*?)\s+@\s+(-?\d+)$/);
    return m ? { team: m[1], price: Number(m[2]) } : null;
  };

  const SIGMA = bestSigma.sigma;
  const rows = [];
  const bookNames = new Set();

  for (const g of data.sample || []) {
    for (const b of g.books || []) {
      const sp = (b.spreads || []).map(parseSpread).filter(Boolean);
      const ml = (b.moneyline || []).map(parseML).filter(Boolean);
      if (sp.length !== 2 || ml.length !== 2) continue;
      const homeN = norm(g.home);
      const hs = sp.find(x => norm(x.team) === homeN);
      const hm = ml.find(x => norm(x.team) === homeN);
      const am = ml.find(x => norm(x.team) !== homeN);
      if (!hs || !hm || !am) continue;
      bookNames.add(b.book);

      // What the spread says the home side's chance of winning outright is.
      const fromSpread = model.normalCdf(-hs.point / SIGMA);
      // What the moneyline at the same book says.
      let fromML;
      try { fromML = model.deVigTwoWayShin(hm.price, am.price).probA; } catch (e) { continue; }

      rows.push({
        book: b.book, game: `${g.away} @ ${g.home}`,
        spread: hs.point, homeML: hm.price, awayML: am.price,
        fromSpread, fromML, gap: (fromML - fromSpread) * 100,
      });
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`live board: ${rows.length} book-games across ${bookNames.size} books, priced at sigma ${SIGMA}`);
  console.log('='.repeat(72));

  const gaps = rows.map(r => r.gap);
  const med = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
  const absSorted = [...gaps].map(Math.abs).sort((a, b) => a - b);
  console.log(`  moneyline minus what the spread implies, in probability points:`);
  console.log(`    median ${med.toFixed(2)}   median absolute ${absSorted[absSorted.length >> 1].toFixed(2)}` +
    `   90th ${absSorted[Math.floor(absSorted.length * 0.9)].toFixed(2)}   max ${absSorted[absSorted.length - 1].toFixed(2)}`);
  const rich = gaps.filter(x => x > 0).length;
  console.log(`    ${rich}/${rows.length} have the moneyline richer than the spread` +
    `${rich === rows.length || rich === 0 ? '   <-- ALL ONE WAY, the sigma is doing this' : ''}`);

  console.log('\n  furthest apart — where a book contradicts itself:');
  rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  for (const r of rows.slice(0, 10)) {
    console.log(`    ${r.book.padEnd(13)} ${r.game.padEnd(44)} ${String(r.spread).padStart(6)}  ` +
      `ml ${String(r.homeML).padStart(5)}/${String(r.awayML).padStart(5)}   ` +
      `spread says ${(r.fromSpread * 100).toFixed(1)}%  ml says ${(r.fromML * 100).toFixed(1)}%  ` +
      `${r.gap > 0 ? '+' : ''}${r.gap.toFixed(1)}`);
  }

  // Does the same game disagree ACROSS books? That is the shoppable version.
  console.log('\n  same game, widest moneyline disagreement between books:');
  const byGame = new Map();
  for (const r of rows) {
    if (!byGame.has(r.game)) byGame.set(r.game, []);
    byGame.get(r.game).push(r);
  }
  const spreads = [...byGame.entries()]
    .filter(([, rs]) => rs.length >= 4)
    .map(([game, rs]) => {
      const ps = rs.map(r => r.fromML);
      return { game, spread: rs[0].spread, lo: Math.min(...ps), hi: Math.max(...ps),
               range: (Math.max(...ps) - Math.min(...ps)) * 100, books: rs.length };
    })
    .sort((a, b) => b.range - a.range);
  for (const s of spreads.slice(0, 6)) {
    console.log(`    ${s.game.padEnd(44)} spread ${String(s.spread).padStart(6)}   ` +
      `moneyline implies ${(s.lo * 100).toFixed(1)}% to ${(s.hi * 100).toFixed(1)}%   ` +
      `spread of ${s.range.toFixed(1)} points across ${s.books} books`);
  }
  const ranges = spreads.map(s => s.range).sort((a, b) => a - b);
  if (ranges.length) {
    console.log(`\n  across ${spreads.length} games: median between-book range ${ranges[ranges.length >> 1].toFixed(2)} points,` +
      ` max ${ranges[ranges.length - 1].toFixed(2)}`);
  }
})();
