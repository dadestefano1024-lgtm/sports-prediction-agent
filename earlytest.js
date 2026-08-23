'use strict';

// How fast should last season's ratings be handed over to this season's?
//
// Backtests weeks 1-8 of 2025 with 2024 as the prior, sweeping
// gamesForFullWeight. Only games played before each slate are used.
//
//   node earlytest.js

const axios = require('axios');
const fs = require('fs');
const model = require('./model');

const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const i = src.indexOf('const nflTeamIds = {'), j = src.indexOf('\n};', i);
const nflTeamIds = eval('(' + src.slice(src.indexOf('{', i), j + 2) + ')');
const pa = src.indexOf('function parseScore'), pb = src.indexOf('\n}\n', pa) + 2;
const parseScore = eval('(' + src.slice(pa, pb) + ')');
const ta = src.indexOf('function teamNickname'), tb = src.indexOf('\n}\n', ta) + 2;
const teamNickname = eval('(' + src.slice(ta, tb) + ')');

const WEEKS = ['20250907','20250914','20250921','20250928','20251005','20251012','20251019','20251026'];

const schedCache = {};
async function schedule(id, season) {
  const k = `${id}:${season}`;
  if (!schedCache[k]) {
    schedCache[k] = (await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/schedule?season=${season}`)).data;
  }
  return schedCache[k];
}

async function logsFor(season, cutoff) {
  const logs = {};
  for (const [nick, id] of Object.entries(nflTeamIds)) {
    const sched = await schedule(id, season);
    const out = [];
    for (const e of sched.events || []) {
      const cm = e.competitions?.[0];
      if (!cm?.status?.type?.completed) continue;
      const st = e.seasonType?.id ?? e.season?.type;
      if (st !== undefined && st !== null && Number(st) < 2) continue;
      if (cutoff && new Date(e.date).getTime() >= cutoff) continue;
      const h = cm.competitors.find(x => x.homeAway === 'home');
      const aw = cm.competitors.find(x => x.homeAway === 'away');
      const hs = parseScore(h), as = parseScore(aw);
      if (hs === null || as === null) continue;
      const isHome = String(h.team.id) === String(id);
      const opp = isHome ? aw : h;
      out.push({
        opponent: teamNickname(opp.team.displayName, nflTeamIds),
        scored: isHome ? hs : as, allowed: isHome ? as : hs,
      });
    }
    logs[nick] = out;
  }
  return logs;
}

const oddsCache = {};
async function lineFor(id) {
  if (oddsCache[id] !== undefined) return oddsCache[id];
  try {
    const r = await axios.get(
      `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${id}/competitions/${id}/odds`);
    const it = (r.data.items || [])[0];
    const ps = it?.homeTeamOdds?.current?.pointSpread?.american ?? it?.spread;
    oddsCache[id] = (ps == null) ? null : Number(String(ps).replace('+', ''));
  } catch (e) { oddsCache[id] = null; }
  return oddsCache[id];
}

const SWEEP = [1, 2, 3, 4, 6, 8, 12];

(async () => {
  const priorLogs = await logsFor(2024, null);
  const prior = model.opponentAdjustedRatings(priorLogs, { iterations: 3, minGames: 3 });
  console.log('2024 prior:', Object.keys(prior.ratings).length, 'teams, league avg',
    prior.leagueAvg.toFixed(2));

  const rows = [];
  for (const week of WEEKS) {
    const cutoff = new Date(`${week.slice(0,4)}-${week.slice(4,6)}-${week.slice(6)}T00:00:00Z`).getTime();
    const currentLogs = await logsFor(2025, cutoff);
    const current = model.opponentAdjustedRatings(currentLogs, { iterations: 3, minGames: 3 });

    const blends = {};
    for (const g of SWEEP) {
      blends[g] = model.blendSeasonRatings({
        prior, current, gamesForFullWeight: g, priorRegression: 0.5 });
    }
    // "pure current" = ignore the prior entirely once any current data exists
    const pureCurrent = current;

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

      const gamesPlayed = (currentLogs[hn] || []).length;
      const row = { actual: fh - fa, market: -spread, week, gamesPlayed, proj: {} };
      for (const g of SWEEP) {
        const r = blends[g];
        const hr = r && r.ratings[hn], ar = r && r.ratings[an];
        const p = (hr && ar) ? model.projectFromRatings({
          homeOff: hr.offense, homeDef: hr.defense, awayOff: ar.offense, awayDef: ar.defense,
          leagueAvg: r.leagueAvg, sport: 'nfl' }) : null;
        row.proj[g] = p ? p.predictedMargin : null;
      }
      const chr = pureCurrent && pureCurrent.ratings[hn], car = pureCurrent && pureCurrent.ratings[an];
      const cp = (chr && car) ? model.projectFromRatings({
        homeOff: chr.offense, homeDef: chr.defense, awayOff: car.offense, awayDef: car.defense,
        leagueAvg: pureCurrent.leagueAvg, sport: 'nfl' }) : null;
      row.proj.pure = cp ? cp.predictedMargin : null;
      rows.push(row);
    }
  }

  console.log('');
  console.log(`weeks 1-8 of 2025 — ${rows.length} games`);
  const mktMae = rows.reduce((s, r) => s + Math.abs(r.market - r.actual), 0) / rows.length;
  console.log('market line MAE:', mktMae.toFixed(3));
  console.log('');
  console.log('  handover speed      model MAE   blended@0.1   coverage');
  const report = (label, key) => {
    const have = rows.filter(r => r.proj[key] !== null);
    if (!have.length) { console.log(`  ${label}  no coverage`); return; }
    const mae = have.reduce((s, r) => s + Math.abs(r.proj[key] - r.actual), 0) / have.length;
    const bl = have.reduce((s, r) =>
      s + Math.abs((r.market + 0.1 * (r.proj[key] - r.market)) - r.actual), 0) / have.length;
    console.log(`  ${label}      ${mae.toFixed(3)}      ${bl.toFixed(3)}      ${have.length}/${rows.length}`);
  };
  for (const g of SWEEP) report(`gamesForFullWeight=${String(g).padEnd(2)}`, g);
  report('pure current only ', 'pure');

  console.log('');
  console.log('  by week, prior weight at gamesForFullWeight 3 vs 8:');
  for (const w of WEEKS) {
    const sample = rows.find(r => r.week === w);
    if (!sample) continue;
    const g = sample.gamesPlayed;
    console.log(`    ${w}  games played ${String(g).padStart(2)}  ->  w3 prior ${Math.max(0, 1 - g / 3).toFixed(2)}   w8 prior ${Math.max(0, 1 - g / 8).toFixed(2)}`);
  }
})();
