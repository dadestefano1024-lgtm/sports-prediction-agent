'use strict';
/**
 * Price BOTH cards -- the one the app serves and the one the travel curve would
 * -- on the same measured curves, and render them side by side in the app's own
 * styling so the change can be looked at instead of argued about.
 *
 * CHECKED: render-preview.js and shop-test.js (both LIFT their subject out of
 * index.html rather than retyping it, and the CSS is lifted here the same way),
 * travel-test.js (follow curve), fade-curve.js (fade curve), stale-read.js
 * (the board read), counterfactual.js (the ranking diff as text).
 *
 * Run: node card-compare.js   ->  ../card-compare.html
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY PICK NEEDS A NUMBER, including the bad ones. Comparing two cards
 * means pricing both under the SAME model. Leaving the app's weak picks at a
 * nominal 50% flatters them; quoting CLAUDE.md's bare "fading goes 43.5%"
 * assumes they sit at the opener, and this week they do not -- Titans +3 and
 * Giants +11 are both PAST the current market, which is a better number than
 * the market on the side they are fading. Priced at 0% travel they look like
 * 32% bets. Priced where they actually are they are about 48%. The difference
 * decides whether the app's card is bad or merely mediocre, so it gets measured.
 *
 * TRAVEL BEYOND THE MARKET. The sweeps cover travel 0 to 1, the opener through
 * the market. Past that, the held number is worse than the market on a followed
 * side and better on a faded one, and there is no measurement. Rather than
 * clamp -- which silently prices a worse number as if it were level, the defect
 * that put Vikings -7 on the card at 53.2% -- the excess points are converted
 * at the normal density at the mean, phi(0)/sigma = 0.3989/13.2 = 3.0% of cover
 * probability per point. That is an approximation and is labelled as one
 * wherever it is used.
 */
const fs = require('fs');

const SIGMA = 13.2;                       // NFL margin SD, as model.js uses
const PTS_TO_PROB = 0.3989 / SIGMA;       // ~3.0% per point, near the mean
const BREAK_EVEN = 0.524;

const TRAVEL = [0, 0.25, 0.5, 0.75, 1];
const FOLLOW = { 4: [0.679, 0.625, 0.607, 0.554, 0.518], 3: [0.660, 0.617, 0.606, 0.574, 0.532],
                 2: [0.598, 0.569, 0.563, 0.540, 0.517], 0: [0.550, 0.540, 0.520, 0.509, 0.501] };
const FADE   = { 4: [0.321, 0.375, 0.375, 0.429, 0.482], 3: [0.330, 0.383, 0.383, 0.415, 0.468],
                 2: [0.391, 0.425, 0.431, 0.448, 0.483], 0: [0.417, 0.458, 0.460, 0.487, 0.499] };
const GATE_OK = 0.5, GATE_THIN = 0.75;

function interp(row, t) {
  let i = 0;
  while (i < TRAVEL.length - 2 && TRAVEL[i + 1] < t) i++;
  const f = (t - TRAVEL[i]) / (TRAVEL[i + 1] - TRAVEL[i]);
  return row[i] + (row[i + 1] - row[i]) * f;
}

/**
 * Price one side. `follow` is true when the market moved toward it.
 * Returns { p, basis, gate } -- basis says how much of it is measured.
 */
function price(move, travel, follow) {
  const mv = Math.abs(move);
  if (!Number.isFinite(mv) || mv < 0.5 || !Number.isFinite(travel)) return null;
  const table = follow ? FOLLOW : FADE;
  const row = table[mv >= 4 ? 4 : mv >= 3 ? 3 : mv >= 2 ? 2 : 0];
  const t = Math.max(0, Math.min(1, travel));
  let p = interp(row, t);
  let basis = 'measured';
  if (travel > 1) {
    // points held WORSE than the market on a followed side, BETTER on a faded one
    const excess = (travel - 1) * mv;
    p += (follow ? -1 : +1) * excess * PTS_TO_PROB;
    basis = 'extrapolated ' + excess.toFixed(1) + 'pt past the market';
  } else if (travel < 0) {
    const extra = -travel * mv;
    p += (follow ? +1 : -1) * extra * PTS_TO_PROB;
    basis = 'extrapolated ' + extra.toFixed(1) + 'pt better than the open';
  }
  const gate = !follow ? 'fade'
    : t <= GATE_OK ? 'clears' : t <= GATE_THIN ? 'thin' : 'fails';
  return { p: Math.max(0.05, Math.min(0.95, p)), basis, gate };
}

// --------------------------------------------------------------- the board --
const scored = JSON.parse(fs.readFileSync('../pool_scored7.json', 'utf8'));
const sheet = JSON.parse(fs.readFileSync('../pool_payload7.json', 'utf8')).lines;
const fx = new Map(JSON.parse(fs.readFileSync('../wk7.json', 'utf8')).map((f) => [f.id, f]));

const spreadByGame = new Map();
for (const c of (scored.ranked || [])) {
  if (c.market === 'spread' && !spreadByGame.has(c.gameId)) spreadByGame.set(c.gameId, c);
}

const sides = [];
for (const [gid, c] of spreadByGame) {
  const s = sheet[gid], f = fx.get(gid);
  if (!s || !f) continue;
  const open = c.openSpread, mv = c.spreadMovement;
  if (!Number.isFinite(open) || !Number.isFinite(mv) || Math.abs(mv) < 0.01) continue;
  const trav = (s.spread - open) / mv;
  const toward = mv < 0 ? 'home' : 'away';
  const bothLay = s.spread < 0 && s.awaySpread < 0;
  for (const side of ['home', 'away']) {
    const poolN = side === 'home' ? s.spread : s.awaySpread;
    const q = price(mv, trav, toward === side);
    sides.push({
      gameId: gid, side, market: 'spread', bothLay,
      team: side === 'home' ? f.homeShort : f.awayShort,
      pick: (side === 'home' ? f.homeShort : f.awayShort) + ' ' + (poolN > 0 ? '+' : '') + poolN,
      game: f.awayShort + ' @ ' + f.homeShort,
      mv: Math.abs(mv), trav, follow: toward === side,
      p: q && q.p, basis: q && q.basis, gate: q && q.gate,
    });
  }
}

const find = (gid, side) => sides.find((x) => x.gameId === gid && x.side === side);

// ---------------------------------------------------------- the two cards --
const appSix = (scored.best || []).slice(0, 6).map((b) => {
  const m = b.market === 'spread' ? find(b.gameId, b.side) : null;
  return {
    key: b.gameId + '|' + b.market + '|' + b.side,
    pick: b.pick, market: b.market, app: b.winProb,
    p: m ? m.p : null, mv: m ? m.mv : null, trav: m ? m.trav : null,
    follow: m ? m.follow : null, gate: m ? m.gate : null, basis: m ? m.basis : null,
    game: m ? m.game : (b.matchup || ''),
  };
});

// the curve's card: best measured first, and it must fill six because the pool
// demands six -- so weak slots are SHOWN as weak rather than left off
const pool = sides.filter((x) => !x.bothLay && Number.isFinite(x.p));
const seenGame = new Set();
const curveSix = [];
for (const x of pool.sort((a, b) => b.p - a.p)) {
  if (seenGame.has(x.gameId)) continue;          // one side per game, obviously
  seenGame.add(x.gameId);
  curveSix.push(Object.assign({ key: x.gameId + '|' + x.market + '|' + x.side }, x));
  if (curveSix.length === 6) break;
}

const perfect = (arr, key) => arr.reduce((acc, x) => acc * (Number.isFinite(x[key]) ? x[key] : 0.5), 1);
const oneIn = (p) => (p > 0 ? Math.round(1 / p) : Infinity);

const pc = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '--');

console.log('');
console.log('WEEK 7 -- BOTH CARDS, PRICED ON THE SAME MEASURED CURVES');
console.log('');
console.log('THE APP\'S SIX');
console.log('  pick                  app says   measured   why');
for (const b of appSix) {
  const why = b.market === 'total' ? 'total -- rule rejected, no measured number'
    : b.follow === false ? 'FADES a ' + b.mv.toFixed(1) + '-pt move'
    : b.gate === 'clears' ? 'move behind it, ' + (b.trav * 100).toFixed(0) + '% absorbed'
    : b.gate === 'thin' ? 'thin -- ' + (b.trav * 100).toFixed(0) + '% absorbed'
    : 'past the gates -- ' + (b.trav * 100).toFixed(0) + '% absorbed';
  console.log('  ' + String(b.pick).padEnd(22) + pc(b.app).padStart(7) + '   ' +
    pc(b.p).padStart(8) + '   ' + why);
}
const appP = perfect(appSix, 'p'), appOwn = perfect(appSix, 'app');
console.log('');
console.log('  the app shows:   1 week in ' + oneIn(appOwn) + '   (' + (appOwn * 100).toFixed(2) + '%)');
console.log('  actually worth:  1 week in ' + oneIn(appP) + '   (' + (appP * 100).toFixed(2) + '%)');

console.log('');
console.log('THE TRAVEL CURVE\'S SIX');
console.log('  pick                  measured   why');
for (const x of curveSix) {
  console.log('  ' + x.pick.padEnd(22) + pc(x.p).padStart(8) + '   ' +
    (x.follow ? 'move ' + x.mv.toFixed(1) + ' behind it, ' + (x.trav * 100).toFixed(0) + '% absorbed'
              : 'FADES a ' + x.mv.toFixed(1) + '-pt move') +
    (x.gate === 'clears' ? '   (clears)' : x.gate === 'thin' ? '   (thin)' : ''));
}
const curveP = perfect(curveSix, 'p');
console.log('');
console.log('  worth:  1 week in ' + oneIn(curveP) + '   (' + (curveP * 100).toFixed(2) + '%)');
console.log('');
const appKeys = new Set(appSix.map((b) => b.key));
const shared = curveSix.filter((x) => appKeys.has(x.key));
console.log('  shared by both cards: ' + (shared.map((x) => x.pick).join(', ') || 'none') +
  '   (' + shared.length + ' of 6)');
const extrap = curveSix.filter((x) => x.basis && x.basis !== 'measured');
console.log('  resting on EXTRAPOLATION, not measurement: ' +
  (extrap.map((x) => x.pick).join(', ') || 'none') + '   (' + extrap.length + ' of 6)');
if (extrap.length) {
  console.log('    those sides hold a number outside the swept range, so their');
  console.log('    probability comes partly from the 3.0%-per-point conversion rather');
  console.log('    than from any measurement. The ranking should not lean on them.');
}
console.log('  change in a perfect week: ' +
  ((curveP / appP - 1) * 100).toFixed(0) + '%   (1 in ' + oneIn(appP) + ' -> 1 in ' + oneIn(curveP) + ')');
console.log('');

// ------------------------------------------------------------- the preview --
const page = fs.readFileSync('public/index.html', 'utf8');
const grab = (re, what) => {
  const m = page.match(re);
  if (!m) throw new Error('could not lift ' + what + ' from index.html');
  return m[0];
};
const css = [
  grab(/\.card-odds \{[\s\S]*?\.card-warn \{[^}]*\}/, '.card-odds css'),
  grab(/\.pool-rounding \{[^}]*\}/, '.pool-rounding css'),
].join('\n');

const row = (label, p, note, bad) => `
  <div class="cc-row${bad ? ' cc-bad' : ''}">
    <span class="cc-pick">${label}</span>
    <span class="cc-p">${pc(p)}</span>
    <span class="cc-note">${note}</span>
  </div>`;

const cardBlock = (title, items, shown, worth, sub) => `
  <div class="cc-card">
    <h3>${title}</h3>
    <div class="card-odds">
      <div class="card-headline">This card goes 6-0 about
        <strong>1 week in ${oneIn(worth)}</strong>
        <span class="card-sub">(${(worth * 100).toFixed(2)}%)</span></div>
      ${shown !== null ? `<div class="card-line"><span class="card-warn">the app currently
        tells you 1 week in ${oneIn(shown)}</span></div>` : ''}
    </div>
    <div class="pool-rounding">${sub}</div>
    ${items.join('')}
  </div>`;

const appRows = appSix.map((b) => row(b.pick, b.p,
  b.market === 'total' ? 'total &mdash; rule rejected'
    : b.follow === false ? `fades a ${b.mv.toFixed(1)}-pt move`
    : b.gate === 'clears' ? `${(b.trav * 100).toFixed(0)}% absorbed`
    : b.gate === 'thin' ? `${(b.trav * 100).toFixed(0)}% absorbed &mdash; thin`
    : `${(b.trav * 100).toFixed(0)}% absorbed &mdash; past the gates`,
  b.follow === false || (Number.isFinite(b.p) && b.p < BREAK_EVEN)));

const curveRows = curveSix.map((x) => row(x.pick, x.p,
  (x.follow ? `${x.mv.toFixed(1)}-pt move, ${(x.trav * 100).toFixed(0)}% absorbed`
            : `fades a ${x.mv.toFixed(1)}-pt move`) +
  (x.basis && x.basis !== 'measured' ? ' &mdash; <em>extrapolated</em>' : ''),
  !x.follow || x.p < BREAK_EVEN));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pick 6 ranking preview</title>
<style>
  body { background:#0d1117; color:#c9d1d9; font-family:-apple-system,BlinkMacSystemFont,
         "Segoe UI",Helvetica,Arial,sans-serif; margin:0; padding:16px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .lede { color:#8b949e; font-size:13px; margin:0 0 18px; line-height:1.6; max-width:760px; }
  .cc-wrap { display:grid; grid-template-columns:1fr; gap:16px; }
  @media (min-width:760px) { .cc-wrap { grid-template-columns:1fr 1fr; } }
  .cc-card { border:1px solid #21262d; border-radius:8px; background:#10151c; padding:12px 14px; }
  .cc-card h3 { margin:0 0 10px; font-size:14px; }
  .cc-row { display:flex; align-items:baseline; gap:10px; padding:7px 0; font-size:13px;
            border-top:1px solid #1b2127; }
  .cc-pick { font-weight:600; min-width:150px; }
  .cc-p { color:#58a6ff; font-variant-numeric:tabular-nums; min-width:52px; }
  .cc-note { color:#6e7681; font-size:11px; }
  .cc-bad .cc-pick { color:#f85149; }
  .cc-bad .cc-p { color:#f85149; }
  .foot { margin-top:18px; color:#6e7681; font-size:12px; line-height:1.7; max-width:760px; }
  .foot strong { color:#8b949e; }
${css}
</style></head><body>
<h1>Pick 6 &mdash; what changes if the ranking moves to the travel curve</h1>
<p class="lede">Week 7, real lines, both cards priced on the same measured curves so the
  comparison is fair. Red is a pick below the 52.4% break&#8209;even. The
  &ldquo;absorbed&rdquo; figure is how much of the market&rsquo;s move your frozen Wednesday
  number has already taken on &mdash; 0% means you hold the opener and the whole move is
  still in front of you.</p>
<div class="cc-wrap">
  ${cardBlock('What the app serves now', appRows, appOwn, appP,
    `${appSix.filter((b) => b.follow === false).length} of these six back the side the market
     moved AWAY from. ${appSix.filter((b) => Number.isFinite(b.p) && b.p < BREAK_EVEN).length}
     are below break-even.`)}
  ${cardBlock('What the travel curve serves', curveRows, null, curveP,
    `${curveSix.filter((x) => x.gate === 'clears' || x.gate === 'thin').length} of these six
     clear the gates, and ${curveSix.filter((x) => x.basis && x.basis !== 'measured').length}
     rest partly on extrapolation rather than measurement. The rest are the best available
     and are shown as weak rather than dressed up.`)}
</div>
<p class="foot">
  <strong>A perfect week goes from 1 in ${oneIn(appP)} to 1 in ${oneIn(curveP)}</strong>
  &mdash; ${((curveP / appP - 1) * 100).toFixed(0)}% more likely, which is a real but
  modest gain, not a transformation. Both cards share ${shared.length} of six picks
  (${shared.map((x) => x.pick).join(', ') || 'none'}); the difference is which sides fill
  the rest. Note the app currently UNDERSELLS its own card &mdash; it shows 1 in
  ${oneIn(appOwn)} where the measured curves make it 1 in ${oneIn(appP)}.<br>
  <strong>Where the numbers come from:</strong> a 690-game sweep, 2023&ndash;25, pushes
  counted as losses. <code>travel-test.js</code> for the followed side,
  <code>fade-curve.js</code> for the faded one. The 2026 season is not in that sample.<br>
  <strong>What is approximate:</strong> a pick holding a number past the current market is
  outside the sweep, so the excess points are converted at 3.0% of cover probability per
  point. Four of this week&rsquo;s sides are in that position.
</p>
</body></html>`;

fs.writeFileSync('../card-compare.html', html, 'utf8');
console.log('preview -> ../card-compare.html');
console.log('');
