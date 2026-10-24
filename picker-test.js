'use strict';
/**
 * Run the REAL lock-panel code out of index.html against a fake DOM.
 *
 * CHECKED: shop-test.js, render-preview.js and tier-preview.js, which lift
 * their subject out of the page the same way rather than reimplementing it --
 * a preview or a test that reimplements the thing it covers proves nothing.
 * Earlier sessions also established that "the inline script parses" catches
 * almost nothing: a lost `$` in a template literal, a reference error 3,000
 * lines from its declaration and a cache key doubling as a path key all parsed
 * cleanly and were all broken.
 *
 * REWRITTEN for the per-game picker. The old version drove a single flat list
 * of every side of every market with one "current player" -- setPoolPlayer,
 * cardPicks, toggleCardPick, lockCard. All four are gone. Picking now happens
 * inside each game's own card, with a button per player on every bet, so the
 * state is per player and there is no current player at all.
 *
 * Run: node picker-test.js
 */
const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const start = html.indexOf('    // ---- LOCKED CARDS ---');
const endMark = '    function renderPool() {';
const end = html.indexOf(endMark, start);
if (start < 0 || end < 0) throw new Error('could not find the lock-panel block');
const code = html.slice(start, end);

// --- the smallest DOM the panel actually touches ---------------------------
const nodes = {};
const node = (id) => {
  if (!nodes[id]) nodes[id] = { id, _html: '', set innerHTML(v) { this._html = v; },
                                get innerHTML() { return this._html; },
                                disabled: false, textContent: '' };
  return nodes[id];
};
const document = { getElementById: (id) => (id in nodes ? nodes[id] : null) };
node('lock-panel');                       // the panel is mounted; game blocks are not yet

let lastPut = null;
const puts = [];
const fetch = async (url, opts) => {
  if (opts && opts.method === 'PUT') {
    lastPut = { url, body: JSON.parse(opts.body) };
    puts.push(lastPut);
    return { json: async () => ({ locked: lastPut.body.picks.length }) };
  }
  // the GET after a lock: echo every card put so far, the way the server shapes it
  const cards = {};
  for (const p of puts) {
    cards[p.body.player] = {
      player: p.body.player, lockedAt: '2026-10-24T01:00:00Z',
      picks: p.body.picks.map(x => ({
        pick: x.pick, home_team: x.homeTeam, away_team: x.awayTeam, result: null })),
      wins: 0, losses: 0, pushes: 0, pending: p.body.picks.length,
      perfect: false, blown: false,
    };
  }
  return { json: async () => ({ cards, overlap: null }) };
};

const api = new Function('document', 'fetch', 'nflWeek', 'poolCandidates',
  code + '\nreturn { togglePickFor, lockCardFor, loadLockedCards, renderLockPanel,' +
         ' gamePickerHTML, gamePickerInner, renderGamePicker, repick, cardKey, optKey,' +
         ' selCount, POOL_PLAYERS,' +
         ' get cardSel(){return cardSel}, get lockMsg(){return lockMsg},' +
         ' set lockedCards(v){lockedCards = v} };'
)(document, fetch, 7, []);

// poolCandidates is a parameter, so point it at the real board per test
function setBoard(list) {
  // rebuild with a new closure over poolCandidates -- simpler and more honest
  // than reaching into the module to mutate it
  return new Function('document', 'fetch', 'nflWeek', 'poolCandidates',
    code + '\nreturn { togglePickFor, lockCardFor, loadLockedCards, renderLockPanel,' +
           ' gamePickerHTML, gamePickerInner, renderGamePicker, repick, cardKey, optKey,' +
           ' selCount, POOL_PLAYERS,' +
           ' get cardSel(){return cardSel}, get lockMsg(){return lockMsg},' +
           ' set lockedCards(v){lockedCards = v} };'
  )(document, fetch, 7, list);
}

const txt = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '.')
  .replace(/&rsquo;/g, "'").replace(/&mdash;/g, '-').replace(/\s+/g, ' ').trim();

// two games, all four sides each, as the server now returns them
const BOARD = [
  { gameId: 'g1', market: 'spread', side: 'home', pick: 'Raiders +5', poolLine: 5,
    winProb: 0.512, matchup: 'Rams @ Raiders', homeTeam: 'Las Vegas Raiders',
    awayTeam: 'Los Angeles Rams', appPick: true, poolTier: 'thin',
    travelProb: { p: 0.595, measured: true, gate: 'thin' }, movePts: 4.5, absorbed: 0.56 },
  { gameId: 'g1', market: 'spread', side: 'away', pick: 'Rams -5', poolLine: -5,
    winProb: 0.459, matchup: 'Rams @ Raiders', homeTeam: 'Las Vegas Raiders',
    awayTeam: 'Los Angeles Rams', appPick: false, poolTier: 'none' },
  { gameId: 'g1', market: 'total', side: 'over', pick: 'Over 49', poolLine: 49,
    winProb: 0.46, matchup: 'Rams @ Raiders', homeTeam: 'Las Vegas Raiders',
    awayTeam: 'Los Angeles Rams', appPick: false, poolTier: 'none' },
  { gameId: 'g1', market: 'total', side: 'under', pick: 'Under 49', poolLine: 49,
    winProb: 0.52, matchup: 'Rams @ Raiders', homeTeam: 'Las Vegas Raiders',
    awayTeam: 'Los Angeles Rams', appPick: true, poolTier: 'none' },
  { gameId: 'g2', market: 'spread', side: 'home', pick: 'Falcons +4', poolLine: 4,
    winProb: 0.546, matchup: '49ers @ Falcons', homeTeam: 'Atlanta Falcons',
    awayTeam: 'San Francisco 49ers', appPick: true, poolTier: 'edge',
    travelProb: { p: 0.569, measured: true, gate: 'ok' }, movePts: 2, absorbed: 0.25 },
  { gameId: 'g2', market: 'spread', side: 'away', pick: '49ers -4', poolLine: -4,
    winProb: 0.431, matchup: '49ers @ Falcons', homeTeam: 'Atlanta Falcons',
    awayTeam: 'San Francisco 49ers', appPick: false, poolTier: 'none' },
];
// enough distinct games to hit the six-pick cap
for (let i = 3; i <= 9; i++) {
  BOARD.push({ gameId: 'g' + i, market: 'spread', side: 'home', pick: 'Team' + i + ' +3',
    poolLine: 3, winProb: 0.5, matchup: 'A' + i + ' @ B' + i, homeTeam: 'B' + i,
    awayTeam: 'A' + i, appPick: true, poolTier: 'none' });
}

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '   ' + extra : '')); }
};

console.log('PER-GAME PICKER, real code against a fake DOM\n');

// 1. nothing ranked
api.renderLockPanel();
check('empty state tells you to rank first',
  /Rank the week first/.test(txt(node('lock-panel').innerHTML)),
  txt(node('lock-panel').innerHTML).slice(0, 70));
check('both players still appear in the bar',
  /Danny/.test(node('lock-panel').innerHTML) && /Logan/.test(node('lock-panel').innerHTML));

// 2. a game's bets are TOGETHER, in that game's own block
const a = setBoard(BOARD);
const g1 = a.gamePickerHTML('g1');
check('one block per game, carrying its own id', /id="gp-g1"/.test(g1), g1.slice(0, 60));
const inG1 = ['Raiders +5', 'Rams -5', 'Over 49', 'Under 49'].filter(x => g1.includes(x));
check('all four of that game\'s sides are in it, and nothing else',
  inG1.length === 4 && !g1.includes('Falcons') && !g1.includes('Team3'),
  'found ' + inG1.length + ' of 4');
check('the other game gets its own block',
  a.gamePickerHTML('g2').includes('Falcons +4') && !a.gamePickerHTML('g2').includes('Raiders'));
check('a game with no options renders nothing', a.gamePickerHTML('nope') === '');

// 3. a button per player on every bet
const btns = (h) => (String(h).match(/class="gp-b /g) || []).length;
check('every bet has a button for each player', btns(g1) === 4 * a.POOL_PLAYERS.length,
  'got ' + btns(g1) + ' for ' + (4 * a.POOL_PLAYERS.length));
check('the buttons name the players',
  /onclick="togglePickFor\('Danny', 'g1\|spread\|home'\)"/.test(g1) &&
  /onclick="togglePickFor\('Logan', 'g1\|spread\|home'\)"/.test(g1), g1.slice(0, 200));
check('the app\'s own side is still starred', /pl-star/.test(g1));
check('the measured tier is marked', /pl-thin|pl-edge/.test(g1));

// 4. picking puts it on ONE player's card
a.togglePickFor('Danny', 'g1|spread|home');
check('it lands on Danny', a.selCount('Danny') === 1, String(a.selCount('Danny')));
check('and not on Logan', a.selCount('Logan') === 0, String(a.selCount('Logan')));
a.togglePickFor('Logan', 'g2|spread|home');
check('Logan picks independently', a.selCount('Logan') === 1 && a.selCount('Danny') === 1);

// 5. THE BUG THIS DESIGN INTRODUCED: the other side of a game must SWITCH.
//    Slot and option were the same thing in the flat list, so clicking the
//    second side of a game you had already picked deleted the slot.
a.togglePickFor('Danny', 'g1|spread|away');
check('the other side of the same spread switches, not clears',
  a.selCount('Danny') === 1 &&
  a.cardSel.Danny['g1|spread'] && a.cardSel.Danny['g1|spread'].side === 'away',
  JSON.stringify(Object.keys(a.cardSel.Danny)) + ' side=' +
    (a.cardSel.Danny['g1|spread'] || {}).side);

// 6. the same game's TOTAL is a separate slot
a.togglePickFor('Danny', 'g1|total|under');
check('a spread and a total on one game are two picks', a.selCount('Danny') === 2,
  String(a.selCount('Danny')));

// 7. clicking your own pick clears it
a.togglePickFor('Danny', 'g1|total|under');
check('clicking the same pick again clears it', a.selCount('Danny') === 1);

// 8. the cap
for (const id of ['g2', 'g3', 'g4', 'g5', 'g6']) a.togglePickFor('Danny', id + '|spread|home');
check('six fills up', a.selCount('Danny') === 6, String(a.selCount('Danny')));
a.togglePickFor('Danny', 'g7|spread|home');
check('a seventh is refused', a.selCount('Danny') === 6, String(a.selCount('Danny')));
check('and it says so rather than failing silently', /already has six/.test(a.lockMsg),
  a.lockMsg);
check('Logan is unaffected by Danny being full', a.selCount('Logan') === 1);
// switching sides while full must still work -- it does not add a pick
a.togglePickFor('Danny', 'g2|spread|away');
check('switching sides still works at six', a.selCount('Danny') === 6 &&
  a.cardSel.Danny['g2|spread'].side === 'away');

// 9. the bar counts both
a.renderLockPanel();
const bar = txt(node('lock-panel').innerHTML);
check('the bar shows both counts', /Danny 6 of 6/.test(bar) && /Logan 1 of 6/.test(bar), bar.slice(0, 120));
check('lock is offered for a player with picks', /id="lock-btn-Danny"/.test(node('lock-panel').innerHTML));

// 10. locking sends that player only
(async () => {
  await a.lockCardFor('Danny');
  check('a PUT was sent', !!lastPut, 'nothing sent');
  if (lastPut) {
    check('to the card endpoint', /\/api\/pool\/nfl\/card$/.test(lastPut.url), lastPut.url);
    check('for Danny', lastPut.body.player === 'Danny', lastPut.body.player);
    check('with the week', lastPut.body.week === 7, String(lastPut.body.week));
    check('six picks', lastPut.body.picks.length === 6, String(lastPut.body.picks.length));
    const pk = lastPut.body.picks[0];
    check('each pick carries gameId, market, side, pick, line',
      pk.gameId && pk.market && pk.side && pk.pick && pk.line !== undefined, JSON.stringify(pk));
    check('and the teams, so the row can be graded', !!(pk.homeTeam && pk.awayTeam));
  }
  check('Danny\'s selection is cleared after locking', a.selCount('Danny') === 0);
  check('Logan\'s is NOT', a.selCount('Logan') === 1, String(a.selCount('Logan')));

  // 11. a locked player's buttons are disabled so the card is not edited by accident
  const after = a.gamePickerHTML('g1');
  const dis = (after.match(/disabled/g) || []).length;
  check('Danny\'s buttons are disabled once locked', dis === 4, 'got ' + dis + ' disabled of 4');
  check('Logan\'s are not', /togglePickFor\('Logan'/.test(after) &&
    after.split('togglePickFor(\'Logan\'')[0].lastIndexOf('disabled') <
      after.lastIndexOf('class="gp-b '));

  // 12. the locked card is on screen, and so is the other player's state
  const panel = txt(node('lock-panel').innerHTML);
  check('the locked card is shown', /Danny/.test(panel) && /locked/.test(panel), panel.slice(0, 100));
  check('Logan still has a lock button', /id="lock-btn-Logan"/.test(node('lock-panel').innerHTML));

  // 13. re-pick reopens it
  a.repick('Danny');
  check('re-pick reopens the card', /open again/.test(a.lockMsg), a.lockMsg);
  check('and the buttons come back', !/disabled/.test(a.gamePickerHTML('g1')));

  // 14. renderGamePicker writes the guts in place, with no nested wrapper
  nodes['gp-g1'] = { id: 'gp-g1', _html: '', set innerHTML(v) { this._html = v; },
                     get innerHTML() { return this._html; } };
  a.renderGamePicker('g1');
  const guts = nodes['gp-g1'].innerHTML;
  check('a redraw fills the existing element', guts.includes('Raiders +5'), guts.slice(0, 60));
  check('and does not nest a second wrapper', !guts.includes('id="gp-g1"'), guts.slice(0, 80));
  check('a redraw of a game with no block is harmless',
    (() => { try { a.renderGamePicker('g2'); return true; } catch (e) { return false; } })());

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
