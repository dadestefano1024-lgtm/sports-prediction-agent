// Is a point of total always worth the same, and do totals land on whole numbers?
//
// The working now prints what a better number buys, and every total on the live
// card printed the identical 3.8 points — because totals are priced with a
// continuous normal at a fixed sigma, which cannot tell 38.5 from 49.5 and
// gives a whole-number total a push probability of exactly zero.
//
// Spreads had precisely this defect and it was worth 2.2 points at the 3.
//
// Run: node totals-shape.js

const URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const split = (l) => { const o=[]; let c='',q=false;
  for (const ch of l){ if(ch==='"'){q=!q;continue;} if(ch===','&&!q){o.push(c);c='';continue;} c+=ch; }
  o.push(c); return o; };

(async () => {
  const text = await (await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const rows = text.trim().split('\n');
  const cols = split(rows[0]);
  const i = (n) => cols.indexOf(n);
  const [iT,iH,iA,iTot] = ['game_type','home_score','away_score','total_line'].map(i);
  const games = [];
  for (const l of rows.slice(1)) {
    const f = split(l);
    if (f[iT] !== 'REG') continue;
    const n = (v) => (v===''||v==null)?null:Number(v);
    const hs=n(f[iH]), as=n(f[iA]), tl=n(f[iTot]);
    if ([hs,as,tl].some(v=>v===null||!Number.isFinite(v))) continue;
    games.push({ points: hs+as, line: tl });
  }
  console.log(`${games.length} games with a closing total\n`);

  // 1. How often does a whole-number total push?
  const whole = games.filter(g => Number.isInteger(g.line));
  const pushes = whole.filter(g => g.points === g.line).length;
  console.log('WHOLE-NUMBER TOTALS');
  console.log(`  ${whole.length} games closed on a whole number`);
  console.log(`  ${pushes} landed exactly on it — ${(pushes/whole.length*100).toFixed(1)}%`);
  console.log(`  the model currently says 0.0%\n`);

  // 2. Does a point of total buy the same everywhere?
  console.log('WHAT ONE POINT OF TOTAL ACTUALLY BUYS, by where the total sits');
  console.log('  (share of games landing in the one-point window just below the line —');
  console.log('   that IS what moving the line down a point converts from loss to win)\n');
  console.log('  total band   games   pts bought   model says');
  const bands = [[35,42],[42,45],[45,48],[48,51],[51,60]];
  for (const [lo,hi] of bands) {
    const set = games.filter(g => g.line >= lo && g.line < hi);
    if (set.length < 200) continue;
    // over bettor moving from line L to L-1 gains games landing in (L-1, L]
    let gained = 0;
    for (const g of set) if (g.points > g.line - 1 && g.points <= g.line) gained++;
    console.log(`  ${String(lo).padStart(2)}-${String(hi).padEnd(2)}       ${String(set.length).padStart(5)}   ` +
      `${(gained/set.length*100).toFixed(1).padStart(6)}%       3.8%`);
  }

  // 3. Are totals actually normal with sigma 10.5?
  const resid = games.map(g => g.points - g.line);
  const mean = resid.reduce((a,b)=>a+b,0)/resid.length;
  const sd = Math.sqrt(resid.reduce((a,b)=>a+(b-mean)**2,0)/resid.length);
  console.log(`\nRESIDUAL (points minus closing total)`);
  console.log(`  mean ${mean.toFixed(2)}, sd ${sd.toFixed(2)} — model uses totalSigma 10.5`);
})();
