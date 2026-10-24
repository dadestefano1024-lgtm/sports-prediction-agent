'use strict';
/**
 * Grade the travel-curve ranking on weeks 5 and 6, which are finished.
 *
 * counterfactual.js could not do this: POST /api/pool/nfl returns nothing for a
 * completed week, because poolEdge drops games that have started. So the board
 * is rebuilt here from the three things that still exist -- the pool lines in
 * the database, ESPN's open and closing numbers, and the final scores.
 *
 * WHAT THIS CANNOT SHOW: what the app actually served those weeks. That ranking
 * is gone and reconstructing winProb by hand would be my approximation of it,
 * not it. So this grades the NEW method only, and the comparison stays on week
 * 7 where both rankings are real.
 *
 * Twelve picks across two weeks proves nothing by itself. frozen-rows.json stops
 * at 2025, so 2026 is at least untouched by the sweep that produced the curve.
 */
const https = require('https');

const req = (m, p) => new Promise((res, rej) => {
  https.request({ host: 'sports-prediction-agent.onrender.com', path: p, method: m,
    headers: { Accept: 'application/json' } }, (s) => {
    let x = ''; s.on('data', (c) => { x += c; });
    s.on('end', () => { try { res(JSON.parse(x)); } catch (e) { rej(new Error('status ' + s.statusCode)); } });
  }).on('error', rej).end();
});
const espn = (u) => new Promise((res, rej) => {
  https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('status ' + r.statusCode)); } });
  }).on('error', rej);
});
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^(even|ev|pk|pick)$/i.test(s)) return 0;
  const n = Number(s.replace('+', ''));
  return Number.isFinite(n) ? n : null;
};

const TRAVEL = [0, 0.25, 0.5, 0.75, 1];
const CURVE = { 4: [0.679, 0.625, 0.607, 0.554, 0.518], 3: [0.660, 0.617, 0.606, 0.574, 0.532],
                2: [0.598, 0.569, 0.563, 0.540, 0.517], 0: [0.550, 0.540, 0.520, 0.509, 0.501] };
const GATE_THIN = 0.75;
function measuredProb(move, travel) {
  const mv = Math.abs(move);
  if (!Number.isFinite(mv) || mv < 0.5) return null;
  if (!Number.isFinite(travel) || travel > 1.02 || travel > GATE_THIN) return null;
  const row = CURVE[mv >= 4 ? 4 : mv >= 3 ? 3 : mv >= 2 ? 2 : 0];
  const t = Math.max(0, travel);
  let i = 0;
  while (i < TRAVEL.length - 2 && TRAVEL[i + 1] < t) i++;
  const f = (t - TRAVEL[i]) / (TRAVEL[i + 1] - TRAVEL[i]);
  return row[i] + (row[i + 1] - row[i]) * f;
}

(async () => {
  let allW = 0, allL = 0;
  for (const week of [5, 6]) {
    const lr = await req('GET', '/api/pool/nfl/lines?week=' + week);
    const lines = (lr && (lr.lines || lr)) || {};
    const sb = await espn('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' +
      '?week=' + week + '&seasontype=2&dates=2026');

    const rows = [];
    for (const e of (sb.events || [])) {
      const s = lines[e.id]; if (!s) continue;
      const c = e.competitions[0];
      const done = c.status && c.status.type && c.status.type.completed;
      const h = c.competitors.find((x) => x.homeAway === 'home');
      const a = c.competitors.find((x) => x.homeAway === 'away');
      const margin = done ? (Number(h.score) - Number(a.score)) : null;

      let open = null, close = null;
      try {
        const od = await espn('https://sports.core.api.espn.com/v2/sports/football/leagues/nfl' +
          '/events/' + e.id + '/competitions/' + e.id + '/odds');
        const items = od.items || [];
        const it = items.find((x) => !/live/i.test((x.provider && x.provider.name) || '')) || items[0];
        const hto = (it && it.homeTeamOdds) || {};
        open = num(hto.open && hto.open.pointSpread && hto.open.pointSpread.american);
        close = num(hto.current && hto.current.pointSpread && hto.current.pointSpread.american);
      } catch (err) { /* no odds for this game */ }

      if (!Number.isFinite(open) || !Number.isFinite(close)) {
        rows.push({ skip: 'no open/close', game: a.team.name + ' @ ' + h.team.name });
        continue;
      }
      const mv = close - open;
      const trav = Math.abs(mv) < 0.01 ? null : (s.spread - open) / mv;
      const toward = mv < 0 ? 'home' : mv > 0 ? 'away' : null;
      const bothLay = s.spread < 0 && s.awaySpread < 0;
      if (!toward || bothLay) continue;
      const p = measuredProb(mv, trav);
      if (!Number.isFinite(p)) continue;
      const line = toward === 'home' ? s.spread : s.awaySpread;
      const cover = toward === 'home' ? (margin + line) : (-margin + line);
      rows.push({
        pick: (toward === 'home' ? h.team.name : a.team.name) + ' ' + (line > 0 ? '+' : '') + line,
        game: a.team.name + ' @ ' + h.team.name,
        p, mv: Math.abs(mv), trav,
        result: margin === null ? null
          : Math.abs(cover) < 1e-9 ? 'push' : cover > 0 ? 'win' : 'loss',
      });
    }

    const live = rows.filter((r) => Number.isFinite(r.p)).sort((a, b) => b.p - a.p);
    const six = live.slice(0, 6);
    console.log('');
    console.log('=========== WEEK ' + week + ' ===========');
    const skipped = rows.filter((r) => r.skip);
    if (skipped.length) console.log('  (' + skipped.length + ' games had no open/close on ESPN)');
    console.log('  ' + live.length + ' sides cleared the gates; the pool wants 6');
    console.log('');
    for (const r of six) {
      console.log('    ' + r.pick.padEnd(22) + (r.p * 100).toFixed(1) + '%   ' +
        r.mv.toFixed(1) + '-pt move, ' + (r.trav * 100).toFixed(0) + '% absorbed   -> ' +
        (r.result ? r.result.toUpperCase() : 'not final'));
    }
    const g = six.filter((r) => r.result);
    const w = g.filter((r) => r.result === 'win').length;
    allW += w; allL += g.length - w;
    console.log('');
    console.log('    ' + w + '-' + (g.length - w) + '   (' +
      (g.length ? (100 * w / g.length).toFixed(0) + '%' : 'n/a') + ')' +
      (six.length < 6 ? '   -- only ' + six.length + ' of six had an edge' : ''));
  }
  console.log('');
  console.log('TWO WEEKS TOGETHER: ' + allW + '-' + allL +
    (allW + allL ? '   (' + (100 * allW / (allW + allL)).toFixed(0) + '%)' : ''));
  console.log('  n = ' + (allW + allL) + '. Far too small to mean anything on its own --');
  console.log('  the evidence is the 690-game sweep, this is a sanity check that the');
  console.log('  method can be run on a real week and graded at all.');
  console.log('');
})().catch((e) => { console.error(e.message); process.exit(1); });
