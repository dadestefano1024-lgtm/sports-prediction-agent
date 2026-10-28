'use strict';
/**
 * A push LOSES in the Pick 6 and REFUNDS everywhere else. Pinned.
 *
 * CHECKED: market-card-test.js and feed-banner-test.js (lift their subject out
 * of index.html the same way; the market-card block is covered there and this
 * covers the source split, which had NO test and is where the rule was wrong),
 * model.test.js cardOdds (the pool side, already correct in the model).
 *
 * THE DEFECT THIS EXISTS FOR. srcSplitHTML divided by wins + losses + pushes for
 * BOTH rows. That is right for the pool -- a frozen whole number landing on
 * itself busts the card -- and wrong for the NFL tab, where the stake comes back
 * and the bet never happened. On the live record it showed 51.6% on 16-14-1 when
 * the figure is 53.3%: understated by 1.7 points, which is the difference
 * between reading as below the 52.4% break-even and above it. Danny caught it.
 *
 * CLAUDE.md's opening note on this app is that its two use cases pull in
 * opposite directions and almost every bug in its history came from applying
 * one's logic to the other. There was no test holding that line here.
 *
 * Run: node push-rule-test.js
 */
const fs = require('fs');

const page = fs.readFileSync('public/index.html', 'utf8');
const at = page.indexOf('      const srcSplitHTML = (() => {');
if (at < 0) throw new Error('could not find srcSplitHTML');
let d = 0, end = -1;
for (let j = page.indexOf('{', at); j < page.length; j++) {
  if (page[j] === '{') d++;
  else if (page[j] === '}') { d--; if (d === 0) { end = j; break; } }
}
if (end < 0) throw new Error('could not find the end of srcSplitHTML');
const close = page.indexOf(';', end);
const src = page.slice(at, close + 1);
const render = new Function('data', src + '\nreturn srcSplitHTML;');

const txt = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '-')
  .replace(/—/g, '-').replace(/\s+/g, ' ').trim();

let pass = 0, fail = 0;
const check = (l, c, x) => { if (c) { pass++; console.log('  ok    ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (x ? '\n          ' + x : '')); } };

console.log('THE PUSH RULE, real source-split block\n');

// the live record as it stood when Danny raised it
const out = render({
  poolRecord: { wins: 38, losses: 29, pushes: 3 },
  bySource: { recommendation: { wins: '16', losses: '14', pushes: '1' } },
});
const t = txt(out);

check('the Pick 6 row counts a push as a LOSS  (38/(38+29+3) = 54.3%)',
  /Pick 6 38-29-3 54\.3%/.test(t), t.slice(0, 200));
check('the NFL tab row counts a push as a REFUND  (16/(16+14) = 53.3%)',
  /53\.3%/.test(t), t.slice(0, 260));
check('and it no longer shows the 51.6% that divided the push like a loss',
  !/51\.6%/.test(t), t.slice(0, 260));
check('the refunded push is still disclosed, not hidden',
  /1 push refunded, not counted/.test(t), t.slice(0, 300));

// a pool card with a push can never be perfect; a live record with one is fine
const allPush = render({
  poolRecord: { wins: 0, losses: 0, pushes: 4 },
  bySource: { recommendation: { wins: '0', losses: '0', pushes: '4' } },
});
const ap = txt(allPush);
check('four pushes in the pool is 0% -- all four busted the card',
  /Pick 6 0-0-4 0\.0%/.test(ap), ap.slice(0, 200));
check('four pushes on the NFL tab settles nothing at all',
  /nothing settled yet/.test(ap), ap.slice(0, 220));

// no pushes: both divisors agree, so the two rules must not diverge
const none = txt(render({
  poolRecord: { wins: 6, losses: 4, pushes: 0 },
  bySource: { recommendation: { wins: '6', losses: '4', pushes: '0' } },
}));
const sixties = (none.match(/60\.0%/g) || []).length;
check('with no pushes both rows read 60.0% -- the rules only differ on a push',
  sixties === 2, none.slice(0, 220));

// and the SD must use the same divisor as the percentage it sits beside
const sd = render({
  poolRecord: { wins: 20, losses: 0, pushes: 20 },
  bySource: { recommendation: { wins: '20', losses: '0', pushes: '20' } },
});
const st = txt(sd);
check('the pool SD is computed on 40 settled (20-0-20 = 50.0%)',
  /Pick 6 20-0-20 50\.0%/.test(st), st.slice(0, 200));
check('the NFL tab SD is computed on 20 (20-0, 100%), not 40',
  /100\.0%/.test(st), st.slice(0, 260));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('\n  --- the live record as it now reads ---\n  ' + t);
process.exit(fail ? 1 : 0);
