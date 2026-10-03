'use strict';
/**
 * The stale-price rule in hockey, with 2023-24 as a real holdout.
 *
 * CHECKED: nhl-price.js (found the effect on 2024-25 and 2025-26 and built the
 * price extraction reused here), calibrate-sport.js (harvests the seasons),
 * frozen-test.js and stale-oos.js (the football rule, which was found on one
 * season and held out on another -- the same discipline).
 *
 * The rule: the puckline cannot go stale because it is fixed at 1.5, but the
 * PRICE can. Back the side the moneyline moved toward, at the OPENING price.
 *
 * WHY A HOLDOUT. The hypothesis was formed after looking at 2024-25 and 2025-26,
 * so neither of those can test it -- a threshold chosen after seeing the data is
 * fitted to it. 2023-24 has never been looked at. Its number on its own is the
 * only honest test, and it is stated FIRST below so it cannot be buried under a
 * pooled figure that includes the seasons the idea came from.
 *
 * Measured in PROBABILITY POINTS, not ROI. A one-point probability edge pays far
 * more ROI on a +200 dog than on a -200 favourite purely from the payout
 * multiplier, so ROI invents an asymmetry between the two. That is exactly what
 * it did on the first pass here: it reported the effect as dog-only when in
 * price-neutral terms both sides are positive.
 *
 * Run: node nhl-holdout.js
 */
const fs = require('fs');

const SEASONS = [
  ['./cal-nhl-rows-2024.json', '2023-24', 'HOLDOUT'],
  ['./cal-nhl-rows-2025.json', '2024-25', 'found on'],
  ['./cal-nhl-rows-2026.json', '2025-26', 'found on'],
];

const cache = JSON.parse(fs.readFileSync('./cal-nhl-cache.json', 'utf8'));
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace('+', '').trim());
  return Number.isFinite(n) ? n : null;
};
const prices = new Map();
for (const [url, val] of Object.entries(cache)) {
  const mm = /hockey\/leagues\/nhl\/events\/(\d+)\//.exec(url);
  if (!mm || !val || !val.items) continue;
  const it = (val.items || []).find(x => !/live/i.test((x.provider && x.provider.name) || '') &&
                                         x.homeTeamOdds && x.awayTeamOdds);
  if (!it) continue;
  const ml = (side, phase) => {
    const o = it[side] && it[side][phase];
    return (o && o.moneyLine) ? num(o.moneyLine.american) : null;
  };
  prices.set(mm[1], {
    hOpen: ml('homeTeamOdds', 'open'), hClose: ml('homeTeamOdds', 'current'),
    aOpen: ml('awayTeamOdds', 'open'), aClose: ml('awayTeamOdds', 'current'),
  });
}

const implied = (o) => o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
const profitOf = (o) => o > 0 ? o / 100 : 100 / Math.abs(o);

const load = (file, season) => {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const p = prices.get(String(r.id));
    if (!p) continue;
    if ([p.hOpen, p.hClose, p.aOpen, p.aClose].some(x => x === null)) continue;
    // De-vig each phase so the two sides sum to one; otherwise a change in the
    // book's margin reads as a change of opinion.
    const fair = (h, a) => { const ih = implied(h), ia = implied(a); return ih / (ih + ia); };
    out.push({ ...r, ...p, season,
      openFair: fair(p.hOpen, p.aOpen), closeFair: fair(p.hClose, p.aClose),
      homeWon: r.margin > 0 });
  }
  return out;
};

const all = [];
for (const [f, s] of SEASONS) all.push(...load(f, s));
const toward = (g) => (g.closeFair - g.openFair) > 0 ? 1 : -1;
const moved = (g, t) => Math.abs(g.closeFair - g.openFair) >= t;

/** Edge in probability points against the price actually taken. */
function edge(set, phase = 'open') {
  if (!set.length) return null;
  let impl = 0, act = 0, ret = 0;
  for (const g of set) {
    const s = toward(g);
    const p = phase === 'open' ? (s > 0 ? g.openFair : 1 - g.openFair)
                               : (s > 0 ? g.closeFair : 1 - g.closeFair);
    const odds = s > 0 ? (phase === 'open' ? g.hOpen : g.hClose)
                       : (phase === 'open' ? g.aOpen : g.aClose);
    const won = (s > 0) === g.homeWon;
    impl += p; act += won ? 1 : 0; ret += won ? profitOf(odds) : -1;
  }
  const n = set.length, ip = impl / n, ap = act / n;
  const se = Math.sqrt(ip * (1 - ip) / n) || 1e-9;
  return { n, ip, ap, d: ap - ip, z: (ap - ip) / se, roi: ret / n };
}
const line = (lab, e) => {
  if (!e || e.n < 40) { console.log('  ' + lab.padEnd(30) + 'too few (' + (e ? e.n : 0) + ')'); return; }
  console.log('  ' + lab.padEnd(30) + 'implied ' + (e.ip * 100).toFixed(1) +
    '%  actual ' + (e.ap * 100).toFixed(1) + '%  edge ' + (e.d >= 0 ? '+' : '') +
    (e.d * 100).toFixed(2) + ' pts  ' + e.z.toFixed(2) + ' SD  ROI ' +
    (e.roi >= 0 ? '+' : '') + (e.roi * 100).toFixed(1) + '%  n=' + e.n);
};

console.log('games loaded per season:');
for (const [, s, tag] of SEASONS) {
  console.log('  ' + s + '  ' + all.filter(g => g.season === s).length + '  (' + tag + ')');
}
console.log('');

const hold = all.filter(g => g.season === '2023-24' && moved(g, 0.01));
console.log('=== THE HOLDOUT, ON ITS OWN. 2023-24 was never looked at. ===');
line('moved >= 1 pt, at the OPEN', edge(hold));
line('  the same bets at the CLOSE', edge(hold, 'close'));
const isDog = (g) => (toward(g) > 0) === (g.openFair < 0.5);
line('  at a DOG', edge(hold.filter(isDog)));
line('  at a FAVOURITE', edge(hold.filter(g => !isDog(g))));
line('  CONTROL: fade the move', (() => {
  const e = edge(hold);
  if (!e) return null;
  // fading is the complement: implied flips, actual flips
  return { n: e.n, ip: 1 - e.ip, ap: 1 - e.ap, d: (1 - e.ap) - (1 - e.ip),
           z: -e.z, roi: NaN };
})());
console.log('');

console.log('=== ALL THREE SEASONS, each on its own ===');
for (const [, s] of SEASONS) line(s, edge(all.filter(g => g.season === s && moved(g, 0.01))));
console.log('');

const pooled = all.filter(g => moved(g, 0.01));
console.log('=== POOLED ===');
line('moved >= 1 pt, at the OPEN', edge(pooled));
line('the same bets at the CLOSE', edge(pooled, 'close'));
line('at a DOG', edge(pooled.filter(isDog)));
line('at a FAVOURITE', edge(pooled.filter(g => !isDog(g))));
console.log('');
console.log('=== IS IT MONOTONE IN HOW STALE THE PRICE IS? ===');
console.log('  (a real staleness effect should grow, not shrink)');
for (const t of [0.01, 0.02, 0.03, 0.05]) {
  line('moved >= ' + (t * 100) + ' pts', edge(all.filter(g => moved(g, t))));
}
console.log('');
console.log('=== GATES ===');
const g1 = edge(pooled.filter(isDog)), g2 = edge(pooled.filter(g => !isDog(g)));
const perSeason = SEASONS.map(([, s]) => edge(all.filter(g => g.season === s && moved(g, 0.01))));
const p = edge(pooled);
const bothSides = g1 && g2 && g1.d > 0 && g2.d > 0;
const everySeason = perSeason.every(e => e && e.d > 0);
const big = p && p.z >= 2.5;
const holdoutOk = (() => { const e = edge(hold); return e && e.d > 0 && e.z >= 2; })();
console.log('  both sides positive        ' + (bothSides ? 'PASS' : 'fail'));
console.log('  every season positive      ' + (everySeason ? 'PASS' : 'fail'));
console.log('  pooled >= 2.5 SD           ' + (big ? 'PASS' : 'fail'));
console.log('  HOLDOUT positive, >= 2 SD  ' + (holdoutOk ? 'PASS' : 'fail') +
  '   <- the one that matters');
