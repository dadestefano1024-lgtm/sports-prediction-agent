'use strict';
/**
 * Danny's Week 7 Pick 6 sheet -> the pool lines payload.
 *
 * Same shape as pool_week5.js / pool_week6.js: the sheet lists AWAY first in
 * every pair, which is CHECKED against the ESPN week-7 fixtures rather than
 * assumed, and the sheet's own numbers go in verbatim including awaySpread.
 *
 * ONE BOTH-LAY GAME this week, where the pool lays points on both sides and a
 * game decided inside the margin loses whichever side you take:
 *
 *   Bengals -2 / Ravens -2    total 49
 *
 * which is why awaySpread is sent from the sheet rather than mirrored. The
 * mirror would be +2 and wrong.
 *
 * The sheet carries 13 of the week's 14 games -- the Thursday Patriots @ Bears
 * has already been played and is not on it, so a Sunday-morning lock gives up
 * nothing this week. The unlined-fixture line below is expected to name it, and
 * naming anything ELSE means a pair failed to match.
 *
 * Every row is matched to a fixture before anything is sent: a swapped pair
 * silently reverses a spread, and that is the error that looks normal on screen.
 */
const fs = require('fs');

// away, home, away number, home number, total -- verbatim from the sheet.
const SHEET = [
  ['Steelers',   'Saints',      -4,  +4, 45],   // Sun 8:30am CDT
  ['Bengals',    'Ravens',      -2,  -2, 49],   // BOTH-LAY
  ['Browns',     'Titans',      -3,  +3, 38],
  ['Colts',      'Vikings',     +7,  -7, 42],
  ['Dolphins',   'Jets',        +5,  -5, 40],
  ['Giants',     'Texans',     +11, -11, 43],
  ['49ers',      'Falcons',     -4,  +4, 50],
  ['Buccaneers', 'Panthers',    +3,  -3, 45],
  ['Broncos',    'Cardinals',   -5,  +5, 44],   // Sun 3:05pm
  ['Packers',    'Lions',       +3,  -3, 54],   // Sun 3:25pm
  ['Rams',       'Raiders',     -5,  +5, 49],   // Sun 3:25pm
  ['Chiefs',     'Seahawks',    +3,  -3, 43],   // Sun 7:20pm
  ['Cowboys',    'Eagles',      -5,  +5, 45],   // Mon 7:15pm
];

const fixtures = JSON.parse(fs.readFileSync('wk7.json', 'utf8'));
const byPair = new Map(fixtures.map(f => [f.awayShort + '|' + f.homeShort, f]));

const lines = {};
const report = [];
const problems = [];

for (const [away, home, awayNum, homeNum, total] of SHEET) {
  const f = byPair.get(away + '|' + home);
  if (!f) { problems.push(`no week-7 fixture for ${away} @ ${home}`); continue; }
  if (lines[f.id]) { problems.push(`${away} @ ${home} matched a fixture already used`); continue; }
  lines[f.id] = { spread: homeNum, awaySpread: awayNum, total };
  const bothLay = (awayNum < 0 && homeNum < 0);
  const mirrored = (awayNum === -homeNum);
  if (!bothLay && !mirrored) {
    problems.push(`${away} ${awayNum} / ${home} ${homeNum} is neither mirrored nor both-lay`);
  }
  const sg = (n) => (n > 0 ? '+' : '') + n;
  report.push({
    id: f.id,
    game: `${f.awayShort} @ ${f.homeShort}`,
    sheet: `${away} ${sg(awayNum)} / ${home} ${sg(homeNum)}`,
    stored: `spread ${sg(homeNum)} (home ${f.homeShort}), awaySpread ${sg(awayNum)}, total ${total}`,
    shape: bothLay ? 'BOTH-LAY' : 'mirrored',
    kick: f.date,
  });
}

const unlined = fixtures.filter(f => !lines[f.id]);

console.log('WEEK 7 PICK 6 -- what will be sent\n');
console.log('  id          game                      sheet says                     shape');
for (const r of report) {
  console.log('  ' + r.id + '  ' + r.game.padEnd(24) + '  ' + r.sheet.padEnd(29) + '  ' + r.shape);
}
console.log('');
console.log('  stored as (home-spread convention the app uses):');
for (const r of report) console.log('    ' + r.game.padEnd(24) + r.stored);
console.log('');
console.log('  games on the sheet: ' + report.length + ' of ' + SHEET.length);
console.log('  week-7 fixtures with no line: ' +
  (unlined.length ? unlined.map(f => f.awayShort + ' @ ' + f.homeShort +
    ' (' + f.date.slice(0, 10) + ')').join(', ') : 'none'));
console.log('  both-lay games: ' + (report.filter(r => r.shape === 'BOTH-LAY')
  .map(r => r.game).join(', ') || 'none'));
console.log('');
if (problems.length) {
  console.log('  PROBLEMS -- nothing will be sent:');
  for (const p of problems) console.log('    ' + p);
  process.exit(1);
}
fs.writeFileSync('pool_payload7.json',
  JSON.stringify({ week: 7, count: 6, lines }, null, 1), 'utf8');
console.log('  all ' + report.length + ' rows matched a fixture. payload -> pool_payload7.json');
