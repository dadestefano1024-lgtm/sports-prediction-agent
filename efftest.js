'use strict';

// NEGATIVE RESULT — yards per play is a WORSE input than points. Kept so the
// idea is not tried again from scratch.
//
// The reasoning going in was that efficiency stabilises faster than points, so
// it would both improve accuracy and let last season's ratings be handed over
// sooner. Measured over 132 games of the 2025 season it does neither:
//
//   market line              10.064
//   points-based model       10.614
//   efficiency-based model   11.582
//
// It is also more confidently wrong, disagreeing with the line by 5.0 points
// against the points model's 3.9. Combining the two does not rescue it: sweeping
// the weight on efficiency, the best value is 0.00.
//
// Note the efficiency model was fitted IN-SAMPLE — the yards-to-points
// coefficient was estimated on the same games it was scored against, which
// flatters it — and it still lost by a point a game.
//
// Why it fails, most likely: yards per play is not EPA. It ignores down,
// distance and field position; it is contaminated by game script, since leading
// teams run the ball and shorten games; and it discards turnovers and red-zone
// conversion, which are large margin drivers that points already contain.
//
//   node efftest.js

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

const CACHE_FILE = 'efftest-cache.json';
const disk = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
let dirty = 0;
const save = () => { if (dirty) { fs.writeFileSync(CACHE_FILE, JSON.stringify(disk)); dirty = 0; } };

async function cached(key, fn) {
  if (disk[key] !== undefined) return disk[key];
  try { disk[key] = await fn(); } catch (e) { disk[key] = null; }
  dirty++;
  if (dirty >= 40) save();
  return disk[key];
}

const num = (v) => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };

/** One boxscore -> per-team offensive output plus the opponent it came against. */
async function gameStats(eventId) {
  return cached(`g:${eventId}`, async () => {
    const r = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`);
    const teams = r.data?.boxscore?.teams || [];
    if (teams.length !== 2) return null;
    const out = teams.map(t => {
      const st = {};
      for (const s of t.statistics || []) st[s.name] = s.displayValue;
      return {
        team: t.team?.displayName,
        yards: num(st.totalYards),
        plays: num(st.totalOffensivePlays),
        turnovers: num(st.turnovers),
      };
    });
    if (out.some(o => o.yards === null || !o.plays)) return null;
    return out;
  });
}

const schedCache = {};
async function schedule(id, season) {
  const k = `${id}:${season}`;
  if (!schedCache[k]) {
    schedCache[k] = await cached(`s:${k}`, async () => (await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/schedule?season=${season}`)).data);
  }
  return schedCache[k];
}

/** Every completed regular-season game before cutoff, as {id, date}. */
async function gameList(season, cutoff) {
  const seen = new Map();
  for (const id of Object.values(nflTeamIds)) {
    const s = await schedule(id, season);
    for (const e of s?.events || []) {
      const cm = e.competitions?.[0];
      if (!cm?.status?.type?.completed) continue;
      const st = e.seasonType?.id ?? e.season?.type;
      if (st != null && Number(st) < 2) continue;
      if (cutoff && new Date(e.date).getTime() >= cutoff) continue;
      seen.set(e.id, e.date);
    }
  }
  return [...seen.entries()].map(([id, date]) => ({ id, date }));
}

/** Points logs and yards-per-play logs, both keyed by team. */
async function buildLogs(season, cutoff) {
  const games = await gameList(season, cutoff);
  const pts = {}, eff = {};
  for (const nick of Object.keys(nflTeamIds)) { pts[nick] = []; eff[nick] = []; }
  for (const g of games) {
    const st = await gameStats(g.id);
    if (!st) continue;
    const [a, b] = st;
    const an = teamNickname(a.team || '', nflTeamIds);
    const bn = teamNickname(b.team || '', nflTeamIds);
    if (!pts[an] || !pts[bn]) continue;
    // yards per play, offense and (from the opponent's line) defense
    eff[an].push({ opponent: bn, scored: a.yards / a.plays, allowed: b.yards / b.plays });
    eff[bn].push({ opponent: an, scored: b.yards / b.plays, allowed: a.yards / a.plays });
  }
  return { eff, games: games.length };
}

async function pointsLogs(season, cutoff) {
  const logs = {};
  for (const [nick, id] of Object.entries(nflTeamIds)) {
    const s = await schedule(id, season);
    const out = [];
    for (const e of s?.events || []) {
      const cm = e.competitions?.[0];
      if (!cm?.status?.type?.completed) continue;
      const st = e.seasonType?.id ?? e.season?.type;
      if (st != null && Number(st) < 2) continue;
      if (cutoff && new Date(e.date).getTime() >= cutoff) continue;
      const h = cm.competitors.find(x => x.homeAway === 'home');
      const aw = cm.competitors.find(x => x.homeAway === 'away');
      const hs = parseScore(h), as = parseScore(aw);
      if (hs === null || as === null) continue;
      const isHome = String(h.team.id) === String(id);
      const opp = isHome ? aw : h;
      out.push({ opponent: teamNickname(opp.team.displayName, nflTeamIds),
                 scored: isHome ? hs : as, allowed: isHome ? as : hs });
    }
    logs[nick] = out;
  }
  return logs;
}

const oddsCache = {};
async function lineFor(id) {
  if (oddsCache[id] !== undefined) return oddsCache[id];
  oddsCache[id] = await cached(`o:${id}`, async () => {
    const r = await axios.get(
      `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${id}/competitions/${id}/odds`);
    const it = (r.data.items || [])[0];
    const ps = it?.homeTeamOdds?.current?.pointSpread?.american ?? it?.spread;
    return (ps == null) ? null : Number(String(ps).replace('+', ''));
  });
  return oddsCache[id];
}

const WEEKS = ['20251005','20251012','20251019','20251026','20251102','20251109',
               '20251116','20251123','20251130','20251207','20251214'];

(async () => {
  const rows = [];
  for (const week of WEEKS) {
    const cutoff = new Date(`${week.slice(0,4)}-${week.slice(4,6)}-${week.slice(6)}T00:00:00Z`).getTime();
    const [{ eff }, pl] = await Promise.all([buildLogs(2025, cutoff), pointsLogs(2025, cutoff)]);
    const ptsRated = model.opponentAdjustedRatings(pl, { iterations: 3, minGames: 3 });
    const effRated = model.opponentAdjustedRatings(eff, { iterations: 3, minGames: 3 });
    if (!ptsRated || !effRated) continue;

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

      const ph = ptsRated.ratings[hn], pa2 = ptsRated.ratings[an];
      const eh = effRated.ratings[hn], ea = effRated.ratings[an];
      if (!ph || !pa2 || !eh || !ea) continue;

      const ptsProj = model.projectFromRatings({
        homeOff: ph.offense, homeDef: ph.defense, awayOff: pa2.offense, awayDef: pa2.defense,
        leagueAvg: ptsRated.leagueAvg, sport: 'nfl' });

      // Efficiency differential, in net yards per play.
      const effDiff = ((eh.offense - ea.defense) - (ea.offense - eh.defense));
      rows.push({ actual: fh - fa, market: -spread,
                  pts: ptsProj.predictedMargin, effDiff });
    }
  }
  save();

  // Fit margin = k * effDiff + hfa by least squares on (actual - hfa).
  const hfa = model.sportConfig('nfl').hfa;
  const num_ = rows.reduce((s, r) => s + r.effDiff * (r.actual - hfa), 0);
  const den = rows.reduce((s, r) => s + r.effDiff * r.effDiff, 0);
  const k = num_ / den;

  const mae = (f) => rows.reduce((s, r) => s + Math.abs(f(r) - r.actual), 0) / rows.length;
  const effMargin = (r) => k * r.effDiff + hfa;

  console.log('');
  console.log(`NFL 2025 weeks 5-16 — ${rows.length} games`);
  console.log(`fitted yards-per-play to points coefficient: ${k.toFixed(2)} pts per net y/p`);
  console.log('');
  console.log('  mean absolute error vs actual margin');
  console.log('    market line              :', mae(r => r.market).toFixed(3));
  console.log('    points-based model       :', mae(r => r.pts).toFixed(3));
  console.log('    efficiency-based model   :', mae(effMargin).toFixed(3));
  console.log('');
  console.log('  disagreement with the line');
  console.log('    points-based             :',
    (rows.reduce((s, r) => s + Math.abs(r.pts - r.market), 0) / rows.length).toFixed(3));
  console.log('    efficiency-based         :',
    (rows.reduce((s, r) => s + Math.abs(effMargin(r) - r.market), 0) / rows.length).toFixed(3));
  console.log('');
  console.log('  blended MAE by trust      points   efficiency');
  let bp = null, be = null;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const mp = mae(r => r.market + t * (r.pts - r.market));
    const me = mae(r => r.market + t * (effMargin(r) - r.market));
    if (!bp || mp < bp.v) bp = { t, v: mp };
    if (!be || me < be.v) be = { t, v: me };
    console.log(`     trust ${t.toFixed(2)}            ${mp.toFixed(3)}   ${me.toFixed(3)}`);
  }
  console.log('');
  console.log(`  best — points ${bp.t.toFixed(2)} (${bp.v.toFixed(3)}), efficiency ${be.t.toFixed(2)} (${be.v.toFixed(3)})`);
  console.log(`  market baseline ${mae(r => r.market).toFixed(3)}`);

  // Does combining the two beat either alone? Weight w on efficiency.
  console.log('');
  console.log('  combined model (w = weight on efficiency), best blended MAE:');
  let bestCombo = null;
  for (let w = 0; w <= 1.0001; w += 0.25) {
    const combo = (r) => (1 - w) * r.pts + w * effMargin(r);
    let best = null;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = mae(r => r.market + t * (combo(r) - r.market));
      if (!best || v < best.v) best = { t, v };
    }
    if (!bestCombo || best.v < bestCombo.v) bestCombo = { w, ...best };
    console.log(`     w=${w.toFixed(2)}  raw ${mae(combo).toFixed(3)}   best trust ${best.t.toFixed(2)} -> ${best.v.toFixed(3)}`);
  }
  console.log('');
  console.log(`  best combination: efficiency weight ${bestCombo.w.toFixed(2)}, trust ${bestCombo.t.toFixed(2)}, MAE ${bestCombo.v.toFixed(3)}`);
  console.log(`  versus market ${mae(r => r.market).toFixed(3)} -> ${(mae(r => r.market) - bestCombo.v).toFixed(3)} points/game`);
})();
