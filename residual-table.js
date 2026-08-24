// Extract the empirical NFL cover-margin distribution, ready to paste.
//
// Every probability the Pick 6 tab reports is P(final margin beats a line that
// is N points away from the market's). A normal curve gets that wrong in a
// direction that flatters the bet: on 7,239 games it overstates a seven-point
// stale line by 2.4 points at the shipped sigma and 1.6 at the best-fit one.
//
// The residual (final margin + closing spread) is the thing to count, exactly
// as the baseball and hockey margin tables are counted. Half-point spreads mean
// residuals land on halves, so the table is kept at half-point resolution.
//
// Run: node residual-table.js

const URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';

function splitRow(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}

(async () => {
  const text = await (await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const lines = text.trim().split('\n');
  const cols = splitRow(lines[0]);
  const at = (n) => cols.indexOf(n);
  const [iSeason, iType, iHome, iAway, iSpread] =
    ['season', 'game_type', 'home_score', 'away_score', 'spread_line'].map(at);

  const res = [];
  for (const line of lines.slice(1)) {
    const f = splitRow(line);
    const hs = Number(f[iHome]), as = Number(f[iAway]), sp = Number(f[iSpread]);
    if (!Number.isFinite(hs) || !Number.isFinite(as) || !Number.isFinite(sp)) continue;
    if (f[iType] !== 'REG') continue;
    res.push((hs - as) - sp);   // nflverse states the home line with the opposite sign
  }
  res.sort((a, b) => a - b);
  const n = res.length;

  // P(residual > d) at half-point steps, which is every line a book posts.
  const lo = -28, hi = 28;
  const surv = [];
  for (let d = lo; d <= hi; d += 0.5) {
    surv.push(+(res.filter(r => r > d).length / n).toFixed(5));
  }
  console.log(`// ${n} regular-season games, nflverse, ${lines.length - 1} rows scanned`);
  console.log(`  games: ${n},`);
  console.log(`  from: ${lo}, step: 0.5,`);
  console.log('  survival: [');
  for (let i = 0; i < surv.length; i += 10) {
    console.log('    ' + surv.slice(i, i + 10).join(', ') + ',');
  }
  console.log('  ],');

  console.log('\n// sanity: what it says at the offsets that matter');
  for (const d of [1, 2, 3, 4, 5, 6, 7]) {
    const idx = Math.round((-d - lo) / 0.5);
    console.log(`//   stale by ${d}: ${(surv[idx] * 100).toFixed(1)}%`);
  }
  console.log(`// P(exact push at 0): ${((res.filter(r => Math.abs(r) < 1e-9).length / n) * 100).toFixed(2)}%`);
  console.log(`// P(push at 3): ${((res.filter(r => Math.abs(r - 3) < 1e-9).length / n) * 100).toFixed(2)}%`);
})();
