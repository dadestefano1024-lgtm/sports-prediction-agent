'use strict';
/**
 * How much of the edge survives when the frozen number is only PARTWAY behind
 * the move?
 *
 * CHECKED: frozen-test.js (same frozen-rows.json, bets the OPEN), fade-the-move.js
 * (bets the CLOSE), stale-totals-pool.js (the totals version, rejected),
 * pool-math.js, stale-oos.js. Every one of them bets a single number -- the open
 * or the close. None sweeps the space between, and that space is where Danny
 * actually lives.
 *
 * WHY THIS MATTERS. CLAUDE.md records the edge as:
 *     moved-toward side at the OPEN      59.8% at move>=2
 *     moved-toward side at the CLOSE     50.7%
 *     "the edge is the NUMBER, not the side"
 * Danny's pool numbers are neither. They are posted Wednesday, after part of the
 * move has already happened: this week they sit 25%, 56% and 83% of the way from
 * the open to the current market. If the win rate falls off linearly in that
 * fraction we can price his actual numbers. If it collapses early, a number that
 * has absorbed most of the move is worth nothing and most of what I recommended
 * tonight was junk. Nothing in the repo answers which.
 *
 * Conventions, from fade-the-move.js so the two agree:
 *   open/close/line are the HOME spread, negative when the home side lays.
 *   margin is home score minus away score.
 *   home covers at L when margin + L > 0; away covers when -(margin + L) > 0.
 *   move = close - open. Negative = the market moved toward HOME.
 *   A PUSH IS A LOSS -- this pool's rule, and what the recorded table used.
 */
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('./frozen-rows.json', 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.rows || raw.games || []);

const BREAK_EVEN = 0.524;

/** Back the moved-toward side at a number `t` of the way from open to close. */
function run(t, minMove) {
  const bets = [];
  for (const r of rows) {
    const move = r.close - r.open;
    if (!Number.isFinite(move) || Math.abs(move) < minMove) continue;
    if (Math.abs(move) < 1e-9) continue;              // no move, no side to back
    const line = r.open + t * move;                   // the number he holds
    const backHome = move < 0;                        // money came in on home
    const cover = backHome ? (r.margin + line) : -(r.margin + line);
    bets.push({ won: cover > 0, season: r.year });    // a push (cover === 0) loses
  }
  const n = bets.length;
  if (!n) return null;
  const w = bets.filter((b) => b.won).length;
  const p = w / n;
  const sd = (p - 0.5) / Math.sqrt(0.25 / n);
  const bySeason = {};
  for (const b of bets) {
    bySeason[b.season] = bySeason[b.season] || { n: 0, w: 0 };
    bySeason[b.season].n++;
    if (b.won) bySeason[b.season].w++;
  }
  return { n, p, sd, bySeason };
}

const pc = (x) => (x * 100).toFixed(1) + '%';
const TRAVELS = [0, 0.25, 0.5, 0.75, 1];
const BUCKETS = [
  ['any move', 0.5],
  ['move >=2', 2],
  ['move >=3', 3],
  ['move >=4', 4],
];

console.log('');
console.log('HOLDING A NUMBER PART OF THE WAY FROM THE OPEN TO THE CLOSE');
console.log(rows.length + ' games, 2023-25, push = loss. Break-even in the pool is ' +
  pc(BREAK_EVEN) + '.');
console.log('');
console.log('  travel = how much of the move the number has already absorbed.');
console.log('  0% = he holds the opener (the measured edge). 100% = he holds the close.');
console.log('');

const hdr = '  bucket        n  ' + TRAVELS.map((t) => (t * 100) + '%').map((s) => s.padStart(8)).join('');
console.log(hdr);
console.log('  ' + '-'.repeat(hdr.length - 2));
const grid = {};
for (const [name, mm] of BUCKETS) {
  const cells = TRAVELS.map((t) => run(t, mm));
  grid[name] = cells;
  const n = cells[0] ? cells[0].n : 0;
  console.log('  ' + name.padEnd(10) + String(n).padStart(5) + '  ' +
    cells.map((c) => (c ? pc(c.p) : '  --  ').padStart(8)).join(''));
}
console.log('');
console.log('  the same rows as SD against 50%:');
for (const [name] of BUCKETS) {
  console.log('  ' + name.padEnd(10) + '       ' +
    grid[name].map((c) => (c ? (c.sd >= 0 ? '+' : '') + c.sd.toFixed(2) : ' -- ').padStart(8)).join(''));
}

// --- gate 2: every season the same direction -------------------------------
console.log('');
console.log('GATE 2 -- does every season agree, at each travel point? (move >=2)');
console.log('');
console.log('  travel   2023            2024            2025            verdict');
for (const t of TRAVELS) {
  const r = run(t, 2);
  if (!r) continue;
  const seasons = ['2023', '2024', '2025'].map((y) => {
    const s = r.bySeason[y];
    return s ? { y, n: s.n, p: s.w / s.n } : null;
  });
  const all = seasons.filter(Boolean);
  const allUp = all.every((s) => s.p > 0.5);
  const allBE = all.every((s) => s.p > BREAK_EVEN);
  console.log('  ' + ((t * 100) + '%').padStart(5) + '    ' +
    all.map((s) => (pc(s.p) + ' (' + s.n + ')').padEnd(16)).join('') +
    (allBE ? 'all clear break-even' : allUp ? 'all above 50% only' : 'SEASONS DISAGREE'));
}

// --- the practical question -------------------------------------------------
console.log('');
console.log('WHAT THIS WEEK\'S THREE ACTUALLY PRICE AT');
console.log('  interpolating the measured curve above at each pick\'s own travel.');
console.log('');
const picks = [
  ['Falcons +4', 2.0, 0.25],
  ['Raiders +5', 4.5, 0.56],
  ['Cardinals +5', 3.0, 0.83],
];
const bucketFor = (mv) => mv >= 4 ? 'move >=4' : mv >= 3 ? 'move >=3' : mv >= 2 ? 'move >=2' : 'any move';
for (const [label, mv, trav] of picks) {
  const name = bucketFor(mv);
  const cells = grid[name];
  // linear between the two travel points either side
  let lo = 0;
  while (lo < TRAVELS.length - 2 && TRAVELS[lo + 1] < trav) lo++;
  const t0 = TRAVELS[lo], t1 = TRAVELS[lo + 1];
  const p0 = cells[lo] && cells[lo].p, p1 = cells[lo + 1] && cells[lo + 1].p;
  const p = (Number.isFinite(p0) && Number.isFinite(p1))
    ? p0 + (p1 - p0) * ((trav - t0) / (t1 - t0)) : null;
  console.log('  ' + label.padEnd(14) + 'move ' + mv.toFixed(1) + ', ' +
    (trav * 100).toFixed(0) + '% absorbed   ->  ' +
    (p === null ? '--' : pc(p)) + '  (' + name + ')' +
    (p !== null && p > BREAK_EVEN ? '   clears break-even' : '   BELOW break-even'));
}
console.log('');
