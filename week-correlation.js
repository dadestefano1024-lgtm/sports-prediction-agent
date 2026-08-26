// Do covers cluster within a week?
//
// This matters only because of the format. Paid per win, correlation is noise
// you want to diversify away. Paid ONLY at 6-0, correlation is the opposite —
// if favourites tend to cover together, a card of six favourites goes 6-0 more
// often than 0.565^6 says, and cardOdds is understating it. If covers are
// independent, the product is right and there is nothing here.
//
// Test: per week, what share of favourites covered? If weeks were independent
// coin flips the spread of that share is binomial. Wider than binomial means
// the outcomes move together.
//
// Run: node week-correlation.js

const URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const split = (l) => { const o=[]; let c='',q=false;
  for (const ch of l){ if(ch==='"'){q=!q;continue;} if(ch===','&&!q){o.push(c);c='';continue;} c+=ch; }
  o.push(c); return o; };

(async () => {
  const text = await (await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const rows = text.trim().split('\n');
  const cols = split(rows[0]);
  const i = (n) => cols.indexOf(n);
  const [iT,iH,iA,iS,iSeason,iWeek,iTot] =
    ['game_type','home_score','away_score','spread_line','season','week','total_line'].map(i);

  const weeks = new Map();
  for (const l of rows.slice(1)) {
    const f = split(l);
    if (f[iT] !== 'REG') continue;
    const n = (v) => (v===''||v==null)?null:Number(v);
    const hs=n(f[iH]), as=n(f[iA]), sp=n(f[iS]), tl=n(f[iTot]);
    if ([hs,as,sp].some(v=>v===null||!Number.isFinite(v))) continue;
    if (sp === 0) continue;
    const key = `${f[iSeason]}-${f[iWeek]}`;
    if (!weeks.has(key)) weeks.set(key, []);
    const homeMargin = hs - as;
    const favCovered = (sp > 0 ? homeMargin : -homeMargin) > Math.abs(sp);
    const overHit = (tl !== null && Number.isFinite(tl)) ? (hs + as) > tl : null;
    weeks.get(key).push({ favCovered, overHit });
  }

  const analyse = (label, pick) => {
    const shares = [], sizes = [];
    let hits = 0, total = 0;
    for (const games of weeks.values()) {
      const usable = games.map(pick).filter(v => v !== null);
      if (usable.length < 10) continue;
      const k = usable.filter(Boolean).length;
      shares.push(k / usable.length); sizes.push(usable.length);
      hits += k; total += usable.length;
    }
    const p = hits / total;
    const meanN = sizes.reduce((a,b)=>a+b,0) / sizes.length;
    const observedVar = shares.reduce((a,s)=>a+(s-p)**2,0) / shares.length;
    const binomialVar = p * (1 - p) / meanN;
    const ratio = observedVar / binomialVar;
    console.log(`\n${label}`);
    console.log(`  ${shares.length} weeks, ${total} games, base rate ${(p*100).toFixed(1)}%`);
    console.log(`  spread of the weekly share : ${(Math.sqrt(observedVar)*100).toFixed(2)} pts`);
    console.log(`  if weeks were independent  : ${(Math.sqrt(binomialVar)*100).toFixed(2)} pts`);
    console.log(`  ratio of variances         : ${ratio.toFixed(3)}` +
      (ratio > 1.25 ? '   <- covers CLUSTER' : ratio < 0.85 ? '   <- covers spread out' : '   <- independent, near enough'));
    return { p, ratio, weeks: shares.length };
  };

  const fav = analyse('FAVOURITES COVERING', g => g.favCovered);
  const ovr = analyse('OVERS HITTING', g => g.overHit);

  // What clustering would be worth on a six-pick all-must-win card.
  console.log('\n\nWHAT THIS DOES TO A SIX-PICK CARD');
  console.log('  (a beta-binomial with the measured overdispersion, against the plain product)\n');
  const cardProb = (p, ratio, n = 6) => {
    if (ratio <= 1.0001) return Math.pow(p, n);
    // Match the observed variance: rho scales the pairwise correlation.
    const meanN = 15;
    const rho = Math.max(0, (ratio - 1) / (meanN - 1));
    // Beta-binomial P(all n succeed) = prod_{k=0..n-1} (p + k*rho) / (1 + k*rho)
    let acc = 1;
    for (let k = 0; k < n; k++) acc *= (p + k * rho) / (1 + k * rho);
    return acc;
  };
  for (const [label, r] of [['favourites', fav], ['overs', ovr]]) {
    for (const p of [0.55, 0.58]) {
      const indep = Math.pow(p, 6);
      const clustered = cardProb(p, r.ratio);
      console.log(`  six ${label} at ${(p*100).toFixed(0)}%: independent ${(indep*100).toFixed(2)}%  ` +
        `clustered ${(clustered*100).toFixed(2)}%  (${((clustered/indep - 1)*100).toFixed(1)}%)`);
    }
  }
})();
