'use strict';
/**
 * NEGATIVE RESULT -- the projection does not beat a frozen line, in any form.
 * Kept so the idea is not proposed again from scratch. Re-run it if the ratings
 * themselves change; do not re-run it to see whether the answer improved.
 *
 * Measured 2023-2025, 690 games, opening line as the frozen number, push = loss:
 *
 *                              <1pt move   1-2pt    >=2pt    ALL
 *   back HOME (control)          47.1%      47.0%    54.6%   49.0%
 *   market moved toward (rule)   50.0%      54.7%    59.8%   54.1%
 *   projection, standalone       47.1%      57.2%    51.7%   51.7%
 *
 * Standalone it is worse than the rule everywhere except the 1-2pt bucket, and
 * it is 47.1% in the bucket that matters most -- the games where the market has
 * NOT moved, which is where the pool card has no edge and where a new signal
 * would have been worth the most. Backing it there loses money.
 *
 * As a FILTER on the rule it looked real and is not. Pooled, the rule goes 54.1%
 * -> 56.9% where the projection agrees and 51.3% where it disagrees, and that
 * 5-6 point gap appeared in all three seasons. It does not survive two checks:
 *
 *   inside each movement bucket   <1pt -0.7   1-2pt +14.4   >=2pt +0.5
 *   the 1-2pt bucket by season    2023 +34.8 (n=55)   2024 +17.1   2025 +4.2
 *
 * The whole effect sits in one movement bucket and decays from 34.8 points to
 * 4.2 across three seasons, with the oldest and smallest sample carrying it.
 * A real effect would appear in the >=2pt bucket too, where it is +0.5. Pooled
 * it is 2.21 SD after examining roughly sixteen bucket-by-strategy cells, which
 * is where a 2-SD cell is expected to turn up by chance.
 *
 * What this settles: the opponent-adjusted ratings are not an input to the pool
 * pick, and that is a measurement rather than an oversight. They stay where they
 * are -- the projected score and the write-up -- and reach/reach.js records that
 * they move nothing about which side is picked.
 *
 * ---------------------------------------------------------------------------
 *
 * CHECKED: backtest.js (walks weeks with no lookahead, but scores ACCURACY
 * against the closing line -- MAE, not a win rate, and never against a frozen
 * number), efftest.js (negative result on yards-per-play, a different input),
 * stale-keys.js / stale-oos.js / fade-the-move.js (the market-movement rule,
 * which is the thing this has to beat and is reproduced here as a control).
 *
 * Why it is worth running. The projection was benched because it averages 10.6
 * points of error against the real margin where the market line averages 10.1.
 * That is a fair reason not to bet it against the CLOSING line. The pool number
 * is frozen on Wednesday and never moves, and a Wednesday line knows strictly
 * less than Sunday's close -- it has not seen the injuries or the money. Losing
 * to the close does not establish losing to a Wednesday number.
 *
 * The opening line stands in for the frozen pool number. That is the same proxy
 * the stale-line rule was validated on (325 bets, 55.4%), so the control and the
 * candidate are measured on one footing.
 *
 * A push counts as a LOSS, because it does in the pool.
 *
 * Run: node frozen-test.js [firstYear] [lastYear]
 */
const fs = require('fs');
const model = require('./model');

const FIRST = Number(process.argv[2] || 2023);
const LAST = Number(process.argv[3] || 2025);
const CACHE = './frozen-cache.json';
const BREAK_EVEN = 0.524;

const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const i = src.indexOf('const nflTeamIds = {'), j = src.indexOf('\n};', i);
const nflTeamIds = eval('(' + src.slice(i + 'const nflTeamIds = '.length, j + 2) + ')');
const c = src.indexOf('function teamNickname'), d2 = src.indexOf('\n}\n', c) + 2;
const teamNickname = eval('(' + src.slice(c, d2) + ')');

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
let fetched = 0;
async function getJson(url) {
  if (cache[url] !== undefined) return cache[url];
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) { const v = await r.json(); cache[url] = v; fetched++; return v; }
    } catch (e) { /* retry */ }
    await new Promise(s => setTimeout(s, 400 * (a + 1)));
  }
  cache[url] = null;
  return null;
}
const save = () => fs.writeFileSync(CACHE, JSON.stringify(cache));

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace('+', '').trim());
  return Number.isFinite(n) ? n : null;
};
const scoreOf = (cmp) => {
  const raw = cmp && cmp.score;
  const n = Number(raw && typeof raw === 'object' ? raw.value : raw);
  return Number.isFinite(n) ? n : null;
};

/** Open and close home spread for one completed game, skipping live feeds. */
async function spreads(eventId) {
  const d = await getJson('https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/' +
    eventId + '/competitions/' + eventId + '/odds');
  const items = (d && d.items) || [];
  // The live feed sits in the same list carrying a number from the middle of the
  // game -- one showed 14.5 where the book had 2.5. Taking items[0] believes it.
  const it = items.find(x => !/live/i.test((x.provider && x.provider.name) || '') &&
                             x.homeTeamOdds && x.homeTeamOdds.open &&
                             x.homeTeamOdds.open.pointSpread);
  if (!it) return null;
  const hto = it.homeTeamOdds;
  const open = num(hto.open.pointSpread.american);
  const close = num(hto.current && hto.current.pointSpread && hto.current.pointSpread.american);
  return (open === null || close === null) ? null : { open: open, close: close };
}

async function seasonLogs(year) {
  const logs = {};
  for (const entry of Object.entries(nflTeamIds)) {
    const nick = entry[0], id = entry[1];
    const s = await getJson('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/' +
      id + '/schedule?season=' + year);
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
  for (const entry of Object.entries(logs)) {
    out[entry[0]] = entry[1].filter(g => g.at < cutoff);
  }
  return out;
};

(async () => {
  const rows = [];
  for (let year = FIRST; year <= LAST; year++) {
    const cur = await seasonLogs(year);
    // Production blends last season in until this one has eight games, so the
    // test has to as well -- otherwise it grades a model the app never runs.
    const prior = await seasonLogs(year - 1);
    const priorRated = model.opponentAdjustedRatings(prior, { iterations: 3, minGames: 3 });

    for (let week = 2; week <= 18; week++) {
      const sb = await getJson('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' +
        '?seasontype=2&week=' + week + '&dates=' + year + '&limit=100');
      const events = (sb && sb.events) || [];
      if (!events.length) continue;
      const cutoff = Math.min.apply(null, events.map(e => new Date(e.date).getTime()));
      const currentRated = model.opponentAdjustedRatings(before(cur, cutoff),
        { iterations: 3, minGames: 3 });
      const rated = model.blendSeasonRatings({
        prior: priorRated, current: currentRated,
        gamesForFullWeight: 8, priorRegression: 0.5,
      });
      if (!rated || !rated.ratings) continue;

      for (const ev of events) {
        const cm = ev.competitions[0];
        if (!(cm.status && cm.status.type && cm.status.type.completed)) continue;
        const H = cm.competitors.find(x => x.homeAway === 'home');
        const A = cm.competitors.find(x => x.homeAway === 'away');
        if (!H || !A) continue;
        const fh = scoreOf(H), fa = scoreOf(A);
        if (fh === null || fa === null) continue;
        const hn = teamNickname(H.team.displayName, nflTeamIds);
        const an = teamNickname(A.team.displayName, nflTeamIds);
        const hr = rated.ratings[hn], ar = rated.ratings[an];
        if (!hr || !ar) continue;
        const sp = await spreads(ev.id);
        if (!sp) continue;
        const proj = model.projectFromRatings({
          homeOff: hr.offense, homeDef: hr.defense,
          awayOff: ar.offense, awayDef: ar.defense,
          leagueAvg: rated.leagueAvg, sport: 'nfl',
        });
        if (!proj) continue;
        rows.push({ id: ev.id, year: year, week: week, hn: hn, an: an, margin: fh - fa,
                    open: sp.open, close: sp.close, proj: proj.predictedMargin });
      }
      save();
      process.stderr.write(year + ' wk' + week + ' rows=' + rows.length +
        ' fetched=' + fetched + '          \r');
    }
  }
  save();
  const prior = fs.existsSync('./frozen-rows.json')
    ? JSON.parse(fs.readFileSync('./frozen-rows.json', 'utf8')) : [];
  const merged = new Map();
  for (const r of prior) merged.set(String(r.id), r);
  for (const r of rows) merged.set(String(r.id), r);
  fs.writeFileSync('./frozen-rows.json', JSON.stringify([...merged.values()]));
  console.log('frozen-rows.json now holds ' + merged.size + ' games');
  console.error('');
  console.log('rows: ' + rows.length + '  (' + FIRST + '-' + LAST +
    ', network calls this run: ' + fetched + ')\n');

  // Settle one bet on the FROZEN (opening) number. side +1 home, -1 away.
  // A push is a loss, as it is in the pool.
  const settle = (r, side) => {
    const cover = r.margin + r.open;     // >0 home covers, <0 away covers, 0 push
    if (Math.abs(cover) < 1e-9) return 0;
    return (side > 0) === (cover > 0) ? 1 : 0;
  };
  const strategies = {
    'back HOME (control)': () => 1,
    'market moved toward (rule)': (r) => (r.close - r.open) < 0 ? 1 : -1,
    'projection': (r) => (r.proj > -r.open) ? 1 : -1,
    'both agree': (r) => {
      const mk = (r.close - r.open) < 0 ? 1 : -1;
      const pj = (r.proj > -r.open) ? 1 : -1;
      return mk === pj ? pj : 0;         // 0 = no bet
    },
  };
  const buckets = [
    ['market moved < 1pt   (the coin flips)', (r) => Math.abs(r.close - r.open) < 1],
    ['market moved 1 to 2pt', (r) => {
      const m = Math.abs(r.close - r.open); return m >= 1 && m < 2; }],
    ['market moved >= 2pt', (r) => Math.abs(r.close - r.open) >= 2],
    ['ALL games', () => true],
  ];

  for (const b of buckets) {
    const set = rows.filter(b[1]);
    console.log(b[0] + '   n=' + set.length);
    for (const entry of Object.entries(strategies)) {
      const name = entry[0], sideOf = entry[1];
      const bets = set.filter(r => sideOf(r) !== 0);
      if (!bets.length) { console.log('   ' + name.padEnd(28) + ' no bets'); continue; }
      const w = bets.reduce((s, r) => s + settle(r, sideOf(r)), 0);
      const rate = w / bets.length;
      console.log('   ' + name.padEnd(28) + ' ' + w + '-' + (bets.length - w) +
        '  ' + (rate * 100).toFixed(1) + '%  (n=' + bets.length + ')' +
        (rate >= BREAK_EVEN ? '  <== clears break-even' : ''));
    }
    console.log('');
  }
  console.log('break-even in this pool is ' + (BREAK_EVEN * 100).toFixed(1) +
    '% with a push counted as a loss.');
})();
