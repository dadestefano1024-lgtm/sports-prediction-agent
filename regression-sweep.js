'use strict';
/**
 * Are priorRegression=0.5 and gamesForFullWeight=8 right, or just chosen?
 *
 * CHECKED: backtest.js (sweeps MODEL_TRUST, which blends the model against the
 * MARKET -- a different parameter), frozen-test.js (built the week-by-week
 * no-lookahead harness this reuses), calibrate.js / calibrate2.js /
 * calibrate-keys.js (sigma and key numbers, not the season blend).
 *
 * Neither number has ever been measured. They appear only as hard-coded call
 * sites in server.js and frozen-test.js, plus tests that assert the mechanics
 * rather than the value. The owner's objection is that the blend regresses so
 * hard that at week 3 the model cannot express a large gap: with two games
 * played the weight on this season is 2/8 = 0.25, so 75% of the rating comes
 * from a prior that has itself been pulled 50% to the mean, leaving last
 * season's real signal at 37.5%. A team seven points better than average shows
 * up as 2.6, which is why Kansas City at Miami projects a two-point margin
 * against a market of 10.5.
 *
 * That is either correct conservatism or discarded information, and only a sweep
 * says which. Scored as mean absolute error of the projected margin against the
 * actual margin, bucketed by how many games the current season has, because that
 * is the quantity the weight is a function of. The market's closing line is the
 * benchmark -- nothing here is expected to beat it, the question is only which
 * settings come closest.
 *
 * Run: node regression-sweep.js
 */
const fs = require('fs');
const model = require('./model');

const CACHE = './frozen-cache.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const rows = JSON.parse(fs.readFileSync('./frozen-rows.json', 'utf8'));

const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const i = src.indexOf('const nflTeamIds = {'), j = src.indexOf('\n};', i);
const nflTeamIds = eval('(' + src.slice(i + 'const nflTeamIds = '.length, j + 2) + ')');
const c = src.indexOf('function teamNickname'), d2 = src.indexOf('\n}\n', c) + 2;
const teamNickname = eval('(' + src.slice(c, d2) + ')');

const scoreOf = (cmp) => {
  const raw = cmp && cmp.score;
  const n = Number(raw && typeof raw === 'object' ? raw.value : raw);
  return Number.isFinite(n) ? n : null;
};

function seasonLogs(year) {
  const logs = {};
  for (const [nick, id] of Object.entries(nflTeamIds)) {
    const s = cache['https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/' +
      id + '/schedule?season=' + year];
    const out = [];
    for (const e of ((s && s.events) || [])) {
      const cm = (e.competitions || [])[0];
      if (!cm || !(cm.status && cm.status.type && cm.status.type.completed)) continue;
      const st = e.seasonType ? e.seasonType.id : (e.season && e.season.type);
      if (st !== undefined && Number(st) < 2) continue;
      const h = cm.competitors.find(x => x.homeAway === 'home');
      const aw = cm.competitors.find(x => x.homeAway === 'away');
      if (!h || !aw) continue;
      const hs = scoreOf(h), as = scoreOf(aw);
      if (hs === null || as === null) continue;
      const isHome = String(h.team.id) === String(id);
      out.push({
        at: new Date(e.date).getTime(),
        opponent: teamNickname((isHome ? aw : h).team.displayName, nflTeamIds),
        scored: isHome ? hs : as, allowed: isHome ? as : hs,
      });
    }
    logs[nick] = out;
  }
  return logs;
}

const before = (logs, cutoff) => {
  const out = {};
  for (const [k, v] of Object.entries(logs)) out[k] = v.filter(g => g.at < cutoff);
  return out;
};

// rows already carry margin, open, close, year, week and the two nicknames.
const byWeek = new Map();
for (const r of rows) {
  const k = r.year + '|' + r.week;
  if (!byWeek.has(k)) byWeek.set(k, []);
  byWeek.get(k).push(r);
}

const REGS = [0, 0.25, 0.5, 0.75, 1];
const FULLS = [4, 6, 8, 12];
// keyed by reg|full|bucket -> {sum, n}
const acc = new Map();
const mkt = new Map();
const bucketOf = (games) => games <= 2 ? '0-2 games' : games <= 5 ? '3-5 games'
  : games <= 8 ? '6-8 games' : '9+ games';

const seasons = [...new Set(rows.map(r => r.year))].sort();
const logsCache = {};
const ratedPriorCache = {};
const getLogs = (y) => (logsCache[y] || (logsCache[y] = seasonLogs(y)));
const getPrior = (y) => {
  if (!(y in ratedPriorCache)) {
    ratedPriorCache[y] = model.opponentAdjustedRatings(getLogs(y), { iterations: 3, minGames: 3 });
  }
  return ratedPriorCache[y];
};

for (const year of seasons) {
  const cur = getLogs(year);
  const prior = getPrior(year - 1);
  if (!prior) { console.error('no prior ratings for ' + (year - 1) + ', skipping ' + year); continue; }
  for (let week = 2; week <= 18; week++) {
    const set = byWeek.get(year + '|' + week);
    if (!set || !set.length) continue;
    // Every game in a week shares the same cutoff in the harness, so the logs
    // and the current-season ratings are computed once per week, not per game.
    const weekLogs = before(cur, weekCutoff(cur, year, week, set));
    const currentRated = model.opponentAdjustedRatings(weekLogs, { iterations: 3, minGames: 3 });

    for (const reg of REGS) {
      for (const full of FULLS) {
        const rated = model.blendSeasonRatings({
          prior, current: currentRated, gamesForFullWeight: full, priorRegression: reg,
        });
        if (!rated || !rated.ratings) continue;
        for (const r of set) {
          const hr = rated.ratings[r.hn], ar = rated.ratings[r.an];
          if (!hr || !ar) continue;
          const p = model.projectFromRatings({
            homeOff: hr.offense, homeDef: hr.defense,
            awayOff: ar.offense, awayDef: ar.defense,
            leagueAvg: rated.leagueAvg, sport: 'nfl',
          });
          if (!p) continue;
          const games = (weekLogs[r.hn] || []).length;
          const b = bucketOf(games);
          const key = reg + '|' + full + '|' + b;
          if (!acc.has(key)) acc.set(key, { sum: 0, n: 0 });
          const o = acc.get(key);
          o.sum += Math.abs(p.predictedMargin - r.margin);
          o.n++;
          const mk = b;
          if (!mkt.has(mk)) mkt.set(mk, { sum: 0, n: 0 });
        }
      }
    }
    // market benchmark, once per week per game
    for (const r of set) {
      const games = (weekLogs[r.hn] || []).length;
      const b = bucketOf(games);
      if (!mkt.has(b)) mkt.set(b, { sum: 0, n: 0 });
      const o = mkt.get(b);
      o.sum += Math.abs(-r.close - r.margin);
      o.n++;
    }
  }
}

/** The week's cutoff: the earliest kickoff among that week's games. */
function weekCutoff(cur, year, week, set) {
  // The harness stored no kickoff time, so derive it from the logs: the cutoff
  // is the earliest start among games in this week, which is the same instant
  // frozen-test.js used. Fall back to the max time before any of these games
  // appear in the team logs.
  let earliest = Infinity;
  for (const r of set) {
    for (const g of (cur[r.hn] || [])) {
      // a game of this team against this opponent is the one being predicted
      if (g.opponent === r.an && g.at < earliest) earliest = Math.min(earliest, g.at);
    }
  }
  return earliest === Infinity ? 0 : earliest;
}

const BUCKETS = ['0-2 games', '3-5 games', '6-8 games', '9+ games'];
console.log('MEAN ABSOLUTE ERROR of the projected margin, by how many games this season has');
console.log('(lower is better; the market closing line is the benchmark nothing is expected to beat)\n');
for (const b of BUCKETS) {
  const mb = mkt.get(b);
  if (!mb || !mb.n) continue;
  console.log(b + '   n=' + mb.n + '   market closing line: ' + (mb.sum / mb.n).toFixed(3));
  let head = '        full=  ';
  for (const f of FULLS) head += String(f).padStart(8);
  console.log(head);
  let best = null;
  for (const reg of REGS) {
    let line = '   reg=' + String(reg).padEnd(5) + '   ';
    for (const f of FULLS) {
      const o = acc.get(reg + '|' + f + '|' + b);
      if (!o || !o.n) { line += '      --'; continue; }
      const mae = o.sum / o.n;
      line += mae.toFixed(3).padStart(8);
      if (!best || mae < best.mae) best = { mae, reg, full: f };
    }
    console.log(line);
  }
  if (best) {
    console.log('   best: priorRegression=' + best.reg + ' gamesForFullWeight=' + best.full +
      '  (' + best.mae.toFixed(3) + ')   current setting 0.5/8: ' +
      (() => { const o = acc.get('0.5|8|' + b); return o && o.n ? (o.sum / o.n).toFixed(3) : '--'; })());
  }
  console.log('');
}
