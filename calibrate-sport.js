'use strict';
/**
 * Measure a sport's sigma, total sigma and home edge from real closing lines.
 *
 * CHECKED: calibrate.js / calibrate2.js / fit-total-sigma.js (all NFL-only, and
 * they fit against data files this does not have for other sports),
 * frozen-test.js (the harvest-and-settle pattern reused here), model.js SPORTS.
 *
 * Why this exists. model.js says it outright: "basketball's sigma is still an
 * unmeasured placeholder". nfl sigma is 10.82 and is MEASURED over 1,087 games;
 * nba 11.5, mlb 4.4 and nhl 2.2 are guesses, and every probability the app
 * quotes for those three is built on them. A win percentage derived from a made
 * up standard deviation is a made up win percentage, however carefully the rest
 * of the arithmetic is done.
 *
 * Uses ESPN only -- the scoreboard for scores and the core odds endpoint for the
 * opening and closing numbers. Nothing here touches the paid feed.
 *
 * MLB and NHL carry fixedSpread: true, because the runline and puckline are
 * always 1.5. For those, sigma still governs how much probability a point is
 * worth on the moneyline-equivalent, so it is still worth measuring, but the
 * spread fit is over a single number and the TOTAL is the live market.
 *
 * Run: node calibrate-sport.js <nba|mlb|nhl> <startYYYYMMDD> <endYYYYMMDD>
 */
const fs = require('fs');

const SPORT = (process.argv[2] || 'nba').toLowerCase();
const START = process.argv[3];
const END = process.argv[4];
if (!START || !END) {
  console.error('usage: node calibrate-sport.js <nba|mlb|nhl> <startYYYYMMDD> <endYYYYMMDD>');
  process.exit(1);
}
const SB = { nba: 'basketball/nba', mlb: 'baseball/mlb', nhl: 'hockey/nhl' }[SPORT];
const CORE = { nba: 'basketball/leagues/nba', mlb: 'baseball/leagues/mlb',
               nhl: 'hockey/leagues/nhl' }[SPORT];
if (!SB) { console.error('unknown sport: ' + SPORT); process.exit(1); }

const CACHE = `./cal-${SPORT}-cache.json`;
const OUT = `./cal-${SPORT}-rows.json`;
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
let fetched = 0;

async function getJson(url) {
  if (cache[url] !== undefined) return cache[url];
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) { const v = await r.json(); cache[url] = v; fetched++; return v; }
      if (r.status === 404) break;
    } catch (e) { /* retry */ }
    await new Promise(s => setTimeout(s, 300 * (a + 1)));
  }
  cache[url] = null;
  return null;
}
const save = () => fs.writeFileSync(CACHE, JSON.stringify(cache));

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = String(v).trim().toUpperCase();
  if (t === 'EVEN' || t === 'PK') return 0;
  const n = Number(t.replace('+', ''));
  return Number.isFinite(n) ? n : null;
};
const scoreOf = (cmp) => {
  const raw = cmp && cmp.score;
  const n = Number(raw && typeof raw === 'object' ? raw.value : raw);
  return Number.isFinite(n) ? n : null;
};

/** Walk the date range a day at a time; ESPN rejects ranges. */
function* days(start, end) {
  const d = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6)}T12:00:00Z`);
  const stop = new Date(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6)}T12:00:00Z`);
  while (d <= stop) {
    yield d.toISOString().slice(0, 10).replace(/-/g, '');
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

async function oddsFor(id) {
  const d = await getJson(`https://sports.core.api.espn.com/v2/sports/${CORE}/events/${id}/competitions/${id}/odds`);
  const items = (d && d.items) || [];
  // Skip in-play feeds: they sit in the same list carrying a number from the
  // middle of the game. One NFL game showed 14.5 where the book had 2.5.
  const it = items.find(x => !/live/i.test((x.provider && x.provider.name) || '') &&
                             x.homeTeamOdds && x.homeTeamOdds.current &&
                             x.homeTeamOdds.current.pointSpread);
  if (!it) return null;
  const hto = it.homeTeamOdds;
  const close = num(hto.current.pointSpread.american);
  const open = (hto.open && hto.open.pointSpread) ? num(hto.open.pointSpread.american) : null;
  const closeTotal = (it.current && it.current.total) ? num(it.current.total.american) : null;
  const openTotal = (it.open && it.open.total) ? num(it.open.total.american) : null;
  return (close === null) ? null : { open, close, openTotal, closeTotal };
}

(async () => {
  const rows = [];
  let dates = 0;
  for (const day of days(START, END)) {
    const sb = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${SB}/scoreboard?dates=${day}&limit=200`);
    const events = (sb && sb.events) || [];
    dates++;
    for (const ev of events) {
      const cm = (ev.competitions || [])[0];
      if (!cm || !(cm.status && cm.status.type && cm.status.type.completed)) continue;
      // Regular season only. Playoff basketball and baseball are different
      // distributions and mixing them makes the fit describe neither.
      const st = ev.seasonType ? ev.seasonType.id : (ev.season && ev.season.type);
      if (st !== undefined && Number(st) !== 2) continue;
      const h = cm.competitors.find(x => x.homeAway === 'home');
      const a = cm.competitors.find(x => x.homeAway === 'away');
      if (!h || !a) continue;
      const hs = scoreOf(h), as = scoreOf(a);
      if (hs === null || as === null) continue;
      const o = await oddsFor(ev.id);
      if (!o) continue;
      rows.push({ id: ev.id, date: day, margin: hs - as, total: hs + as, ...o });
    }
    if (dates % 10 === 0) { save(); process.stderr.write(`${day} rows=${rows.length} fetched=${fetched}   \r`); }
  }
  save();
  fs.writeFileSync(OUT, JSON.stringify(rows));
  console.error('');
  console.log(`${SPORT.toUpperCase()} — ${rows.length} completed regular-season games with a closing number`);
  console.log(`(${dates} dates walked, ${fetched} network calls this run, 0 paid-feed requests)\n`);
  if (rows.length < 100) { console.log('too few to fit anything'); return; }

  const sd = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  };
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  // ---- the spread residual ------------------------------------------------
  const res = rows.map(r => r.margin + r.close);
  console.log('SPREAD, residual = final margin + closing spread');
  console.log('  mean  ' + mean(res).toFixed(3) + '   (near zero means the market is unbiased)');
  console.log('  sd    ' + sd(res).toFixed(3));
  const within = (k) => res.filter(x => Math.abs(x) <= k * sd(res)).length / res.length;
  console.log('  inside 1 sd: ' + (within(1) * 100).toFixed(1) + '%  (a normal gives 68.3%)');

  // Fit the sigma that best reproduces what actually happened at the offsets the
  // app asks about, which is the middle of the distribution rather than its
  // tails. Same method as the measured NFL number.
  const OFFS = SPORT === 'nba' ? [1, 2, 3, 4, 5, 6, 7, 8, 10]
    : SPORT === 'mlb' ? [0.5, 1, 1.5, 2] : [0.5, 1, 1.5, 2];
  const erf = (x) => {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  };
  const normAbove = (off, sigma) => 0.5 * (1 - erf(off / (sigma * Math.SQRT2)));
  let best = null;
  for (let sg = 1; sg <= 20; sg += 0.01) {
    let err = 0;
    for (const off of OFFS) {
      const real = res.filter(x => x > off).length / res.length;
      err += (normAbove(off, sg) - real) ** 2;
    }
    if (!best || err < best.err) best = { sg: +sg.toFixed(2), err };
  }
  console.log('  sigma fitted to the offsets the app actually asks about: ' + best.sg);
  console.log('    offset   real      normal at ' + best.sg);
  for (const off of OFFS) {
    const real = res.filter(x => x > off).length / res.length;
    console.log('    ' + String(off).padEnd(8) + (real * 100).toFixed(1).padStart(6) + '%' +
      (normAbove(off, best.sg) * 100).toFixed(1).padStart(12) + '%');
  }

  // ---- totals -------------------------------------------------------------
  const tot = rows.filter(r => Number.isFinite(r.closeTotal));
  console.log('');
  if (tot.length > 100) {
    const tr = tot.map(r => r.total - r.closeTotal);
    console.log('TOTAL, residual = final total - closing total   (n=' + tot.length + ')');
    console.log('  mean  ' + mean(tr).toFixed(3));
    console.log('  sd    ' + sd(tr).toFixed(3) + '   <- this is totalSigma');
  } else {
    console.log('TOTAL: only ' + tot.length + ' games carry a closing total; not enough');
  }

  // ---- home edge ----------------------------------------------------------
  console.log('');
  console.log('HOME EDGE');
  console.log('  mean final margin (home - away): ' + mean(rows.map(r => r.margin)).toFixed(3));
  console.log('  mean closing spread implies    : ' + mean(rows.map(r => -r.close)).toFixed(3));
  console.log('  the market already prices it; hfa in SPORTS is only used when no');
  console.log('  line exists, so it should match the first number, not be invented.');

  // ---- does the stale-line rule transfer? ---------------------------------
  const movers = rows.filter(r => Number.isFinite(r.open) && Math.abs(r.close - r.open) > 0);
  console.log('');

  // THE PUCKLINE AND RUNLINE DO MOVE, and this message used to deny it.
  //
  // What is measured below is ONE provider's primary line, and for hockey and
  // baseball that is 1.5 almost always. Stating "the spread is FIXED" from that
  // was reading a property of one feed as a property of the market. Checking
  // every pre-game provider in the same cached responses: hockey shows 392
  // readings at -2.5, 216 at +2.5 and 130 at -3.5, at ESPN BET, SugarHouse and
  // Unibet, and pre-game books disagree with each other on the puckline in 7.4%
  // of games -- sometimes about WHICH SIDE is favoured. Alternative lines are
  // real and the owner was right to say so.
  //
  // So this reports what it can see and does not generalise. The stale-line rule
  // still cannot be run on it: the one line available here barely moves, and the
  // only "move" it can show is the favourite flipping, where the side the market
  // moved toward is the side that was getting points at the open -- 118 of 118
  // cases, by construction. That is a base rate, not an edge.
  //
  // Measuring the multi-book version needs prices attached to the points, and
  // ESPN does not carry spreadOdds. Its multi-book MONEYLINES are also too dirty
  // to substitute: 40% fail a basic vig check, five books post +100 placeholders,
  // and there are two conflicting DraftKings feeds. That measurement wants The
  // Odds API, which is the feed bestOffer already uses in production.
  const distinct = new Set(rows.map(r => Math.abs(r.close)));
  if (distinct.size <= 2) {
    const plus = rows.filter(r => r.margin >= -1).length / rows.length;
    console.log('STALE-LINE RULE: not run. This provider posted only ' +
      [...distinct].join(' and ') + ', so there is no movement here to measure.');
    console.log('  That is this FEED, not the market: other books post 2.5 and 3.5,');
    console.log('  and pre-game books disagree on the puckline in 7.4% of games.');
    console.log('  The only "move" visible here is the favourite flipping, and the');
    console.log('  side it flips toward was the one getting points at the open, in');
    console.log('  118 of 118 cases. Base rate of that ticket: ' + (plus * 100).toFixed(1) + '%.');
  } else if (movers.length > 100) {
    const settle = (r, side) => {
      const c = r.margin + r.open;
      if (Math.abs(c) < 1e-9) return 0;
      return ((side > 0) === (c > 0)) ? 1 : 0;
    };
    const mk = (r) => (r.close - r.open) < 0 ? 1 : -1;
    console.log('STALE-LINE RULE — back the side the market moved toward, at the OPEN');
    const step = SPORT === 'nba' ? [1, 1.5, 2, 3] : [0.5, 1];
    for (const t of step) {
      const set = movers.filter(r => Math.abs(r.close - r.open) >= t);
      if (set.length < 40) { console.log('  moved >= ' + t + ': too few (' + set.length + ')'); continue; }
      const w = set.reduce((s, r) => s + settle(r, mk(r)), 0);
      const p = w / set.length;
      const z = (p - 0.5) / Math.sqrt(0.25 / set.length);
      console.log('  moved >= ' + String(t).padEnd(4) + ' ' + w + '-' + (set.length - w) +
        '  ' + (p * 100).toFixed(1) + '%  n=' + set.length + '  ' + z.toFixed(2) + ' SD');
    }
    const hw = movers.reduce((s, r) => s + settle(r, 1), 0);
    console.log('  control, back HOME at the open: ' + (hw / movers.length * 100).toFixed(1) +
      '%  n=' + movers.length);
  } else {
    console.log('STALE-LINE RULE: only ' + movers.length + ' games have an opening number');
  }
})();
