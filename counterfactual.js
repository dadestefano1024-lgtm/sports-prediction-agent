'use strict';
/**
 * What would actually change if the app ranked on the travel curve instead of
 * winProb? Answered on real weeks, with the real results where they exist.
 *
 * CHECKED: stale-read.js (same curve, same board read -- this adds the SIDE BY
 * SIDE against what the app really served, and the grading), travel-test.js
 * (the sweep itself), frozen-test.js, improvement.js. improvement.js compares
 * model variants on historical data; nothing compares the SHIPPED ranking to a
 * replacement on the weeks Danny actually played.
 *
 * Weeks 5 and 6 of 2026 are graded. frozen-rows.json stops at 2025, so these
 * two weeks are a genuine holdout -- and also twelve picks, which proves
 * nothing on its own. Printed as an anecdote and labelled as one. The evidence
 * is the 690-game sweep; this is the "what changes on screen" answer.
 */
const https = require('https');
const HOST = 'sports-prediction-agent.onrender.com';

const req = (m, p, b) => new Promise((res, rej) => {
  const data = b ? JSON.stringify(b) : null;
  const r = https.request({ host: HOST, path: p, method: m,
    headers: Object.assign({ Accept: 'application/json' },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    (s) => { let x = ''; s.on('data', (c) => { x += c; });
      s.on('end', () => { try { res(JSON.parse(x)); } catch (e) { rej(new Error('status ' + s.statusCode)); } }); });
  r.on('error', rej); r.setTimeout(180000, () => r.destroy(new Error('timeout')));
  if (data) r.write(data); r.end();
});
const espn = (u) => new Promise((res, rej) => {
  https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('status ' + r.statusCode)); } });
  }).on('error', rej);
});

// the curve, copied from stale-read.js -- see travel-test.js to regenerate
const TRAVEL = [0, 0.25, 0.5, 0.75, 1];
const CURVE = { 4: [0.679, 0.625, 0.607, 0.554, 0.518], 3: [0.660, 0.617, 0.606, 0.574, 0.532],
                2: [0.598, 0.569, 0.563, 0.540, 0.517], 0: [0.550, 0.540, 0.520, 0.509, 0.501] };
const GATE_THIN = 0.75;
function measuredProb(move, travel) {
  const mv = Math.abs(move);
  if (!Number.isFinite(mv) || mv < 0.5) return null;
  if (!Number.isFinite(travel) || travel > 1.02) return null;   // past the market: not measured
  if (travel > GATE_THIN) return null;                          // seasons disagree past here
  const row = CURVE[mv >= 4 ? 4 : mv >= 3 ? 3 : mv >= 2 ? 2 : 0];
  const t = Math.max(0, travel);
  let i = 0;
  while (i < TRAVEL.length - 2 && TRAVEL[i + 1] < t) i++;
  const f = (t - TRAVEL[i]) / (TRAVEL[i + 1] - TRAVEL[i]);
  return row[i] + (row[i + 1] - row[i]) * f;
}

/** Did this side cover its POOL number? push = loss. */
function graded(side, poolHome, poolAway, margin) {
  if (!Number.isFinite(margin)) return null;
  const line = side === 'home' ? poolHome : poolAway;
  if (!Number.isFinite(line)) return null;
  // home covers at L when margin + L > 0; the away number is already signed
  const cover = side === 'home' ? (margin + line) : (-margin + line);
  if (Math.abs(cover) < 1e-9) return 'push';        // a push LOSES this pool
  return cover > 0 ? 'win' : 'loss';
}

(async () => {
  for (const week of [5, 6, 7]) {
    const lr = await req('GET', '/api/pool/nfl/lines?week=' + week);
    const lines = (lr && (lr.lines || lr)) || {};
    if (!Object.keys(lines).length) { console.log('week ' + week + ': no lines'); continue; }
    const d = await req('POST', '/api/pool/nfl', { week, count: 6 });

    // final scores
    const sb = await espn('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' +
      '?week=' + week + '&seasontype=2&dates=2026');
    const fin = new Map();
    for (const e of (sb.events || [])) {
      const c = e.competitions[0];
      if (!c.status || !c.status.type || !c.status.type.completed) continue;
      const h = c.competitors.find((x) => x.homeAway === 'home');
      const a = c.competitors.find((x) => x.homeAway === 'away');
      const hs = Number(h.score), as = Number(a.score);
      if (Number.isFinite(hs) && Number.isFinite(as)) fin.set(e.id, hs - as);
    }

    // build every spread side with both rankings
    const seen = new Set(); const sides = [];
    for (const c of (d.ranked || [])) {
      if (c.market !== 'spread' || seen.has(c.gameId)) continue;
      seen.add(c.gameId);
      const s = lines[c.gameId]; if (!s) continue;
      const open = c.openSpread, mv = c.spreadMovement;
      const trav = (Number.isFinite(open) && Number.isFinite(mv) && Math.abs(mv) > 0.01)
        ? (s.spread - open) / mv : null;
      const toward = Number.isFinite(mv) ? (mv < 0 ? 'home' : mv > 0 ? 'away' : null) : null;
      const bothLay = s.spread < 0 && s.awaySpread < 0;
      const margin = fin.has(c.gameId) ? fin.get(c.gameId) : null;
      for (const side of ['home', 'away']) {
        sides.push({
          gameId: c.gameId, matchup: c.matchup, side, bothLay,
          pick: (c.matchup || '').split(' @ ')[side === 'home' ? 1 : 0] + ' ' +
            ((side === 'home' ? s.spread : s.awaySpread) > 0 ? '+' : '') +
            (side === 'home' ? s.spread : s.awaySpread),
          measured: (toward === side && !bothLay) ? measuredProb(mv, trav) : null,
          mv: Number.isFinite(mv) ? Math.abs(mv) : null, trav,
          fades: toward && toward !== side && Math.abs(mv) >= 2,
          result: graded(side, s.spread, s.awaySpread, margin),
        });
      }
    }

    const appSix = (d.best || []).slice(0, 6).map((b) => {
      const m = sides.find((x) => x.gameId === b.gameId && x.side === b.side);
      const s = lines[b.gameId];
      return {
        pick: b.pick, market: b.market, winProb: b.winProb,
        measured: m ? m.measured : null, fades: m ? m.fades : false, mv: m ? m.mv : null,
        result: b.market === 'spread' ? (m ? m.result : null)
          : graded('over', null, null, null),     // totals not graded here
      };
    });
    const newSix = sides.filter((x) => Number.isFinite(x.measured))
      .sort((a, b) => b.measured - a.measured).slice(0, 6);

    const tally = (arr) => {
      const g = arr.filter((x) => x.result === 'win' || x.result === 'loss' || x.result === 'push');
      const w = g.filter((x) => x.result === 'win').length;
      return g.length ? w + '-' + (g.length - w) + ' of ' + g.length + ' graded' : 'not graded';
    };

    console.log('');
    console.log('================ WEEK ' + week + ' ================');
    console.log('');
    console.log('  THE APP SERVED (ranked on winProb):');
    appSix.forEach((b, i) => console.log('    ' + (i + 1) + '. ' + String(b.pick).padEnd(24) +
      (b.winProb * 100).toFixed(1) + '%' +
      (b.fades ? '   FADES a ' + b.mv.toFixed(1) + '-pt move' : '') +
      (b.market === 'total' ? '   (total - rule rejected)' : '') +
      (b.result ? '   -> ' + b.result.toUpperCase() : '')));
    console.log('    spreads: ' + tally(appSix));
    console.log('    of these six: ' + appSix.filter((b) => b.fades).length + ' fade a 2pt+ move, ' +
      appSix.filter((b) => b.market === 'total').length + ' are totals, ' +
      appSix.filter((b) => !Number.isFinite(b.measured)).length + ' have no measured edge');
    console.log('');
    console.log('  THE TRAVEL CURVE WOULD SERVE:');
    if (!newSix.length) console.log('    nothing clears the gates');
    newSix.forEach((x, i) => console.log('    ' + (i + 1) + '. ' + x.pick.padEnd(24) +
      (x.measured * 100).toFixed(1) + '%   ' + x.mv.toFixed(1) + '-pt move, ' +
      (x.trav * 100).toFixed(0) + '% absorbed' +
      (x.result ? '   -> ' + x.result.toUpperCase() : '')));
    console.log('    spreads: ' + tally(newSix));
    const kept = newSix.filter((x) => appSix.some((b) => b.pick === x.pick)).map((x) => x.pick);
    console.log('');
    console.log('    same in both: ' + (kept.length ? kept.join(', ') : 'none') +
      '   (' + kept.length + ' of ' + newSix.length + ')');
    if (newSix.length < 6) {
      console.log('    only ' + newSix.length + ' clear the gates, so ' + (6 - newSix.length) +
        ' slots have no measured edge either way');
    }
  }
  console.log('');
})().catch((e) => { console.error(e.message); process.exit(1); });
