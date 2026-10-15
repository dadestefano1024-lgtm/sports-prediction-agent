'use strict';
/**
 * Run the REAL lock-panel code out of index.html against a fake DOM.
 *
 * CHECKED: shop-test.js and render-preview.js, which lift their subject out of
 * the page the same way rather than reimplementing it -- a preview that
 * reimplements the thing it previews proves nothing. Tonight also established
 * that "the inline script parses" catches nothing: a lost `$` in a template
 * literal, a reference error 3,000 lines from its declaration and a cache key
 * doubling as a path key all parsed cleanly and were all broken.
 *
 * Exercises: empty state, the picker, the six-pick cap, locking (what gets
 * PUT), and the locked-card view.
 *
 * Run: node picker-test.js
 */
const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const start = html.indexOf('    let poolPlayer = (() => {');
const endMark = '    function renderPool() {';
const end = html.indexOf(endMark, start);
if (start < 0 || end < 0) throw new Error('could not find the lock-panel block');
const code = html.slice(start, end);

// --- the smallest DOM that renderLockPanel actually touches ---------------
let mounted = '';
const el = { set innerHTML(v) { mounted = v; }, get innerHTML() { return mounted; } };
const buttons = {};
const document = {
  getElementById: (id) => {
    if (id === 'lock-panel') return el;
    if (!buttons[id]) buttons[id] = { disabled: false, textContent: '' };
    return buttons[id];
  },
};
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
let lastPut = null;
const fetch = async (url, opts) => {
  if (opts && opts.method === 'PUT') {
    lastPut = { url, body: JSON.parse(opts.body) };
    return { json: async () => ({ locked: lastPut.body.picks.length }) };
  }
  // the GET after a lock: echo the card back the way the server shapes it
  const picks = lastPut ? lastPut.body.picks.map(p => ({
    pick: p.pick, home_team: p.homeTeam, away_team: p.awayTeam, result: null,
  })) : [];
  const cards = lastPut ? {
    [lastPut.body.player]: {
      player: lastPut.body.player, lockedAt: '2026-10-15T01:00:00Z', picks,
      wins: 0, losses: 0, pushes: 0, pending: picks.length,
      perfect: false, blown: false,
    },
  } : {};
  return { json: async () => ({ cards }) };
};

const api = new Function('document', 'localStorage', 'fetch', 'nflWeek',
  code + '\nreturn { setPoolPlayer, toggleCardPick, lockCard, loadLockedCards,' +
         ' renderLockPanel, cardKey,' +
         ' get poolPlayer(){return poolPlayer}, get cardPicks(){return cardPicks},' +
         ' set poolCandidates(v){poolCandidates = v},' +
         ' set lockedCards(v){lockedCards = v} };'
)(document, localStorage, fetch, 6);

const txt = () => mounted.replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '.')
  .replace(/&rsquo;/g, "'").replace(/&mdash;/g, '-').replace(/\s+/g, ' ').trim();

const CANDS = [
  { gameId: '1', market: 'spread', side: 'away', pick: 'Las Vegas Raiders +7', poolLine: 7,
    winProb: 0.565, matchup: 'Bills @ Raiders', homeTeam: 'Las Vegas Raiders', awayTeam: 'Buffalo Bills' },
  { gameId: '2', market: 'spread', side: 'home', pick: 'Philadelphia Eagles +3', poolLine: 3,
    winProb: 0.565, matchup: 'Panthers @ Eagles', homeTeam: 'Philadelphia Eagles', awayTeam: 'Carolina Panthers' },
  { gameId: '3', market: 'spread', side: 'home', pick: 'New York Giants +3', poolLine: 3,
    winProb: 0.544, matchup: 'Saints @ Giants', homeTeam: 'New York Giants', awayTeam: 'New Orleans Saints' },
  { gameId: '4', market: 'spread', side: 'away', pick: 'New York Jets +8', poolLine: -8,
    winProb: 0.531, matchup: 'Jets @ Patriots', homeTeam: 'New England Patriots', awayTeam: 'New York Jets' },
  { gameId: '5', market: 'spread', side: 'home', pick: 'Cleveland Browns +6', poolLine: 6,
    winProb: 0.514, matchup: 'Ravens @ Browns', homeTeam: 'Cleveland Browns', awayTeam: 'Baltimore Ravens' },
  { gameId: '6', market: 'total', side: 'under', pick: 'Under 43', poolLine: 43,
    winProb: 0.525, matchup: 'Texans @ Jaguars', homeTeam: 'Jacksonville Jaguars', awayTeam: 'Houston Texans' },
  { gameId: '7', market: 'spread', side: 'home', pick: 'Kansas City Chiefs -8', poolLine: -8,
    winProb: 0.485, matchup: 'Chargers @ Chiefs', homeTeam: 'Kansas City Chiefs', awayTeam: 'Los Angeles Chargers' },
];

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '   ' + extra : '')); }
};

console.log('LOCK PANEL, real code against a fake DOM\n');

// 1. nothing ranked yet
api.poolCandidates = [];
api.renderLockPanel();
check('empty state tells you to rank first', /Rank the week first/.test(txt()), txt().slice(0, 70));
check('both players get a tab', /Danny/.test(mounted) && /Logan/.test(mounted));
check('Danny is the default', api.poolPlayer === 'Danny');

// 2. the picker
api.poolCandidates = CANDS;
api.renderLockPanel();
// /class="pl-opt/ also matched the CONTAINER, class="pl-opts" -- 7 candidates
// read as 8. The option class is always followed by a space before the state.
const optCount = () => (mounted.match(/class="pl-opt /g) || []).length;
check('every candidate is offered', optCount() === CANDS.length, 'got ' + optCount());
check('lock is disabled with nothing chosen', /id="lock-btn" disabled/.test(mounted));

// 3. choose six
for (const c of CANDS.slice(0, 6)) api.toggleCardPick(api.cardKey(c));
check('six chosen', Object.keys(api.cardPicks).length === 6);
check('the count is shown', /6 of 6/.test(txt()), txt().slice(0, 80));

// 4. the cap
api.toggleCardPick(api.cardKey(CANDS[6]));
check('a seventh is refused', Object.keys(api.cardPicks).length === 6);

// 5. deselect works
api.toggleCardPick(api.cardKey(CANDS[0]));
check('deselect frees a slot', Object.keys(api.cardPicks).length === 5);
api.toggleCardPick(api.cardKey(CANDS[0]));

// 6. lock
(async () => {
  await api.lockCard();
  check('a PUT was sent', !!lastPut, 'nothing sent');
  if (lastPut) {
    check('to the card endpoint', /\/api\/pool\/nfl\/card$/.test(lastPut.url), lastPut.url);
    check('for the right player', lastPut.body.player === 'Danny', lastPut.body.player);
    check('with the week', lastPut.body.week === 6, String(lastPut.body.week));
    check('six picks', lastPut.body.picks.length === 6, String(lastPut.body.picks.length));
    const p = lastPut.body.picks[0];
    check('each pick carries gameId, market, side, pick, line',
      p.gameId && p.market && p.side && p.pick && p.line !== undefined, JSON.stringify(p));
    check('and the teams, so the row can be graded',
      !!(p.homeTeam && p.awayTeam), JSON.stringify(p));
  }
  check('selection cleared after locking', Object.keys(api.cardPicks).length === 0);
  check('the locked card is shown', /locked/.test(txt()), txt().slice(0, 90));
  check('and the picker is gone', !/id="lock-btn"/.test(mounted));

  // 7. switching player clears the half-built card
  api.poolCandidates = CANDS;
  api.toggleCardPick(api.cardKey(CANDS[0]));
  api.setPoolPlayer('Logan');
  check('switching player clears the selection', Object.keys(api.cardPicks).length === 0);
  check('Logan is now current', api.poolPlayer === 'Logan');
  check("Danny's card is visible to Logan", /Danny/.test(txt()), txt().slice(0, 120));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
