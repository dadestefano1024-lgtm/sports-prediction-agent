'use strict';

// NEGATIVE RESULT — EPA does not beat the closing line either. Kept so the idea
// is not rebuilt from scratch.
//
// This was the best remaining candidate: real expected points added, from
// nflverse, free and without a key, which is the metric the yards-per-play test
// was a poor substitute for. Over 173 games of 2025:
//
//   market line   10.194
//   EPA model     11.287
//
// Best blended error 10.184 at trust 0.10 — a gain of 0.010 points per game,
// which is noise. Like the others it is also fitted in-sample, which flatters
// it.
//
// The first attempt used the multiplicative opponent adjustment built for
// points, with EPA shifted positive to make ratios work. That was the wrong
// tool: EPA is signed and centred near zero, so ratios are meaningless and the
// shift distorts them. Redone additively — subtract how far above or below
// average each opponent was — the result barely moved, 11.331 to 11.287. The
// method was not what was holding it back.
//
// Three inputs have now been tested against the same protocol: opponent-adjusted
// points, yards per play, and EPA. All three land in the same place, which is
// indistinguishable from simply taking the market price.
//
// Does EPA beat points as the model's input?
//
// nflverse publishes per-team, per-week EPA as a free CSV with no key. Each row
// carries the opponent, so a team's defensive EPA is simply what its opponents
// produced against it — offence and defence from one file.
//
// Same protocol as the yards-per-play test that failed: opponent-adjust, fit a
// coefficient, score against the closing line, sweep trust.
//
//   node epatest.js

const axios = require('axios');
const fs = require('fs');
const model = require('./model');

const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const pa = src.indexOf('function parseScore'), pb = src.indexOf('\n}\n', pa) + 2;
const parseScore = eval('(' + src.slice(pa, pb) + ')');

const CACHE = 'epatest-cache.json';
const disk = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
let dirty = 0;
const flush = () => { if (dirty) { fs.writeFileSync(CACHE, JSON.stringify(disk)); dirty = 0; } };
async function cached(k, fn) {
  if (disk[k] !== undefined) return disk[k];
  try { disk[k] = await fn(); } catch (e) { disk[k] = null; }
  if (++dirty >= 40) flush();
  return disk[k];
}

// ESPN and nflverse disagree on a handful of abbreviations.
const ALIAS = { WSH: 'WAS', LAR: 'LA', JAX: 'JAX', LV: 'LV', ARI: 'ARI' };
const norm = (abbr) => ALIAS[abbr] || abbr;

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map(l => {
    // no quoted commas in this file, so a plain split is safe
    const cells = l.split(',');
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i]; });
    return o;
  });
}

(async () => {
  const csv = await cached('nflverse:2025', async () => (await axios.get(
    'https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_2025.csv',
    { responseType: 'text', timeout: 60000 })).data);
  const rows = parseCsv(csv).filter(r => r.season_type === 'REG');
  console.log('nflverse rows (regular season):', rows.length,
    '| teams:', new Set(rows.map(r => r.team)).size,
    '| weeks:', Math.max(...rows.map(r => +r.week)));

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  // Total offensive EPA for a team-week.
  const offEpa = (r) => num(r.passing_epa) + num(r.rushing_epa);

  // { team: [{opponent, scored, allowed}] } where the values are EPA.
  function epaLogsBefore(week) {
    const byGame = {};
    for (const r of rows) {
      if (+r.week >= week) continue;
      (byGame[r.game_id] = byGame[r.game_id] || []).push(r);
    }
    const logs = {};
    for (const pair of Object.values(byGame)) {
      if (pair.length !== 2) continue;
      const [a, b] = pair;
      const an = norm(a.team), bn = norm(b.team);
      (logs[an] = logs[an] || []).push({ opponent: bn, scored: offEpa(a), allowed: offEpa(b) });
      (logs[bn] = logs[bn] || []).push({ opponent: an, scored: offEpa(b), allowed: offEpa(a) });
    }
    return logs;
  }

  // EPA is a SIGNED quantity centred near zero, so the multiplicative adjustment
  // used for points is the wrong tool — ratios around zero are meaningless and
  // shifting the data to force positives distorts them. Additive is correct
  // here: subtract how much better or worse than average each opponent was.
  //
  //   O*_i = mean( scored_g  - (D_opp - league) )
  //   D*_i = mean( allowed_g - (O_opp - league) )
  function additiveRatings(logs, iterations = 3, minGames = 3) {
    const teams = Object.keys(logs).filter(t => logs[t].length >= minGames);
    if (teams.length < 2) return null;
    let sum = 0, n = 0;
    for (const t of teams) for (const g of logs[t]) { sum += g.scored; n++; }
    if (!n) return null;
    const league = sum / n;

    const off = {}, def = {};
    for (const t of teams) {
      off[t] = logs[t].reduce((a, g) => a + g.scored, 0) / logs[t].length;
      def[t] = logs[t].reduce((a, g) => a + g.allowed, 0) / logs[t].length;
    }
    for (let it = 0; it < iterations; it++) {
      const no = {}, nd = {};
      for (const t of teams) {
        let o = 0, d = 0;
        for (const g of logs[t]) {
          o += g.scored - ((def[g.opponent] ?? league) - league);
          d += g.allowed - ((off[g.opponent] ?? league) - league);
        }
        no[t] = o / logs[t].length;
        nd[t] = d / logs[t].length;
      }
      for (const t of teams) { off[t] = no[t]; def[t] = nd[t]; }
    }
    const ratings = {};
    for (const t of teams) ratings[t] = { offense: off[t], defense: def[t], games: logs[t].length };
    return { leagueAvg: league, ratings };
  }

  const WEEKS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const out = [];

  for (const wk of WEEKS) {
    const logs = epaLogsBefore(wk);
    const rated = additiveRatings(logs, 3, 3);
    if (!rated) continue;

    // ESPN games for that week
    const sb = await cached(`sb:${wk}`, async () => (await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${wk}&dates=2025&limit=100`)).data);
    for (const ev of (sb && sb.events) || []) {
      const cm = ev.competitions[0];
      const H = cm.competitors.find(x => x.homeAway === 'home');
      const A = cm.competitors.find(x => x.homeAway === 'away');
      const fh = parseScore(H), fa = parseScore(A);
      if (fh === null || fa === null) continue;
      const hn = norm(H.team.abbreviation), an = norm(A.team.abbreviation);
      const hr = rated.ratings[hn], ar = rated.ratings[an];
      if (!hr || !ar) continue;

      const spread = await cached(`o:${ev.id}`, async () => {
        const r = await axios.get(
          `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${ev.id}/competitions/${ev.id}/odds`);
        const it = (r.data.items || [])[0];
        const ps = it?.homeTeamOdds?.current?.pointSpread?.american ?? it?.spread;
        return (ps == null) ? null : Number(String(ps).replace('+', ''));
      });
      if (spread === null) continue;

      // Net EPA edge: our offence against their defence, minus the reverse.
      const epaDiff = (hr.offense - ar.defense) - (ar.offense - hr.defense);
      out.push({ actual: fh - fa, market: -spread, epaDiff, week: wk });
    }
  }
  flush();

  const hfa = model.sportConfig('nfl').hfa;
  const n = out.reduce((s, r) => s + r.epaDiff * (r.actual - hfa), 0);
  const d = out.reduce((s, r) => s + r.epaDiff * r.epaDiff, 0);
  const k = n / d;
  const epaMargin = (r) => k * r.epaDiff + hfa;
  const mae = (f) => out.reduce((s, r) => s + Math.abs(f(r) - r.actual), 0) / out.length;

  console.log('');
  console.log(`weeks 5-16 of 2025 — ${out.length} games`);
  console.log(`fitted coefficient: ${k.toFixed(3)} points per unit of net EPA edge`);
  console.log('');
  console.log('  mean absolute error vs actual margin');
  console.log('    market line   :', mae(r => r.market).toFixed(3));
  console.log('    EPA model     :', mae(epaMargin).toFixed(3));
  console.log('');
  console.log('  disagreement with the line:',
    (out.reduce((s, r) => s + Math.abs(epaMargin(r) - r.market), 0) / out.length).toFixed(3));
  console.log('');
  console.log('  blended MAE by trust');
  let best = null;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const v = mae(r => r.market + t * (epaMargin(r) - r.market));
    if (!best || v < best.v) best = { t, v };
    console.log(`     ${t.toFixed(2)}   ${v.toFixed(3)}`);
  }
  console.log('');
  console.log(`  best trust ${best.t.toFixed(2)} -> ${best.v.toFixed(3)}, market ${mae(r => r.market).toFixed(3)}`);
  console.log(`  gain over market: ${(mae(r => r.market) - best.v).toFixed(3)} points/game`);
})();
