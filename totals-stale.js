// Does the stale-line rule work on TOTALS?
//
// It has been tested on spreads and it holds: backing the side the market moved
// toward, at the frozen opening number, went 60% across 2024 and 2025 with a
// clean control. The Pick 6 includes totals, the app flags them the same way,
// and nobody has ever checked whether the rule transfers.
//
// There is no reason to assume it does. A spread moves because opinion about
// who wins changes; a total moves because of weather, a kicker, a pace read.
// Different mechanism, possibly different behaviour.
//
// Harvests opening total, closing total and final combined score for 2024-25,
// then applies the identical rule: back the side the market moved toward, at
// the number it opened at.
//
// Run: node totals-stale.js

const fs = require('fs');

const OUT = './nfl-totals.json';

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
const readScore = (c) => {
  const raw = typeof c.score === 'object' ? (c.score && c.score.value) : c.score;
  return (raw === null || raw === undefined || raw === '') ? null : Number(raw);
};

(async () => {
  const cached = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { rows: [] };
  const rows = cached.rows;
  const seen = new Set(rows.map(r => r.id));

  for (const year of [2024, 2025]) {
    for (let week = 1; week <= 18; week++) {
      const board = await getJson(
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${year}&seasontype=2&week=${week}`);
      if (!board) continue;
      const pending = [];
      for (const ev of board.events || []) {
        if (seen.has(ev.id)) continue;
        const comp = (ev.competitions || [])[0];
        if (!comp || !(comp.status && comp.status.type && comp.status.type.completed)) continue;
        const cs = comp.competitors || [];
        if (cs.length !== 2) continue;
        const a = readScore(cs[0]), b = readScore(cs[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        pending.push({ id: ev.id, year, week, points: a + b });
      }
      for (let i = 0; i < pending.length; i += 6) {
        const batch = pending.slice(i, i + 6);
        const odds = await Promise.all(batch.map(g => getJson(
          `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${g.id}/competitions/${g.id}/odds`)));
        batch.forEach((g, j) => {
          const items = (odds[j] && odds[j].items) || [];
          const it = items.find(x => !/live/i.test((x.provider && x.provider.name) || '') &&
            x.open && x.open.total && x.current && x.current.total);
          if (!it) return;
          const open = num(it.open.total.american);
          const close = num(it.current.total.american);
          if (open === null || close === null) return;
          rows.push({ ...g, openTotal: open, closeTotal: close });
          seen.add(g.id);
        });
      }
      process.stdout.write(`\r  ${year} week ${week}: ${rows.length} games   `);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ rows }));
  console.log(`\n\n${rows.length} games with an opening total, a closing total and a final score\n`);

  const run = (set, minMove) => {
    let w = 0, l = 0, push = 0;
    for (const r of set) {
      const move = r.closeTotal - r.openTotal;
      if (Math.abs(move) < minMove) continue;
      // Back the side the market moved toward, at the OPENING number.
      // Total moved up -> the market wants the over -> take the over at the old
      // lower number.
      const backOver = move > 0;
      const diff = r.points - r.openTotal;
      if (Math.abs(diff) < 1e-9) push++;
      else if (backOver ? diff > 0 : diff < 0) w++;
      else l++;
    }
    const n = w + l;
    if (n < 15) return null;
    const rate = w / n;
    return { w, l, push, n, rate, z: (rate - 0.5) / Math.sqrt(0.25 / n) };
  };

  const show = (label, r) => {
    if (!r) { console.log(`    ${label.padEnd(26)} too few`); return; }
    console.log(`    ${label.padEnd(26)} ${String(r.w).padStart(3)}-${String(r.l).padStart(3)}` +
      `${r.push ? ` (${r.push}p)` : '     '}  ${(r.rate * 100).toFixed(1)}%  ${r.n} bets  ` +
      `${r.z >= 0 ? '+' : ''}${r.z.toFixed(2)} SD${r.rate > 0.524 ? '   beats the vig' : ''}`);
  };

  const y24 = rows.filter(r => r.year === 2024);
  const y25 = rows.filter(r => r.year === 2025);

  console.log('  TOTALS — backing the side the total moved toward, at the opening number:');
  console.log('  2025:');
  for (const t of [0.5, 1, 1.5, 2, 2.5]) show(`move >= ${t}`, run(y25, t));
  console.log('  2024:');
  for (const t of [0.5, 1, 1.5, 2, 2.5]) show(`move >= ${t}`, run(y24, t));
  console.log('  both seasons:');
  for (const t of [0.5, 1, 1.5, 2, 2.5]) show(`move >= ${t}`, run(rows, t));

  console.log('\n  and fading it, in case the effect runs the other way:');
  const fade = (set, minMove) => {
    let w = 0, l = 0;
    for (const r of set) {
      const move = r.closeTotal - r.openTotal;
      if (Math.abs(move) < minMove) continue;
      const backOver = move < 0;
      const diff = r.points - r.openTotal;
      if (Math.abs(diff) < 1e-9) continue;
      if (backOver ? diff > 0 : diff < 0) w++; else l++;
    }
    return w + l >= 15 ? { w, l, n: w + l, rate: w / (w + l) } : null;
  };
  for (const t of [1, 2]) {
    const f = fade(rows, t);
    if (f) console.log(`    fading, move >= ${t}: ${(f.rate * 100).toFixed(1)}% on ${f.n} bets`);
  }

  // Control: is the opening total simply too low or too high in general?
  let over = 0, under = 0;
  for (const r of rows) {
    const diff = r.points - r.openTotal;
    if (Math.abs(diff) < 1e-9) continue;
    if (diff > 0) over++; else under++;
  }
  console.log(`\n  control — always taking the over at the opening number: ${over}-${under} ` +
    `(${(over / (over + under) * 100).toFixed(1)}%), which should be a coin flip`);

  const moved = rows.filter(r => Math.abs(r.closeTotal - r.openTotal) >= 1).length;
  console.log(`  ${moved}/${rows.length} totals moved a point or more (${(moved / rows.length * 100).toFixed(0)}%)`);
})();
