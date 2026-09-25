'use strict';
/**
 * Does each thing the app claims to use actually change the answer?
 *
 * CHECKED: deadfields.js (string-matches field names in the page, which answers
 * "is the name mentioned", not "does it move the number" — that is the check
 * that missed detectPoolRounding scoring movement as a rounding failure).
 *
 * The method is perturbation. Take the real card, change ONE input across a
 * plausible range, and see whether the win probability, the grade, or which six
 * get picked changes at all. An input that moves nothing under any perturbation
 * is not being scored, whatever the code looks like.
 *
 * Run:  node reach.js <pool-lines.json> <pool-response.json>
 */
const fs = require('fs');
const model = require('./model');

const lines = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).lines || {};
const resp = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const gm = {};
for (const g of (resp.games || [])) gm[g.id] = g;

// Rebuild the card the way the server does, with an override hook so one input
// can be moved at a time.
function build(over = {}) {
  const candidates = [], sample = [];
  for (const [id, v0] of Object.entries(lines)) {
    const g0 = gm[id];
    if (!g0) continue;
    const v = { ...v0, ...(over.line ? over.line(v0, g0) : {}) };
    const g = { ...g0, ...(over.game ? over.game(g0) : {}) };
    const [awayTeam, homeTeam] = g.matchup.split(' @ ');
    const e = model.poolEdge({
      sport: over.sport || 'nfl',
      poolSpread: v.spread, poolAwaySpread: v.awaySpread,
      marketSpread: g.marketSpread, poolTotal: v.total, marketTotal: g.marketTotal,
      homeTeam, awayTeam,
    });
    const mirrored = !Number.isFinite(v.awaySpread) ||
      Math.abs(v.awaySpread - (-v.spread)) < 1e-9;
    if (mirrored && Number.isFinite(v.spread) && Number.isFinite(g.marketSpread)) {
      sample.push({ poolLine: v.spread, marketLine: g.marketSpread });
    }
    if (e.spread) candidates.push({ ...e.spread, market: 'spread', gameId: id,
      matchup: g.matchup, homeMarketSpread: g.marketSpread });
    if (e.total) candidates.push({ ...e.total, market: 'total', gameId: id, matchup: g.matchup });
  }
  const rounding = model.detectPoolRounding(sample);
  for (const c of candidates) {
    c.grade = model.gradePoolPick(c);
    if (over.headwind) c.headwind = over.headwind(c);
    if (over.noPosted) continue;
    if (c.market !== 'spread' || !rounding.rounds) continue;
    if (!Number.isFinite(c.homeLine) || !Number.isFinite(c.homeMarketSpread)) continue;
    const mv = model.movementSincePosted({ poolLine: c.homeLine, marketLine: c.homeMarketSpread });
    if (!mv) continue;
    const backingFav = (c.side === 'home') === (c.homeMarketSpread < 0);
    c.movedSincePosted = { ...mv, helpsThisSide: mv.direction === 'none' ? null
      : (mv.direction === 'favourite') === backingFav };
  }
  const six = model.rankPoolPicks(candidates, 6);
  return {
    rounds: rounding.rounds,
    six: six.map(b => b.pick).join(' | '),
    probs: candidates.map(c => c.winProb).join(','),
    grades: candidates.map(c => c.grade).join(','),
  };
}

const base = build();

function probe(name, over, note) {
  const r = build(over);
  const moved = [];
  if (r.probs !== base.probs) moved.push('win%');
  if (r.grades !== base.grades) moved.push('grade');
  if (r.six !== base.six) moved.push('the six');
  if (r.rounds !== base.rounds) moved.push('rounding verdict');
  const verdict = moved.length ? 'MOVES ' + moved.join(' + ') : 'moves NOTHING';
  console.log('  ' + name.padEnd(34) + verdict.padEnd(38) + (note || ''));
  return moved.length > 0;
}

console.log('PERTURBATION AUDIT — pool / Pick 6 decision path\n');
console.log('  baseline six: ' + base.six + '\n');

const inert = [];
const track = (n, ok) => { if (!ok) inert.push(n); };

console.log('  --- the line arithmetic ---');
track('your pool spread',
  probe('your pool spread', { line: v => ({ spread: Number.isFinite(v.spread) ? v.spread + 3 : v.spread }) }));
track('the market spread',
  probe('the market spread', { game: g => ({ marketSpread: Number.isFinite(g.marketSpread) ? g.marketSpread + 3 : g.marketSpread }) }));
track('your away number (both-lay)',
  probe('your away number (both-lay)', { line: v => ({ awaySpread: Number.isFinite(v.awaySpread) ? v.awaySpread - 2 : v.awaySpread }) }));
track('your pool total',
  probe('your pool total', { line: v => ({ total: Number.isFinite(v.total) ? v.total + 4 : v.total }) }));
track('the market total',
  probe('the market total', { game: g => ({ marketTotal: Number.isFinite(g.marketTotal) ? g.marketTotal + 4 : g.marketTotal }) }));
track('sport (key numbers + sigma)',
  probe('sport (key numbers + sigma)', { sport: 'nba' }, 'nba sigma, no NFL key numbers'));

console.log('\n  --- the tiebreaks ---');
let hw = 0;
track('open-to-now headwind',
  probe('open-to-now headwind', { headwind: () => {
    hw++; return { against: hw % 2 === 0, points: 1 + (hw % 4) };
  } }, 'varied per pick, so the ordering has something to bite on'));

// The fallback path: with the post-posting signal stripped, does the older
// open-to-now headwind still decide anything? If not, it is dead code that only
// LOOKS like a safety net for the weeks the sheet does not round.
let hw2 = 0;
track('headwind as the ONLY tiebreak',
  probe('headwind as the ONLY tiebreak',
    { headwind: () => { hw2++; return { against: hw2 % 2 === 0, points: 1 + (hw2 % 4) }; },
      noPosted: true },
    'post-posting movement suppressed'));
track('movement since posting',
  probe('movement since posting', { line: (v) => ({
    spread: Number.isFinite(v.spread) ? v.spread + Math.sign(v.spread || 1) : v.spread }) },
    'shifts every posted number a point'));

console.log('\n  --- the things the NFL tab writes about ---');
// Injected onto the game the way the server carries them, then the pool card is
// rebuilt. If the pick does not move, these are context, not inputs.
track('predicted score',
  probe('predicted score', { game: () => ({ predictedScore: { home: 40, away: 3 } }) },
    'a 37-point blowout forced onto every game'));
track('injuries (players out)',
  probe('injuries (players out)', { game: () => ({ injuriesHome: 9, injuriesAway: 0 }) },
    'nine starters out on one side'));
track('weather',
  probe('weather', { game: () => ({ weather: { tempF: 4, windMph: 40, precip: 'snow' } }) },
    '40mph wind and snow'));
track('efficiency / situation flags',
  probe('efficiency / situation flags', { game: () => ({
    situationFlags: [{ kind: 'qb-out', note: 'starting QB ruled out' }],
    stats: { homeOffEff: 0.9, homeDefEff: 0.1, awayOffEff: 0.1, awayDefEff: 0.9 } }) },
    'lopsided ratings + a QB out'));

console.log('\n  --- the NFL tab verdict, probed on its own arguments ---');
const bases = { bookValuePts: 0, inProgress: false, hasLine: true, bookName: 'DK', side: 'home' };
const verdict = (o) => model.betRecommendation({ ...bases, ...o }).level;
const vbase = verdict({});
for (const [name, o] of [
  ['book value points', { bookValuePts: 2 }],
  ['in progress',       { inProgress: true }],
  ['no line',           { hasLine: false }],
]) {
  console.log('  ' + name.padEnd(34) + (verdict(o) !== vbase ? 'MOVES the verdict' : 'moves NOTHING'));
}
console.log('  ' + 'anything else'.padEnd(34) +
  'not an argument — betRecommendation takes only these');

console.log('\n' + '='.repeat(78));
if (inert.length) {
  console.log('INERT in the pool decision (' + inert.length + '):');
  for (const n of inert) console.log('  - ' + n);
} else {
  console.log('Every probed input moved the pool decision.');
}
