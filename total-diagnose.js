// Is the projected-total effect real, or is it the recent data?
//
// The headline said 56.0% on 928 bets at a five-point disagreement, which is
// large. The era split said 49.5%, 49.6%, then 56.2% — two decades of nothing
// followed by a strong recent effect. That is the shape of a regime change OR
// of something wrong with the recent rows, and a max disagreement of 53.5
// points says the projection is producing nonsense somewhere.
//
// Checks, in order of how likely they are to kill it:
//   1. season by season, so "an era" cannot hide one freak year
//   2. drop 2026, which is in progress
//   3. drop the first four weeks of each season, where the rolling window is
//      still carrying the PREVIOUS season's games
//   4. cap the disagreement, since a 53-point gap is a broken projection rather
//      than a strong opinion
//
// Run: node total-diagnose.js

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
  const idx = ['season', 'week', 'game_type', 'home_team', 'away_team',
               'home_score', 'away_score', 'total_line'].map(at);
  const [iSeason, iWeek, iType, iHome, iAway, iHS, iAS, iTotal] = idx;

  const games = [];
  for (const line of lines.slice(1)) {
    const f = splitRow(line);
    if (f[iType] !== 'REG') continue;
    // Reject the empties BEFORE converting. Number('') is 0 and passes
    // isFinite, so an unplayed game arrives as a 0-0 final — and those zeros
    // then poison the rolling averages of every team that played in them,
    // dragging projected totals toward nothing. That produced a 96.8% win rate
    // on the 2026 fixture list and very nearly got reported as an edge.
    const raw = (v) => (v === '' || v === undefined || v === null) ? null : Number(v);
    const hs = raw(f[iHS]), as = raw(f[iAS]), tot = raw(f[iTotal]);
    if (hs === null || as === null || tot === null) continue;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || !Number.isFinite(tot)) continue;
    games.push({ season: Number(f[iSeason]), week: Number(f[iWeek]),
                 home: f[iHome], away: f[iAway], hs, as, total: tot });
  }
  games.sort((a, b) => a.season - b.season || a.week - b.week);

  const form = new Map();
  const push = (t, s, a) => {
    if (!form.has(t)) form.set(t, []);
    const arr = form.get(t); arr.push({ s, a }); if (arr.length > 10) arr.shift();
  };
  const avg = (t) => {
    const a = form.get(t);
    if (!a || a.length < 10) return null;
    return { s: a.reduce((x, y) => x + y.s, 0) / a.length,
             a: a.reduce((x, y) => x + y.a, 0) / a.length };
  };

  const bets = [];
  for (const g of games) {
    const h = avg(g.home), a = avg(g.away);
    if (h && a) {
      const projected = (h.s + a.a) / 2 + (a.s + h.a) / 2;
      const actual = g.hs + g.as;
      if (Math.abs(actual - g.total) > 1e-9) {
        bets.push({ season: g.season, week: g.week, gap: projected - g.total,
                    wonOver: actual > g.total, projected, total: g.total, actual });
      }
    }
    push(g.home, g.hs, g.as);
    push(g.away, g.as, g.hs);
  }

  const score = (set, min, max = Infinity) => {
    const sel = set.filter(b => Math.abs(b.gap) >= min && Math.abs(b.gap) <= max);
    if (sel.length < 25) return null;
    let w = 0;
    for (const b of sel) if ((b.gap > 0) === b.wonOver) w++;
    const rate = w / sel.length;
    return { n: sel.length, rate, z: (rate - 0.5) / Math.sqrt(0.25 / sel.length) };
  };
  const line = (label, r) => {
    if (!r) { console.log(`  ${label.padEnd(30)} too few`); return; }
    console.log(`  ${label.padEnd(30)} ${(r.rate * 100).toFixed(1)}%  ${String(r.n).padStart(5)} bets  ` +
      `${r.z >= 0 ? '+' : ''}${r.z.toFixed(2)} SD${r.rate > 0.524 ? '  *' : ''}`);
  };

  console.log('1. SEASON BY SEASON at a 4-point disagreement');
  console.log('   (an "era" effect that is really one or two freak years shows up here)\n');
  const seasons = [...new Set(bets.map(b => b.season))].sort();
  for (const s of seasons) line(String(s), score(bets.filter(b => b.season === s), 4));

  console.log('\n2. DROPPING 2026, which is in progress');
  const settled = bets.filter(b => b.season <= 2025);
  for (const t of [3, 4, 5, 7]) line(`disagreement >= ${t}`, score(settled, t));

  console.log('\n3. DROPPING weeks 1-4, where the window still holds LAST season');
  const midSeason = settled.filter(b => b.week >= 5);
  for (const t of [3, 4, 5, 7]) line(`disagreement >= ${t}`, score(midSeason, t));

  console.log('\n4. CAPPING the disagreement — a 53-point gap is a broken projection');
  for (const [lo, hi] of [[4, 8], [4, 10], [5, 10], [7, 15]]) {
    line(`between ${lo} and ${hi}`, score(settled, lo, hi));
  }
  console.log('\n   how many bets live above each cap:');
  for (const t of [10, 15, 20, 30]) {
    const n = settled.filter(b => Math.abs(b.gap) >= t).length;
    console.log(`     |gap| >= ${String(t).padStart(2)}: ${n} bets`);
  }

  console.log('\n5. WHAT A HUGE GAP ACTUALLY LOOKS LIKE');
  const wild = settled.slice().sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 5);
  for (const b of wild) {
    console.log(`   ${b.season} wk${String(b.week).padStart(2)}  projected ${b.projected.toFixed(1)} ` +
      `vs line ${b.total}  -> actual ${b.actual}  (gap ${b.gap.toFixed(1)})`);
  }

  console.log('\n6. THE SAME TEST ON THE FIRST HALF vs SECOND HALF of the data');
  const half = Math.floor(settled.length / 2);
  line('first half (older)', score(settled.slice(0, half), 4));
  line('second half (newer)', score(settled.slice(half), 4));
})();
