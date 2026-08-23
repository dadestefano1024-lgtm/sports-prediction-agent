'use strict';

// Backtest: does opponent adjustment beat raw scoring averages, and does either
// beat the closing line? Uses only games played BEFORE each slate, so there is
// no lookahead.
//
//   node backtest.js

const axios = require('axios');
const fs = require('fs');
const model = require('./model');

const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const i = src.indexOf('const nflTeamIds = {'), j = src.indexOf('\n};', i);
// eval in a strict-mode module gets its own scope, so a `var` inside it would
// not escape. Assign the object literal explicitly instead.
const nflTeamIds = eval('(' + src.slice(src.indexOf('{', i), j + 2) + ')');
const a = src.indexOf('function parseScore'), b = src.indexOf('\n}\n', a) + 2;
const parseScore = eval('(' + src.slice(a, b) + ')');
const c = src.indexOf('function teamNickname'), d = src.indexOf('\n}\n', c) + 2;
const teamNickname = eval('(' + src.slice(c, d) + ')');

const SEASON = 2025;
const WEEKS = ['20251026', '20251102', '20251109', '20251116',
               '20251123', '20251130', '20251207', '20251214'];

const schedCache = {};
async function schedule(id) {
  if (!schedCache[id]) {
    schedCache[id] = (await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/schedule?season=${SEASON}`)).data;
  }
  return schedCache[id];
}

/** Every team's completed regular-season games before `cutoff`. */
async function gameLogs(cutoff) {
  const logs = {};
  for (const [nick, id] of Object.entries(nflTeamIds)) {
    const sched = await schedule(id);
    const out = [];
    for (const e of sched.events || []) {
      const cm = e.competitions?.[0];
      if (!cm?.status?.type?.completed) continue;
      const st = e.seasonType?.id ?? e.season?.type;
      if (st !== undefined && Number(st) < 2) continue;
      if (new Date(e.date).getTime() >= cutoff) continue;
      const h = cm.competitors.find(x => x.homeAway === 'home');
      const aw = cm.competitors.find(x => x.homeAway === 'away');
      const hs = parseScore(h), as = parseScore(aw);
      if (hs === null || as === null) continue;
      const isHome = String(h.team.id) === String(id);
      const oppTeam = isHome ? aw : h;
      out.push({
        opponent: teamNickname(oppTeam.team.displayName, nflTeamIds),
        scored: isHome ? hs : as,
        allowed: isHome ? as : hs,
      });
    }
    logs[nick] = out;
  }
  return logs;
}

const oddsCache = {};
async function lineFor(eventId) {
  if (oddsCache[eventId] !== undefined) return oddsCache[eventId];
  try {
    const r = await axios.get(
      `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${eventId}/competitions/${eventId}/odds`);
    const it = (r.data.items || [])[0];
    const ps = it?.homeTeamOdds?.current?.pointSpread?.american ?? it?.spread;
    oddsCache[eventId] = (ps === undefined || ps === null)
      ? null : Number(String(ps).replace('+', ''));
  } catch (e) { oddsCache[eventId] = null; }
  return oddsCache[eventId];
}

(async () => {
  const rows = [];
  for (const week of WEEKS) {
    const cutoff = new Date(`${week.slice(0,4)}-${week.slice(4,6)}-${week.slice(6)}T00:00:00Z`).getTime();
    const logs = await gameLogs(cutoff);
    const rated = model.opponentAdjustedRatings(logs, { iterations: 3, minGames: 3 });
    if (!rated) continue;

    const sb = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${week}&limit=100`);
    for (const ev of sb.data.events || []) {
      const cm = ev.competitions[0];
      const H = cm.competitors.find(x => x.homeAway === 'home');
      const A = cm.competitors.find(x => x.homeAway === 'away');
      const fh = parseScore(H), fa = parseScore(A);
      if (fh === null || fa === null) continue;
      const hn = teamNickname(H.team.displayName, nflTeamIds);
      const an = teamNickname(A.team.displayName, nflTeamIds);
      const spread = await lineFor(ev.id);
      if (spread === null) continue;

      const hl = logs[hn] || [], al = logs[an] || [];
      if (hl.length < 3 || al.length < 3) continue;
      const avg = (arr, k) => arr.reduce((s, g) => s + g[k], 0) / arr.length;

      const raw = model.projectFromScoringAverages({
        homeAvgScored: avg(hl, 'scored'), homeAvgAllowed: avg(hl, 'allowed'),
        awayAvgScored: avg(al, 'scored'), awayAvgAllowed: avg(al, 'allowed'),
        sport: 'nfl',
      });
      const hr = rated.ratings[hn], ar = rated.ratings[an];
      const adj = (hr && ar) ? model.projectFromRatings({
        homeOff: hr.offense, homeDef: hr.defense,
        awayOff: ar.offense, awayDef: ar.defense,
        leagueAvg: rated.leagueAvg, sport: 'nfl',
      }) : null;
      if (!raw || !adj) continue;

      rows.push({
        actual: fh - fa, market: -spread,
        raw: raw.predictedMargin, adj: adj.predictedMargin, spread,
      });
    }
  }

  const mae = (f) => rows.reduce((s, r) => s + Math.abs(f(r) - r.actual), 0) / rows.length;
  const dogLean = (key) => rows.filter(r =>
    (r.spread < 0 && r[key] < r.market) || (r.spread > 0 && r[key] > r.market)).length;

  console.log(`NFL ${SEASON} weeks 8-16 — ${rows.length} games`);
  console.log('');
  console.log('  mean absolute error vs actual margin');
  console.log('    market line          :', mae(r => r.market).toFixed(3));
  console.log('    raw averages         :', mae(r => r.raw).toFixed(3));
  console.log('    opponent-adjusted    :', mae(r => r.adj).toFixed(3));
  console.log('');
  console.log('  mean |model - market|');
  console.log('    raw averages         :',
    (rows.reduce((s, r) => s + Math.abs(r.raw - r.market), 0) / rows.length).toFixed(3));
  console.log('    opponent-adjusted    :',
    (rows.reduce((s, r) => s + Math.abs(r.adj - r.market), 0) / rows.length).toFixed(3));
  console.log('');
  console.log('  leaning toward the underdog');
  console.log('    raw averages         :', dogLean('raw'), '/', rows.length,
    `= ${(100 * dogLean('raw') / rows.length).toFixed(0)}%`);
  console.log('    opponent-adjusted    :', dogLean('adj'), '/', rows.length,
    `= ${(100 * dogLean('adj') / rows.length).toFixed(0)}%`);
  console.log('');
  console.log('  blended MAE by trust        raw      adjusted');
  let bestRaw = null, bestAdj = null;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const mr = mae(r => r.market + t * (r.raw - r.market));
    const ma = mae(r => r.market + t * (r.adj - r.market));
    if (!bestRaw || mr < bestRaw.v) bestRaw = { t, v: mr };
    if (!bestAdj || ma < bestAdj.v) bestAdj = { t, v: ma };
    console.log(`     trust ${t.toFixed(2)}              ${mr.toFixed(3)}    ${ma.toFixed(3)}`);
  }
  console.log('');
  console.log(`  best trust — raw ${bestRaw.t.toFixed(2)} (${bestRaw.v.toFixed(3)}), adjusted ${bestAdj.t.toFixed(2)} (${bestAdj.v.toFixed(3)})`);
  const base = mae(r => r.market);
  console.log(`  adjusted at its best beats the pure market by ${(base - bestAdj.v).toFixed(3)} points/game`);
})();
