'use strict';
/**
 * Render the Pick 6 blocks as the app will now draw them, with real week-7
 * data, by LIFTING poolBlockHTML and its CSS out of public/index.html.
 *
 * CHECKED: render-preview.js and shop-test.js, which lift their subject the
 * same way and for the same reason -- a preview that reimplements the thing it
 * previews proves nothing. card-compare.js priced the two cards as text; this
 * shows the actual markup, including the colours.
 *
 * The server is not deployed yet, so pool_scored7.json has no tier fields.
 * They are computed here with the SHIPPED model functions from the openSpread,
 * spreadMovement and pool line already in that payload -- the same three
 * inputs server.js uses -- so the preview exercises the real maths rather than
 * a hand-written stand-in.
 *
 * Run: node tier-preview.js   ->  ../tier-preview.html
 */
const fs = require('fs');
const model = require('./model');

const page = fs.readFileSync('public/index.html', 'utf8');
const scored = JSON.parse(fs.readFileSync('../pool_scored7.json', 'utf8'));
const sheet = JSON.parse(fs.readFileSync('../pool_payload7.json', 'utf8')).lines;

// ---- lift the function ------------------------------------------------------
const start = page.indexOf('    function poolBlockHTML(b, isRecommended, g) {');
if (start < 0) throw new Error('could not find poolBlockHTML in index.html');
// walk braces to find its end, so the extraction does not depend on what
// happens to follow it in the file
let depth = 0, i = page.indexOf('{', start), end = -1;
for (let j = i; j < page.length; j++) {
  if (page[j] === '{') depth++;
  else if (page[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
}
if (end < 0) throw new Error('could not find the end of poolBlockHTML');
const src = page.slice(start, end);
// eslint-disable-next-line no-new-func
const poolBlockHTML = new Function('return (' + src.replace(/^\s*function /, 'function ') + ')')();

// ---- lift the styles --------------------------------------------------------
const want = [
  '.pool-block', '.pool-block-off', '.pool-block-dead', '.pool-block-head',
  '.pool-block-prob', '.pool-block-line', '.pool-block-note', '.pool-filler',
  '.pool-flat', '.pool-with', '.pool-against', '.pool-against-inline', '.pool-dead',
  '.rec-badge', '.flat-badge', '.avoid-badge', '.edge-badge', '.thin-badge',
  '.pool-edge-why', '.pool-thin-why', '.pool-block-measured', '.pool-block-thin',
  '.pool-block-app', '.pool-rounding', '.card-odds', '.card-headline', '.card-sub',
  '.card-line', '.card-warn',
];
const styleBlock = (page.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
const rules = styleBlock.match(/[^{}]+\{[^{}]*\}/g) || [];
const css = rules.filter((r) => {
  const sel = r.slice(0, r.indexOf('{'));
  return want.some((w) => new RegExp('(^|[\\s,])' + w.replace('.', '\\.') + '($|[\\s,:.])').test(sel));
}).join('\n');
if (!css) throw new Error('lifted no CSS -- the selector list has drifted from the page');

// ---- rebuild the board with the tier fields --------------------------------
const spreadByGame = new Map();
for (const c of (scored.ranked || [])) {
  if (c.market === 'spread' && !spreadByGame.has(c.gameId)) spreadByGame.set(c.gameId, c);
}
/** The same three inputs server.js hands the model. */
function withTier(c) {
  const s = sheet[c.gameId];
  if (!s || c.market !== 'spread') return { ...c, poolTier: 'none' };
  const travel = model.poolTravel({
    openLine: c.openSpread, movePts: c.spreadMovement, poolLine: s.spread,
  });
  if (travel === null) return { ...c, poolTier: 'none' };
  const follow = c.spreadMovement < 0 ? c.side === 'home' : c.side === 'away';
  const q = model.travelProb({ movePts: c.spreadMovement, travel, follow });
  if (!q) return { ...c, poolTier: 'none' };
  const enriched = {
    ...c, travelProb: q, movePts: +Math.abs(c.spreadMovement).toFixed(1),
    absorbed: +travel.toFixed(3), followsMove: follow,
  };
  return { ...enriched, poolTier: model.poolTier(enriched) };
}

const all = (scored.ranked || []).map(withTier);
const ranked = model.rankPoolPicks(all, all.length);
const six = ranked.slice(0, 6);
const card = model.cardOdds(six, { target: 6 });
const tc = six.reduce((a, b) => { a[b.poolTier || 'none']++; return a; },
  { edge: 0, thin: 0, none: 0 });

// the old ordering, for the before/after
const oldSix = (scored.best || []).slice(0, 6).map((b) => {
  const match = all.find((x) => x.gameId === b.gameId && x.market === b.market && x.side === b.side);
  return match || { ...b, poolTier: 'none' };
});

console.log('NEW ORDER (tier first, then the measured number):');
six.forEach((b, n) => console.log('  ' + (n + 1) + '. ' + String(b.pick).padEnd(26) +
  (b.poolTier || 'none').padEnd(6) + '  ' +
  (b.travelProb ? (b.travelProb.p * 100).toFixed(1) + '%' : '  --  ') +
  '   winProb ' + (b.winProb * 100).toFixed(1) + '%'));
console.log('');
console.log('WAS:');
oldSix.forEach((b, n) => console.log('  ' + (n + 1) + '. ' + String(b.pick).padEnd(26) +
  (b.poolTier || 'none')));
console.log('');
console.log('tiers in the six: ' + tc.edge + ' edge, ' + tc.thin + ' thin, ' + tc.none + ' filler');
console.log('card: 1 week in ' + (card && card.oneIn));

// ---- render -----------------------------------------------------------------
const edgeLine = (tc.edge + tc.thin) === 0
  ? `<div class="pool-rounding">None of these six has a measured edge.</div>`
  : `<div class="pool-rounding"><strong>${tc.edge} of your 6 ${tc.edge === 1 ? 'carries' : 'carry'}
       a real edge</strong>${tc.thin ? `, and ${tc.thin} ${tc.thin === 1 ? 'carries' : 'carry'} a
       weaker one` : ''}. The rest are filler &mdash; the pool wants six whether or not six are
       any good. Green is the measured edge: the market moved toward that side and your number is
       still behind it.</div>`;

const blocks = six.map((b) => poolBlockHTML(b, true, {})).join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pick 6 tiers</title>
<style>
  body { background:#0d1117; color:#c9d1d9; margin:0; padding:16px;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  h1 { font-size:17px; margin:0 0 4px; }
  .lede { color:#8b949e; font-size:13px; line-height:1.6; max-width:720px; margin:0 0 16px; }
  .ord { border:1px solid #21262d; border-radius:8px; background:#10151c; padding:10px 12px;
         margin:0 0 16px; font-size:12px; color:#8b949e; }
  .ord table { border-collapse:collapse; width:100%; max-width:520px; }
  .ord td { padding:3px 10px 3px 0; }
  .ord .n { color:#6e7681; }
  .e { color:#3fb950; } .t { color:#58a6ff; } .f { color:#6e7681; }
  .foot { margin-top:18px; color:#6e7681; font-size:12px; line-height:1.7; max-width:720px; }
${css}
</style></head><body>
<h1>Your six &mdash; week 7, as the app will now show them</h1>
<p class="lede">Still six picks, because the pool wants six.
  <span class="e">Green</span> is a measured edge: the market moved 2+ points toward that side and
  your number still holds half that move or more. <span class="t">Blue</span> is the same shape of
  thing on weaker evidence. <span class="f">Grey</span> is a slot that had to be filled.</p>

<div class="ord"><strong style="color:#c9d1d9">What moved</strong>
  <table>
    ${six.map((b, n) => {
      const was = oldSix.findIndex((x) => x.pick === b.pick);
      const cls = b.poolTier === 'edge' ? 'e' : b.poolTier === 'thin' ? 't' : 'f';
      return `<tr><td class="n">${n + 1}.</td><td class="${cls}">${b.pick}</td>
        <td class="n">${was === n ? 'unchanged' : was < 0 ? 'new to the six' : 'was #' + (was + 1)}</td></tr>`;
    }).join('')}
  </table>
  ${oldSix.filter((b) => !six.some((x) => x.pick === b.pick)).length
    ? `<div style="margin-top:8px">dropped: ${oldSix.filter((b) => !six.some((x) => x.pick === b.pick))
        .map((b) => b.pick + (b.followsMove === false && b.movePts >= 2
          ? ` <span style="color:#f85149">(fades a ${b.movePts}-pt move)</span>` : ''))
        .join(', ')}</div>` : ''}
</div>

${model.cardOdds(six, { target: 6 }) ? `<div class="card-odds">
  <div class="card-headline">This card goes 6-0 about
    <strong>1 week in ${card.oneIn}</strong>
    <span class="card-sub">(${(card.perfect * 100).toFixed(2)}%)</span></div>
</div>` : ''}
${edgeLine}
${blocks}

<p class="foot">
  <strong>Where the numbers come from:</strong> a 690-game sweep, 2023&ndash;25, a push counted as
  a loss. <code>travel-test.js</code> for the side the market moved toward,
  <code>fade-curve.js</code> for the other one. The 2026 season is not in that sample.<br>
  <strong>What this does not do:</strong> fill your card for you. It found
  ${tc.edge + tc.thin} ${tc.edge + tc.thin === 1 ? 'side' : 'sides'} worth betting out of 26 on the
  board, and said so, instead of dressing six picks up alike.
</p>
</body></html>`;

fs.writeFileSync('../tier-preview.html', html, 'utf8');
console.log('');
console.log('preview -> ../tier-preview.html');
