// The stale-line rule, tested on a season it was never fitted to.
//
// This is the only edge the app has that has ever survived a test, and it
// rests on 269 games of one season with a threshold chosen after looking at
// the results. That is exactly the shape of a finding that evaporates.
//
// ESPN keeps opening lines for 2024 and 2025 (not 2022 or 2023). 2025 is where
// the rule came from. 2024 has never been looked at, which makes it a real
// holdout: same rule, same two-point threshold, no refitting.
//
// The rule: the market moves between the opening number and the close. If your
// pool line is still the OPENING number, back the side the market moved
// toward. You are not beating anybody's forecast, only a number that stopped
// updating.
//
// Run: node stale-oos.js

const fs = require('fs');

const OUT = './nfl-open-close.json';
const { games } = JSON.parse(fs.readFileSync('./nfl-history.json', 'utf8'));

async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) return r.json();
      if (r.status === 404) return null;
    } catch (e) { /* retry */ }
  }
  return null;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-+]/g, ''));
  return Number.isFinite(n) ? n : null;
};

(async () => {
  const cached = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { rows: [] };
  const rows = cached.rows;
  const seen = new Set(rows.map(r => r.id));

  const targets = games.filter(g => (g.year === 2024 || g.year === 2025) && !seen.has(g.id));
  for (let i = 0; i < targets.length; i += 6) {
    const batch = targets.slice(i, i + 6);
    const res = await Promise.all(batch.map(g => getJson(
      `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${g.id}/competitions/${g.id}/odds`)));
    batch.forEach((g, j) => {
      const items = (res[j] && res[j].items) || [];
      // Skip the in-play feeds; they carry a live number, not an opening one.
      const it = items.find(x => !/live/i.test((x.provider && x.provider.name) || '') &&
        x.homeTeamOdds && x.homeTeamOdds.open && x.homeTeamOdds.open.pointSpread &&
        x.homeTeamOdds.current && x.homeTeamOdds.current.pointSpread);
      if (!it) return;
      const open = num(it.homeTeamOdds.open.pointSpread.american);
      const close = num(it.homeTeamOdds.current.pointSpread.american);
      if (open === null || close === null) return;
      rows.push({ id: g.id, year: g.year, week: g.week, home: g.home, away: g.away,
                  margin: g.margin, open, close });
      seen.add(g.id);
    });
    process.stdout.write(`\r  fetched ${rows.length}   `);
  }
  fs.writeFileSync(OUT, JSON.stringify({ rows }));
  console.log(`\n${rows.length} games with an opening and a closing spread\n`);

  // ------------------------------------------------------------------
  // The rule, applied at the OPENING number.
  // ------------------------------------------------------------------
  const run = (set, label, minMove) => {
    let w = 0, l = 0, push = 0;
    for (const r of set) {
      const move = r.close - r.open;          // negative = market moved toward home
      if (Math.abs(move) < minMove) continue;
      // Back the side the market moved toward, at the stale opening number.
      const backHome = move < 0;
      const cover = backHome ? (r.margin + r.open) : -(r.margin + r.open);
      if (Math.abs(cover) < 1e-9) push++;
      else if (cover > 0) w++;
      else l++;
    }
    const n = w + l;
    if (n < 15) return null;
    const rate = w / n;
    const se = Math.sqrt(0.25 / n);
    return { label, w, l, push, n, rate, z: (rate - 0.5) / se };
  };

  const show = (r) => {
    if (!r) return;
    console.log(`    ${r.label.padEnd(30)} ${String(r.w).padStart(3)}-${String(r.l).padStart(3)}` +
      `${r.push ? ` (${r.push}p)` : '     '}  ${(r.rate * 100).toFixed(1)}%  ` +
      `${r.n} bets  ${r.z >= 0 ? '+' : ''}${r.z.toFixed(2)} SD` +
      `${r.rate > 0.524 ? '   beats the vig' : ''}`);
  };

  const y24 = rows.filter(r => r.year === 2024);
  const y25 = rows.filter(r => r.year === 2025);

  console.log('  2025 — the season the rule came from:');
  for (const t of [0.5, 1, 1.5, 2, 2.5, 3]) show(run(y25, `move >= ${t} pts`, t));

  console.log('\n  2024 — HOLDOUT, never looked at, same rule and same threshold:');
  for (const t of [0.5, 1, 1.5, 2, 2.5, 3]) show(run(y24, `move >= ${t} pts`, t));

  console.log('\n  both seasons together:');
  for (const t of [1, 2, 3]) show(run(rows, `move >= ${t} pts`, t));

  // How often is a line stale enough to matter?
  const big = rows.filter(r => Math.abs(r.close - r.open) >= 2).length;
  console.log(`\n  ${big}/${rows.length} games moved 2+ points between open and close ` +
    `(${(big / rows.length * 100).toFixed(0)}% — so about ${(big / rows.length * 16).toFixed(1)} of a 16-game slate)`);

  // Control: does backing the stale number work regardless of direction? If
  // simply taking the opening number wins, the movement is not the story.
  let cw = 0, cl = 0;
  for (const r of rows) {
    const cover = r.margin + r.open;
    if (Math.abs(cover) < 1e-9) continue;
    if (cover > 0) cw++; else cl++;
  }
  console.log(`  control — always backing home at the opening number: ${cw}-${cl} ` +
    `(${(cw / (cw + cl) * 100).toFixed(1)}%), which should be a coin flip`);
})();
