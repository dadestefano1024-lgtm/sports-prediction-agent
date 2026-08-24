// Do the key-number weights reproduce what actually happens?
//
// The verdict now SHOWS what a half point buys, so the figure has to be right
// rather than roughly right. Current weights are round hand-set numbers; this
// checks them against counted games and calibrates from the same data.
//
// Run: node calibrate-keys.js

const m = require('./model');
const URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';

function splitRow(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}

(async () => {
  const text = await (await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const lines = text.trim().split('\n');
  const cols = splitRow(lines[0]);
  const at = (n) => cols.indexOf(n);
  const [iType, iHS, iAS, iSpread] = ['game_type', 'home_score', 'away_score', 'spread_line'].map(at);

  const games = [];
  for (const l of lines.slice(1)) {
    const f = splitRow(l);
    if (f[iType] !== 'REG') continue;
    const num = (v) => (v === '' || v == null) ? null : Number(v);
    const hs = num(f[iHS]), as = num(f[iAS]), sp = num(f[iSpread]);
    if (hs === null || as === null || sp === null) continue;
    if (![hs, as, sp].every(Number.isFinite)) continue;
    games.push({ homeMargin: hs - as, spread: sp });
  }
  console.log(`${games.length} regular-season games with a closing spread\n`);

  // The question the verdict answers out loud: at a market line of L, how often
  // does the game land EXACTLY on the key number — because that share IS what
  // the half point across it buys.
  console.log('WHAT THE HALF POINT ACROSS A KEY NUMBER IS WORTH');
  console.log('  line   games    counted    model now    error');
  for (const L of [3, 7, 10, 6, 4]) {
    const set = games.filter(g => Math.abs(g.spread) === L);
    if (set.length < 150) continue;
    // favourite's margin, so the key number is positive
    const favMargins = set.map(g => (g.spread > 0 ? g.homeMargin : -g.homeMargin));
    const counted = favMargins.filter(x => x === L).length / set.length;
    const o = m.coverOutcomes({ predictedMargin: L, spread: -L, sigma: 10.82, sport: 'nfl' });
    console.log(`  ${String(L).padStart(4)}  ${String(set.length).padStart(5)}   ${(counted * 100).toFixed(1).padStart(6)}%   ` +
      `${(o.push * 100).toFixed(1).padStart(6)}%   ${((o.push - counted) * 100).toFixed(1).padStart(6)} pts`);
  }

  // Calibrate from the residual-centred distribution the model actually uses.
  console.log('\n\nCALIBRATING THE WEIGHTS FROM THE SAME GAMES');
  const favMarginsAll = games.map(g => (g.spread > 0 ? g.homeMargin : -g.homeMargin));
  const cal = m.calibrateMarginWeights(favMarginsAll, 10.82);
  if (!cal) { console.log('  not enough samples'); return; }
  console.log(`  ${cal.samples} games, mean favourite margin ${cal.mean}\n`);
  console.log('  margin   current   calibrated');
  const cur = m.NFL_KEY_NUMBER_WEIGHTS;
  const keys = [...new Set([...Object.keys(cur), ...Object.keys(cal.weights)])]
    .map(Number).sort((a, b) => a - b).filter(k => k <= 24);
  for (const k of keys) {
    const c = cur[k], n = cal.weights[k];
    if (c == null && (n == null || Math.abs(n - 1) < 0.12)) continue;
    console.log(`  ${String(k).padStart(6)}   ${String(c == null ? '1.00' : c.toFixed(2)).padStart(7)}   ${String(n == null ? '-' : n.toFixed(2)).padStart(10)}`);
  }
  console.log('\n  calibrated object:');
  console.log('  ' + JSON.stringify(Object.fromEntries(
    keys.filter(k => cal.weights[k] != null).map(k => [k, cal.weights[k]]))));
})();
