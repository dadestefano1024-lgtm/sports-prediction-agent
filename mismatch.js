// Do stronger teams win by more? Measured, not fitted.
//
// The run line pricing needs P(won by 2 or more | this side won) as a function
// of how likely that side was to win at all. Fitting that to a ten-game slate
// of market prices moved the headline answer by six percentage points, which is
// far too much weight for far too little data.
//
// So measure it on the season instead. Every completed game gives a winner and
// a margin. Season win percentage for both teams comes out of the same games —
// no extra source — and log5 turns the pair into a pre-game win probability.
// Bucket by that probability, and the conditional falls out of ~2,000 games
// rather than out of ten prices.
//
// Two passes: the first collects results and builds records, the second scores
// each game against the records. Records include the game being scored, which
// biases a winner's record slightly upward; with 160-odd games each the effect
// is under a percentage point and it applies equally across buckets.
//
// Run: node mismatch.js [sport] [days]

const SPORT = process.argv[2] || 'mlb';
const DAYS = Number(process.argv[3] || 150);
const PATHS = { mlb: 'baseball/mlb', nhl: 'hockey/nhl' };

async function getJson(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
function stamp(back) {
  const d = new Date(Date.UTC(2026, 7, 23));
  d.setUTCDate(d.getUTCDate() - back);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function readScore(c) {
  const raw = c && (typeof c.score === 'object' ? (c.score && c.score.value) : c.score);
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

(async () => {
  const results = [];
  const rec = new Map();   // team id -> {w, l}

  const dates = []; for (let i = 1; i <= DAYS; i++) dates.push(stamp(i));
  for (let i = 0; i < dates.length; i += 8) {
    const boards = await Promise.all(dates.slice(i, i + 8).map(d =>
      getJson(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[SPORT]}/scoreboard?dates=${d}`).catch(() => null)));
    for (const b of boards) {
      if (!b) continue;
      for (const ev of b.events || []) {
        const c = (ev.competitions || [])[0];
        if (!c || !(c.status && c.status.type && c.status.type.completed)) continue;
        const cs = c.competitors || []; if (cs.length !== 2) continue;
        const home = cs.find(x => x.homeAway === 'home');
        const away = cs.find(x => x.homeAway === 'away');
        if (!home || !away || !home.team || !away.team) continue;
        const hs = readScore(home), as = readScore(away);
        if (hs === null || as === null || hs === as) continue;

        const hId = home.team.id, aId = away.team.id;
        for (const id of [hId, aId]) if (!rec.has(id)) rec.set(id, { w: 0, l: 0 });
        if (hs > as) { rec.get(hId).w++; rec.get(aId).l++; }
        else { rec.get(aId).w++; rec.get(hId).l++; }

        results.push({ hId, aId, margin: Math.abs(hs - as), homeWon: hs > as });
      }
    }
  }

  const winPct = (id) => {
    const r = rec.get(id);
    if (!r || r.w + r.l < 20) return null;
    return r.w / (r.w + r.l);
  };
  // log5: the classic pairing of two win percentages into a head-to-head.
  const log5 = (a, b) => (a * (1 - b)) / (a * (1 - b) + b * (1 - a));

  // Bucket each game by the WINNER's pre-game probability of winning.
  const buckets = [
    { lo: 0.00, hi: 0.40, label: 'winner was <40% to win' },
    { lo: 0.40, hi: 0.45, label: 'winner was 40-45%' },
    { lo: 0.45, hi: 0.50, label: 'winner was 45-50%' },
    { lo: 0.50, hi: 0.55, label: 'winner was 50-55%' },
    { lo: 0.55, hi: 0.60, label: 'winner was 55-60%' },
    { lo: 0.60, hi: 1.01, label: 'winner was >60% to win' },
  ].map(b => ({ ...b, n: 0, twoPlus: 0, sumP: 0 }));

  let scored = 0, unscorable = 0;
  const points = [];
  for (const g of results) {
    const hp = winPct(g.hId), ap = winPct(g.aId);
    if (hp === null || ap === null) { unscorable++; continue; }
    const pHome = log5(hp, ap);
    const pWinner = g.homeWon ? pHome : 1 - pHome;
    const two = g.margin >= 2 ? 1 : 0;
    scored++;
    points.push({ p: pWinner, two });
    for (const b of buckets) {
      if (pWinner >= b.lo && pWinner < b.hi) { b.n++; b.twoPlus += two; b.sumP += pWinner; break; }
    }
  }

  console.log(`${SPORT.toUpperCase()} — ${results.length} completed games, ${scored} scorable, ${unscorable} skipped for thin records\n`);
  console.log('  P(won by 2 or more | this side won), by how likely that side was to win:');
  for (const b of buckets) {
    if (!b.n) { console.log(`    ${b.label.padEnd(26)} —`); continue; }
    console.log(`    ${b.label.padEnd(26)} ${String(b.n).padStart(5)} games   mean p ${(b.sumP / b.n).toFixed(3)}   ` +
      `P(2+) ${(b.twoPlus / b.n * 100).toFixed(2)}%`);
  }

  // Least squares line through the per-game points: P(2+) = base + k*(p - 0.5).
  const n = points.length;
  const mx = points.reduce((s, q) => s + (q.p - 0.5), 0) / n;
  const my = points.reduce((s, q) => s + q.two, 0) / n;
  let num = 0, den = 0;
  for (const q of points) { const dx = (q.p - 0.5) - mx; num += dx * (q.two - my); den += dx * dx; }
  const k = num / den;
  const base = my - k * mx;
  console.log(`\n  straight-line fit over all ${n} games:`);
  console.log(`    base (at a coin flip) = ${base.toFixed(4)}`);
  console.log(`    mismatch k            = ${k.toFixed(4)}`);
  console.log(`\n  compare: the table's unconditional P(2+) is ${(my).toFixed(4)} across these same games.`);
  console.log(`  a side that is 63% to win therefore covers 1.5 about ` +
    `${((base + k * 0.13) * 0.63 * 100).toFixed(1)}% of the time.`);
})();
