// Build a counted table for total residuals, the way NFL_RESIDUALS was built
// for spreads.
//
// A fitted normal cannot do this job: the tails want a sigma near 12.6 and the
// middle wants one near 14.7, because the total residual is flatter in the
// centre than any normal with the same spread. Pricing off the tail fit
// overstated what a point buys by a third, and every total on the card printed
// the same 3.8% regardless of where it sat.
//
// Emits two things: a survival curve for over/under, and a counted integer PMF
// so a whole-number total can push instead of silently being called a loss.
//
// Run: node total-residual-table.js

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
  const all = [], wholeLine = [];
  for (const l of rows.slice(1)) {
    const f = split(l);
    if (f[iT] !== 'REG') continue;
    const n = (v) => (v===''||v==null)?null:Number(v);
    const hs=n(f[iH]), as=n(f[iA]), tl=n(f[iTot]);
    if ([hs,as,tl].some(v=>v===null||!Number.isFinite(v))) continue;
    const r = (hs+as) - tl;
    all.push(r);
    if (Number.isInteger(tl)) wholeLine.push(r);
  }

  const FROM = -30, STEP = 0.5, TO = 30;
  const survival = [];
  for (let x = FROM; x <= TO + 1e-9; x += STEP) {
    survival.push(+(all.filter(r => r > x).length / all.length).toFixed(5));
  }
  console.log(`// ${all.length} games`);
  console.log('const NFL_TOTAL_RESIDUALS = {');
  console.log(`  games: ${all.length},`);
  console.log(`  from: ${FROM}, step: ${STEP},`);
  console.log('  survival: [');
  for (let k = 0; k < survival.length; k += 10) {
    console.log('    ' + survival.slice(k, k+10).join(', ') + ',');
  }
  console.log('  ],');

  // Counted chance the game lands exactly on a whole-number total, by how far
  // that number sits from the expectation.
  const pmf = {};
  for (let k = -12; k <= 12; k++) {
    const c = wholeLine.filter(r => r === k).length / wholeLine.length;
    if (c > 0.0005) pmf[k] = +c.toFixed(5);
  }
  console.log(`  // ${wholeLine.length} games closed on a whole number; how often the`);
  console.log('  // final total lands exactly k points off it.');
  console.log('  exact: ' + JSON.stringify(pmf) + ',');
  console.log('};');

  const onTheNumber = wholeLine.filter(r => r === 0).length / wholeLine.length;
  console.log(`\n// push on a whole-number total: ${(onTheNumber*100).toFixed(2)}%`);
  let gain = 0;
  for (const r of all) if (r > -1 && r <= 0) gain++;
  console.log(`// one point of total buys: ${(gain/all.length*100).toFixed(2)}%`);
})();
