'use strict';
/**
 * The Pick 6 board, read against the ONLY signal that passed all three gates:
 * back the side the market moved toward, at a number the market has left behind.
 *
 * CHECKED: fade-the-move.js (the backtest that produced the buckets),
 * book-shop.js (reads a scored board the same way), poolEdge in server.js.
 * None of them answer the question this does -- whether Danny's FROZEN number
 * is still behind the move, or whether the move finished before he wrote it
 * down. Nothing else measures that, and without it a pick that merely has
 * momentum looks identical to a pick with an edge.
 *
 * Run: node stale-read.js [week]      (default: the current NFL week)
 *
 * -------------------------------------------------------------------------
 * TWO TRAPS THIS FILE EXISTS TO AVOID, both hit while writing it:
 *
 * 1. THERE ARE TWO "CURRENT" LINES. ESPN's core feed carries open AND current;
 *    the odds-API carries a multi-book consensus current. spreadMovement is
 *    ESPN-now minus ESPN-open. Differencing ESPN's open against the odds-API's
 *    current invents movement no book ever showed -- it read as an 8-of-13
 *    big-move week on the first pass and as a different set of numbers on the
 *    second. Move and travel are ESPN end to end; the "what can I get now" gap
 *    is the consensus, because that is the number a book would actually give.
 *
 * 2. A WHOLE POOL NUMBER IS WORTH HALF A POINT LESS THAN IT READS, because a
 *    push LOSES here. "Under 42" wins on 41 or fewer -- exactly what the
 *    market's "under 41.5" wins on, so the half point in the gap is not real.
 *    Every gap below is the effective one.
 *
 * And the structural limit, which no amount of care in this file fixes:
 * winProb reads the current line as FAIR and prices the pool number against
 * it, so it can never report the stale-line edge. The >=2pt bucket measured
 * 59.8% (+2.58 SD, n=174); winProb will sit near 51% on the same bet. The two
 * columns are different claims, not a disagreement -- which is why both print.
 */
const https = require('https');
const BASE = process.env.SPA_BASE || 'sports-prediction-agent.onrender.com';
const BREAK_EVEN = 0.524;        // a push loses, so 50% is not break-even
const SIGNAL_PTS = 2;            // the only bucket that cleared all three gates

const req = (method, path, body) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : null;
  const r = https.request({ host: BASE, path, method, headers: Object.assign(
    { Accept: 'application/json' },
    data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
  ) }, (s) => {
    let b = ''; s.on('data', (c) => { b += c; });
    s.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('status ' + s.statusCode)); } });
  });
  r.on('error', rej);
  r.setTimeout(180000, () => r.destroy(new Error('timeout')));
  if (data) r.write(data);
  r.end();
});

const sg = (n) => (Number.isFinite(n) ? ((n > 0 ? '+' : '') + n) : '--');
const pct = (p) => (Number.isFinite(p) ? (p * 100).toFixed(1) + '%' : ' -- ');

function readBoard(d, lines) {
  const prob = new Map();
  for (const o of (d.options || [])) prob.set(o.gameId + '|' + o.market + '|' + o.side, o.winProb);
  const byGame = new Map();
  for (const c of (d.ranked || [])) {
    if (!byGame.has(c.gameId)) byGame.set(c.gameId, {});
    byGame.get(c.gameId)[c.market] = c;
  }
  const rows = [];
  for (const [gid, m] of byGame) {
    const s = lines[gid];
    if (!s) continue;                                    // no pool line for this game
    const matchup = (m.spread || m.total || {}).matchup || gid;
    const parts = String(matchup).split(' @ ');
    const bothLay = s.spread < 0 && s.awaySpread < 0;     // the pool lays BOTH sides

    const sp = m.spread;
    if (sp && Number.isFinite(sp.openSpread) && Number.isFinite(sp.spreadMovement)) {
      const open = sp.openSpread, mv = sp.spreadMovement, cons = sp.homeMarketSpread;
      const toward = mv < 0 ? 'home' : mv > 0 ? 'away' : null;
      const trav = Math.abs(mv) < 0.01 ? null : (s.spread - open) / mv;
      for (const side of ['home', 'away']) {
        const poolN = side === 'home' ? s.spread : s.awaySpread;
        if (!Number.isFinite(poolN)) continue;
        const eff = Number.isInteger(poolN) ? poolN - 0.5 : poolN;
        const mkt = Number.isFinite(cons) ? (side === 'home' ? cons : -cons) : null;
        rows.push({ game: matchup, market: 'spread', side, poolN, trav, bothLay,
          label: (parts[side === 'home' ? 1 : 0] || side) + ' ' + sg(poolN),
          mv: Math.abs(mv), withMove: toward === side,
          gap: mkt === null ? null : +(eff - mkt).toFixed(2),
          p: prob.get(gid + '|spread|' + side) });
      }
    }
    const tt = m.total;
    if (tt && Number.isFinite(tt.openTotal) && Number.isFinite(tt.totalMovement)) {
      const open = tt.openTotal, mv = tt.totalMovement, cons = tt.marketLine;
      // money going IN raises a total, so a rising number is money on the OVER
      const toward = mv > 0 ? 'over' : mv < 0 ? 'under' : null;
      const trav = Math.abs(mv) < 0.01 ? null : (s.total - open) / mv;
      for (const side of ['over', 'under']) {
        // the over wants a LOWER number, the under a higher one, and both give
        // up half a point to the push
        const eff = side === 'over' ? s.total + 0.5 : s.total - 0.5;
        rows.push({ game: matchup, market: 'total', side, poolN: s.total, trav, bothLay: false,
          label: (side === 'over' ? 'Over ' : 'Under ') + s.total,
          mv: Math.abs(mv), withMove: toward === side,
          gap: Number.isFinite(cons)
            ? +(side === 'over' ? (cons - eff) : (eff - cons)).toFixed(2) : null,
          p: prob.get(gid + '|total|' + side) });
      }
    }
  }
  return rows;
}

(async () => {
  const week = Number(process.argv[2]) || undefined;
  const lineRes = await req('GET', '/api/pool/nfl/lines' + (week ? '?week=' + week : ''));
  const lines = (lineRes && (lineRes.lines || lineRes)) || {};
  const n = Object.keys(lines).length;
  if (!n) { console.log('No pool lines stored' + (week ? ' for week ' + week : '') + '.'); return; }

  const d = await req('POST', '/api/pool/nfl', week ? { week, count: 6 } : { count: 6 });
  const rows = readBoard(d, lines);
  if (!rows.length) { console.log('Board scored but no movement data on any game.'); return; }

  const live = rows.filter((r) => r.withMove && r.mv >= SIGNAL_PTS && !r.bothLay)
    .sort((a, b) => ((b.gap || 0) - (a.gap || 0)) || (b.mv - a.mv));

  console.log('');
  console.log('WEEK ' + (d.week || week || '?') + '  --  ' + n + ' pool games, ' + rows.length + ' sides');
  console.log('');
  console.log('THE MARKET MOVED >=' + SIGNAL_PTS + ' PTS TOWARD THESE SIDES');
  console.log('  move: ESPN open -> ESPN now.  gap: your number vs the book consensus, push counted.');
  console.log('');
  console.log('  pick                     win%       your no.     move   your sheet sits at');
  for (const r of live) {
    const pos = r.trav === null ? '--'
      : r.trav <= 0.02 ? 'the OPEN - fully stale'
      : r.trav >= 0.98 ? 'the CURRENT market - no edge left'
      : (r.trav * 100).toFixed(0) + '% of the way to now';
    console.log('  ' + r.label.padEnd(22) + '  ' + pct(r.p).padStart(6) + '   ' +
      (r.gap === null ? '     --     '
        : (sg(r.gap) + ' ' + (r.gap > 0 ? 'better' : r.gap < 0 ? 'WORSE ' : 'same  ')).padStart(12)) +
      '   ' + r.mv.toFixed(1) + '   ' + pos);
  }

  const both = live.filter((r) => r.gap > 0);
  console.log('');
  console.log('  BOTH HALVES (move behind it AND a number the books have left behind):');
  console.log('    ' + (both.map((r) => r.label).join(', ') || 'none this week'));
  console.log('  clears the ' + (BREAK_EVEN * 100).toFixed(1) + '% break-even on the app\'s own number:');
  console.log('    ' + (live.filter((r) => r.p > BREAK_EVEN).map((r) => r.label).join(', ') || 'NONE'));

  const faded = rows.filter((r) => !r.withMove && r.mv >= SIGNAL_PTS && !r.bothLay && r.p > BREAK_EVEN)
    .sort((a, b) => b.p - a.p);
  if (faded.length) {
    console.log('');
    console.log('  READS WELL BUT FADES A BIG MOVE -- the app ranks these up, the signal says no:');
    for (const r of faded) {
      console.log('    ' + r.label.padEnd(22) + pct(r.p) + '   against a ' + r.mv.toFixed(1) +
        '-pt move   (' + r.game + ')');
    }
  }
  const bl = rows.filter((r) => r.bothLay);
  if (bl.length) {
    console.log('');
    console.log('  BOTH-LAY SPREAD, skipped: ' + [...new Set(bl.map((r) => r.game))].join(', '));
    console.log('    the pool lays points on both sides, so the margin loses whichever you');
    console.log('    take. The TOTAL on that game is an ordinary bet and is still listed.');
  }
  console.log('');
})().catch((e) => { console.error(e.message); process.exit(1); });
