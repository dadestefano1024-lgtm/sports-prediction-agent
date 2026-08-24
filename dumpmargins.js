// Dump the complete winning-margin table for a sport, as JS ready to paste.
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
  const counts = new Map();
  let games = 0;
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
        const x = readScore(cs[0]), y = readScore(cs[1]);
        if (x === null || y === null) continue;
        const mg = Math.abs(x - y); if (!mg) continue;
        games++; counts.set(mg, (counts.get(mg) || 0) + 1);
      }
    }
  }
  const keys = [...counts.keys()].sort((a, b) => a - b);
  const max = keys[keys.length - 1];
  const arr = [];
  for (let k = 1; k <= max; k++) arr.push(counts.get(k) || 0);
  const total = arr.reduce((a, b) => a + b, 0);
  console.log(`// ${SPORT}: ${games} completed games, ${DAYS} days back from 2026-08-23`);
  console.log(`  ${SPORT}: { games: ${total}, counts: [${arr.join(', ')}] },`);
  const one = arr[0] / total;
  console.log(`// P(margin = 1) = ${(one * 100).toFixed(2)}%   P(margin >= 2) = ${((1 - one) * 100).toFixed(2)}%`);
})();
