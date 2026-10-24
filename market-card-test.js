'use strict';
/**
 * Run the REAL market-card block out of index.html against the REAL history
 * payload, and check it says what it is supposed to say.
 *
 * CHECKED: picker-test.js and tier-preview.js (lift their subject out of the
 * page the same way), render-preview.js, shop-test.js. Nothing covered the
 * history tab's breakdown cards at all, which is how a 22-bet record came to be
 * printed as a bare 59.1% with nothing beside it.
 *
 * ../hist.json is the live payload, fetched before the server change, so it has
 * no byMarketSport. The per-sport rows are built here from the recent rows in
 * that same payload -- the same grouping the new SQL does -- so the fixture is
 * derived from real data rather than invented.
 *
 * Run: node market-card-test.js
 */
const fs = require('fs');

const page = fs.readFileSync('public/index.html', 'utf8');
const start = page.indexOf("      let marketHTML = '';");
if (start < 0) throw new Error('could not find the marketHTML block');
// to the end of the `if` that builds it
const endMark = "      // By Confidence breakdown";
const end = page.indexOf(endMark, start);
if (end < 0) throw new Error('could not find the end of the marketHTML block');
const src = page.slice(start, end);

/** Lift a named top-level function out of the page by brace balance. */
function liftFn(name) {
  const at = page.indexOf('    function ' + name + '(');
  if (at < 0) throw new Error('could not find ' + name + ' in index.html');
  let depth = 0;
  for (let j = page.indexOf('{', at); j < page.length; j++) {
    if (page[j] === '{') depth++;
    else if (page[j] === '}') { depth--; if (depth === 0) return page.slice(at, j + 1); }
  }
  throw new Error('could not find the end of ' + name);
}
// fmtRecord leans on pctClass, so both come across -- lifted, not guessed at.
// Reimplementing either would make this test agree with itself rather than with
// the page, which is the whole failure mode these lifted harnesses avoid.
const helpers = ['pctClass', 'fmtRecord'].map(liftFn).join('\n');

// eslint-disable-next-line no-new-func
const render = new Function('data', helpers + '\n' + src + '\nreturn marketHTML;');

// ---- the fixture, derived from the live payload ---------------------------
const hist = JSON.parse(fs.readFileSync('../hist.json', 'utf8'));
const rows = hist.recent || [];
const int = (v) => parseInt(v, 10) || 0;
const graded = (r) => ['win', 'loss', 'push'].includes(r.result);
const bms = {};
for (const r of rows.filter(graded)) {
  const k = [(r.source || 'recommendation'), r.market, r.sport].join('|');
  bms[k] = bms[k] || { src: (r.source || 'recommendation'), market: r.market, sport: r.sport,
                       wins: 0, losses: 0, pushes: 0 };
  bms[k][r.result === 'win' ? 'wins' : r.result === 'loss' ? 'losses' : 'pushes']++;
}
const byMarketSport = Object.values(bms).map(x => ({
  ...x, wins: String(x.wins), losses: String(x.losses), pushes: String(x.pushes) }));

const blended = { ...hist, byMarketSport, sportFilter: null };
const filtered = {
  ...hist,
  byMarket: (hist.byMarket || []).filter(m => m.market !== 'total' || m.src !== 'recommendation')
    .concat([{ src: 'recommendation', market: 'total', wins: '9', losses: '8', pushes: '0' }]),
  byMarketSport: byMarketSport.filter(x => x.sport === 'nfl'),
  sportFilter: 'nfl',
};

const txt = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '.')
  .replace(/&mdash;/g, '-').replace(/—/g, '-').replace(/\s+/g, ' ').trim();

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '\n          ' + extra : '')); }
};

console.log('MARKET CARDS, real block against the real payload\n');

const all = render(blended);
const allTxt = txt(all);

// 1. the thing Danny hit: a bare record with no sample size
check('n is printed beside every record', /n=22/.test(allTxt) && /n=65/.test(allTxt),
  allTxt.slice(0, 300));
check('so is the SD', /SD/.test(allTxt));
check('and anything under 2.5 SD is called noise', /noise/.test(allTxt));
const sdCount = (all.match(/breakdown-sd/g) || []).length;
check('every settled card carries it', sdCount === (blended.byMarket || []).length,
  'got ' + sdCount + ' of ' + (blended.byMarket || []).length);

// 2. two cards called TOTAL are now distinguishable
const totalCards = (all.match(/breakdown-name">TOTAL/g) || []).length;
check('there really are two TOTAL cards', totalCards === 2, 'got ' + totalCards);
check('one is labelled Pick 6 and one NFL tab',
  /Pick 6/.test(allTxt) && /NFL tab/.test(allTxt), allTxt.slice(0, 300));

// 3. THE ANSWER TO HIS QUESTION: the 13-9 must show that it spans two sports
check('the blended totals card shows 13-9', /13-9/.test(allTxt), allTxt.slice(0, 300));
check('and splits it by sport', /NFL 9-8/.test(allTxt) && /MLB 4-1/.test(allTxt),
  allTxt.slice(0, 400));
check('with each split\'s own n', /n=17/.test(allTxt) && /n=5/.test(allTxt), allTxt.slice(0, 400));
check('and says why it matters', /Two sports in one figure/.test(allTxt));

// 4. on a single-sport view the split is pointless and must not appear
const nfl = render(filtered);
const nflTxt = txt(nfl);
check('the NFL-only view shows 9-8', /9-8/.test(nflTxt), nflTxt.slice(0, 200));
check('and prints no sport split', !/Two sports in one figure/.test(nflTxt), nflTxt.slice(0, 250));
check('but still prints n and SD', /n=17/.test(nflTxt) && /SD/.test(nflTxt), nflTxt.slice(0, 250));

// 5. degenerate inputs must not throw or print a bogus figure
check('no byMarket at all renders nothing',
  render({ byMarket: [] }) === '' && render({}) === '');
const zero = render({ byMarket: [{ src: 'pool', market: 'total', wins: '0', losses: '0', pushes: '0' }],
                      byMarketSport: [], sportFilter: null });
check('a market with nothing settled prints no SD', !/breakdown-sd/.test(zero), txt(zero));
check('and does not divide by zero', !/NaN|Infinity/.test(zero), txt(zero));
const oneSport = render({
  byMarket: [{ src: 'pool', market: 'spread', wins: '5', losses: '4', pushes: '0' }],
  byMarketSport: [{ src: 'pool', market: 'spread', sport: 'nfl', wins: '5', losses: '4', pushes: '0' }],
  sportFilter: null });
check('a market in only ONE sport prints no split',
  !/Two sports in one figure/.test(oneSport), txt(oneSport));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('\n  --- what the blended totals card now reads as ---');
const card = all.split('<div class="breakdown-card">')
  .find(c => /TOTAL/.test(c) && /13-9/.test(c));
console.log('  ' + txt(card || ''));
process.exit(fail ? 1 : 0);
