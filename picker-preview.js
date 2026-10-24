'use strict';
/**
 * Render the new per-game picker with real week-7 data, by LIFTING the lock
 * block, poolBlockHTML and the CSS out of public/index.html.
 *
 * CHECKED: tier-preview.js (lifts poolBlockHTML and the CSS the same way and
 * shares the helpers), picker-test.js (drives the same lifted block against a
 * fake DOM), render-preview.js, shop-test.js. This one differs by rendering the
 * picker INSIDE each card, which is the thing that changed, and by showing a
 * card mid-selection so the chosen state is visible rather than described.
 *
 * Run: node picker-preview.js   ->  ../picker-preview.html
 */
const fs = require('fs');
const model = require('./model');

const page = fs.readFileSync('public/index.html', 'utf8');
const scored = JSON.parse(fs.readFileSync('../pool_scored7.json', 'utf8'));
const sheet = JSON.parse(fs.readFileSync('../pool_payload7.json', 'utf8')).lines;
const fx = new Map(JSON.parse(fs.readFileSync('../wk7.json', 'utf8')).map((f) => [f.id, f]));

// ---- lift a brace-balanced function by name --------------------------------
function lift(name) {
  const at = page.indexOf('    function ' + name + '(');
  if (at < 0) throw new Error('could not find ' + name);
  let depth = 0, end = -1;
  for (let j = page.indexOf('{', at); j < page.length; j++) {
    if (page[j] === '{') depth++;
    else if (page[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error('could not find the end of ' + name);
  return page.slice(at, end);
}

// ---- lift the whole lock block, same boundaries picker-test.js uses --------
const bStart = page.indexOf('    // ---- LOCKED CARDS ---');
const bEnd = page.indexOf('    function renderPool() {', bStart);
if (bStart < 0 || bEnd < 0) throw new Error('could not find the lock-panel block');
const lockBlock = page.slice(bStart, bEnd);

// ---- the board, with the tier fields server.js now attaches ----------------
function withTier(c) {
  const s = sheet[c.gameId];
  if (!s || c.market !== 'spread') return { ...c, poolTier: 'none' };
  const travel = model.poolTravel({
    openLine: c.openSpread, movePts: c.spreadMovement, poolLine: s.spread });
  if (travel === null) return { ...c, poolTier: 'none' };
  const follow = c.spreadMovement < 0 ? c.side === 'home' : c.side === 'away';
  const q = model.travelProb({ movePts: c.spreadMovement, travel, follow });
  if (!q) return { ...c, poolTier: 'none' };
  const e = { ...c, travelProb: q, movePts: +Math.abs(c.spreadMovement).toFixed(1),
              absorbed: +travel.toFixed(3), followsMove: follow };
  return { ...e, poolTier: model.poolTier(e) };
}
const options = (scored.options || []).map(withTier);
const ranked = model.rankPoolPicks((scored.ranked || []).map(withTier), 99);
const six = ranked.slice(0, 6);
const byGame = {};
for (const b of six) byGame[b.gameId] = b;

// ---- run the lifted block -------------------------------------------------
const nodes = {};
const document = {
  getElementById: (id) => (id in nodes ? nodes[id] : null),
};
nodes['lock-panel'] = { _h: '', set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; } };
const api = new Function('document', 'fetch', 'nflWeek', 'poolCandidates',
  lockBlock + '\nreturn { togglePickFor, renderLockPanel, gamePickerHTML, POOL_PLAYERS,' +
              ' get cardSel(){return cardSel} };'
)(document, async () => ({ json: async () => ({ cards: {} }) }), 7, options);

// a card mid-selection, so the chosen state is SHOWN and not just described
const picked = [
  ['Danny', six[0]], ['Danny', six[1]], ['Danny', six[2]],
  ['Logan', six[0]], ['Logan', six[3]],
];
for (const [who, b] of picked) {
  if (b) api.togglePickFor(who, `${b.gameId}|${b.market}|${b.side}`);
}
api.renderLockPanel();
const bar = nodes['lock-panel'].innerHTML;

// ---- poolBlockHTML, for the card body above each picker --------------------
// eslint-disable-next-line no-new-func
const poolBlockHTML = new Function('return (' + lift('poolBlockHTML') + ')')();

// ---- lift the styles -------------------------------------------------------
const want = [
  '.pool-block', '.pool-block-off', '.pool-block-dead', '.pool-block-head',
  '.pool-block-prob', '.pool-block-line', '.pool-block-note', '.pool-filler',
  '.pool-flat', '.pool-with', '.pool-against', '.pool-against-inline', '.pool-dead',
  '.rec-badge', '.flat-badge', '.avoid-badge', '.edge-badge', '.thin-badge',
  '.pool-edge-why', '.pool-thin-why', '.pool-block-measured', '.pool-block-thin',
  '.pool-block-app', '.pool-rounding', '.card-odds', '.card-headline', '.card-sub',
  '.card-line', '.card-warn', '.game-card',
  '.gp', '.gp-head', '.gp-row', '.gp-bet', '.gp-p', '.gp-p-edge', '.gp-p-thin',
  '.gp-b', '.gp-note', '.lp-bar', '.lp-st', '.lp-ct', '.lp-rec', '.lp-msg', '.lp-hint',
  '.pl-wrap', '.pl-cards', '.pl-card', '.pl-card-head', '.pl-row', '.pl-pick', '.pl-game',
  '.pl-lock', '.pl-redo', '.pl-none', '.pl-other', '.pl-lk', '.pl-star',
  '.pl-edge', '.pl-thin', '.pl-w', '.pl-l', '.pl-p', '.pl-o', '.pl-warn',
];
const styleBlock = (page.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
const rules = styleBlock.match(/[^{}]+\{[^{}]*\}/g) || [];
const css = rules.filter((r) => {
  const sel = r.slice(0, r.indexOf('{'));
  return want.some((w) => new RegExp('(^|[\\s,])' + w.replace(/\./g, '\\.') + '($|[\\s,:.])').test(sel));
}).join('\n');
if (!css) throw new Error('lifted no CSS -- the selector list has drifted from the page');

// ---- three cards: an edge, a filler, and one not in the six ----------------
const showIds = [six[0].gameId, six[3].gameId,
  (scored.ranked || []).map((c) => c.gameId).find((id) => !byGame[id])];
const cards = showIds.filter(Boolean).map((id) => {
  const f = fx.get(id);
  const b = byGame[id];
  const head = `<div class="gc-head">${f ? f.awayShort + ' @ ' + f.homeShort : id}</div>`;
  const body = b ? poolBlockHTML(b, true, {})
    : `<div class="pool-block pool-block-off"><div class="pool-block-head">Not in your six
         <span class="pool-block-prob">&mdash;</span></div></div>`;
  return `<div class="game-card">${head}${body}${api.gamePickerHTML(id)}</div>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pick 6 picker</title>
<style>
  body { background:#0d1117; color:#c9d1d9; margin:0; padding:16px;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  h1 { font-size:17px; margin:0 0 4px; }
  .lede { color:#8b949e; font-size:13px; line-height:1.6; max-width:720px; margin:0 0 14px; }
  .gc-head { font-size:13px; font-weight:600; color:#c9d1d9; margin-bottom:8px; }
  .game-card { border:1px solid #21262d; border-radius:8px; background:#10151c;
               padding:12px 14px; margin-bottom:12px; }
  .foot { margin-top:16px; color:#6e7681; font-size:12px; line-height:1.7; max-width:720px; }
  .foot strong { color:#8b949e; }
${css}
</style></head><body>
<h1>Locking a card &mdash; the picker moved into the game cards</h1>
<p class="lede">Three cards shown, with Danny part-way through a card and Logan two picks in.
  Every bet on a game carries a <strong>Danny</strong> and a <strong>Logan</strong> button, so one
  game&rsquo;s four bets sit together and neither of you scrolls a 52-row list. The bar at the top
  is sticky &mdash; it follows you down the page, so locking never means scrolling back up.</p>

${bar}
${cards}

<p class="foot">
  <strong>What changed:</strong> the options used to be one flat list above every card, sorted by
  probability, so a single game&rsquo;s four bets ended up scattered with other games in between.
  There was also a player tab, which meant a half-built card was cleared whenever you switched
  &mdash; wrong when the two of you are filling cards side by side. Both are gone.<br>
  <strong>Clicking the other side of a game you have already picked switches sides</strong> rather
  than clearing the slot. A game and a market is one slot; which side you take is the choice within
  it. Those were the same thing in the flat list, and the test pins it.<br>
  <strong>A locked card&rsquo;s buttons are disabled</strong>, so it is not edited by accident
  &mdash; re-picking goes through the re-pick button on the card itself.
</p>
</body></html>`;

fs.writeFileSync('../picker-preview.html', html, 'utf8');
console.log('Danny: ' + Object.keys(api.cardSel.Danny).length + ' of 6, Logan: ' +
  Object.keys(api.cardSel.Logan).length + ' of 6');
console.log('cards shown: ' + showIds.filter(Boolean).map((id) => {
  const f = fx.get(id); return f ? f.awayShort + ' @ ' + f.homeShort : id;
}).join(', '));
console.log('preview -> ../picker-preview.html');
