'use strict';
/**
 * Drive the REAL feed banner out of index.html through its three states.
 *
 * CHECKED: market-card-test.js and picker-test.js (lift their subject out of
 * the page the same way), tier-preview.js, render-preview.js. Nothing covered
 * this banner, and its old single sentence -- "the paid odds feed has no data
 * right now" -- was WRONG in the only case that ever actually happened. The
 * feed had data the whole time; the app had stopped buying it. A reader was
 * told the supplier was broken when the answer was a button nobody had built.
 *
 * Run: node feed-banner-test.js
 */
const fs = require('fs');

const page = fs.readFileSync('public/index.html', 'utf8');
// Start at wantsBook, NOT at feedWarn: `wantsBook` and `feed` are both declared
// above the IIFE and both are read inside it. Lifting the IIFE alone threw
// "feed is not defined" -- and that is the point of lifting rather than
// retyping, since a hand-written copy would have declared them and passed.
const start = page.indexOf('      const wantsBook = games.some(g => g.bestBet || g.spreadPick);');
if (start < 0) throw new Error('could not find the wantsBook line');
const iife = page.indexOf('const feedWarn = (() => {', start);
if (iife < 0) throw new Error('could not find the feedWarn block');
let depth = 0, end = -1;
for (let j = page.indexOf('{', iife); j < page.length; j++) {
  if (page[j] === '{') depth++;
  else if (page[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
}
if (end < 0) throw new Error('could not find the end of the feedWarn block');
const close = page.indexOf(';', end);          // the `})();` tail
const src = page.slice(start, close + 1);

// eslint-disable-next-line no-new-func
const render = new Function('games', 'data', src + '\nreturn feedWarn;');

const txt = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '.')
  .replace(/&rsquo;/g, "'").replace(/&mdash;/g, '-').replace(/\s+/g, ' ').trim();

const GAMES_NO_PRICE = [
  { bestBet: null, spreadPick: 'Falcons +4', myBook: null },
  { bestBet: null, spreadPick: 'Raiders +5', myBook: null },
];
const GAMES_PRICED = GAMES_NO_PRICE.map(g => ({ ...g, myBook: { title: 'DraftKings' } }));
const GAMES_NO_VERDICT = [{ bestBet: null, spreadPick: null, myBook: null }];

const feed = (o) => ({ oddsFeed: Object.assign({
  onDemand: true, source: 'database-stale', ageMinutes: 0, games: 14, stale: false,
  quotaRemaining: 120, quotaUsed: 380, callCost: 3, reserve: 12, canRefresh: true,
}, o) });

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '\n          ' + extra : '')); }
};

console.log('FEED BANNER, real block, three states\n');

// --- 1. nothing bought yet --------------------------------------------------
const none = render(GAMES_NO_PRICE, feed({ source: 'none', games: 0, stale: null, ageMinutes: null }));
const noneTxt = txt(none);
check('says no prices have been BOUGHT, not that the feed is broken',
  /no book prices have been bought/i.test(noneTxt) && !/feed has no data/i.test(noneTxt),
  noneTxt.slice(0, 160));
check('still explains that No lean is not a verdict',
  /not the same as the sides being examined/i.test(noneTxt));
check('reassures that the free data is unaffected',
  /free\s+sources and are unaffected/i.test(noneTxt), noneTxt.slice(-140));
check('offers the button', /id="odds-buy"/.test(none) && /buyOddsPrices\(\)/.test(none));
check('and states the cost against the balance', /costs 3 of your 120 remaining/.test(noneTxt),
  noneTxt.slice(-120));

// --- 2. prices, but old -----------------------------------------------------
const stale = render(GAMES_PRICED, feed({ stale: true, ageMinutes: 60 * 30 }));
const staleTxt = txt(stale);
check('an old price is reported as old, in days', /1 day old/.test(staleTxt), staleTxt.slice(0, 140));
check('and says what it is still good for', /frozen on Wednesday/.test(staleTxt));
check('with a refresh button', /id="odds-buy"/.test(stale));
const staleH = txt(render(GAMES_PRICED, feed({ stale: true, ageMinutes: 300 })));
check('hours when it is hours, not a fraction of a day', /5 hours old/.test(staleH), staleH.slice(0, 120));
const staleOne = txt(render(GAMES_PRICED, feed({ stale: true, ageMinutes: 60 })));
check('and singular at one hour', /1 hour old/.test(staleOne), staleOne.slice(0, 120));

// --- 3. fresh prices: say nothing ------------------------------------------
check('a fresh board shows no banner at all',
  render(GAMES_PRICED, feed({ stale: false })) === '');

// --- 4. no verdict wanted: say nothing -------------------------------------
check('a board with no priced verdicts shows nothing',
  render(GAMES_NO_VERDICT, feed({ source: 'none' })) === '');

// --- 5. out of credits: offer no button that cannot work -------------------
const broke = render(GAMES_NO_PRICE, feed({ source: 'none', quotaRemaining: 2, canRefresh: false }));
const brokeTxt = txt(broke);
check('with too few credits there is no button', !/id="odds-buy"/.test(broke), brokeTxt.slice(-140));
check('and it says why, with the numbers',
  /out of credits/i.test(brokeTxt) && /2 left/.test(brokeTxt) && /costs 3/.test(brokeTxt),
  brokeTxt.slice(-170));

// --- 6. no feed status at all must not throw or print a bogus number -------
const noFeed = render(GAMES_NO_PRICE, {});
check('a payload with no oddsFeed still renders', /odds-buy/.test(noFeed), txt(noFeed).slice(0, 120));
check('and falls back to naming the cost without a balance',
  /costs 3 credits/.test(txt(noFeed)) && !/NaN|undefined|null/.test(txt(noFeed)),
  txt(noFeed).slice(-120));

console.log('\n  --- what you see with nothing bought ---');
console.log('  ' + noneTxt);
console.log('\n  --- what you see with day-old prices ---');
console.log('  ' + staleTxt);
// The tally and the exit live at the very END of this file, after every
// appended block. They used to sit here, so a set of checks appended later
// never ran at all and the file still reported a clean pass -- a test harness
// failing open, which is the exact shape of defect this repo keeps finding.

// --- 7. the free single-book line, added when ESPN turned out to carry one ---
// Appended rather than woven in, so the earlier cases stay exactly as they were
// when they passed.
(() => {
  const freeBook = { title: 'DraftKings', from: 'espn', singleBook: true };
  const GAMES_FREE = GAMES_NO_PRICE.map(g => ({ ...g, myBook: freeBook }));
  const out = render(GAMES_FREE, feed({ source: 'none', stale: null }));
  const t = txt(out);
  check('a free one-book line is reported as live, not as missing',
    /Live DraftKings lines, free from ESPN/.test(t) && !/no book prices have been bought/i.test(t),
    t.slice(0, 150));
  check('and says the ACROSS-books comparison is what is missing',
    /comparison ACROSS books/.test(t));
  // Both phrases appear ON PURPOSE -- the sentence contrasts them -- so the
  // check is on the contrast, not on "No lean" being absent. The first version
  // asserted the absence and failed on correct copy.
  check('so the game is said to read No read on price RATHER THAN No lean',
    /reads\s+No read on price rather than\s+No lean/.test(t), t.slice(0, 220));
  check('with a button to buy the comparison', /id="odds-buy"/.test(out));

  // the ordering that matters: a stale PAID cache must not be reported as the
  // age of an ESPN line, which rides its own five-minute fetch
  const staleFeed = render(GAMES_FREE, feed({ stale: true, ageMinutes: 60 * 144 }));
  check('a six-day-old PAID cache is not reported as the age of a live ESPN line',
    !/days old/.test(txt(staleFeed)) && /free from ESPN/.test(txt(staleFeed)),
    txt(staleFeed).slice(0, 150));

  // a mixed board -- one paid book and one free -- is not "only free"
  const mixed = render(
    [{ ...GAMES_NO_PRICE[0], myBook: { title: 'DraftKings' } },
     { ...GAMES_NO_PRICE[1], myBook: freeBook }],
    feed({ stale: false }));
  check('a board with any PAID book does not claim to be single-book',
    !/free from ESPN/.test(txt(mixed)), txt(mixed).slice(0, 120));

  console.log('\n  with the free ESPN line:');
  console.log('  ' + t);
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed  (including the appended set)');
  process.exit(fail ? 1 : 0);
})();
