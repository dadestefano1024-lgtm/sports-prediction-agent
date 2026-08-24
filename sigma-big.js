// Re-measure the NFL sigma on every season nflverse has, not four.
//
// sigma is the constant behind every Pick 6 probability: it converts "your pool
// line is N points stale" into "you win X% of the time". It was measured on
// 1,087 games from 2022-2025, which is enough to beat the 13.5 the file used to
// carry but not enough to be comfortable about.
//
// nflverse publishes closing spread and final score for 1999 onward, free, and
// the app already reads nflverse for other things. Opening lines are NOT in
// there, so this cannot extend the stale-line test — but sigma only needs a
// closing line and a result, which is exactly what this has.
//
// Run: node sigma-big.js

const model = require('./model');

const URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';

// Minimal CSV split that respects quoted fields.
function splitRow(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

(async () => {
  const text = await (await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const lines = text.trim().split('\n');
  const cols = splitRow(lines[0]);
  const at = (n) => cols.indexOf(n);
  const iSeason = at('season'), iType = at('game_type');
  const iHome = at('home_score'), iAway = at('away_score'), iSpread = at('spread_line');

  const games = [];
  for (const line of lines.slice(1)) {
    const f = splitRow(line);
    const hs = Number(f[iHome]), as = Number(f[iAway]), sp = Number(f[iSpread]);
    if (!Number.isFinite(hs) || !Number.isFinite(as) || !Number.isFinite(sp)) continue;
    // nflverse spread_line is the HOME line stated as points the home team is
    // favoured by — the opposite sign convention to this codebase, where a home
    // favourite carries a negative spread. Convert.
    games.push({ season: Number(f[iSeason]), type: f[iType],
                 margin: hs - as, spread: -sp });
  }

  const reg = games.filter(g => g.type === 'REG');
  console.log(`nflverse: ${games.length} games with a closing spread and a score, ${reg.length} regular season`);
  const years = reg.map(g => g.season).filter(Number.isFinite);
  console.log(`seasons ${Math.min(...years)} to ${Math.max(...years)}\n`);

  const fit = (set, label) => {
    const res = set.map(g => g.margin + g.spread);
    const n = res.length;
    const mean = res.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(res.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));

    // The sigma this app actually needs: the one that gets P(margin beats a line
    // offset by d) right for the offsets a stale pool line really sits at.
    const offs = [-7, -6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7];
    const actual = offs.map(d => res.filter(r => r > d).length / n);
    let best = null;
    for (let sg = 8; sg <= 16; sg += 0.01) {
      let err = 0;
      offs.forEach((d, i) => { err += Math.pow(actual[i] - (1 - model.normalCdf(d / sg)), 2); });
      if (!best || err < best.err) best = { sigma: +sg.toFixed(2), err };
    }
    console.log(`  ${label.padEnd(22)} n=${String(n).padStart(5)}  raw SD ${sd.toFixed(2)}  ` +
      `offset-fit sigma ${best.sigma}  mean residual ${mean.toFixed(3)}`);
    return { n, sd, sigma: best.sigma, res };
  };

  console.log('sigma by era — a single number is only usable if it is stable:');
  const all = fit(reg, 'all seasons');
  fit(reg.filter(g => g.season >= 2015), '2015 onward');
  fit(reg.filter(g => g.season >= 2020), '2020 onward');
  fit(reg.filter(g => g.season >= 2022), '2022 onward (current)');
  for (const y of [2021, 2022, 2023, 2024, 2025]) {
    const s = reg.filter(g => g.season === y);
    if (s.length > 100) fit(s, `${y} alone`);
  }

  // What the shipped value gets wrong, on the big sample.
  console.log(`\nshipped sigma is ${model.SPORTS.nfl.sigma}. Against ${all.n} games:`);
  console.log('  pool line stale by   real     at 10.82    at the new fit');
  const n = all.res.length;
  for (const d of [1, 2, 3, 4, 5, 6, 7]) {
    const act = all.res.filter(r => r > -d).length / n;
    const cur = 1 - model.normalCdf(-d / model.SPORTS.nfl.sigma);
    const neu = 1 - model.normalCdf(-d / all.sigma);
    console.log(`    ${String(d).padStart(4)} pts        ${(act * 100).toFixed(1)}%    ` +
      `${(cur * 100).toFixed(1)}% (${((cur - act) * 100).toFixed(1)})   ${(neu * 100).toFixed(1)}% (${((neu - act) * 100).toFixed(1)})`);
  }

  // Key numbers, on 7,000 games instead of 269.
  const counts = new Map();
  for (const g of reg) {
    const m = Math.abs(g.margin);
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  console.log(`\nmost common winning margins across ${reg.length} games:`);
  [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([m, c]) =>
    console.log(`    by ${String(m).padStart(2)}: ${(c / reg.length * 100).toFixed(2)}%`));
})();
