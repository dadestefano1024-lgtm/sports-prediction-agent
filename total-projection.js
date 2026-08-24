// If the projection says 5 and the line says 6.5, is the under a bet?
//
// It is the obvious question and it has never been tested here. The spread
// version of it has: three different inputs all landed indistinguishable from
// taking the market price. Totals were never checked, and there is no reason to
// assume the answer carries over — a total moves for weather and pace, a spread
// for opinion about who wins.
//
// So this replays exactly what the app does. For every NFL game in order, each
// team's last ten games give a scoring average and a conceded average; the
// projection is the same arithmetic projectFromScoringAverages performs; and
// the bet is the side of the market total that the projection disagrees with.
//
// nflverse supplies closing total and final score for every regular-season
// game back to 1999. No opening lines are needed — this is a question about the
// projection against the CURRENT number, not about staleness.
//
// RESULT: NEGATIVE. 6,672 games, 1999-2025.
//
//   disagreement >= 1    50.2%   5018 bets
//   disagreement >= 3    49.6%   2331 bets
//   disagreement >= 4    50.4%   1450 bets
//   disagreement >= 5    51.6%    838 bets   +0.90 SD
//   disagreement >= 7    52.8%    231 bets   +0.86 SD
//
// Break-even is 52.4%. Nothing clears it by as much as a standard error, and
// the era split is flat: 49.5%, 49.6%, 49.7% across three decades. Fading it is
// no better (49.6% at a four-point gap), and the control — always taking the
// over — is 49.6%, so the market total is not biased either.
//
// So a projected total of 5 against a line of 6.5 is not a signal. The
// projection is a description of recent scoring, and the market has already
// read the same box scores plus the things the projection cannot see.
//
// A WARNING ABOUT THE FIRST RUN OF THIS FILE. It reported 56.0% at a
// five-point gap and 64.9% at seven, on thousands of bets. All of it was one
// bug: Number('') is 0 and passes Number.isFinite, so 272 unplayed 2026
// fixtures entered as 0-0 finals — and the rolling averages then ate those
// zeros, dragging projected totals toward nothing until every bet was "under"
// against a real line, which duly won. The tell was the era split: two decades
// of 49% followed by a single season at 96.8%.
//
// That is the same falsy-zero trap this project has now hit three times: once
// on scores read as 0-10, once on blank pool inputs becoming a line of zero,
// and once here, in the test written to check the others.
//
// Run: node total-projection.js

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
  const [iSeason, iWeek, iType, iHome, iAway, iHomeScore, iAwayScore, iTotal] =
    ['season', 'week', 'game_type', 'home_team', 'away_team', 'home_score', 'away_score', 'total_line'].map(at);

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
    const hs = raw(f[iHomeScore]), as = raw(f[iAwayScore]), tot = raw(f[iTotal]);
    if (hs === null || as === null || tot === null) continue;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || !Number.isFinite(tot)) continue;
    games.push({
      season: Number(f[iSeason]), week: Number(f[iWeek]),
      home: f[iHome], away: f[iAway], hs, as, total: tot,
    });
  }
  games.sort((a, b) => a.season - b.season || a.week - b.week);
  console.log(`${games.length} regular-season games with a closing total and a final score`);
  console.log(`seasons ${games[0].season} to ${games[games.length - 1].season}\n`);

  // Rolling last-10 form, exactly the window the app uses.
  const form = new Map();   // team -> [{scored, allowed}]
  const push = (team, scored, allowed) => {
    if (!form.has(team)) form.set(team, []);
    const a = form.get(team);
    a.push({ scored, allowed });
    if (a.length > 10) a.shift();
  };
  const avg = (team) => {
    const a = form.get(team);
    if (!a || a.length < 10) return null;        // same bar: no projection on thin data
    return {
      scored: a.reduce((s, x) => s + x.scored, 0) / a.length,
      allowed: a.reduce((s, x) => s + x.allowed, 0) / a.length,
    };
  };

  const bets = [];
  for (const g of games) {
    const h = avg(g.home), a = avg(g.away);
    if (h && a) {
      // projectFromScoringAverages: home field advantage cancels out of a total.
      const expHome = (h.scored + a.allowed) / 2;
      const expAway = (a.scored + h.allowed) / 2;
      const projected = expHome + expAway;
      const actual = g.hs + g.as;
      if (Math.abs(actual - g.total) > 1e-9) {           // pushes excluded
        bets.push({
          season: g.season,
          gap: projected - g.total,                       // + means projection says OVER
          wonOver: actual > g.total,
        });
      }
    }
    push(g.home, g.hs, g.as);
    push(g.away, g.as, g.hs);
  }

  console.log(`${bets.length} games where both teams had ten prior games\n`);

  const run = (set, min) => {
    const sel = set.filter(b => Math.abs(b.gap) >= min);
    if (sel.length < 30) return null;
    let w = 0;
    for (const b of sel) {
      const backOver = b.gap > 0;
      if (backOver === b.wonOver) w++;
    }
    const rate = w / sel.length;
    return { w, l: sel.length - w, n: sel.length, rate,
             z: (rate - 0.5) / Math.sqrt(0.25 / sel.length) };
  };
  const show = (label, r) => {
    if (!r) { console.log(`    ${label.padEnd(24)} too few`); return; }
    console.log(`    ${label.padEnd(24)} ${String(r.w).padStart(4)}-${String(r.l).padStart(4)}  ` +
      `${(r.rate * 100).toFixed(1)}%  ${String(r.n).padStart(5)} bets  ` +
      `${r.z >= 0 ? '+' : ''}${r.z.toFixed(2)} SD${r.rate > 0.524 ? '   beats the vig' : ''}`);
  };

  console.log('  backing the side the PROJECTION disagrees with, at the market total:');
  for (const t of [0, 1, 2, 3, 4, 5, 7]) show(`disagreement >= ${t}`, run(bets, t));

  console.log('\n  and fading it, in case the projection is worth reading backwards:');
  for (const t of [2, 4]) {
    const sel = bets.filter(b => Math.abs(b.gap) >= t);
    if (sel.length < 30) continue;
    let w = 0;
    for (const b of sel) { const backOver = b.gap < 0; if (backOver === b.wonOver) w++; }
    console.log(`    fading, gap >= ${t}: ${(w / sel.length * 100).toFixed(1)}% on ${sel.length} bets`);
  }

  // A control: is the market total simply biased?
  const overs = bets.filter(b => b.wonOver).length;
  console.log(`\n  control — always taking the over: ${overs}-${bets.length - overs} ` +
    `(${(overs / bets.length * 100).toFixed(1)}%), which should be a coin flip`);

  // Split by era, because one stretch can say anything.
  console.log('\n  by era at a 3-point disagreement:');
  for (const [lo, hi] of [[1999, 2009], [2010, 2019], [2020, 2026]]) {
    const r = run(bets.filter(b => b.season >= lo && b.season <= hi), 3);
    show(`${lo}-${hi}`, r);
  }

  // How big do the disagreements get?
  const gaps = bets.map(b => Math.abs(b.gap)).sort((x, y) => x - y);
  console.log(`\n  disagreement size: median ${gaps[gaps.length >> 1].toFixed(1)}, ` +
    `90th ${gaps[Math.floor(gaps.length * 0.9)].toFixed(1)}, max ${gaps[gaps.length - 1].toFixed(1)} points`);
})();
