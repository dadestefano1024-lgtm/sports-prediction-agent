// Solve each key weight against the CONDITIONAL rate, not the pooled one.
//
// Pooling every line together and dividing by a smooth curve produces a table
// whose tail is noise — it wanted weight 2.32 at a margin of 24. The number the
// verdict shows is a conditional one ("games lined at 3 land on 3 this often"),
// so that is what the weight should be fitted to, and only where there are
// enough games to mean anything.
//
// Run: node solve-keys.js

const m = require('./model');
const URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const split = (line) => { const o=[]; let c='',q=false;
  for (const ch of line){ if(ch==='"'){q=!q;continue;} if(ch===','&&!q){o.push(c);c='';continue;} c+=ch; }
  o.push(c); return o; };

(async () => {
  const text = await (await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const rows = text.trim().split('\n');
  const cols = split(rows[0]);
  const i = (n) => cols.indexOf(n);
  const [iT,iH,iA,iS] = ['game_type','home_score','away_score','spread_line'].map(i);
  const games = [];
  for (const l of rows.slice(1)) {
    const f = split(l);
    if (f[iT] !== 'REG') continue;
    const n = (v) => (v===''||v==null)?null:Number(v);
    const hs=n(f[iH]), as=n(f[iA]), sp=n(f[iS]);
    if ([hs,as,sp].some(v=>v===null||!Number.isFinite(v))) continue;
    games.push({ fav: sp>0 ? hs-as : as-hs, line: Math.abs(sp) });
  }

  const counted = (L) => {
    const set = games.filter(g => g.line === L);
    return { n: set.length, rate: set.filter(g => g.fav === L).length / set.length };
  };

  // Push probability the model gives at line L, with weight w at margin L.
  const modelPush = (L, w) => {
    const saved = m.NFL_KEY_NUMBER_WEIGHTS[L];
    m.NFL_KEY_NUMBER_WEIGHTS[L] = w;
    const o = m.coverOutcomes({ predictedMargin: L, spread: -L, sigma: 10.82, sport: 'nfl' });
    if (saved === undefined) delete m.NFL_KEY_NUMBER_WEIGHTS[L]; else m.NFL_KEY_NUMBER_WEIGHTS[L] = saved;
    return o.push;
  };

  console.log('SOLVING each weight so the model reproduces the counted rate\n');
  console.log('  key   games   counted   weight now -> solved   model after');
  const solved = {};
  for (const L of [3, 7, 6, 4, 10, 14]) {
    const c = counted(L);
    if (c.n < 300) { console.log(`  ${String(L).padStart(3)}   ${String(c.n).padStart(5)}   only ${c.n} games — left alone`); continue; }
    let lo = 0.05, hi = 6;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (modelPush(L, mid) < c.rate) lo = mid; else hi = mid;
    }
    const w = +((lo + hi) / 2).toFixed(3);
    solved[L] = w;
    console.log(`  ${String(L).padStart(3)}   ${String(c.n).padStart(5)}   ${(c.rate*100).toFixed(1).padStart(6)}%   ` +
      `${String(m.NFL_KEY_NUMBER_WEIGHTS[L] ?? 1).padStart(6)} -> ${String(w).padStart(5)}   ${(modelPush(L,w)*100).toFixed(1)}%`);
  }
  console.log('\n  solved weights:', JSON.stringify(solved));

  // What this changes for the number the verdict prints.
  console.log('\n\nWHAT THE HALF POINT IS WORTH, before and after');
  const half = (L, side) => {
    const a = m.coverOutcomes({ predictedMargin: L, spread: -L, sigma: 10.82, sport: 'nfl' });
    const b = m.coverOutcomes({ predictedMargin: L, spread: -(L + (side==='dog'?0.5:-0.5)), sigma: 10.82, sport: 'nfl' });
    return side==='dog' ? (a.loss + a.push) - a.loss : 0;  // dog gains the push
  };
  for (const L of [3, 7]) {
    const before = m.coverOutcomes({ predictedMargin: L, spread: -L, sigma: 10.82, sport: 'nfl' }).push;
    Object.assign(m.NFL_KEY_NUMBER_WEIGHTS, solved);
    const after = m.coverOutcomes({ predictedMargin: L, spread: -L, sigma: 10.82, sport: 'nfl' }).push;
    console.log(`  dog +${L} -> +${L}.5 : was ${(before*100).toFixed(1)} pts, now ${(after*100).toFixed(1)} pts, counted ${(counted(L).rate*100).toFixed(1)} pts`);
  }
})();
