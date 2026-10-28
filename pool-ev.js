'use strict';
/**
 * The Pick 6 as a DOLLAR problem, not a probability problem.
 *
 * CHECKED: week-correlation.js (measured covers as independent, variance ratio
 * 0.97 -- which is why maximising each pick is right for P(6-0), and is exactly
 * the result that stops applying once the pot SPLITS), model.js cardOdds (the
 * probability of a perfect card), travel-test.js and nba-travel.js (the per-pick
 * edge), detectPoolRounding. Nothing here has ever modelled the FIELD. CLAUDE.md
 * says plainly "Only Danny knows the pool rules", and now he has said them:
 *
 *   ~300 entrants, six picks, 6-0 required, a push LOSES.
 *   The pot SPLITS between winners. It ROLLS OVER when nobody wins. $1,800/week.
 *
 * WHY THAT CHANGES THE OBJECTIVE. cardOdds maximises P(my card goes 6-0). With a
 * split pot the thing worth maximising is
 *
 *     E[$] = P(my card hits) * E[ pot / (winners) | my card hits ]
 *
 * and the second factor depends on WHO ELSE hits. Three hundred people picking
 * off the same thirteen frozen lines do not pick independently: they crowd onto
 * the same obvious sides. So conditional on a popular card hitting, many others
 * hit too and the pot divides. A card that avoids the crowd is worth more per
 * win even if it wins slightly less often. That trade has never been priced
 * here, and it needs no forecasting at all.
 *
 * WHAT IS MODELLED AND WHAT IS ASSUMED, because the field is the weak point:
 *   - Game margins: simulated from model.marginPmf centred on the MARKET line,
 *     which is the best estimate available. Pool picks are then settled against
 *     the POOL line with a push counted as a loss.
 *   - The field: I do not know how 300 people pick, so THREE different field
 *     models are run and the conclusion is only reported where all three agree.
 *     If the answer depends on the field model, that is the finding.
 *
 * Run: node pool-ev.js [trials]
 */
const fs = require('fs');
const model = require('./model');

const TRIALS = Number(process.argv[2]) || 40000;
const ENTRANTS = 300;
const WEEKLY = 1800;
const SIGMA = 13.2;          // NFL margin SD, measured
const CARD = 6;

// ---- the board: real week-7 pool lines and market numbers ------------------
const scored = JSON.parse(fs.readFileSync('../pool_scored7.json', 'utf8'));
const sheet = JSON.parse(fs.readFileSync('../pool_payload7.json', 'utf8')).lines;
const fx = new Map(JSON.parse(fs.readFileSync('../wk7.json', 'utf8')).map((f) => [f.id, f]));

const games = [];
for (const c of (scored.ranked || [])) {
  if (c.market !== 'spread') continue;
  if (games.some((g) => g.id === c.gameId)) continue;
  const s = sheet[c.gameId], f = fx.get(c.gameId);
  if (!s || !f || !Number.isFinite(c.homeMarketSpread)) continue;
  const bothLay = s.spread < 0 && s.awaySpread < 0;
  games.push({
    id: c.gameId, label: f.awayShort + ' @ ' + f.homeShort,
    market: c.homeMarketSpread, poolHome: s.spread, poolAway: s.awaySpread,
    home: f.homeShort, away: f.awayShort, bothLay,
    // the move, for the measured-edge strategy
    open: c.openSpread, move: c.spreadMovement,
  });
}
if (!games.length) throw new Error('no games with both a pool line and a market line');

// ---- every pickable side, with its probability of winning the pool leg -----
// A line of L for the home side predicts a home margin of -L; the pool pick
// wins when margin + poolLine > 0, and a push LOSES.
const sides = [];
for (const g of games) {
  const pmf = model.marginPmf({ mean: -g.market, sigma: SIGMA, sport: 'nfl', centre: 'mean' });
  // TWO CONVENTIONS, AND MIXING THEM INVERTS THE AWAY SIDE.
  //
  //   m + L     is the cover margin for HOME at the home line L
  //   -(m + L)  is the cover margin for AWAY *evaluated at the HOME line* --
  //             correct only when the sheet is mirrored
  //   A - m     is the cover margin for AWAY at its OWN line A, which is what
  //             a pool sheet actually posts and what a both-lay game requires
  //
  // The first cut used -(m + A): away side, away line. That computes the
  // OPPOSITE TICKET -- it put Cowboys -5 at 76.72%, which is the +5 side's
  // number. Same defect as the away picks that graded backwards earlier in this
  // app's history, in new code, from the same root cause.
  const probOver = (line, isHome) => {
    let p = 0;
    for (const [m, w] of pmf) {
      const cover = isHome ? (m + line) : (line - m);
      if (cover > 1e-9) p += w;
    }
    return p;
  };
  for (const which of ['home', 'away']) {
    const line = which === 'home' ? g.poolHome : g.poolAway;
    if (!Number.isFinite(line)) continue;
    sides.push({
      gameId: g.id, side: which, line, game: g,
      team: which === 'home' ? g.home : g.away,
      p: probOver(line, which === 'home'),
    });
  }
}
// attractiveness as the FIELD would see it: the bigger the win probability, the
// more entrants pile on. This is the crowding model and it is an assumption.
const byProb = sides.slice().sort((a, b) => b.p - a.p);

const pmfFor = new Map();
for (const g of games) {
  pmfFor.set(g.id, model.marginPmf({ mean: -g.market, sigma: SIGMA, sport: 'nfl', centre: 'mean' }));
}
const cumFor = new Map();
for (const [id, pmf] of pmfFor) {
  const rows = []; let acc = 0;
  for (const [m, w] of pmf) { acc += w; rows.push([m, acc]); }
  cumFor.set(id, rows);
}
const drawMargin = (id) => {
  const u = Math.random();
  const rows = cumFor.get(id);
  for (const [m, c] of rows) if (u <= c) return m;
  return rows[rows.length - 1][0];
};

const wins = (s, margin) => {
  // See probOver: the away side is settled at its OWN line, A - m, not -(m + A).
  const cover = s.side === 'home' ? (margin + s.line) : (s.line - margin);
  return cover > 1e-9;                      // a push LOSES
};

// ---- the field: three models, because I do not know the real one ----------
function buildField(kind) {
  const cards = [];
  for (let i = 0; i < ENTRANTS; i++) {
    let pick;
    if (kind === 'crowd') {
      // everyone leans on the most attractive sides, with noise: sample 6
      // distinct games weighted toward the top of byProb
      pick = sampleWeighted(byProb, CARD, 3.0);
    } else if (kind === 'identical') {
      // the extreme: everyone plays the top six
      pick = topSix(byProb);
    } else {
      // no crowding at all: a random side of six random games
      pick = sampleWeighted(sides.slice().sort(() => Math.random() - 0.5), CARD, 0);
    }
    cards.push(pick);
  }
  return cards;
}
function topSix(pool) {
  const out = [], used = new Set();
  for (const s of pool) {
    if (used.has(s.gameId)) continue;
    used.add(s.gameId); out.push(s);
    if (out.length === CARD) break;
  }
  return out;
}
/** Pick CARD distinct games, favouring the front of `pool` as `bias` rises. */
function sampleWeighted(pool, n, bias) {
  const out = [], used = new Set();
  let guard = 0;
  while (out.length < n && guard++ < 500) {
    const u = Math.random();
    const idx = bias > 0
      ? Math.floor(Math.pow(u, bias) * pool.length)
      : Math.floor(u * pool.length);
    const s = pool[Math.min(idx, pool.length - 1)];
    if (!s || used.has(s.gameId)) continue;
    used.add(s.gameId); out.push(s);
  }
  return out;
}

// ---- Danny's candidate strategies -----------------------------------------
const strategies = {
  'max probability': topSix(byProb),
  'measured edge': (() => {
    // the travel-curve six: move>=2 toward the side, least absorbed first
    const scoredSides = sides.map((s) => {
      const g = s.game;
      if (!Number.isFinite(g.open) || !Number.isFinite(g.move) || Math.abs(g.move) < 2) return null;
      if (g.bothLay) return null;
      const toward = g.move < 0 ? 'home' : 'away';
      if (toward !== s.side) return null;
      const travel = (g.poolHome - g.open) / g.move;
      const q = model.travelProb({ movePts: g.move, travel, follow: true });
      return q && q.measured ? { s, p: q.p } : null;
    }).filter(Boolean).sort((a, b) => b.p - a.p);
    const out = topSix(scoredSides.map((x) => x.s));
    // fill from probability if the measured set is short -- the pool needs six
    for (const s of byProb) {
      if (out.length >= CARD) break;
      if (out.some((x) => x.gameId === s.gameId)) continue;
      out.push(s);
    }
    return out;
  })(),
  'contrarian': (() => {
    // the six least-popular sides that still clear a floor, so this is
    // "different" rather than "deliberately bad"
    const usable = sides.filter((s) => s.p >= 0.45 && !s.game.bothLay)
      .sort((a, b) => a.p - b.p);
    return topSix(usable);
  })(),
};

// ---- simulate --------------------------------------------------------------
function run(fieldKind) {
  const field = buildField(fieldKind);
  const names = Object.keys(strategies);
  const take = {}; const hits = {}; const splitWhenWon = {};
  for (const n of names) { take[n] = 0; hits[n] = 0; splitWhenWon[n] = 0; }
  let weeksNoWinner = 0;
  // rollover: carry the pot when nobody in the field (nor Danny) wins
  let carried = 0;
  for (let t = 0; t < TRIALS; t++) {
    const margins = new Map();
    for (const g of games) margins.set(g.id, drawMargin(g.id));
    const hit = (card) => card.length === CARD &&
      card.every((s) => wins(s, margins.get(s.gameId)));
    const fieldWinners = field.reduce((a, c) => a + (hit(c) ? 1 : 0), 0);
    const pot = WEEKLY + carried;
    let anyoneWon = fieldWinners > 0;
    const myHit = {};
    for (const n of names) { myHit[n] = hit(strategies[n]); if (myHit[n]) anyoneWon = true; }
    for (const n of names) {
      if (!myHit[n]) continue;
      hits[n]++;
      const share = pot / (fieldWinners + 1);
      take[n] += share;
      splitWhenWon[n] += fieldWinners + 1;
    }
    if (!anyoneWon) { carried = pot; weeksNoWinner++; } else { carried = 0; }
  }
  return { take, hits, splitWhenWon, weeksNoWinner, field };
}

const pc = (x) => (x * 100).toFixed(2) + '%';
console.log('');
console.log('PICK 6 AS A DOLLAR PROBLEM');
console.log('  ' + games.length + ' games, ' + ENTRANTS + ' entrants, $' + WEEKLY +
  '/week, split between winners, rolls over when nobody wins.');
console.log('  ' + TRIALS.toLocaleString() + ' simulated weeks per field model.');
console.log('  Margins drawn from the market line; pool legs settled on the pool line, push LOSES.');

for (const kind of ['crowd', 'identical', 'random']) {
  const r = run(kind);
  console.log('');
  console.log('--- field model: ' + kind.toUpperCase() +
    (kind === 'crowd' ? ' (entrants crowd onto attractive sides -- the realistic one)'
      : kind === 'identical' ? ' (everyone plays the top six -- the extreme)'
      : ' (no crowding at all -- the control)') + ' ---');
  console.log('  weeks with no winner anywhere: ' + pc(r.weeksNoWinner / TRIALS) +
    '   (so the pot rolls that often)');
  console.log('');
  console.log('  strategy           hit rate    avg split when won    $ per week');
  for (const n of Object.keys(strategies)) {
    const hr = r.hits[n] / TRIALS;
    const avgSplit = r.hits[n] ? r.splitWhenWon[n] / r.hits[n] : 0;
    console.log('  ' + n.padEnd(18) + pc(hr).padStart(8) + '        ' +
      avgSplit.toFixed(2).padStart(6) + ' ways          $' +
      (r.take[n] / TRIALS).toFixed(2).padStart(8));
  }
}
console.log('');
console.log('THE SIX EACH STRATEGY PLAYS');
for (const [n, card] of Object.entries(strategies)) {
  console.log('  ' + n + ':');
  for (const s of card) {
    console.log('    ' + (s.team + ' ' + (s.line > 0 ? '+' : '') + s.line).padEnd(24) +
      pc(s.p) + '   ' + s.game.label);
  }
}
console.log('');
