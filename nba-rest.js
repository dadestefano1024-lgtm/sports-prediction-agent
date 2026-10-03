'use strict';
/**
 * Does rest matter to an NBA BET, or only to the players?
 *
 * CHECKED: increment-test.js (the same question for football, where crude rest
 * buckets and the famous west-coast-early-kickoff angle both came back null and
 * the travelling team actually beat the line), calibrate-sport.js (built the
 * 1,231-game season this reads), reach.js (what reaches a pick).
 *
 * The football answer was that rest and travel matter to the players and are
 * already in the price, so there is nothing left to win. Basketball has a much
 * stronger prior -- a back-to-back is a genuinely large, well documented effect
 * and teams play 82 games -- but "well documented" is precisely why it may be
 * fully priced. The only question that pays is whether the market UNDER-prices
 * it, and that is a measurement.
 *
 * Rest is derived from each team's own game sequence in the season, so a
 * back-to-back means the team played the previous calendar day.
 *
 * Three gates, as everywhere else: the effect must show in more than one bucket,
 * hold direction across the season, and clear 2.5 SD.
 *
 * Run: node nba-rest.js
 */
const fs = require('fs');

const rows = JSON.parse(fs.readFileSync('./cal-nba-rows.json', 'utf8'))
  .filter(r => r.home && r.away)
  .sort((a, b) => a.date.localeCompare(b.date));

const dayOf = (d) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6));
const DAY = 86400000;

// Each team's game days, in order, so rest is the gap to the previous one.
const played = new Map();
for (const r of rows) {
  for (const t of [r.home, r.away]) {
    if (!played.has(t)) played.set(t, []);
    played.get(t).push(dayOf(r.date));
  }
}
for (const v of played.values()) v.sort((a, b) => a - b);

/** Days since this team's previous game, and games in the last 4 and 5 days. */
function restFor(team, day) {
  const days = played.get(team) || [];
  const i = days.indexOf(day);
  const prev = days.filter(d => d < day);
  const gap = prev.length ? (day - prev[prev.length - 1]) / DAY : null;
  const inLast = (n) => days.filter(d => d >= day - n * DAY && d <= day).length;
  return { gap, in4: inLast(3), in5: inLast(4), idx: i };
}

for (const r of rows) {
  const d = dayOf(r.date);
  r.hr = restFor(r.home, d);
  r.ar = restFor(r.away, d);
}

const usable = rows.filter(r => r.hr.gap !== null && r.ar.gap !== null);
console.log(`${usable.length} games with a known rest gap for both sides, of ${rows.length}\n`);

const b2b = (x) => x.gap === 1;
const settleClose = (r, side) => {
  const c = r.margin + r.close;                 // >0 home covers
  if (Math.abs(c) < 1e-9) return 0;
  return ((side > 0) === (c > 0)) ? 1 : 0;
};
const rate = (set, sideOf) => {
  const bets = set.filter(r => sideOf(r) !== 0);
  if (!bets.length) return null;
  const w = bets.reduce((s, r) => s + settleClose(r, sideOf(r)), 0);
  const p = w / bets.length;
  return { w, n: bets.length, p, z: (p - 0.5) / Math.sqrt(0.25 / bets.length) };
};
const fm = (r) => r ? `${r.w}-${r.n - r.w}  ${(r.p * 100).toFixed(1)}%  n=${r.n}  ${r.z.toFixed(2)} SD` : '--';

console.log('HOW OFTEN DOES EACH SITUATION HAPPEN');
console.log('  home on a back-to-back : ' + usable.filter(r => b2b(r.hr)).length);
console.log('  away on a back-to-back : ' + usable.filter(r => b2b(r.ar)).length);
console.log('  both on a back-to-back : ' + usable.filter(r => b2b(r.hr) && b2b(r.ar)).length);
console.log('  only away on one       : ' + usable.filter(r => b2b(r.ar) && !b2b(r.hr)).length);
console.log('  only home on one       : ' + usable.filter(r => b2b(r.hr) && !b2b(r.ar)).length);
console.log('');

console.log('1. IS THE BACK-TO-BACK ALREADY IN THE LINE?');
console.log('   fade the tired side AT THE CLOSING NUMBER. If the market has it priced,');
console.log('   this is a coin flip. If it under-prices it, this wins.\n');
const onlyAway = usable.filter(r => b2b(r.ar) && !b2b(r.hr));
const onlyHome = usable.filter(r => b2b(r.hr) && !b2b(r.ar));
console.log('   away is tired, back HOME      : ' + fm(rate(onlyAway, () => 1)));
console.log('   home is tired, back AWAY      : ' + fm(rate(onlyHome, () => -1)));
const either = [...onlyAway, ...onlyHome];
console.log('   combined, fade the tired side : ' +
  fm(rate(either, (r) => b2b(r.ar) ? 1 : -1)));
console.log('   control, back HOME everywhere : ' + fm(rate(usable, () => 1)));
console.log('');

console.log('2. THE SAME, BY SEASON MONTH  (combined, fade the tired side)');
const byMonth = {};
for (const r of either) (byMonth[r.date.slice(0, 6)] = byMonth[r.date.slice(0, 6)] || []).push(r);
for (const m of Object.keys(byMonth).sort()) {
  console.log('   ' + m + '  ' + fm(rate(byMonth[m], (r) => b2b(r.ar) ? 1 : -1)));
}
console.log('');

console.log('3. DOES A TIRED TEAM MAKE THE GAME LOWER-SCORING THAN THE MARKET THINKS?');
const tot = usable.filter(r => Number.isFinite(r.closeTotal));
const resid = (set) => set.reduce((s, r) => s + (r.total - r.closeTotal), 0) / set.length;
const underRate = (set) => set.filter(r => r.total < r.closeTotal).length / set.length;
for (const [lab, set] of [
  ['neither tired', tot.filter(r => !b2b(r.hr) && !b2b(r.ar))],
  ['one side tired', tot.filter(r => b2b(r.hr) !== b2b(r.ar))],
  ['both tired', tot.filter(r => b2b(r.hr) && b2b(r.ar))],
]) {
  if (set.length < 25) { console.log('   ' + lab.padEnd(16) + 'too few (' + set.length + ')'); continue; }
  console.log('   ' + lab.padEnd(16) + 'mean total residual ' +
    (resid(set) >= 0 ? '+' : '') + resid(set).toFixed(2) +
    '   under hit ' + (underRate(set) * 100).toFixed(1) + '%   n=' + set.length);
}
console.log('');

console.log('4. HEAVIER FATIGUE — 3 games in 4 days, and 4 in 5');
for (const [lab, pick, side] of [
  ['away in a 3-in-4, back home', (r) => r.ar.in4 >= 3 && r.hr.in4 < 3, () => 1],
  ['home in a 3-in-4, back away', (r) => r.hr.in4 >= 3 && r.ar.in4 < 3, () => -1],
  ['away in a 4-in-5, back home', (r) => r.ar.in5 >= 4 && r.hr.in5 < 4, () => 1],
]) {
  const set = usable.filter(pick);
  if (set.length < 25) { console.log('   ' + lab.padEnd(30) + 'too few (' + set.length + ')'); continue; }
  console.log('   ' + lab.padEnd(30) + fm(rate(set, side)));
}
console.log('');

console.log('5. REST ADVANTAGE — back the better-rested side, at the close');
for (const edge of [1, 2, 3]) {
  const set = usable.filter(r => Math.abs(r.hr.gap - r.ar.gap) >= edge);
  if (set.length < 25) { console.log('   edge >= ' + edge + ' days: too few'); continue; }
  console.log('   edge >= ' + edge + ' days  ' +
    fm(rate(set, (r) => r.hr.gap > r.ar.gap ? 1 : -1)));
}
console.log('');
console.log('Break-even on a -110 bet is 52.4%. A coin flip here means the market');
console.log('has already priced the fatigue, which is the football answer and the');
console.log('null result to expect.');
