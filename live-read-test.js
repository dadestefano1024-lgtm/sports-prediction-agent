'use strict';
/**
 * Drive the REAL liveReadHTML out of index.html.
 *
 * CHECKED: feed-banner-test.js and market-card-test.js (lift their subject the
 * same way). This one matters because the component nearly shipped as a blue
 * "Some edge" badge off one season's 55.3%, and three seasons took that to
 * break-even. The tests assert that it does NOT claim an edge.
 */
const fs = require('fs');
const page = fs.readFileSync('public/index.html', 'utf8');
const at = page.indexOf('    function liveReadHTML(g) {');
if (at < 0) throw new Error('could not find liveReadHTML');
let d = 0, end = -1;
for (let j = page.indexOf('{', at); j < page.length; j++) {
  if (page[j] === '{') d++;
  else if (page[j] === '}') { d--; if (d === 0) { end = j + 1; break; } }
}
const render = new Function('return (' + page.slice(at, end) + ')')();
const txt = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '-')
  .replace(/\s+/g, ' ').trim();

let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) { pass++; console.log('  ok    ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (x ? '\n          ' + x : '')); } };

console.log('LIVE READ, real component, three states\n');

const moved = render({ liveRead: { state: 'moved', side: 'home', team: 'Boston Celtics',
  movePts: 3, atOpen: 0.663, atClose: 0.526, breakEven: 0.5238, sd: 1.51,
  periods: null, periodsTotal: 24, gatesAtClose: 0, liveEdge: false } });
const mt = txt(moved);
check('names the side the money went to', /Money is on Boston Celtics/.test(mt), mt.slice(0, 120));
check('and the size of the move', /3 pts since it opened/.test(mt));
check('quotes BOTH ends of the curve', /66\.3%/.test(mt) && /52\.6%/.test(mt), mt.slice(0, 220));
check('states break-even beside them', /52\.4%/.test(mt));
check('says the value is in being early', /value is in being early/.test(mt));
check('and says plainly it is NOT a bet signal', /not a bet signal/i.test(mt), mt.slice(-160));
check('no green or blue edge styling', !/lr-edge|lr-thin/.test(moved), moved.slice(0, 120));
check('never uses the word Recommended', !/recommend/i.test(mt));

const none = render({ liveRead: { state: 'no-move', movePts: 0 } });
const nt = txt(none);
check('a line that has not moved says so', /has not moved/.test(nt), nt.slice(0, 120));
check('and says it is not a verdict on the game', /Not a verdict/.test(nt));
check('with no percentages invented', !/%/.test(nt), nt);

check('no liveRead at all renders nothing', render({}) === '' && render(null) === '');
check('a 1-pt move still reports its own numbers',
  /51\.8%/.test(txt(render({ liveRead: { state: 'moved', side: 'away', team: 'Nets',
    movePts: 1, atOpen: 0.586, atClose: 0.518, breakEven: 0.5238, sd: 1.99,
    periods: null, periodsTotal: 24 } }))));
const withMonths = txt(render({ liveRead: { state: 'moved', side: 'home', team: 'Lakers',
  movePts: 2, atOpen: 0.628, atClose: 0.524, breakEven: 0.5238, sd: 1.86,
  periods: 12, periodsTotal: 24 } }));
check('where months were measured it reports them', /12 of 24 months/.test(withMonths),
  withMonths.slice(-200));
check('where they were not, it does not invent them',
  !/of 24 months/.test(mt), mt.slice(-150));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('\n  --- what a moved line reads as ---\n  ' + mt);
console.log('\n  --- and one that has not moved ---\n  ' + nt);
process.exit(fail ? 1 : 0);
