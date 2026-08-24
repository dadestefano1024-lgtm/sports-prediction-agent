// Fit totalSigma to what a point of total actually buys.
//
// Same reasoning as the spread sigma, which is 10.82 rather than its measured
// SD of 12.38 because nearly every call asks how much probability a few points
// buys, and that is a question about the middle of the distribution. The total
// residual has an SD of 13.39 and a middle flatter than a normal with that SD,
// so pricing off the SD overstates a point by a third.
//
// Run: node fit-total-sigma.js

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

  // What the market's own number is worth at each offset: how often does the
  // game land more than k points above the line? A correct sigma reproduces
  // this curve, not just its variance.
  console.log(`${games.length} games\n`);
  console.log('OVER RATE AT AN OFFSET FROM THE CLOSING TOTAL');
  console.log('  offset   real     sigma 10.5   sigma 13.4   sigma 14.7');
  const erf = (x) => { const t=1/(1+0.3275911*Math.abs(x));
    const y=1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
    return x>=0?y:-y; };
  const cdf = (z) => 0.5*(1+erf(z/Math.SQRT2));
  for (const off of [0, 1, 2, 3, 5, 7]) {
    const real = games.filter(g => g.points > g.line + off).length / games.length;
    const cells = [10.5, 13.39, 14.7].map(s => (( 1-cdf(off/s) )*100).toFixed(1).padStart(10)).join('  ');
    console.log(`  ${String(off).padStart(6)}   ${(real*100).toFixed(1).padStart(5)}%   ${cells}`);
  }

  // Fit: minimise squared error across those offsets.
  let best = null;
  for (let s = 8; s <= 22; s += 0.01) {
    let err = 0;
    for (const off of [1, 2, 3, 4, 5, 6, 7]) {
      const real = games.filter(g => g.points > g.line + off).length / games.length;
      const model = 1 - cdf(off / s);
      err += (real - model) ** 2;
    }
    if (!best || err < best.err) best = { s: +s.toFixed(2), err };
  }
  console.log(`\n  best fit: totalSigma ${best.s}`);

  const whole = games.filter(g => Number.isInteger(g.line));
  const push = whole.filter(g => g.points === g.line).length / whole.length;
  console.log(`\n  a discrete distribution at that sigma puts ${(0.3989/best.s*100).toFixed(1)}% on the exact number`);
  console.log(`  measured push rate on whole-number totals: ${(push*100).toFixed(1)}% (${whole.length} games)`);
})();
