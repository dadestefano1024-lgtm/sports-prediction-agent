// What is a half point actually worth, and where?
//
// "3 and 7 are key numbers" is repeated everywhere and almost never costed. The
// question that matters is the practical one: given a choice, is +4 a better
// buy than +3, and by how much — and does the answer flip depending on which
// side is being taken?
//
// Measured on 7,239 regular-season games with a closing spread and a final
// score. The distribution of margins is conditioned on the closing line, which
// matters: how often a game lands on 3 is very different in a game the market
// made a field goal than in one it made a touchdown, and pooling them smears
// out the exact spikes the question is about.
//
// Run: node keynumbers.js

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

  // favMargin: how much the FAVOURITE won by. Negative means it lost.
  const games = [];
  for (const l of lines.slice(1)) {
    const f = splitRow(l);
    if (f[iType] !== 'REG') continue;
    const raw = (v) => (v === '' || v == null) ? null : Number(v);
    const hs = raw(f[iHS]), as = raw(f[iAS]), sp = raw(f[iSpread]);
    if (hs === null || as === null || sp === null) continue;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || !Number.isFinite(sp)) continue;
    if (sp === 0) continue;                       // pick-em has no favourite
    const homeMargin = hs - as;
    // nflverse states spread_line as points the HOME side is favoured by.
    const favMargin = sp > 0 ? homeMargin : -homeMargin;
    games.push({ line: Math.abs(sp), favMargin });
  }
  console.log(`${games.length} games with a favourite and a final score\n`);

  // How often does a game land EXACTLY on each number, given the line?
  const show = (lineVal) => {
    const set = games.filter(g => Math.abs(g.line - lineVal) < 1e-9);
    if (set.length < 100) return null;
    const on = (k) => set.filter(g => g.favMargin === k).length / set.length;
    return { n: set.length, set, on };
  };

  console.log('WHERE GAMES LAND, by the line the market set');
  console.log('  (share of games decided by exactly that margin, favourite\'s view)\n');
  console.log('  line   games    by 1    by 2    by 3    by 4    by 5    by 6    by 7    by 8');
  for (const L of [2.5, 3, 3.5, 4, 6.5, 7, 7.5, 10]) {
    const r = show(L);
    if (!r) { console.log(`  ${String(L).padStart(4)}   too few`); continue; }
    const cells = [1, 2, 3, 4, 5, 6, 7, 8].map(k => (r.on(k) * 100).toFixed(1).padStart(6)).join('  ');
    console.log(`  ${String(L).padStart(4)}  ${String(r.n).padStart(5)}  ${cells}`);
  }

  // The practical question: what does each half point buy?
  //
  // Held against the SAME games — those the market lined at 3 — so the only
  // thing changing is the number being bought.
  console.log('\n\nWHAT A HALF POINT BUYS, on games the market lined at 3');
  const at3 = games.filter(g => g.line === 3);
  const coverFav = (set, L) => set.filter(g => g.favMargin > L).length / set.length;
  const pushFav = (set, L) => (Number.isInteger(L) ? set.filter(g => g.favMargin === L).length / set.length : 0);
  const coverDog = (set, L) => set.filter(g => -g.favMargin > -L).length / set.length;  // dog +L wins if favMargin < L

  console.log(`  ${at3.length} games\n`);
  console.log('  taking the FAVOURITE                    taking the UNDERDOG');
  console.log('  line     win     push    lose           line     win     push    lose');
  for (const L of [2.5, 3, 3.5, 4]) {
    const fw = coverFav(at3, L), fp = pushFav(at3, L), fl = 1 - fw - fp;
    const dw = at3.filter(g => g.favMargin < L).length / at3.length;
    const dp = pushFav(at3, L), dl = 1 - dw - dp;
    console.log(`  -${String(L).padEnd(5)} ${(fw * 100).toFixed(1).padStart(6)}%  ${(fp * 100).toFixed(1).padStart(6)}%  ${(fl * 100).toFixed(1).padStart(6)}%` +
      `          +${String(L).padEnd(5)} ${(dw * 100).toFixed(1).padStart(6)}%  ${(dp * 100).toFixed(1).padStart(6)}%  ${(dl * 100).toFixed(1).padStart(6)}%`);
  }

  console.log('\n  the value of each step, in win probability:');
  const step = (a, b, side) => {
    const f = (L) => side === 'fav'
      ? at3.filter(g => g.favMargin > L).length / at3.length
      : at3.filter(g => g.favMargin < L).length / at3.length;
    return (f(b) - f(a)) * 100;
  };
  console.log(`    favourite  -3   -> -3.5 : ${step(3, 3.5, 'fav').toFixed(1)} pts`);
  console.log(`    favourite  -3.5 -> -4   : ${step(3.5, 4, 'fav').toFixed(1)} pts`);
  console.log(`    favourite  -2.5 -> -3   : ${step(2.5, 3, 'fav').toFixed(1)} pts`);
  console.log(`    underdog   +3   -> +3.5 : ${step(3, 3.5, 'dog').toFixed(1)} pts`);
  console.log(`    underdog   +3.5 -> +4   : ${step(3.5, 4, 'dog').toFixed(1)} pts`);
  console.log(`    underdog   +2.5 -> +3   : ${step(2.5, 3, 'dog').toFixed(1)} pts`);

  console.log('\n\nSAME QUESTION AT 7, on games the market lined at 7');
  const at7 = games.filter(g => g.line === 7);
  const step7 = (a, b, side) => {
    const f = (L) => side === 'fav'
      ? at7.filter(g => g.favMargin > L).length / at7.length
      : at7.filter(g => g.favMargin < L).length / at7.length;
    return (f(b) - f(a)) * 100;
  };
  console.log(`  ${at7.length} games`);
  console.log(`    underdog   +6.5 -> +7   : ${step7(6.5, 7, 'dog').toFixed(1)} pts`);
  console.log(`    underdog   +7   -> +7.5 : ${step7(7, 7.5, 'dog').toFixed(1)} pts`);
  console.log(`    underdog   +7.5 -> +8   : ${step7(7.5, 8, 'dog').toFixed(1)} pts`);

  console.log('\n\nAND A NUMBER THAT IS NOT KEY, for contrast (lined at 10)');
  const at10 = games.filter(g => g.line === 10);
  const step10 = (a, b) => {
    const f = (L) => at10.filter(g => g.favMargin < L).length / at10.length;
    return (f(b) - f(a)) * 100;
  };
  console.log(`  ${at10.length} games`);
  for (const [a, b] of [[9.5, 10], [10, 10.5], [10.5, 11]]) {
    console.log(`    underdog   +${a} -> +${b} : ${step10(a, b).toFixed(1)} pts`);
  }
})();
