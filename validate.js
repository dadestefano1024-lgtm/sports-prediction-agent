// Does coverProbFromWinProb actually predict what happened?
//
// Everything else here checks internal consistency: that the run line agrees
// with the moneyline, that a fit recovers its own parameter. None of that says
// the formula describes real baseball or real hockey. This does.
//
// For every completed game, season records give both teams a win percentage,
// log5 turns those into a pre-game win probability, and the formula turns THAT
// into a predicted chance of covering 1.5. Then the actual result says whether
// it covered. Bucket the predictions and compare each bucket's predicted rate
// against the rate that occurred.
//
// A formula that is right has buckets that land on the diagonal. A formula that
// is systematically high or low will show it here rather than on somebody's
// money.
//
// Run: node validate.js [sport] [days]

const model = require('./model');

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
  const rec = new Map();
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
        if (hs > as) { rec.get(hId).w++; rec.get(aId).l++; } else { rec.get(aId).w++; rec.get(hId).l++; }
        results.push({ hId, aId, margin: hs - as });
      }
    }
  }

  const winPct = (id) => {
    const r = rec.get(id);
    return (!r || r.w + r.l < 20) ? null : r.w / (r.w + r.l);
  };
  const log5 = (a, b) => (a * (1 - b)) / (a * (1 - b) + b * (1 - a));

  // Every game gives two observations: the home side laying 1.5, and the away
  // side laying 1.5. Both are predictions the formula makes.
  const obs = [];
  for (const g of results) {
    const hp = winPct(g.hId), ap = winPct(g.aId);
    if (hp === null || ap === null) continue;
    const pHome = log5(hp, ap);
    obs.push({ p: model.coverProbFromWinProb({ sport: SPORT, winProb: pHome, line: -1.5 }), hit: g.margin >= 2 });
    obs.push({ p: model.coverProbFromWinProb({ sport: SPORT, winProb: 1 - pHome, line: -1.5 }), hit: -g.margin >= 2 });
  }

  console.log(`${SPORT.toUpperCase()} — ${results.length} games, ${obs.length} laying-1.5 observations`);
  console.log(`  conditional in use: base ${model.MARGIN_TABLES[SPORT].conditional.base},` +
    ` mismatch ${model.MARGIN_TABLES[SPORT].conditional.mismatch}\n`);

  const edges = [0, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 1];
  console.log('  predicted chance of covering -1.5   vs   what actually happened:');
  let totalPred = 0, totalHit = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const inB = obs.filter(o => o.p >= edges[i] && o.p < edges[i + 1]);
    if (inB.length < 25) continue;
    const pred = inB.reduce((s, o) => s + o.p, 0) / inB.length;
    const act = inB.filter(o => o.hit).length / inB.length;
    totalPred += pred * inB.length; totalHit += inB.filter(o => o.hit).length;
    const gap = (act - pred) * 100;
    const flag = Math.abs(gap) > 3 ? '  <-- off by more than 3 points' : '';
    console.log(`    ${(edges[i] * 100).toFixed(0).padStart(3)}-${(edges[i + 1] * 100).toFixed(0).padStart(3)}%: ` +
      `${String(inB.length).padStart(5)} bets   predicted ${(pred * 100).toFixed(1)}%   actual ${(act * 100).toFixed(1)}%   ` +
      `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}${flag}`);
  }
  const overallPred = totalPred / obs.length * 100;
  const overallAct = totalHit / obs.length * 100;
  console.log(`\n  overall: predicted ${overallPred.toFixed(2)}%, actual ${overallAct.toFixed(2)}%, ` +
    `gap ${(overallAct - overallPred >= 0 ? '+' : '')}${(overallAct - overallPred).toFixed(2)} points`);

  // A systematic gap is the thing that matters: it would tilt every price the
  // same way, which is exactly how the earlier artifacts happened.
  const se = Math.sqrt(0.25 / obs.length) * 100;
  console.log(`  one standard error on ${obs.length} observations is about ${se.toFixed(2)} points,` +
    ` so the gap is ${Math.abs(overallAct - overallPred) / se < 2 ? 'within noise' : 'REAL and needs fixing'}`);
})();
