// Fit the mismatch parameter to real prices, using the counted margin tables.
//
// Replaces the sigma fit, which rested on a normal curve now measured to be
// wrong by about ten points at exactly the value a 1.5 line asks about.
//
// Run: node calibrate2.js [book]

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
const norm = (x) => (x || '').toLowerCase().replace(/[^a-z]/g, '');

async function slate(sport) {
  const r = await fetch(`${BASE}/api/debug/shop/${sport}?limit=60`);
  const data = await r.json();
  const out = [];
  for (const g of data.sample || []) {
    const book = (g.books || []).find(b => (b.book || '').toLowerCase() === BOOK);
    if (!book) continue;
    const spreads = (book.spreads || []).map(parseSpread).filter(Boolean);
    const mls = (book.moneyline || []).map(parseML).filter(Boolean);
    if (spreads.length !== 2 || mls.length !== 2) continue;
    const homeN = norm(g.home);
    const hs = spreads.find(x => norm(x.team) === homeN);
    const as = spreads.find(x => norm(x.team) !== homeN);
    const hm = mls.find(x => norm(x.team) === homeN);
    const am = mls.find(x => norm(x.team) !== homeN);
    if (!hs || !as || !hm || !am) continue;
    out.push({
      label: `${g.away} @ ${g.home}`,
      spread: hs.point, spreadHomePrice: hs.price, spreadAwayPrice: as.price,
      homeML: hm.price, awayML: am.price,
    });
  }
  return out;
}

(async () => {
  for (const sport of ['mlb', 'nhl']) {
    const games = await slate(sport).catch(() => []);
    console.log(`\n${'='.repeat(74)}`);
    console.log(`${sport.toUpperCase()} — ${games.length} games priced end to end at ${BOOK}`);
    console.log(`  margin table: ${model.MARGIN_TABLES[sport].games} real games, ` +
      `P(won by 2+) = ${(model.marginAtLeast(sport, 2) * 100).toFixed(2)}%`);
    console.log('='.repeat(74));
    if (games.length < 3) { console.log('  not enough to fit'); continue; }

    // Ignore the mismatch term first, then fit it, and compare.
    const flat = games.map(g => model.runLineEdge({ sport, ...g, mismatch: 0 })).filter(Boolean);
    const flatLean = flat.filter(r => r.disagreementPts > 0).length;
    console.log(`\n  with no mismatch term at all:`);
    console.log(`    median absolute disagreement ${median(flat.map(r => Math.abs(r.disagreementPts))).toFixed(2)} pts`);
    console.log(`    ${flatLean}/${flat.length} lean home` +
      `${flatLean === flat.length || flatLean === 0 ? '   <-- ALL ONE WAY' : ''}`);

    const fit = model.fitMismatch(sport, games);
    if (!fit) { console.log('  fit failed'); continue; }
    console.log(`\n  fitted mismatch: ${fit.mismatch}`);
    console.log(`    median absolute disagreement ${fit.medianAbsDisagreementPts} pts`);
    console.log(`    ${fit.leaningHome} lean home, ${fit.leaningAway} lean away   <-- must be roughly even`);
    console.log(`    largest disagreement ${fit.maxDisagreementPts} pts`);

    // Priced with the MEASURED conditional, not the slate fit. The fit above is
    // a diagnostic: when it drifts far from the season, that is a fact about
    // how little a ten-game slate constrains anything, not a better parameter.
    const measured = model.MARGIN_TABLES[sport].conditional;
    console.log(`
  season-measured mismatch: ${measured.mismatch} over ${measured.games} games` +
      `   (slate fit said ${fit.mismatch} — ${Math.abs(fit.mismatch - measured.mismatch) > 0.2 ? 'MILES OFF, trust the season' : 'close'})`);
    const rows = games.map(g => {
      const r = model.runLineEdge({ sport, ...g });
      return r ? { ...g, ...r } : null;
    }).filter(Boolean);

    const best = rows.map(r => ({
      r, side: r.homeEdgePts >= r.awayEdgePts ? 'home' : 'away',
      pts: Math.max(r.homeEdgePts, r.awayEdgePts),
    })).sort((a, b) => b.pts - a.pts);

    console.log('\n  best side per game, after paying the vig:');
    for (const b of best.slice(0, 6)) {
      const team = b.side === 'home' ? b.r.label.split(' @ ')[1] : b.r.label.split(' @ ')[0];
      const line = b.side === 'home' ? b.r.spread : -b.r.spread;
      const price = b.side === 'home' ? b.r.spreadHomePrice : b.r.spreadAwayPrice;
      console.log(`    ${(team + ' ' + (line > 0 ? '+' : '') + line).padEnd(30)} at ${String(price).padStart(5)}` +
        `   fair ${String(b.side === 'home' ? b.r.fairHomePrice.toFixed(0) : b.r.fairAwayPrice.toFixed(0)).padStart(5)}` +
        `   edge ${b.pts > 0 ? '+' : ''}${b.pts} pts`);
    }

    const positive = best.filter(b => b.pts > 0);
    console.log(`\n  sides that beat their own price: ${positive.length}/${rows.length}`);
    console.log(`  best-side edge: median ${median(best.map(b => b.pts)).toFixed(2)}, max ${best[0].pts} pts`);
    console.log(`  how many favourites vs dogs among the positives: ` +
      `${positive.filter(b => (b.side === 'home') === (b.r.spread < 0)).length} laying, ` +
      `${positive.filter(b => (b.side === 'home') !== (b.r.spread < 0)).length} taking`);
  }
})();
