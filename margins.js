// What do winning margins in baseball and hockey ACTUALLY look like?
//
// The cross-market pricing assumes a normal curve. Baseball margins are not
// normal — they are integers, they cannot be zero, and one-run games are far
// more common than a bell curve allows. That matters in exactly the wrong
// place: the run line sits at 1.5, so the entire question is how often a game
// is decided by exactly one run, which is the single value a normal
// approximation gets worst.
//
// So count them. Every final score ESPN has for the season, both sports.
//
// Run: node margins.js [sport] [days]

const SPORT = process.argv[2] || 'mlb';
const DAYS = Number(process.argv[3] || 150);

const PATHS = { mlb: 'baseball/mlb', nhl: 'hockey/nhl', nfl: 'football/nfl', nba: 'basketball/nba' };

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

function stamp(back) {
  const d = new Date(Date.UTC(2026, 7, 23));
  d.setUTCDate(d.getUTCDate() - back);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Score can arrive as "3" or {value:3}. Zero is a real score, so reject only
// null and empty before converting.
function readScore(c) {
  const raw = c && (typeof c.score === 'object' ? (c.score && c.score.value) : c.score);
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

(async () => {
  const path = PATHS[SPORT];
  const absMargin = new Map();       // |margin| -> count
  const byFavourite = { favWon: new Map(), dogWon: new Map(), unknown: 0 };
  let games = 0, skipped = 0;

  const dates = [];
  for (let i = 1; i <= DAYS; i++) dates.push(stamp(i));

  // A few at a time; ESPN is fine with this and it keeps the run short.
  const CHUNK = 8;
  for (let i = 0; i < dates.length; i += CHUNK) {
    const boards = await Promise.all(dates.slice(i, i + CHUNK).map(d =>
      getJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${d}`).catch(() => null)));

    for (const board of boards) {
      if (!board) continue;
      for (const ev of board.events || []) {
        const comp = (ev.competitions || [])[0];
        if (!comp) continue;
        const done = comp.status && comp.status.type && comp.status.type.completed;
        if (!done) { skipped++; continue; }
        const cs = comp.competitors || [];
        if (cs.length !== 2) { skipped++; continue; }
        const a = readScore(cs[0]), b = readScore(cs[1]);
        if (a === null || b === null) { skipped++; continue; }
        const margin = Math.abs(a - b);
        if (margin === 0) { skipped++; continue; }   // ties should not exist here
        games++;
        absMargin.set(margin, (absMargin.get(margin) || 0) + 1);

        // Did the moneyline favourite win? ESPN carries odds on some events.
        const odds = (comp.odds || [])[0];
        const detail = odds && (odds.details || '');
        const homeC = cs.find(c => c.homeAway === 'home');
        const awayC = cs.find(c => c.homeAway === 'away');
        let favIsHome = null;
        if (detail && homeC && homeC.team) {
          const abbr = homeC.team.abbreviation;
          if (abbr && detail.startsWith(abbr)) favIsHome = true;
          else if (awayC && awayC.team && awayC.team.abbreviation && detail.startsWith(awayC.team.abbreviation)) favIsHome = false;
        }
        if (favIsHome === null) { byFavourite.unknown++; continue; }
        const homeScore = readScore(homeC), awayScore = readScore(awayC);
        const homeWon = homeScore > awayScore;
        const favWon = favIsHome ? homeWon : !homeWon;
        const bucket = favWon ? byFavourite.favWon : byFavourite.dogWon;
        bucket.set(margin, (bucket.get(margin) || 0) + 1);
      }
    }
  }

  const show = (map, label) => {
    const total = [...map.values()].reduce((x, y) => x + y, 0);
    if (!total) { console.log(`  ${label}: none`); return null; }
    console.log(`  ${label} (${total} games)`);
    const keys = [...map.keys()].sort((x, y) => x - y);
    let cum = 0;
    for (const k of keys.slice(0, 8)) {
      const n = map.get(k);
      cum += n;
      console.log(`    by ${String(k).padStart(2)}: ${String(n).padStart(5)}  ${(n / total * 100).toFixed(1).padStart(5)}%   cumulative ${(cum / total * 100).toFixed(1)}%`);
    }
    return total;
  };

  console.log(`${SPORT.toUpperCase()} — ${DAYS} days back from 2026-08-23`);
  console.log(`  completed games: ${games}, skipped: ${skipped}\n`);
  const total = show(absMargin, 'winning margin, all games');

  if (total) {
    const one = (absMargin.get(1) || 0) / total;
    console.log(`\n  P(decided by exactly 1) = ${(one * 100).toFixed(2)}%`);
    console.log(`  P(decided by 2 or more) = ${((1 - one) * 100).toFixed(2)}%   <- what a 1.5 line is really asking`);

    // What a normal curve says instead, at the sigma the file carries.
    const model = require('./model');
    const sigma = model.SPORTS[SPORT].sigma;
    const d = model.marginDistribution(0, sigma);
    const normalOne = d.probAbove(0.5) - d.probAbove(1.5);
    console.log(`\n  a normal at sigma ${sigma} puts P(margin = 1 | home side) at ${(normalOne * 2 * 100).toFixed(2)}%`);
    console.log(`  reality is ${(one * 100).toFixed(2)}%, so the curve is ${normalOne * 2 < one ? 'UNDERSTATING' : 'overstating'} one-goal games` +
      ` by ${Math.abs(one - normalOne * 2) * 100 > 0 ? (Math.abs(one - normalOne * 2) * 100).toFixed(2) : 0} points`);
  }

  console.log('');
  show(byFavourite.favWon, 'when the favourite won');
  show(byFavourite.dogWon, 'when the underdog won');
  if (byFavourite.unknown) console.log(`  (${byFavourite.unknown} games had no readable favourite)`);
})();
