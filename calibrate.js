// Fit sigma to real prices, one book at a time.
//
// The cross-market pricing rests entirely on sigma. Get it wrong and every
// game tilts the same way, which looks like a slate full of edges and is
// actually one bad constant — the exact failure that produced "back the
// underdog run line" on six of seven baseball games earlier today.
//
// So this fits sigma per sport from the market's own prices, and then reports
// the thing that decides whether to believe it: which way the leftovers lean.
// A fit whose residuals are all one sign has found a bias in the model. A fit
// whose residuals straddle zero has found a market, and the few games sitting
// far from zero are the ones worth betting.
//
// Everything is taken from ONE book, because pricing a run line against a
// moneyline from a different shop compares two things that were never meant to
// agree.
//
// Run: node calibrate.js [book]

const model = require('./model');

const BASE = process.env.BASE || 'https://sports-prediction-agent.onrender.com';
const BOOK = (process.argv[2] || 'DraftKings').toLowerCase();

const parseSpread = (q) => {
  const m = q.match(/^(.*?)\s+(-?\d+(?:\.\d+)?)\s+@\s+(-?\d+)$/);
  return m ? { team: m[1], point: Number(m[2]), price: Number(m[3]) } : null;
};
const parseML = (q) => {
  const m = q.match(/^(.*?)\s+@\s+(-?\d+)$/);
  return m ? { team: m[1], price: Number(m[2]) } : null;
};

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return null;
  const i = a.length >> 1;
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};

(async () => {
  for (const sport of ['mlb', 'nhl']) {
    let data;
    try {
      const r = await fetch(`${BASE}/api/debug/shop/${sport}?limit=60`);
      data = await r.json();
    } catch (e) { console.log(`${sport}: fetch failed — ${e.message}`); continue; }

    const games = [];
    for (const g of data.sample || []) {
      const book = (g.books || []).find(b => (b.book || '').toLowerCase() === BOOK);
      if (!book) continue;

      const spreads = (book.spreads || []).map(parseSpread).filter(Boolean);
      const mls = (book.moneyline || []).map(parseML).filter(Boolean);
      if (spreads.length !== 2 || mls.length !== 2) continue;

      // Home is whichever name matches the game's home team.
      const norm = (x) => (x || '').toLowerCase().replace(/[^a-z]/g, '');
      const homeN = norm(g.home);
      const hs = spreads.find(x => norm(x.team) === homeN);
      const as = spreads.find(x => norm(x.team) !== homeN);
      const hm = mls.find(x => norm(x.team) === homeN);
      const am = mls.find(x => norm(x.team) !== homeN);
      if (!hs || !as || !hm || !am) continue;

      games.push({
        label: `${g.away} @ ${g.home}`,
        spread: hs.point,
        spreadHomePrice: hs.price,
        spreadAwayPrice: as.price,
        homeML: hm.price,
        awayML: am.price,
      });
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log(`${sport.toUpperCase()} — ${games.length} games priced end to end at ${BOOK}`);
    console.log('='.repeat(72));
    if (games.length < 3) { console.log('  not enough to fit anything'); continue; }

    const fit = model.calibrateSigmaFromMarkets(games);
    if (!fit) { console.log('  fit failed'); continue; }

    const bookSigma = model.SPORTS[sport].sigma;
    console.log(`  sigma the file assumes : ${bookSigma}`);
    console.log(`  sigma the market implies: ${fit.sigma}`);
    console.log(`  median absolute disagreement at that sigma: ${fit.medianAbsDisagreementPts} probability points`);
    console.log(`  residual direction: ${fit.leaningHome} lean home, ${fit.leaningAway} lean away  <-- must be roughly even`);
    console.log(`  largest disagreement on the slate: ${fit.maxDisagreementPts} points`);

    // What each game looks like at the fitted sigma, sorted by how far the two
    // markets are apart.
    const rows = games.map(g => {
      const r = model.crossMarketEdge({ ...g, sigma: fit.sigma });
      return r ? { ...g, ...r } : null;
    }).filter(Boolean);

    rows.sort((a, b) => Math.abs(b.disagreementPts) - Math.abs(a.disagreementPts));
    console.log('\n  furthest apart (positive disagreement = run line cheap on the home side):');
    for (const r of rows.slice(0, 6)) {
      const side = r.homeEdgePts > r.awayEdgePts ? 'HOME' : 'AWAY';
      const best = Math.max(r.homeEdgePts, r.awayEdgePts);
      console.log(`    ${r.label.padEnd(42)} ml ${String(r.homeML).padStart(5)}/${String(r.awayML).padStart(5)}` +
        `  rl ${String(r.spreadHomePrice).padStart(5)}/${String(r.spreadAwayPrice).padStart(5)}`);
      console.log(`       implied margin ${r.predictedMargin.toFixed(2).padStart(6)}   disagreement ${String(r.disagreementPts).padStart(6)}` +
        `   best side ${side} at ${best > 0 ? '+' : ''}${best} pts after vig   hold ${r.spreadHold}%`);
    }

    // The number that decides whether any of this is bettable: how often does
    // a side survive the vig?
    const positive = rows.filter(r => Math.max(r.homeEdgePts, r.awayEdgePts) > 0);
    console.log(`\n  games where a side beats its own price after vig: ${positive.length}/${rows.length}`);
    const edges = rows.map(r => Math.max(r.homeEdgePts, r.awayEdgePts));
    console.log(`  best-side edge: median ${median(edges).toFixed(2)}, max ${Math.max(...edges).toFixed(2)} probability points`);

    // Sensitivity: how much does the answer move if sigma is off by 10%?
    for (const mult of [0.9, 1.1]) {
      const s2 = +(fit.sigma * mult).toFixed(3);
      const r2 = games.map(g => model.crossMarketEdge({ ...g, sigma: s2 })).filter(Boolean);
      const lean = r2.filter(r => r.disagreementPts > 0).length;
      console.log(`  at sigma ${s2} (${mult === 0.9 ? '-' : '+'}10%): ${lean}/${r2.length} lean home` +
        ` — ${lean === r2.length || lean === 0 ? 'ALL ONE WAY, sigma matters enormously' : 'still mixed'}`);
    }
  }
})();
