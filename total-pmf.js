// One counted integer PMF, so every offset is read off the same grid.
//
// The first table pooled whole-number and half-point lines into one survival
// curve, and those two do not live on the same grid: a residual from a 45 line
// is an integer, one from a 45.5 line is never zero. Reading a half-point
// offset off the pooled curve mixed the two populations and priced Under 45.5
// against a market 45 at 4.3% when the only games it gains are the ones
// totalling exactly 45 — 2.8%.
//
// Built from whole-number lines only, where the residual is a clean integer.
// Every over/push/under then comes from summing the same PMF.
//
// Run: node total-pmf.js

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
  const res = [];
  for (const l of rows.slice(1)) {
    const f = split(l);
    if (f[iT] !== 'REG') continue;
    const n = (v) => (v===''||v==null)?null:Number(v);
    const hs=n(f[iH]), as=n(f[iA]), tl=n(f[iTot]);
    if ([hs,as,tl].some(v=>v===null||!Number.isFinite(v))) continue;
    if (!Number.isInteger(tl)) continue;
    res.push((hs+as) - tl);
  }
  const LO = -34, HI = 34;
  const counts = {};
  for (let k = LO; k <= HI; k++) counts[k] = 0;
  let below = 0, above = 0;
  for (const r of res) {
    if (r < LO) below++; else if (r > HI) above++; else counts[r]++;
  }
  const n = res.length;
  console.log(`// ${n} games closed on a whole-number total`);
  console.log(`// ${below} below ${LO}, ${above} above ${HI} — folded into the end buckets`);
  counts[LO] += below; counts[HI] += above;

  const pmf = {};
  for (let k = LO; k <= HI; k++) pmf[k] = +(counts[k] / n).toFixed(5);
  // Make it sum to exactly one so over+push+under cannot drift.
  const total = Object.values(pmf).reduce((a,b)=>a+b,0);
  pmf[0] = +(pmf[0] + (1 - total)).toFixed(5);

  console.log('const NFL_TOTAL_PMF = {');
  console.log(`  games: ${n}, lo: ${LO}, hi: ${HI},`);
  console.log('  p: [');
  const arr = [];
  for (let k = LO; k <= HI; k++) arr.push(pmf[k]);
  for (let k = 0; k < arr.length; k += 10) console.log('    ' + arr.slice(k, k+10).join(', ') + ',');
  console.log('  ],');
  console.log('};');

  const sum = (f) => arr.reduce((a,v,idx) => a + (f(LO+idx) ? v : 0), 0);
  console.log(`\n// sums to ${arr.reduce((a,b)=>a+b,0).toFixed(6)}`);
  console.log(`// lands exactly on the number: ${(pmf[0]*100).toFixed(2)}%`);
  console.log(`// one point of total buys:     ${(pmf[0]*100).toFixed(2)}% at a whole line`);
  console.log(`// P(over) at offset 0:         ${(sum(k=>k>0)*100).toFixed(2)}%`);
  console.log(`// P(under) at offset 0:        ${(sum(k=>k<0)*100).toFixed(2)}%`);
})();
