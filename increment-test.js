'use strict';
/**
 * Does anything we collect add to line movement, or is it all already priced in?
 *
 * CHECKED: frozen-test.js (built the 690-game frozen-line harness this reuses,
 * and recorded the negative result for the projection), reach.js (established
 * that none of these inputs reaches a pick today), week-correlation.js (pulls
 * the same nflverse games.csv), efftest.js (yards-per-play, already rejected).
 *
 * The app picks on one thing: back the side the market moved toward, at the
 * frozen Wednesday number. That rule is holdout-tested. Everything else we
 * gather -- the starting quarterback, wind, temperature, the roof, rest days,
 * recent form -- is displayed and never scored. The open question is whether any
 * of it says something the market's own move has not already said.
 *
 * The prior is that it does not, and for a specific reason: the market move IS
 * the news. Atlanta's line went four points because the money knew the starter
 * was out. Reading the quarterback separately would count the same fact twice.
 *
 * THREE GATES, applied to every signal, because a 2-SD cell is guaranteed at this
 * much slicing. A signal counts only if it:
 *   1. shows up in BOTH movement buckets (1-2pt and >=2pt), and
 *   2. holds its direction across every season without decaying, and
 *   3. clears 2.5 SD, the crude price of testing this many signals.
 * The third was missing on the first run and let "divisional game" print as
 * a survivor at 1.26 SD -- direction consistency with no magnitude behind
 * it, which is the cheapest thing in the world to find across nine signals.
 * These are the checks that killed the projection filter, which passed the
 * headline test at 5-6 points in 3/3 seasons and then turned out to live
 * entirely in one bucket and decay 34.8 -> 17.1 -> 4.2.
 *
 * Run: node increment-test.js
 */
const fs = require('fs');

const rows = JSON.parse(fs.readFileSync('./frozen-rows.json', 'utf8'));
const csv = fs.readFileSync('../nflverse.csv', 'utf8').trim().split('\n');

const splitLine = (l) => {
  const out = []; let cur = '', q = false;
  for (const ch of l) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur); return out;
};
const cols = splitLine(csv[0]);
const ix = (n) => cols.indexOf(n);
const C = {
  season: ix('season'), week: ix('week'), espn: ix('espn'),
  home: ix('home_team'), away: ix('away_team'),
  hs: ix('home_score'), as: ix('away_score'),
  hrest: ix('home_rest'), arest: ix('away_rest'),
  roof: ix('roof'), temp: ix('temp'), wind: ix('wind'),
  hqb: ix('home_qb_name'), aqb: ix('away_qb_name'),
  div: ix('div_game'), type: ix('game_type'),
};
const num = (v) => (v === '' || v == null) ? null : (Number.isFinite(Number(v)) ? Number(v) : null);

// Every regular-season game, for the modal-starter calculation and for form.
const all = [];
for (const l of csv.slice(1)) {
  const f = splitLine(l);
  if (f[C.type] !== 'REG') continue;
  all.push({
    espn: String(f[C.espn] || '').trim(), season: num(f[C.season]), week: num(f[C.week]),
    home: f[C.home], away: f[C.away], hs: num(f[C.hs]), as: num(f[C.as]),
    hrest: num(f[C.hrest]), arest: num(f[C.arest]),
    roof: f[C.roof], temp: num(f[C.temp]), wind: num(f[C.wind]),
    hqb: f[C.hqb], aqb: f[C.aqb], div: num(f[C.div]),
  });
}

// Who normally starts for a team in a season: the most frequent name. A game
// whose starter is not that name is a backup start, which is what "third-string
// quarterback" means in practice and is the single largest injury in football.
const starts = new Map();   // season|team -> Map(name -> count)
const bump = (s, t, n) => {
  if (!t || !n) return;
  const k = s + '|' + t;
  if (!starts.has(k)) starts.set(k, new Map());
  const m = starts.get(k);
  m.set(n, (m.get(n) || 0) + 1);
};
for (const g of all) { bump(g.season, g.home, g.hqb); bump(g.season, g.away, g.aqb); }
const modal = new Map();
for (const [k, m] of starts) {
  let best = null, n = -1;
  for (const [name, c] of m) if (c > n) { best = name; n = c; }
  modal.set(k, best);
}
const isBackup = (season, team, qb) => {
  const mo = modal.get(season + '|' + team);
  return (mo && qb) ? (qb !== mo) : null;
};

// Points scored minus allowed over the previous three games, before this one.
const formBefore = (season, team, week) => {
  const prev = all.filter(g => g.season === season && g.week < week &&
    (g.home === team || g.away === team) && g.hs !== null)
    .sort((a, b) => b.week - a.week).slice(0, 3);
  if (prev.length < 3) return null;
  let d = 0;
  for (const g of prev) d += (g.home === team) ? (g.hs - g.as) : (g.as - g.hs);
  return d / prev.length;
};

const byEspn = new Map();
for (const g of all) if (g.espn) byEspn.set(g.espn, g);

const joined = [];
for (const r of rows) {
  const g = byEspn.get(String(r.id));
  if (!g) continue;
  const movedToHome = (r.close - r.open) < 0;          // home laying more = money on home
  joined.push({
    ...r, g,
    mv: Math.abs(r.close - r.open),
    ruleSide: movedToHome ? 1 : -1,
    homeBackup: isBackup(g.season, g.home, g.hqb),
    awayBackup: isBackup(g.season, g.away, g.aqb),
    homeForm: formBefore(g.season, g.home, g.week),
    awayForm: formBefore(g.season, g.away, g.week),
  });
}
const SEASONS = [...new Set(joined.map(r => r.year))].sort();

console.log('joined ' + joined.length + ' of ' + rows.length + ' frozen-line games to nflverse   seasons ' + SEASONS.join(' ') + '\n');

const settle = (r, side) => {
  const cover = r.margin + r.open;
  if (Math.abs(cover) < 1e-9) return 0;               // push, a loss in this pool
  return ((side > 0) === (cover > 0)) ? 1 : 0;
};
const rate = (set, sideOf) => {
  const bets = set.filter(r => sideOf(r) !== 0);
  if (!bets.length) return null;
  const w = bets.reduce((s, r) => s + settle(r, sideOf(r)), 0);
  return { w: w, n: bets.length, p: w / bets.length };
};
const fmt = (r) => r ? ((r.p * 100).toFixed(1) + '% (n=' + r.n + ')') : '--';
const ruleSide = (r) => r.ruleSide;

/**
 * A signal is a predicate that flags a game. The question is whether the rule
 * behaves differently on the flagged games -- and whether that survives the
 * two gates.
 */
function filterTest(name, flag, note) {
  const on = joined.filter(r => flag(r) === true);
  const off = joined.filter(r => flag(r) === false);
  if (on.length < 25) {
    console.log('  ' + name.padEnd(30) + 'too few flagged (' + on.length + ')');
    return;
  }
  const a = rate(on, ruleSide), b = rate(off, ruleSide);
  const gap = (a.p - b.p) * 100;
  console.log('  ' + name.padEnd(30) + 'flagged ' + fmt(a).padEnd(16) +
    'not ' + fmt(b).padEnd(16) + 'gap ' + (gap >= 0 ? '+' : '') + gap.toFixed(1));

  // GATE 1 -- both movement buckets
  const bk = [['1-2pt', (r) => r.mv >= 1 && r.mv < 2], ['>=2pt', (r) => r.mv >= 2]];
  const gaps = [];
  let line = '      by movement:  ';
  for (const [lab, f] of bk) {
    const x = rate(on.filter(f), ruleSide), y = rate(off.filter(f), ruleSide);
    if (!x || !y || x.n < 12 || y.n < 12) { line += lab + ' too few   '; gaps.push(null); continue; }
    const gg = (x.p - y.p) * 100;
    gaps.push(gg);
    line += lab + ' ' + (gg >= 0 ? '+' : '') + gg.toFixed(1) + '   ';
  }
  console.log(line);

  // GATE 2 -- all three seasons, same direction
  let sline = '      by season:    ';
  const seasonGaps = [];
  for (const y of SEASONS) {
    const x = rate(on.filter(r => r.year === y), ruleSide);
    const z = rate(off.filter(r => r.year === y), ruleSide);
    if (!x || !z || x.n < 8) { sline += y + ' too few   '; seasonGaps.push(null); continue; }
    const gg = (x.p - z.p) * 100;
    seasonGaps.push(gg);
    sline += y + ' ' + (gg >= 0 ? '+' : '') + gg.toFixed(1) + '   ';
  }
  console.log(sline);

  const okBuckets = gaps.every(g => g !== null && Math.sign(g) === Math.sign(gap) && Math.abs(g) >= 2);
  const okSeasons = seasonGaps.every(g => g !== null && Math.sign(g) === Math.sign(gap));
  const sd = Math.abs(gap / 100) / Math.sqrt(0.25 / a.n + 0.25 / b.n);
  const okSize = sd >= 2.5;
  console.log('      gates: both buckets ' + (okBuckets ? 'PASS' : 'fail') +
    ' | every season ' + (okSeasons ? 'PASS' : 'fail') +
    ' | ' + sd.toFixed(2) + ' SD ' + (okSize ? 'PASS' : 'fail') +
    ((okBuckets && okSeasons && okSize) ? '   <<<<< SURVIVES' : ''));
  if (note) console.log('      ' + note);
  console.log('');
}

/** Back the side a signal names, at the frozen number, ignoring the rule. */
function sideTest(name, sideOf) {
  const r = rate(joined, sideOf);
  if (!r || r.n < 25) { console.log('  ' + name.padEnd(30) + 'too few (' + (r ? r.n : 0) + ')'); return; }
  const sd = (r.p - 0.5) / Math.sqrt(0.25 / r.n);
  let sline = '  ' + name.padEnd(30) + fmt(r).padEnd(18) + sd.toFixed(2) + ' SD   seasons: ';
  for (const y of SEASONS) {
    const s = rate(joined.filter(x => x.year === y), sideOf);
    sline += y + ' ' + (s ? (s.p * 100).toFixed(1) + '%' : '--') + '  ';
  }
  console.log(sline);
}

console.log('CONTROL — the rule on its own');
const base = rate(joined, ruleSide);
console.log('  back the side the market moved toward: ' + fmt(base) + '\n');

console.log('AS A FILTER ON THE RULE  (does the rule work differently when flagged?)');
filterTest('a backup QB is starting', (r) =>
  (r.homeBackup === null || r.awayBackup === null) ? null : (r.homeBackup || r.awayBackup),
  'the case that started this: a third-string QB the model cannot see');
filterTest('backup QB on the side the money left', (r) => {
  if (r.homeBackup === null || r.awayBackup === null) return null;
  const fadedIsHome = r.ruleSide < 0;
  return fadedIsHome ? r.homeBackup : r.awayBackup;
});
filterTest('wind >= 15mph, outdoors', (r) =>
  (r.g.roof === 'outdoors' && r.g.wind !== null) ? r.g.wind >= 15 : null);
filterTest('freezing, below 32F outdoors', (r) =>
  (r.g.roof === 'outdoors' && r.g.temp !== null) ? r.g.temp < 32 : null);
filterTest('played under a roof', (r) =>
  r.g.roof ? (r.g.roof !== 'outdoors') : null);
filterTest('someone on a short week (<7d)', (r) =>
  (r.g.hrest !== null && r.g.arest !== null) ? (r.g.hrest < 7 || r.g.arest < 7) : null);
filterTest('rest edge of 3+ days', (r) =>
  (r.g.hrest !== null && r.g.arest !== null) ? Math.abs(r.g.hrest - r.g.arest) >= 3 : null);
filterTest('divisional game', (r) => r.g.div === null ? null : r.g.div === 1);
filterTest('form disagrees with the move', (r) => {
  if (r.homeForm === null || r.awayForm === null) return null;
  const formSide = r.homeForm > r.awayForm ? 1 : -1;
  return formSide !== r.ruleSide;
});

console.log('AS A PICKER ON ITS OWN  (back the side the signal names)');
sideTest('the rule (reference)', ruleSide);
sideTest('side facing a backup QB', (r) => {
  if (r.homeBackup === null || r.awayBackup === null) return 0;
  if (r.homeBackup === r.awayBackup) return 0;
  return r.homeBackup ? -1 : 1;
});
sideTest('better recent form', (r) => {
  if (r.homeForm === null || r.awayForm === null) return 0;
  if (r.homeForm === r.awayForm) return 0;
  return r.homeForm > r.awayForm ? 1 : -1;
});
sideTest('the rested side (3+ day edge)', (r) => {
  if (r.g.hrest === null || r.g.arest === null) return 0;
  if (Math.abs(r.g.hrest - r.g.arest) < 3) return 0;
  return r.g.hrest > r.g.arest ? 1 : -1;
});
console.log('\nbreak-even in this pool is 52.4% with a push counted as a loss.');
console.log('Both gates must pass. One bucket or one season is how the projection');
console.log('filter looked real before it fell apart.');
