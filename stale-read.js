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

/**
 * THE MISSING PIECE, measured by travel-test.js on the same 690 games.
 *
 * CLAUDE.md records the edge at two points only -- the moved-toward side at the
 * OPEN (59.8% at move>=2) and the same bet at the CLOSE (50.7%) -- and concludes
 * "the edge is the NUMBER, not the side". Danny's pool numbers are at neither.
 * They are posted Wednesday, after part of the move, so the real question is
 * what a PARTLY absorbed number is worth. Nothing here measured that until now.
 *
 * Rows are the move bucket, columns are how much of the move the held number has
 * already absorbed (0% = he holds the opener, 100% = he holds the current
 * market). Push counts as a LOSS throughout, which is this pool's rule.
 *
 * Regenerate with: node travel-test.js
 */
const TRAVEL = [0, 0.25, 0.5, 0.75, 1];
const CURVE = {
  4: [0.679, 0.625, 0.607, 0.554, 0.518],   //  56 games
  3: [0.660, 0.617, 0.606, 0.574, 0.532],   //  94
  2: [0.598, 0.569, 0.563, 0.540, 0.517],   // 174
  0: [0.550, 0.540, 0.520, 0.509, 0.501],   // 513, any move >= 0.5
};
/**
 * How strong the sample is at each travel point: SD against 50%, move>=2 row.
 * This project's bar is three gates and one of them is >=2.5 SD. ONLY the 0%
 * column clears it. Everything to the right is a point estimate that beats
 * break-even on a thinner sample, so the confidence prints beside the number
 * rather than letting a 56% read as settled.
 */
const CURVE_SD = [2.58, 1.82, 1.67, 1.06, 0.45];

/**
 * GATE 2, per travel point, move>=2, from travel-test.js:
 *     0%   56.1 / 56.9 / 64.7   all three seasons clear break-even
 *    25%   53.7 / 55.4 / 60.3   all three clear
 *    50%   53.7 / 55.4 / 58.8   all three clear
 *    75%   51.2 / 52.3 / 57.4   all above 50%, NOT all above break-even
 *   100%   46.3 / 52.3 / 54.4   SEASONS DISAGREE
 * so a number that has absorbed more than about three quarters of its move is
 * not something to bet on, whatever the pooled point estimate says.
 */
const GATE_OK = 0.5;      // every season clears break-even up to here
const GATE_THIN = 0.75;   // above 50% every season, but not break-even

/**
 * The measured probability for a side, by move size and how much is absorbed.
 *
 * Returns null rather than a number when the question is OUTSIDE what was
 * measured. The sweep covered travel 0 to 1 -- the opener through the current
 * market. A pool number PAST the market (travel > 1) is a number strictly worse
 * than what the books are showing, and clamping it to the 100% column quietly
 * priced six of this week's sides as if they sat exactly at the market when they
 * were a point or two the wrong side of it. Extrapolation that reads as a
 * measurement is the thing this file exists to avoid.
 */
function measuredProb(move, travel) {
  if (!Number.isFinite(move) || !Number.isFinite(travel)) return null;
  const mv = Math.abs(move);
  if (mv < 0.5) return null;                      // no move, no side to back
  if (travel > 1.02) return null;                 // worse than the market: not measured
  const row = CURVE[mv >= 4 ? 4 : mv >= 3 ? 3 : mv >= 2 ? 2 : 0];
  const t = Math.max(0, Math.min(1, travel));
  let i = 0;
  while (i < TRAVEL.length - 2 && TRAVEL[i + 1] < t) i++;
  const span = TRAVEL[i + 1] - TRAVEL[i];
  const f = span <= 0 ? 0 : (t - TRAVEL[i]) / span;
  return {
    p: row[i] + (row[i + 1] - row[i]) * f,
    sd: CURVE_SD[i] + (CURVE_SD[i + 1] - CURVE_SD[i]) * f,
    gate: t <= GATE_OK ? 'clears' : t <= GATE_THIN ? 'thin' : 'fails',
  };
}

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
        // The measured number applies only to the side the market moved TOWARD,
        // and only to spreads -- stale-totals-pool.js measured the totals
        // version at +0.55 SD with the seasons disagreeing, and found most of
        // what was left was just "always take the over". Rejected, so no
        // measured probability is offered on a total.
        const m = (toward === side) ? measuredProb(mv, trav) : null;
        rows.push({ game: matchup, market: 'spread', side, poolN, trav, bothLay,
          label: (parts[side === 'home' ? 1 : 0] || side) + ' ' + sg(poolN),
          mv: Math.abs(mv), withMove: toward === side,
          gap: mkt === null ? null : +(eff - mkt).toFixed(2),
          measured: m && m.p, measuredSd: m && m.sd, gate: m && m.gate,
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

  // Rank on the MEASURED probability, not on the gap and not on winProb. The
  // gap was the first ranking and it is the wrong unit: it comes out at half a
  // point on every whole pool line, so it cannot separate a number still holding
  // three points of an unfinished move from one that has already caught up.
  const live = rows.filter((r) => r.withMove && r.mv >= SIGNAL_PTS && !r.bothLay)
    .sort((a, b) => ((b.measured || 0) - (a.measured || 0)) || (b.mv - a.mv));

  console.log('');
  console.log('WEEK ' + (d.week || week || '?') + '  --  ' + n + ' pool games, ' + rows.length + ' sides');
  console.log('');
  console.log('THE MARKET MOVED >=' + SIGNAL_PTS + ' PTS TOWARD THESE SIDES');
  console.log('  move: ESPN open -> ESPN now.  gap: your number vs the book consensus, push counted.');
  console.log('');
  console.log('  pick                  measured   app     your no.   move  absorbed');
  for (const r of live) {
    const pos = r.trav === null ? '--'
      : r.trav <= 0.02 ? 'the OPEN - fully stale'
      : r.trav >= 0.98 ? 'the CURRENT market - no edge left'
      : (r.trav * 100).toFixed(0) + '% of the way to now';
    const mark = !Number.isFinite(r.measured) ? ''
      : r.gate === 'clears' ? (r.measuredSd >= 2.5 ? ' **' : ' * ')
      : r.gate === 'thin' ? ' ? ' : ' x ';
    console.log('  ' + r.label.padEnd(20) + ' ' +
      (Number.isFinite(r.measured) ? (pct(r.measured) + mark) : '   --    ').padStart(10) +
      ' ' + pct(r.p).padStart(6) + '  ' +
      (r.gap === null ? '     --    '
        : ((r.gap > 0 ? '+' : '') + r.gap.toFixed(1)).padStart(4) + ' ' +
          (r.gap > 0 ? 'better' : r.gap < 0 ? 'WORSE ' : 'same  ')) +
      ' ' + r.mv.toFixed(1).padStart(5) + '  ' + pos);
  }

  console.log('');
  console.log('  measured = the travel curve. ** clears the 2.5 SD gate, * every season');
  console.log('  clears break-even, ? above 50% every season but not break-even, x the');
  console.log('  seasons disagree. A blank is a side the sweep never measured -- a total, or');
  console.log('  a number already WORSE than the market. The app column prices your number');
  console.log('  against the current line ASSUMED FAIR, which is why it sees none of this.');

  const ok = live.filter((r) => Number.isFinite(r.measured) && r.measured > BREAK_EVEN
    && (r.gate === 'clears' || r.gate === 'thin'));
  console.log('');
  console.log('  WORTH BETTING, ranked by the measured number:');
  if (!ok.length) {
    console.log('    nothing on the board. Every side either has no move behind it, or holds');
    console.log('    a number that has already absorbed the move.');
  }
  ok.forEach((r, i2) => {
    console.log('    ' + (i2 + 1) + '. ' + r.label.padEnd(20) + pct(r.measured).padStart(6) +
      (r.gate === 'thin' ? '  (thin)' : '        ') +
      '   ' + r.mv.toFixed(1) + '-pt move, ' + (r.trav * 100).toFixed(0) + '% absorbed');
  });
  if (ok.length < 6) {
    console.log('');
    console.log('    That is ' + ok.length + ' of the six the pool demands. The other ' +
      (6 - ok.length) + ' have no measured');
    console.log('    edge, so the card gets filled with sides that are there to make up the');
    console.log('    count -- which is worth knowing before you enter it.');
  }

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
