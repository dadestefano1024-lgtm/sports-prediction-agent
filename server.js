const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { Pool } = require('pg');

const model = require('./model');
const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ============================================================================
// DATABASE — Postgres pool for pick tracking and CLV measurement
// ============================================================================
// Uses Render's DATABASE_URL env var. SSL is required for Render Postgres
// when connecting from outside the local machine; rejectUnauthorized:false
// is the standard pattern for Render-hosted DBs.
let pool = null;
let dbReady = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Create tables on first run if they don't exist
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS picks (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          sport TEXT NOT NULL,
          espn_game_id TEXT,
          home_team TEXT NOT NULL,
          away_team TEXT NOT NULL,
          game_time TIMESTAMPTZ,
          market TEXT NOT NULL,
          pick TEXT NOT NULL,
          line NUMERIC,
          edge NUMERIC,
          confidence TEXT,
          predicted_home INT,
          predicted_away INT,
          line_at_pick NUMERIC,
          closing_line NUMERIC,
          result TEXT,
          actual_home INT,
          actual_away INT,
          graded_at TIMESTAMPTZ
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_picks_game ON picks(espn_game_id);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_picks_ungraded ON picks(result) WHERE result IS NULL;`);
      dbReady = true;
      console.log('[DB] Connected and tables ready');
    } catch (err) {
      console.error('[DB] Setup failed:', err.message);
      dbReady = false;
    }
  })();
} else {
  console.log('[DB] DATABASE_URL not set — pick tracking disabled');
}

// ============================================================================
// PICK TRACKING — save picks, grade results, query history
// ============================================================================

/**
 * Save a single pick to the database. Called once per game per market
 * (spread + total) when a prediction is generated.
 *
 * Silently no-ops if DB is unavailable so the app keeps working without it.
 */
async function savePick(pickData) {
  if (!dbReady || !pool) return null;
  try {
    // Dedup. The same slate is re-analyzed on every prediction cache miss, and
    // savePick was a bare INSERT, so a game sitting pre-game all day would
    // accumulate one duplicate row per run and silently inflate the History tab.
    const dupe = pickData.espn_game_id
      ? await pool.query(
          `SELECT id FROM picks WHERE espn_game_id = $1 AND market = $2 LIMIT 1`,
          [pickData.espn_game_id, pickData.market])
      : await pool.query(
          `SELECT id FROM picks WHERE sport = $1 AND home_team = $2 AND away_team = $3
             AND market = $4 AND game_time = $5 LIMIT 1`,
          [pickData.sport, pickData.home_team, pickData.away_team,
           pickData.market, pickData.game_time]);
    if (dupe.rows.length > 0) return null;

    const result = await pool.query(`
      INSERT INTO picks (
        sport, espn_game_id, home_team, away_team, game_time,
        market, pick, line, edge, confidence,
        predicted_home, predicted_away, line_at_pick
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id;
    `, [
      pickData.sport,
      pickData.espn_game_id,
      pickData.home_team,
      pickData.away_team,
      pickData.game_time,
      pickData.market,
      pickData.pick,
      pickData.line,
      pickData.edge,
      pickData.confidence,
      pickData.predicted_home,
      pickData.predicted_away,
      pickData.line_at_pick
    ]);
    return result.rows[0].id;
  } catch (err) {
    console.error('[DB] savePick error:', err.message);
    return null;
  }
}

/**
 * Save all picks from a generated games list. Skips games with no edge
 * ("No edge" picks) since those aren't actionable bets.
 */
async function savePicksFromGames(sport, games, eventMap) {
  if (!dbReady || !pool) return 0;
  let saved = 0;

  for (const game of games) {
    const espnGameId = eventMap[`${game.homeTeam}|${game.awayTeam}`] || null;
    const gameTime = game.gameTime ? new Date(game.gameTime) : null;

    // Save spread pick if there's an edge
    if (game.spreadPick && game.spreadPick !== 'No edge' && Math.abs(game.spreadEdge || 0) >= 2) {
      const id = await savePick({
        sport,
        espn_game_id: espnGameId,
        home_team: game.homeTeam,
        away_team: game.awayTeam,
        game_time: gameTime,
        market: 'spread',
        pick: game.spreadPick,
        line: parseFloat(game.spread) || null,
        edge: parseFloat(game.spreadEdge) || null,
        confidence: game.confidence,
        predicted_home: game.predictedScore?.home || null,
        predicted_away: game.predictedScore?.away || null,
        line_at_pick: parseFloat(game.spread) || null
      });
      if (id) saved++;
    }

    // Save total pick if there's an edge
    if (game.totalPick && game.totalPick !== 'No edge' && Math.abs(game.totalEdge || 0) >= 2) {
      const id = await savePick({
        sport,
        espn_game_id: espnGameId,
        home_team: game.homeTeam,
        away_team: game.awayTeam,
        game_time: gameTime,
        market: 'total',
        pick: game.totalPick,
        line: parseFloat(game.total) || null,
        edge: parseFloat(game.totalEdge) || null,
        confidence: game.confidence,
        predicted_home: game.predictedScore?.home || null,
        predicted_away: game.predictedScore?.away || null,
        line_at_pick: parseFloat(game.total) || null
      });
      if (id) saved++;
    }
  }

  if (saved > 0) console.log(`[DB] Saved ${saved} picks for ${sport}`);
  return saved;
}

/**
 * Grade ungraded picks by checking ESPN for finished game scores.
 * Runs as a background job every hour.
 */
async function gradePendingPicks() {
  if (!dbReady || !pool) return;

  try {
    const ungraded = await pool.query(`
      SELECT DISTINCT espn_game_id, sport
      FROM picks
      WHERE result IS NULL AND espn_game_id IS NOT NULL
      AND game_time < NOW()
      LIMIT 50;
    `);

    if (ungraded.rows.length === 0) return;
    console.log(`[DB] Grading ${ungraded.rows.length} games`);

    const sportPaths = {
      'nba': 'basketball/nba',
      'nhl': 'hockey/nhl',
      'mlb': 'baseball/mlb',
      'nfl': 'football/nfl'
    };

    for (const row of ungraded.rows) {
      const path = sportPaths[row.sport];
      if (!path) continue;

      try {
        const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard/${row.espn_game_id}`;
        // ESPN doesn't have a clean per-game endpoint, use summary instead
        const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${row.espn_game_id}`;
        const response = await axios.get(summaryUrl, { timeout: 5000 });

        const comp = response.data?.header?.competitions?.[0];
        if (!comp || !comp.status?.type?.completed) continue;

        const home = comp.competitors.find(c => c.homeAway === 'home');
        const away = comp.competitors.find(c => c.homeAway === 'away');
        const homeScore = parseScore(home);
        const awayScore = parseScore(away);

        if (homeScore === null || awayScore === null) continue;

        // Get all picks for this game
        const picks = await pool.query(
          `SELECT * FROM picks WHERE espn_game_id = $1 AND result IS NULL`,
          [row.espn_game_id]
        );

        for (const pick of picks.rows) {
          const result = gradePick(pick, homeScore, awayScore);
          await pool.query(
            `UPDATE picks SET result = $1, actual_home = $2, actual_away = $3, graded_at = NOW() WHERE id = $4`,
            [result, homeScore, awayScore, pick.id]
          );
        }
      } catch (e) {
        console.error(`[DB] Grading error for game ${row.espn_game_id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[DB] gradePendingPicks error:', err.message);
  }
}

/**
 * Grade a single pick against final scores. Returns 'win', 'loss', or 'push'.
 */
/**
 * Which side of the spread a stored pick is on.
 *
 * Lifted out of gradePick so grading and CLV cannot drift apart in how they
 * read the same row — if these two ever disagreed, CLV would be measured
 * against the opposite side of the bet being graded.
 *
 * Matches on the full team name first. gradePick previously compared only the
 * last word of each name, which collides whenever both teams share it: in
 * "Boston Red Sox @ Chicago White Sox" both nicknames reduce to "sox", the home
 * test runs first, and every such pick was read as home regardless of which
 * side was actually taken. Stored picks carry the full team name, so full-name
 * matching is both correct and available; the last-word test is kept only as a
 * fallback for anything older or hand-entered.
 */
function pickedSide(pick) {
  const text = (pick.pick || '').toLowerCase();
  if (!text) return null;

  const home = (pick.home_team || '').toLowerCase();
  const away = (pick.away_team || '').toLowerCase();
  if (home && text.includes(home)) return 'home';
  if (away && text.includes(away)) return 'away';

  const homeNick = home.split(' ').pop();
  const awayNick = away.split(' ').pop();
  if (homeNick && homeNick === awayNick) return null;   // ambiguous, refuse to guess
  if (homeNick && text.includes(homeNick)) return 'home';
  if (awayNick && text.includes(awayNick)) return 'away';
  return null;
}

function gradePick(pick, homeScore, awayScore) {
  const line = parseFloat(pick.line);
  if (isNaN(line)) return null;

  if (pick.market === 'spread') {
    // pick.pick contains text like "Lakers -5.5" or "Celtics +3.5"
    // Determine which team was picked: if pick contains home team name, picked home
    const side = pickedSide(pick);
    if (!side) return null;
    const pickedHome = side === 'home';

    // `line` is the home spread (negative = home favored).
    //
    // This previously computed `margin + (pickedHome ? line : -line)`, which is
    // wrong for away picks: it kept the margin from the HOME team's point of
    // view while flipping only the spread, testing against a threshold off by
    // twice the line. A Thunder +2.5 bet that lost by 2 (a winner, 108 + 2.5 >
    // 110) was scored a loss. That systematically marked winning away bets as
    // losses and is most of why the spread record read 39%.
    //
    // Evaluate the cover from the perspective of whichever side was picked:
    // the away team's margin and spread are both the negation of the home ones.
    const margin = homeScore - awayScore;
    const adjusted = pickedHome ? (margin + line) : (-margin - line);

    if (adjusted > 0) return 'win';
    if (adjusted < 0) return 'loss';
    return 'push';
  }

  if (pick.market === 'total') {
    const totalScore = homeScore + awayScore;
    const pickText = (pick.pick || '').toLowerCase();
    const isOver = pickText.includes('over');
    const isUnder = pickText.includes('under');

    if (!isOver && !isUnder) return null;

    if (totalScore > line) return isOver ? 'win' : 'loss';
    if (totalScore < line) return isUnder ? 'win' : 'loss';
    return 'push';
  }

  return null;
}

/**
 * Capture closing lines for picks whose game is about to start.
 *
 * Closing line value is the only fast read on whether a model is doing
 * anything. A win rate needs on the order of a thousand bets before skill
 * separates from noise; repeatedly beating the number the market settles on is
 * itself the evidence, and it shows up in weeks. The closing_line column has
 * existed since the table was created and was never once written to.
 *
 * Lines come from the ESPN odds scrape rather than The Odds API. A job polling
 * near every game start would burn the 500-request monthly quota in days, and
 * ESPN's current line is free and already fetched and cached elsewhere in this
 * file. It is a scrape and can break; a missing closing line costs one CLV
 * sample and nothing else.
 *
 * The window is games starting within the next 30 minutes that have not yet
 * started. Running every 10 minutes means each qualifying game is seen at least
 * once before kickoff. After kickoff ESPN may serve live numbers, so games
 * already under way are deliberately skipped rather than risk recording an
 * in-play line as the close.
 */
async function captureClosingLines() {
  if (!dbReady || !pool) return;
  try {
    const due = await pool.query(`
      SELECT DISTINCT sport, espn_game_id
      FROM picks
      WHERE closing_line IS NULL
        AND espn_game_id IS NOT NULL
        AND game_time IS NOT NULL
        AND game_time > NOW()
        AND game_time <= NOW() + INTERVAL '30 minutes'
      LIMIT 100;
    `);
    if (due.rows.length === 0) return;

    const bySport = {};
    for (const row of due.rows) {
      (bySport[row.sport] = bySport[row.sport] || []).push(row.espn_game_id);
    }

    let written = 0, rejected = 0;
    for (const [sport, gameIds] of Object.entries(bySport)) {
      let lines;
      try {
        lines = await fetchEspnOpeningLines(sport);
      } catch (e) {
        console.error(`[CLV] line fetch failed for ${sport}:`, e.message);
        continue;
      }
      for (const gameId of gameIds) {
        const current = lines && lines[gameId];
        const closing = current ? current.currentSpread : null;
        // Refuse anything a book could not have posted. The ESPN spread parse
        // is demonstrably broken — constant openSpread per sport, run lines of
        // 0 and -3 — and a wrong closing line is worse than a missing one
        // because it still reads as a measurement.
        if (!model.plausibleSpread(sport, closing)) { rejected++; continue; }
        const res = await pool.query(
          `UPDATE picks SET closing_line = $1
             WHERE espn_game_id = $2 AND market = 'spread' AND closing_line IS NULL`,
          [closing, gameId]);
        written += res.rowCount;
      }
    }
    if (written > 0) console.log(`[CLV] captured closing lines for ${written} picks`);
    if (rejected > 0) {
      console.warn(`[CLV] rejected ${rejected} implausible lines from the ESPN scrape`);
    }
  } catch (err) {
    console.error('[CLV] captureClosingLines error:', err.message);
  }
}

/**
 * Aggregate closing line value across graded spread picks.
 *
 * Positive means the line moved toward us after we bet — we took a better
 * number than the market settled on. Beating the close more than half the time,
 * consistently, is the signal that a model has genuine information. It is worth
 * far more than a short-run win rate: 159 picks cannot distinguish skill from
 * noise, but a persistent CLV edge over a few weeks can.
 */
/**
 * Null out any stored closing line that could not have been a real posted line.
 *
 * Needed because the broken scrape already wrote one: a -9.5 average CLV on an
 * MLB run line, which is arithmetically impossible when the line is always 1.5.
 */
async function clearImplausibleClosingLines() {
  if (!dbReady || !pool) return 0;
  const rows = await pool.query(
    `SELECT id, sport, closing_line FROM picks WHERE closing_line IS NOT NULL`);
  const bad = rows.rows
    .filter(r => !model.plausibleSpread(r.sport, r.closing_line))
    .map(r => r.id);
  if (!bad.length) return 0;
  await pool.query(`UPDATE picks SET closing_line = NULL WHERE id = ANY($1::int[])`, [bad]);
  console.log(`[CLV] cleared ${bad.length} implausible closing lines`);
  return bad.length;
}

async function getClvStats(sport = null) {
  if (!dbReady || !pool) return null;
  const filter = sport ? `AND sport = $1` : '';
  const params = sport ? [sport] : [];
  const rows = await pool.query(`
    SELECT pick, home_team, away_team, line_at_pick, closing_line
    FROM picks
    WHERE market = 'spread'
      AND closing_line IS NOT NULL
      AND line_at_pick IS NOT NULL
      ${filter};
  `, params);

  let beat = 0, tied = 0, lost = 0, sum = 0, n = 0;
  for (const r of rows.rows) {
    const side = pickedSide(r);
    if (!side) continue;
    const clv = model.closingLineValue({
      betSpread: Number(r.line_at_pick),
      closingSpread: Number(r.closing_line),
      side,
    });
    if (clv === null || !Number.isFinite(clv)) continue;
    n++; sum += clv;
    if (clv > 0) beat++; else if (clv < 0) lost++; else tied++;
  }

  return {
    samples: n,
    avgCLV: n ? +(sum / n).toFixed(3) : null,
    beat, tied, lost,
    beatRate: n ? +(beat / n).toFixed(4) : null,
  };
}

/**
 * Get aggregated history stats for the History tab.
 */
async function getHistoryStats(sport = null, limit = 50) {
  if (!dbReady || !pool) {
    return { available: false, message: 'Database not configured' };
  }

  try {
    const sportFilter = sport ? `WHERE sport = $1` : '';
    const params = sport ? [sport] : [];

    // Overall record
    const overall = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE result = 'win') as wins,
        COUNT(*) FILTER (WHERE result = 'loss') as losses,
        COUNT(*) FILTER (WHERE result = 'push') as pushes,
        COUNT(*) FILTER (WHERE result IS NULL) as pending,
        COUNT(*) as total
      FROM picks ${sportFilter};
    `, params);

    // By market
    const byMarket = await pool.query(`
      SELECT market,
        COUNT(*) FILTER (WHERE result = 'win') as wins,
        COUNT(*) FILTER (WHERE result = 'loss') as losses,
        COUNT(*) FILTER (WHERE result = 'push') as pushes
      FROM picks
      ${sportFilter}
      ${sport ? 'AND' : 'WHERE'} result IS NOT NULL
      GROUP BY market;
    `, params);

    // By confidence
    const byConfidence = await pool.query(`
      SELECT confidence,
        COUNT(*) FILTER (WHERE result = 'win') as wins,
        COUNT(*) FILTER (WHERE result = 'loss') as losses,
        COUNT(*) FILTER (WHERE result = 'push') as pushes
      FROM picks
      ${sportFilter}
      ${sport ? 'AND' : 'WHERE'} result IS NOT NULL
      GROUP BY confidence;
    `, params);

    // Recent picks (last 50)
    // The History tab renders 50 rows, but analysing the bank (favourite vs
    // underdog splits, duplicate detection) needs the whole set, so the caller
    // can raise this. Clamped so a stray ?limit=999999 can't pull the table.
    // espn_game_id and game_time are selected for duplicate detection; the
    // frontend ignores the extra fields.
    const rowLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 5000);
    const recent = await pool.query(`
      SELECT id, created_at, sport, espn_game_id, home_team, away_team, game_time,
             market, pick, line, edge, confidence, result, actual_home, actual_away
      FROM picks
      ${sportFilter}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1};
    `, [...params, rowLimit]);

    return {
      available: true,
      overall: overall.rows[0],
      byMarket: byMarket.rows,
      byConfidence: byConfidence.rows,
      clv: await getClvStats(sport),
      returned: recent.rows.length,
      recent: recent.rows
    };
  } catch (err) {
    console.error('[DB] getHistoryStats error:', err.message);
    return { available: false, message: err.message };
  }
}

// ============================================================================
// ODDS CACHE — prevents burning through Odds API quota on repeated page loads
// The Odds API free tier is 500 requests/month. Without caching, every refresh
// of the app burns 1 request per sport. Cache odds for 60 minutes.
// ============================================================================
const oddsCache = {};
const ODDS_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
// This TTL is the real spend governor on The Odds API free tier (500 requests
// per month, ~3 per fetch). It caps cost at ~3 requests/hour/sport no matter
// how often the frontend asks. It was 5 minutes, which exactly matched the
// frontend's 5-minute auto-refresh, so every single auto-refresh was a
// guaranteed cache miss.

// Separate cache for ESPN opening-line scrapes (also 5 min)
const espnOddsCache = {};
const ESPN_ODDS_CACHE_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// NBA TEAM IDS & LOCATIONS
// ============================================================================

const nbaTeamIds = {
  'Hawks': 1, 'Celtics': 2, 'Nets': 17, 'Hornets': 30, 'Bulls': 4,
  'Cavaliers': 5, 'Mavericks': 6, 'Nuggets': 7, 'Pistons': 8, 'Warriors': 9,
  'Rockets': 10, 'Pacers': 11, 'Clippers': 12, 'Lakers': 13, 'Grizzlies': 29,
  'Heat': 14, 'Bucks': 15, 'Timberwolves': 16, 'Pelicans': 3, 'Knicks': 18,
  'Thunder': 25, 'Magic': 19, 'Sixers': 20, 'Suns': 21, 'Trail Blazers': 22,
  'Kings': 23, 'Spurs': 24, 'Raptors': 28, 'Jazz': 26, 'Wizards': 27
};

const nbaTeamLocations = {
  'Hawks': { lat: 33.7573, lon: -84.3963, tz: -5 },
  'Celtics': { lat: 42.3662, lon: -71.0621, tz: -5 },
  'Nets': { lat: 40.6826, lon: -73.9754, tz: -5 },
  'Hornets': { lat: 35.2251, lon: -80.8392, tz: -5 },
  'Bulls': { lat: 41.8807, lon: -87.6742, tz: -6 },
  'Cavaliers': { lat: 41.4965, lon: -81.6882, tz: -5 },
  'Mavericks': { lat: 32.7905, lon: -96.8103, tz: -6 },
  'Nuggets': { lat: 39.7487, lon: -104.8769, tz: -7 },
  'Pistons': { lat: 42.3410, lon: -83.0550, tz: -5 },
  'Warriors': { lat: 37.7680, lon: -122.3878, tz: -8 },
  'Rockets': { lat: 29.7508, lon: -95.3621, tz: -6 },
  'Pacers': { lat: 39.7640, lon: -86.1555, tz: -5 },
  'Clippers': { lat: 34.0430, lon: -118.2673, tz: -8 },
  'Lakers': { lat: 34.0430, lon: -118.2673, tz: -8 },
  'Grizzlies': { lat: 35.1382, lon: -90.0505, tz: -6 },
  'Heat': { lat: 25.7814, lon: -80.1870, tz: -5 },
  'Bucks': { lat: 43.0435, lon: -87.9170, tz: -6 },
  'Timberwolves': { lat: 44.9795, lon: -93.2760, tz: -6 },
  'Pelicans': { lat: 29.9490, lon: -90.0821, tz: -6 },
  'Knicks': { lat: 40.7505, lon: -73.9934, tz: -5 },
  'Thunder': { lat: 35.4634, lon: -97.5151, tz: -6 },
  'Magic': { lat: 28.5392, lon: -81.3839, tz: -5 },
  'Sixers': { lat: 39.9012, lon: -75.1720, tz: -5 },
  'Suns': { lat: 33.4457, lon: -112.0712, tz: -7 },
  'Trail Blazers': { lat: 45.5317, lon: -122.6668, tz: -8 },
  'Kings': { lat: 38.5802, lon: -121.4997, tz: -8 },
  'Spurs': { lat: 29.4270, lon: -98.4375, tz: -6 },
  'Raptors': { lat: 43.6435, lon: -79.3791, tz: -5 },
  'Jazz': { lat: 40.7683, lon: -111.9011, tz: -7 },
  'Wizards': { lat: 38.8981, lon: -77.0209, tz: -5 }
};

// ============================================================================
// NHL TEAM IDS & LOCATIONS
// ============================================================================

const nhlTeamIds = {
  'Bruins': 6, 'Sabres': 7, 'Red Wings': 17, 'Panthers': 13, 'Canadiens': 8,
  'Senators': 9, 'Lightning': 14, 'Maple Leafs': 10, 'Hurricanes': 12, 'Blue Jackets': 29,
  'Devils': 1, 'Islanders': 2, 'Rangers': 3, 'Flyers': 4, 'Penguins': 5,
  'Capitals': 15, 'Blackhawks': 16, 'Avalanche': 21, 'Stars': 25, 'Wild': 30,
  'Predators': 18, 'Blues': 19, 'Jets': 52, 'Ducks': 24, 'Flames': 20,
  'Oilers': 22, 'Kings': 26, 'Sharks': 28, 'Kraken': 55, 'Canucks': 23,
  'Golden Knights': 54, 'Coyotes': 53
};

const nhlTeamLocations = {
  'Bruins': { lat: 42.3662, lon: -71.0621, tz: -5 },
  'Sabres': { lat: 42.8750, lon: -78.8764, tz: -5 },
  'Red Wings': { lat: 42.3410, lon: -83.0550, tz: -5 },
  'Panthers': { lat: 26.1583, lon: -80.3256, tz: -5 },
  'Canadiens': { lat: 45.4960, lon: -73.5694, tz: -5 },
  'Senators': { lat: 45.2968, lon: -75.9274, tz: -5 },
  'Lightning': { lat: 27.9425, lon: -82.4517, tz: -5 },
  'Maple Leafs': { lat: 43.6435, lon: -79.3791, tz: -5 },
  'Hurricanes': { lat: 35.8032, lon: -78.7219, tz: -5 },
  'Blue Jackets': { lat: 39.9693, lon: -83.0061, tz: -5 },
  'Devils': { lat: 40.7336, lon: -74.1710, tz: -5 },
  'Islanders': { lat: 40.7225, lon: -73.5907, tz: -5 },
  'Rangers': { lat: 40.7505, lon: -73.9934, tz: -5 },
  'Flyers': { lat: 39.9012, lon: -75.1720, tz: -5 },
  'Penguins': { lat: 40.4396, lon: -79.9892, tz: -5 },
  'Capitals': { lat: 38.8981, lon: -77.0209, tz: -5 },
  'Blackhawks': { lat: 41.8807, lon: -87.6742, tz: -6 },
  'Avalanche': { lat: 39.7487, lon: -104.8769, tz: -7 },
  'Stars': { lat: 32.7905, lon: -96.8103, tz: -6 },
  'Wild': { lat: 44.9795, lon: -93.2760, tz: -6 },
  'Predators': { lat: 36.1591, lon: -86.7784, tz: -6 },
  'Blues': { lat: 38.6266, lon: -90.2026, tz: -6 },
  'Jets': { lat: 49.8928, lon: -97.1436, tz: -6 },
  'Ducks': { lat: 33.8078, lon: -117.8764, tz: -8 },
  'Flames': { lat: 51.0373, lon: -114.0519, tz: -7 },
  'Oilers': { lat: 53.5467, lon: -113.4969, tz: -7 },
  'Kings': { lat: 34.0430, lon: -118.2673, tz: -8 },
  'Sharks': { lat: 37.3327, lon: -121.9010, tz: -8 },
  'Kraken': { lat: 47.6221, lon: -122.3540, tz: -8 },
  'Canucks': { lat: 49.2778, lon: -123.1089, tz: -8 },
  'Golden Knights': { lat: 36.0909, lon: -115.1833, tz: -8 },
  'Coyotes': { lat: 33.5318, lon: -112.2611, tz: -7 }
};

// ============================================================================
// MLB TEAM IDS & LOCATIONS
// ============================================================================

const mlbTeamIds = {
  'Diamondbacks': 29, 'Braves': 15, 'Orioles': 1, 'Red Sox': 2, 'Cubs': 16,
  'White Sox': 4, 'Reds': 17, 'Guardians': 5, 'Rockies': 27, 'Tigers': 6,
  'Astros': 18, 'Royals': 7, 'Angels': 3, 'Dodgers': 19, 'Marlins': 28,
  'Brewers': 8, 'Twins': 9, 'Mets': 21, 'Yankees': 10, 'Athletics': 11,
  'Phillies': 22, 'Pirates': 23, 'Padres': 25, 'Giants': 26, 'Mariners': 12,
  'Cardinals': 24, 'Rays': 30, 'Rangers': 13, 'Blue Jays': 14, 'Nationals': 20
};

const mlbTeamLocations = {
  'Diamondbacks': { lat: 33.4453, lon: -112.0667, tz: -7 },
  'Braves': { lat: 33.8907, lon: -84.4677, tz: -5 },
  'Orioles': { lat: 39.2839, lon: -76.6216, tz: -5 },
  'Red Sox': { lat: 42.3467, lon: -71.0972, tz: -5 },
  'Cubs': { lat: 41.9484, lon: -87.6553, tz: -6 },
  'White Sox': { lat: 35.3345, lon: -89.9521, tz: -6 },
  'Reds': { lat: 39.0974, lon: -84.5061, tz: -5 },
  'Guardians': { lat: 41.4962, lon: -81.6852, tz: -5 },
  'Rockies': { lat: 39.7559, lon: -104.9942, tz: -7 },
  'Tigers': { lat: 42.3390, lon: -83.0485, tz: -5 },
  'Astros': { lat: 29.7572, lon: -95.3555, tz: -6 },
  'Royals': { lat: 39.0517, lon: -94.4803, tz: -6 },
  'Angels': { lat: 33.8003, lon: -117.8827, tz: -8 },
  'Dodgers': { lat: 34.0739, lon: -118.2400, tz: -8 },
  'Marlins': { lat: 25.7781, lon: -80.2197, tz: -5 },
  'Brewers': { lat: 43.0280, lon: -87.9712, tz: -6 },
  'Twins': { lat: 44.9817, lon: -93.2776, tz: -6 },
  'Mets': { lat: 40.7571, lon: -73.8458, tz: -5 },
  'Yankees': { lat: 40.8296, lon: -73.9262, tz: -5 },
  'Athletics': { lat: 37.7516, lon: -122.2005, tz: -8 },
  'Phillies': { lat: 39.9061, lon: -75.1665, tz: -5 },
  'Pirates': { lat: 40.4469, lon: -80.0057, tz: -5 },
  'Padres': { lat: 32.7073, lon: -117.1566, tz: -8 },
  'Giants': { lat: 37.7786, lon: -122.3893, tz: -8 },
  'Mariners': { lat: 47.5914, lon: -122.3325, tz: -8 },
  'Cardinals': { lat: 38.6226, lon: -90.1928, tz: -6 },
  'Rays': { lat: 27.7682, lon: -82.6534, tz: -5 },
  'Rangers': { lat: 32.7512, lon: -97.0826, tz: -6 },
  'Blue Jays': { lat: 43.6414, lon: -79.3894, tz: -5 },
  'Nationals': { lat: 38.8730, lon: -77.0074, tz: -5 }
};

const ballparkFactors = {
  'Coors Field': 1.25, 'Great American Ball Park': 1.15, 'Camden Yards': 1.10,
  'Globe Life Field': 1.10, 'Fenway Park': 1.08, 'Yankee Stadium': 1.08,
  'Citizens Bank Park': 1.08, 'Truist Park': 1.05, 'Chase Field': 1.05,
  'Wrigley Field': 1.05, 'T-Mobile Park': 0.92, 'Oracle Park': 0.90,
  'Petco Park': 0.90, 'Tropicana Field': 0.95, 'Marlins Park': 0.95
};

// ============================================================================
// ESPN STATS — NBA
// ============================================================================

// ============================================================================
// SHARED HTTP CACHE (ESPN)
// ============================================================================
// Several fetchers request the exact same URL within a single prediction run.
// fetchRecentGames and fetchPaceData both read /teams/{id}/schedule and parse
// different fields out of it, and fetchInjuries pulls the league-wide injury
// page once per team — 30 identical downloads on a 15-game slate. Roughly half
// the outbound ESPN traffic was redundant.
//
// The inFlight map matters as much as the TTL here: the duplicate calls are
// issued concurrently inside Promise.all, so a TTL alone would not help — both
// would miss the cache and fetch anyway. Concurrent callers share one promise.
//
// Returns an axios-shaped { data } object so call sites keep reading .data.
const httpCache = {};
const inFlightRequests = {};
const HTTP_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function cachedGet(url, options) {
  const hit = httpCache[url];
  if (hit && (Date.now() - hit.timestamp) < HTTP_CACHE_TTL_MS) {
    return { data: hit.data };
  }
  if (inFlightRequests[url]) return inFlightRequests[url];

  inFlightRequests[url] = axios.get(url, options)
    .then(response => {
      httpCache[url] = { timestamp: Date.now(), data: response.data };
      delete inFlightRequests[url];
      return { data: response.data };
    })
    .catch(err => {
      delete inFlightRequests[url];
      throw err;
    });

  return inFlightRequests[url];
}

/**
 * Read a score off an ESPN competitor, whichever shape it arrives in.
 *
 * The two ESPN endpoints disagree. /summary (used by grading) returns a plain
 * string, "3". /teams/{id}/schedule (used by every recent-form fetcher) returns
 * an object, {value: 3, displayValue: "3"}. All the schedule callers did
 * parseInt(competitor.score), which on the object form is
 * parseInt("[object Object]") === NaN.
 *
 * So every last-10 record read 0-10 and every scoring average was NaN, for all
 * three sports, and those NaNs were interpolated into the prompt and sent to
 * Claude as the string "NaN". Nothing objected, because nothing checked — the
 * model was happy to write confident numbers on top of missing data. It only
 * surfaced when model.js started validating its inputs and refused to project.
 *
 * Returns null rather than NaN so callers must decide what to do about it.
 */
/**
 * Resolve a team's map key from its ESPN display name.
 *
 * The handlers used displayName.split(' ').pop(), which keeps only the last
 * word. That silently breaks every two-word nickname: "Boston Red Sox" became
 * "Sox", "Toronto Blue Jays" became "Jays", "Chicago White Sox" became "Sox".
 * The id lookup then missed, the fetcher returned null, and that team had no
 * form data at all — with nothing logged and nothing failing. Eight teams were
 * affected across the three sports: Red Sox, White Sox, Blue Jays, Maple Leafs,
 * Blue Jackets, Golden Knights, Red Wings and Trail Blazers.
 *
 * Try progressively longer suffixes against the map and take the first that
 * exists. Falls back to the last word when no map is given, so behaviour is
 * unchanged for callers that do not have one.
 */
// ============================================================================
// NFL TEAMS
// ============================================================================
// ESPN ids and the indoor flag come from its teams API; the coordinates do not
// exist there and are stadium locations. tz is the standard-time UTC offset —
// Arizona is -7 year round because it does not observe DST, which matters for
// the travel calculation.
//
// dome is recorded per ESPN's venue.indoor and covers retractable roofs too. It
// is the prerequisite for weather adjustment on totals, which is not built yet:
// wind is the single largest weather effect on an NFL total, and applying it to
// a covered stadium would be worse than not applying it at all.
const nflTeamIds = {
  '49ers': 25, 'Bears': 3, 'Bengals': 4, 'Bills': 2,
  'Broncos': 7, 'Browns': 5, 'Buccaneers': 27, 'Cardinals': 22,
  'Chargers': 24, 'Chiefs': 12, 'Colts': 11, 'Commanders': 28,
  'Cowboys': 6, 'Dolphins': 15, 'Eagles': 21, 'Falcons': 1,
  'Giants': 19, 'Jaguars': 30, 'Jets': 20, 'Lions': 8,
  'Packers': 9, 'Panthers': 29, 'Patriots': 17, 'Raiders': 13,
  'Rams': 14, 'Ravens': 33, 'Saints': 18, 'Seahawks': 26,
  'Steelers': 23, 'Texans': 34, 'Titans': 10, 'Vikings': 16
};

const nflTeamLocations = {
  '49ers': { lat: 37.4033, lon: -121.9694, tz: -8, dome: false },  // Levi's Stadium
  'Bears': { lat: 41.8623, lon: -87.6167, tz: -6, dome: false },  // Soldier Field
  'Bengals': { lat: 39.0955, lon: -84.5161, tz: -5, dome: false },  // Paycor Stadium
  'Bills': { lat: 42.7738, lon: -78.7870, tz: -5, dome: false },  // Highmark Stadium
  'Broncos': { lat: 39.7439, lon: -105.0201, tz: -7, dome: false },  // Empower Field at Mile High
  'Browns': { lat: 41.5061, lon: -81.6995, tz: -5, dome: false },  // Huntington Bank Field
  'Buccaneers': { lat: 27.9759, lon: -82.5033, tz: -5, dome: false },  // Raymond James Stadium
  'Cardinals': { lat: 33.5276, lon: -112.2626, tz: -7, dome: true },  // State Farm Stadium
  'Chargers': { lat: 33.9535, lon: -118.3392, tz: -8, dome: false },  // Dignity Health Sports Park
  'Chiefs': { lat: 39.0489, lon: -94.4839, tz: -6, dome: false },  // Arrowhead Stadium
  'Colts': { lat: 39.7601, lon: -86.1639, tz: -5, dome: true },  // Lucas Oil Stadium
  'Commanders': { lat: 38.9077, lon: -76.8645, tz: -5, dome: false },  // Northwest Stadium
  'Cowboys': { lat: 32.7473, lon: -97.0945, tz: -6, dome: true },  // AT&T Stadium
  'Dolphins': { lat: 25.9580, lon: -80.2389, tz: -5, dome: false },  // Hard Rock Stadium
  'Eagles': { lat: 39.9008, lon: -75.1675, tz: -5, dome: false },  // Lincoln Financial Field
  'Falcons': { lat: 33.7554, lon: -84.4008, tz: -5, dome: true },  // Mercedes-Benz Stadium
  'Giants': { lat: 40.8135, lon: -74.0745, tz: -5, dome: false },  // MetLife Stadium
  'Jaguars': { lat: 30.3239, lon: -81.6373, tz: -5, dome: false },  // EverBank Stadium
  'Jets': { lat: 40.8135, lon: -74.0745, tz: -5, dome: false },  // MetLife Stadium
  'Lions': { lat: 42.3400, lon: -83.0456, tz: -5, dome: true },  // Ford Field
  'Packers': { lat: 44.5013, lon: -88.0622, tz: -6, dome: false },  // Lambeau Field
  'Panthers': { lat: 35.2258, lon: -80.8528, tz: -5, dome: false },  // Bank of America Stadium
  'Patriots': { lat: 42.0909, lon: -71.2643, tz: -5, dome: false },  // Gillette Stadium
  'Raiders': { lat: 36.0909, lon: -115.1833, tz: -8, dome: true },  // Allegiant Stadium
  'Rams': { lat: 33.9535, lon: -118.3392, tz: -8, dome: false },  // Los Angeles Memorial Coliseum
  'Ravens': { lat: 39.2780, lon: -76.6227, tz: -5, dome: false },  // M&T Bank Stadium
  'Saints': { lat: 29.9511, lon: -90.0812, tz: -6, dome: true },  // Caesars Superdome
  'Seahawks': { lat: 47.5952, lon: -122.3316, tz: -8, dome: false },  // Lumen Field
  'Steelers': { lat: 40.4468, lon: -80.0158, tz: -5, dome: false },  // Acrisure Stadium
  'Texans': { lat: 29.6847, lon: -95.4107, tz: -6, dome: true },  // Reliant Stadium
  'Titans': { lat: 36.1665, lon: -86.7713, tz: -6, dome: false },  // Nissan Stadium
  'Vikings': { lat: 44.9738, lon: -93.2578, tz: -6, dome: true },  // U.S. Bank Stadium
};

function teamNickname(displayName, idMap) {
  const parts = String(displayName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (idMap) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const candidate = parts.slice(i).join(' ');
      if (Object.prototype.hasOwnProperty.call(idMap, candidate)) return candidate;
    }
  }
  return parts[parts.length - 1];
}

function parseScore(competitor) {
  const raw = competitor && competitor.score;
  const val = raw !== null && typeof raw === 'object' ? raw.value : raw;
  // Reject empties explicitly before Number(): Number(null) and Number('') are
  // both 0, and 0 is a perfectly real score in hockey and baseball. Coercing
  // missing data into a shutout would be worse than dropping the game.
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

async function fetchNBATeamStats(teamName) {
  try {
    const teamId = nbaTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}`;
    const response = await cachedGet(url, { timeout: 5000 });
    const team = response.data.team;
    const record = team.record?.items?.find(r => r.type === 'total');
    const homeRecord = team.record?.items?.find(r => r.type === 'home');
    const awayRecord = team.record?.items?.find(r => r.type === 'road');
    return {
      record: record?.summary || 'N/A',
      homeRecord: homeRecord?.summary || 'N/A',
      awayRecord: awayRecord?.summary || 'N/A',
      wins: record?.stats?.find(s => s.name === 'wins')?.value || 0,
      losses: record?.stats?.find(s => s.name === 'losses')?.value || 0
    };
  } catch (error) {
    console.error(`Error fetching NBA stats for ${teamName}:`, error.message);
    return null;
  }
}

async function fetchRecentGames(teamName) {
  try {
    const teamId = nbaTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/schedule`;
    const response = await cachedGet(url, { timeout: 5000 });
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(0, 10);

    let wins = 0, totalScored = 0, totalAllowed = 0, counted = 0;
    completedGames.forEach(game => {
      const comp = game.competitions[0];
      const h = comp.competitors.find(c => c.homeAway === 'home');
      const a = comp.competitors.find(c => c.homeAway === 'away');
      const hs = parseScore(h), as = parseScore(a);
      if (hs === null || as === null) return;   // unscored game contributes nothing
      const isHome = h.team.id == teamId;
      const ts = isHome ? hs : as;
      const os = isHome ? as : hs;
      counted++;
      if (ts > os) wins++;
      totalScored += ts;
      totalAllowed += os;
    });

    return {
      last10: `${wins}-${counted - wins}`,
      avgScored: counted > 0 ? (totalScored / counted).toFixed(1) : 0,
      avgAllowed: counted > 0 ? (totalAllowed / counted).toFixed(1) : 0
    };
  } catch (error) {
    console.error(`Error fetching recent games for ${teamName}:`, error.message);
    return null;
  }
}

async function fetchPaceData(teamName) {
  try {
    const teamId = nbaTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/schedule`;
    const response = await cachedGet(url, { timeout: 5000 });
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(0, 10);
    if (completedGames.length === 0) return null;
    let totalPoints = 0, counted = 0;
    completedGames.forEach(game => {
      const comp = game.competitions[0];
      const h = comp.competitors.find(c => c.homeAway === 'home');
      const a = comp.competitors.find(c => c.homeAway === 'away');
      const hs = parseScore(h), as = parseScore(a);
      if (hs === null || as === null) return;
      totalPoints += hs + as;
      counted++;
    });
    if (counted === 0) return null;
    const avgTotal = totalPoints / counted;
    let pace = 'Average';
    if (avgTotal > 225) pace = 'Fast';
    else if (avgTotal < 215) pace = 'Slow';
    return { avgTotal: avgTotal.toFixed(1), pace };
  } catch (error) {
    return null;
  }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function fetchTravelData(awayTeam, homeTeam, sport) {
  try {
    // Look up in the caller's own sport. The previous version fell through
    // nba -> nhl -> mlb by nickname, and six nicknames are shared across the
    // four leagues: Cardinals and Giants (mlb/nfl), Jets and Panthers
    // (nhl/nfl), Kings (nba/nhl) and Rangers (nhl/mlb). First match won, so an
    // LA Kings game measured travel from Sacramento and a Texas Rangers game
    // from New York — silently, and since well before NFL was added.
    const maps = {
      nba: nbaTeamLocations, nhl: nhlTeamLocations,
      mlb: mlbTeamLocations, nfl: nflTeamLocations,
    };
    const map = maps[String(sport || '').toLowerCase()];
    const pick = (team) => map
      ? map[team]
      : (nbaTeamLocations[team] || nhlTeamLocations[team] || mlbTeamLocations[team]);
    const awayLoc = pick(awayTeam);
    const homeLoc = pick(homeTeam);
    if (!awayLoc || !homeLoc) return null;
    const miles = calculateDistance(awayLoc.lat, awayLoc.lon, homeLoc.lat, homeLoc.lon);
    const tzChange = Math.abs(awayLoc.tz - homeLoc.tz);
    let impact = 'None';
    if (miles > 2000 || tzChange >= 3) impact = 'Severe';
    else if (miles > 1000 || tzChange >= 2) impact = 'Moderate';
    else if (miles > 500) impact = 'Minor';
    return { miles: Math.round(miles), tzChange, impact };
  } catch (error) {
    return null;
  }
}

function calculateProjectedTotal(homePace, awayPace) {
  const homeAvg = parseFloat(homePace?.avgTotal || 220);
  const awayAvg = parseFloat(awayPace?.avgTotal || 220);
  return ((homeAvg + awayAvg) / 2).toFixed(1);
}

// ============================================================================
// ESPN STATS — NHL
// ============================================================================

/**
 * NFL season record.
 */
async function fetchNFLTeamStats(teamName) {
  try {
    const teamId = nflTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}`;
    const response = await cachedGet(url, { timeout: 5000 });
    const team = response.data.team;
    const rec = team?.record?.items?.[0];
    return {
      record: rec?.summary || 'N/A',
      wins: rec?.stats?.find(x => x.name === 'wins')?.value ?? null,
      losses: rec?.stats?.find(x => x.name === 'losses')?.value ?? null,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Recent NFL scoring, regular season only.
 *
 * Preseason games are excluded deliberately. Starters play a quarter, schemes
 * are vanilla and backups decide the result — recent scores of 0, 3 and 6 are
 * normal. Projecting from that would produce confident nonsense, which is the
 * exact failure this whole rewrite exists to stop.
 *
 * The practical consequence is that this returns null until regular-season
 * games have actually been played, so NFL projections switch themselves on as
 * results arrive rather than needing a flag flipped. Only 5 games are used
 * rather than 10: an NFL team plays once a week, so ten games is most of a
 * season and far too slow to react to a roster that has changed.
 */
async function fetchNFLRecentGames(teamName) {
  try {
    const teamId = nflTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/schedule`;
    const response = await cachedGet(url, { timeout: 5000 });
    const events = response.data.events || [];

    const regularSeason = events.filter(e => {
      const comp = e.competitions?.[0];
      if (!comp?.status?.type?.completed) return false;
      const type = e.seasonType?.id ?? e.seasonType?.type ?? e.season?.type;
      // 1 = preseason, 2 = regular, 3 = post. Keep 2 and 3; if ESPN omits the
      // field entirely, keep the game rather than silently discarding data.
      return type === undefined || type === null || Number(type) >= 2;
    });
    const recent = regularSeason.slice(-5);

    let wins = 0, totalScored = 0, totalAllowed = 0, counted = 0;
    recent.forEach(game => {
      const comp = game.competitions[0];
      const h = comp.competitors.find(c => c.homeAway === 'home');
      const a = comp.competitors.find(c => c.homeAway === 'away');
      const hs = parseScore(h), as = parseScore(a);
      if (hs === null || as === null) return;
      const isHome = h.team.id == teamId;
      const ts = isHome ? hs : as;
      const os = isHome ? as : hs;
      counted++;
      if (ts > os) wins++;
      totalScored += ts;
      totalAllowed += os;
    });

    if (counted === 0) return null;
    return {
      last5: `${wins}-${counted - wins}`,
      avgScored: (totalScored / counted).toFixed(1),
      avgAllowed: (totalAllowed / counted).toFixed(1),
    };
  } catch (error) {
    return null;
  }
}

async function fetchNHLTeamStats(teamName) {
  try {
    const teamId = nhlTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/${teamId}`;
    const response = await cachedGet(url, { timeout: 5000 });
    const team = response.data.team;
    const record = team.record?.items?.find(r => r.type === 'total');
    return {
      record: record?.summary || 'N/A',
      wins: record?.stats?.find(s => s.name === 'wins')?.value || 0,
      losses: record?.stats?.find(s => s.name === 'losses')?.value || 0
    };
  } catch (error) {
    console.error(`Error fetching NHL stats for ${teamName}:`, error.message);
    return null;
  }
}

async function fetchNHLRecentGames(teamName) {
  try {
    const teamId = nhlTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/${teamId}/schedule`;
    const response = await cachedGet(url, { timeout: 5000 });
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(0, 10);
    let wins = 0, gf = 0, ga = 0, counted = 0;
    completedGames.forEach(game => {
      const comp = game.competitions[0];
      const h = comp.competitors.find(c => c.homeAway === 'home');
      const a = comp.competitors.find(c => c.homeAway === 'away');
      const hs = parseScore(h), as = parseScore(a);
      if (hs === null || as === null) return;   // unscored game contributes nothing
      const isHome = h.team.id == teamId;
      const ts = isHome ? hs : as;
      const os = isHome ? as : hs;
      counted++;
      if (ts > os) wins++;
      gf += ts; ga += os;
    });
    return {
      last10: `${wins}-${counted - wins}`,
      avgGoalsFor: counted > 0 ? (gf / counted).toFixed(1) : 0,
      avgGoalsAgainst: counted > 0 ? (ga / counted).toFixed(1) : 0
    };
  } catch (error) {
    return null;
  }
}

// ============================================================================
// ESPN STATS — MLB
// ============================================================================

async function fetchMLBTeamStats(teamName) {
  try {
    const teamId = mlbTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${teamId}`;
    const response = await cachedGet(url, { timeout: 5000 });
    const team = response.data.team;
    const record = team.record?.items?.find(r => r.type === 'total');
    return {
      record: record?.summary || 'N/A',
      wins: record?.stats?.find(s => s.name === 'wins')?.value || 0,
      losses: record?.stats?.find(s => s.name === 'losses')?.value || 0
    };
  } catch (error) {
    return null;
  }
}

async function fetchMLBRecentGames(teamName) {
  try {
    const teamId = mlbTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${teamId}/schedule`;
    const response = await cachedGet(url, { timeout: 5000 });
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(0, 10);
    let wins = 0, rf = 0, ra = 0, counted = 0;
    completedGames.forEach(game => {
      const comp = game.competitions[0];
      const h = comp.competitors.find(c => c.homeAway === 'home');
      const a = comp.competitors.find(c => c.homeAway === 'away');
      const hs = parseScore(h), as = parseScore(a);
      if (hs === null || as === null) return;   // unscored game contributes nothing
      const isHome = h.team.id == teamId;
      const ts = isHome ? hs : as;
      const os = isHome ? as : hs;
      counted++;
      if (ts > os) wins++;
      rf += ts; ra += os;
    });
    return {
      last10: `${wins}-${counted - wins}`,
      avgRunsFor: counted > 0 ? (rf / counted).toFixed(1) : 0,
      avgRunsAgainst: counted > 0 ? (ra / counted).toFixed(1) : 0
    };
  } catch (error) {
    return null;
  }
}

function getBallparkFactor(venueName) {
  for (const [park, factor] of Object.entries(ballparkFactors)) {
    if (venueName && venueName.includes(park.split(' ')[0])) return factor;
  }
  return 1.0;
}

// ============================================================================
// MLB STARTING PITCHER STATS
// ============================================================================
// ESPN's scoreboard already includes probable pitchers in
// competitions[0].competitors[].probables[]. We extract the pitcher athlete ID
// from there and fetch his season stats from the athlete endpoint.
//
// Returns: { name, era, whip, k9, wins, losses, ip } or null

async function fetchMLBPitcherFromProbable(probable) {
  if (!probable || !probable.athlete) return null;

  const athlete = probable.athlete;
  const pitcherId = athlete.id;
  const pitcherName = athlete.displayName || athlete.fullName || 'Unknown';

  if (!pitcherId) {
    return { name: pitcherName, era: 'N/A', whip: 'N/A', k9: 'N/A', record: 'N/A' };
  }

  try {
    const url = `https://site.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${pitcherId}/statistics`;
    const response = await cachedGet(url, { timeout: 5000 });

    // ESPN returns categories like "pitching" with stats nested inside
    const stats = response.data?.splits?.categories?.find(c => c.name === 'pitching')?.stats || [];

    const findStat = (names) => {
      for (const n of names) {
        const s = stats.find(s => s.name === n || s.abbreviation === n);
        if (s) return s.displayValue || s.value;
      }
      return 'N/A';
    };

    return {
      name: pitcherName,
      era: findStat(['ERA', 'earnedRunAverage']),
      whip: findStat(['WHIP', 'walksHitsPerInningPitched']),
      k9: findStat(['K/9', 'strikeoutsPerNineInnings', 'strikeoutsPer9Innings']),
      wins: findStat(['W', 'wins']),
      losses: findStat(['L', 'losses']),
      ip: findStat(['IP', 'inningsPitched']),
      strikeouts: findStat(['SO', 'strikeouts'])
    };
  } catch (error) {
    console.error(`[MLB] Error fetching pitcher stats for ${pitcherName}:`, error.message);
    return { name: pitcherName, era: 'N/A', whip: 'N/A', k9: 'N/A', record: 'N/A' };
  }
}

// ============================================================================
// NHL STARTING GOALIE STATS
// ============================================================================
// Daily Faceoff publishes confirmed/projected starters at
// https://www.dailyfaceoff.com/starting-goalies/. We scrape that page once
// per refresh and build a map of teamName -> goalie info, then look up each
// game's home/away goalies. Cached 5 min like other ESPN scrapes.

const goalieCache = { timestamp: 0, data: {} };
const GOALIE_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchNHLGoalieMap() {
  if (goalieCache.timestamp && (Date.now() - goalieCache.timestamp) < GOALIE_CACHE_TTL_MS) {
    return goalieCache.data;
  }

  try {
    const response = await axios.get('https://www.dailyfaceoff.com/starting-goalies/', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = response.data;

    // Daily Faceoff renders matchups with team names and goalie names in a
    // structured layout. We use a permissive scraper: find each team name from
    // our nhlTeamIds list, look for the nearest goalie name and stats nearby.
    const goalieMap = {};

    // Strategy: pull all <h6> or similar headers that contain team nicknames,
    // then grab the next chunk of HTML for the goalie info.
    Object.keys(nhlTeamIds).forEach(teamNickname => {
      // Build a regex that finds this team name as a header somewhere in the page
      const escapedTeam = teamNickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const teamPattern = new RegExp(`>\\s*${escapedTeam}\\s*<`, 'i');
      const teamMatch = html.match(teamPattern);

      if (!teamMatch) return;

      const idx = html.indexOf(teamMatch[0]);
      // Look at the next 2000 chars after the team name for goalie info
      const chunk = html.substring(idx, idx + 2000);

      // Strip tags to get plain text we can pattern-match
      const plainText = chunk
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Look for "CONFIRMED" / "PROJECTED" / "UNCONFIRMED" status keywords
      const statusMatch = plainText.match(/\b(CONFIRMED|PROJECTED|UNCONFIRMED|EXPECTED)\b/i);

      // Look for a goalie name pattern (First Last) that comes after the team
      // and a stats pattern like "12-8-2" (W-L-OT) or "2.45 GAA" or ".915 SV%"
      const nameMatch = plainText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z'\-]+)+)\b/);
      const recordMatch = plainText.match(/\b(\d{1,2}-\d{1,2}-\d{1,2})\b/);
      const gaaMatch = plainText.match(/\b(\d\.\d{1,2})\s*(?:GAA)?/);
      const svMatch = plainText.match(/\b(\.\d{3})\b/);

      if (nameMatch) {
        goalieMap[teamNickname] = {
          name: nameMatch[1],
          status: statusMatch ? statusMatch[1].toUpperCase() : 'UNKNOWN',
          record: recordMatch ? recordMatch[1] : 'N/A',
          gaa: gaaMatch ? gaaMatch[1] : 'N/A',
          svPct: svMatch ? svMatch[1] : 'N/A'
        };
      }
    });

    console.log(`[NHL] Goalie map built: ${Object.keys(goalieMap).length} teams`);
    goalieCache.timestamp = Date.now();
    goalieCache.data = goalieMap;
    return goalieMap;
  } catch (error) {
    console.error('[NHL] Goalie scrape error:', error.message);
    return goalieCache.data || {};
  }
}

// ============================================================================
// INJURY SCRAPER (ESPN)
// ============================================================================
// FIX: Original used team nicknames like "Celtics" but ESPN's injury page
// groups players under full names like "Boston Celtics". The nickname-only
// regex would sometimes match the wrong element or miss the team entirely.
// Now we accept and search for the FULL team name passed in from the scoreboard.

async function fetchInjuries(teamFullName, sport) {
  try {
    const sportUrls = {
      'nba': 'https://www.espn.com/nba/injuries',
      'nhl': 'https://www.espn.com/nhl/injuries',
      'mlb': 'https://www.espn.com/mlb/injuries',
      'nfl': 'https://www.espn.com/nfl/injuries'
    };
    const url = sportUrls[sport];
    if (!url) return [];

    const response = await cachedGet(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = response.data;

    const injuries = [];

    // Escape special regex chars in team name (handles "76ers", "Trail Blazers", etc.)
    const escapedName = teamFullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // ESPN wraps team names in various tags; look for the team name as a "header" element
    // Match patterns like: >Boston Celtics< or "Boston Celtics" inside JSON
    const patterns = [
      new RegExp(`>\\s*${escapedName}\\s*<`, 'i'),
      new RegExp(`"${escapedName}"`, 'i'),
      new RegExp(`>${escapedName}[^<]*<`, 'i')
    ];

    let teamMatchIdx = -1;
    for (const pattern of patterns) {
      const m = html.match(pattern);
      if (m) {
        teamMatchIdx = html.indexOf(m[0]);
        break;
      }
    }

    if (teamMatchIdx === -1) {
      console.log(`[INJURIES] No section found for ${teamFullName} on ${sport}`);
      return [];
    }

    // Find the team's injury table — look for the next ResponsiveTable or end-of-section marker
    const nextTeamStart = html.indexOf('ResponsiveTable', teamMatchIdx + 500);
    const teamSection = html.substring(teamMatchIdx, nextTeamStart > 0 ? nextTeamStart : teamMatchIdx + 5000);

    const rowMatches = [...teamSection.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)];
    rowMatches.forEach(match => {
      const rowHtml = match[1];
      if (rowHtml.includes('<th') || rowHtml.includes('NAME')) return;
      const cells = [];
      const cellMatches = [...rowHtml.matchAll(/<td[^>]*>(.*?)<\/td>/gs)];
      cellMatches.forEach(cell => {
        const text = cell[1].replace(/<[^>]*>/g, '').trim();
        if (text) cells.push(text);
      });
      if (cells.length >= 3) {
        const status = cells[2];
        if (status && status.toLowerCase() !== 'active') {
          injuries.push({
            player: cells[0],
            position: cells[1] || '',
            status: status,
            type: cells[3] || 'Undisclosed'
          });
        }
      }
    });

    if (injuries.length > 0) {
      console.log(`[INJURIES] Found ${injuries.length} for ${teamFullName}`);
    }
    return injuries;
  } catch (error) {
    console.error(`[INJURIES] Error fetching ${teamFullName}:`, error.message);
    return [];
  }
}

// ============================================================================
// ESPN OPENING LINES SCRAPER (TRUE OPENING LINES — what Vegas posted)
// ============================================================================
// ESPN's odds page shows both the OPENING line (what the book first posted)
// and the CURRENT line, side by side for every game. This is the real opening
// line, not a snapshot we took ourselves — exactly what we want for sharp
// money detection.
//
// Format example for one team row:
//   Lakers   -1.5 -112    -1.5 -108    o226.5 -105    -122
//   ^team    ^OPEN spread ^CURRENT spr ^CURRENT total ^CURRENT ML
// And for the other team:
//   Pistons  u228.5 -115  +1.5 -112    u226.5 -115    +102
//   ^team    ^OPEN total  ^CURRENT spr ^CURRENT total ^CURRENT ML
//
// Each game has two team rows. The OPEN column shows opening spread on the
// favorite's row and opening total on the underdog's row (or vice versa).

// ESPN exposes odds as JSON on two endpoints. The scoreboard carries the
// current spread and total for a whole slate in one request; the core API
// carries opening and current numbers per event, including prices.
const ESPN_SCOREBOARD_PATHS = {
  nfl: 'football/nfl', nba: 'basketball/nba', nhl: 'hockey/nhl', mlb: 'baseball/mlb',
};
const ESPN_CORE_PATHS = {
  nfl: 'football/leagues/nfl', nba: 'basketball/leagues/nba',
  nhl: 'hockey/leagues/nhl', mlb: 'baseball/leagues/mlb',
};

/**
 * Read one of ESPN's American-odds strings: "+1.5", "-1.5", "9", "EVEN", "PK".
 * Returns null for anything unreadable rather than NaN, so callers must decide.
 */
function parseAmericanValue(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^(even|ev|pk|pick)$/i.test(s)) return 0;
  const n = Number(s.replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Opening and current lines, read from ESPN's JSON rather than scraped.
 *
 * The previous implementation stripped tags off espn.com/{sport}/odds and
 * pattern-matched numeric tokens by position. It got totals and moneylines
 * right and spreads comprehensively wrong: a constant openSpread for every game
 * in a sport (-8 MLB, -9 NHL, -10 NBA) and current spreads of 0 and -3 on run
 * lines that are only ever 1.5.
 *
 * That mattered in two places. analyzeSharpAction derives its "sharp action"
 * callouts from spreadMovement, so every one of those signals was computed from
 * noise; and closing-line capture read currentSpread, which produced an average
 * CLV of -9.5 on a market where the line cannot move more than a couple of
 * points.
 *
 * Both endpoints are undocumented and can change without notice — the same risk
 * the scrape carried — but reading named fields out of JSON fails loudly and
 * visibly where positional token-matching failed silently and plausibly.
 *
 * `spread` is the HOME spread in both sources: it is negative when the home
 * side lays points and positive when it receives them, matching the convention
 * the picks table and gradePick already use. Verified across a full MLB slate.
 *
 * Note the top-level initialSpread and initialOverUnder fields are NOT the
 * opening numbers — they come back as 0.0. The real openings live under
 * homeTeamOdds.open.pointSpread and open.total.
 */
async function fetchEspnOpeningLines(sport) {
  const key = String(sport || '').toLowerCase();
  const cached = espnOddsCache[key];
  if (cached && (Date.now() - cached.timestamp) < ESPN_ODDS_CACHE_TTL_MS) {
    const ageSec = Math.round((Date.now() - cached.timestamp) / 1000);
    console.log(`[ESPN_ODDS] Cache hit for ${key} (${ageSec}s old, ${Object.keys(cached.data).length} games)`);
    return cached.data;
  }

  const scoreboardPath = ESPN_SCOREBOARD_PATHS[key];
  const corePath = ESPN_CORE_PATHS[key];
  if (!scoreboardPath || !corePath) {
    console.warn(`[ESPN_ODDS] no path mapped for ${key}`);
    return {};
  }

  const result = {};
  try {
    // One request for the slate. The handlers fetch this same URL, so the
    // shared HTTP cache usually makes it free.
    const sb = await cachedGet(
      `https://site.api.espn.com/apis/site/v2/sports/${scoreboardPath}/scoreboard?limit=100`,
      { timeout: 10000 });
    const events = (sb.data && sb.data.events) || [];

    await Promise.all(events.map(async (event) => {
      const comp = (event.competitions || [])[0];
      if (!comp) return;

      // Current numbers are already here; treat them as the fallback so a
      // failed per-event call still yields a usable current line.
      const sbOdds = (comp.odds || [])[0] || null;
      let currentSpread = sbOdds ? parseAmericanValue(sbOdds.spread) : null;
      let currentTotal = sbOdds ? parseAmericanValue(sbOdds.overUnder) : null;
      let openSpread = null, openTotal = null, homeML = null, awayML = null;

      try {
        const core = await cachedGet(
          `https://sports.core.api.espn.com/v2/sports/${corePath}/events/${event.id}/competitions/${event.id}/odds`,
          { timeout: 8000 });
        const item = ((core.data && core.data.items) || [])[0];
        if (item) {
          const hto = item.homeTeamOdds || {};
          const ato = item.awayTeamOdds || {};
          const pick = (obj, phase, field) =>
            obj && obj[phase] && obj[phase][field] ? obj[phase][field].american : null;

          openSpread = parseAmericanValue(pick(hto, 'open', 'pointSpread'));
          const coreCurrentSpread = parseAmericanValue(pick(hto, 'current', 'pointSpread'));
          if (coreCurrentSpread !== null) currentSpread = coreCurrentSpread;

          openTotal = parseAmericanValue(item.open && item.open.total && item.open.total.american);
          const coreCurrentTotal = parseAmericanValue(
            item.current && item.current.total && item.current.total.american);
          if (coreCurrentTotal !== null) currentTotal = coreCurrentTotal;

          homeML = parseAmericanValue(hto.moneyLine !== undefined ? hto.moneyLine : pick(hto, 'current', 'moneyLine'));
          awayML = parseAmericanValue(ato.moneyLine !== undefined ? ato.moneyLine : pick(ato, 'current', 'moneyLine'));
        }
      } catch (e) {
        // Per-event failure costs the opening line for that game only; the
        // scoreboard's current numbers above still stand.
      }

      if (currentSpread === null && currentTotal === null) return;

      result[event.id] = {
        openSpread, currentSpread, openTotal, currentTotal, homeML, awayML,
        // Movement is only meaningful when both ends are known. Null rather
        // than 0, so "no data" cannot be mistaken for "the line did not move" —
        // which is exactly how the old parser manufactured sharp signals.
        spreadMovement: (openSpread !== null && currentSpread !== null)
          ? +(currentSpread - openSpread).toFixed(2) : null,
        totalMovement: (openTotal !== null && currentTotal !== null)
          ? +(currentTotal - openTotal).toFixed(2) : null,
      };
    }));

    const withSpread = Object.values(result).filter(r => r.currentSpread !== null).length;
    console.log(`[ESPN_ODDS] Parsed ${Object.keys(result).length} ${key} games (${withSpread} with a spread)`);
    espnOddsCache[key] = { timestamp: Date.now(), data: result };
    return result;
  } catch (err) {
    console.error(`[ESPN_ODDS] ${key} failed:`, err.message);
    return (cached && cached.data) || {};
  }
}

// Determine "sharp side" from line movement
// Reverse line movement = line moved against the public favorite = sharp signal
function analyzeSharpAction(spreadMovement, totalMovement) {
  const signals = [];

  if (spreadMovement !== null) {
    if (Math.abs(spreadMovement) >= 2) {
      signals.push({
        market: 'spread',
        magnitude: 'strong',
        direction: spreadMovement > 0 ? 'toward away/underdog' : 'toward home/favorite',
        movement: spreadMovement
      });
    } else if (Math.abs(spreadMovement) >= 1) {
      signals.push({
        market: 'spread',
        magnitude: 'moderate',
        direction: spreadMovement > 0 ? 'toward away/underdog' : 'toward home/favorite',
        movement: spreadMovement
      });
    }
  }

  if (totalMovement !== null) {
    if (Math.abs(totalMovement) >= 2) {
      signals.push({
        market: 'total',
        magnitude: 'strong',
        direction: totalMovement > 0 ? 'toward OVER' : 'toward UNDER',
        movement: totalMovement
      });
    } else if (Math.abs(totalMovement) >= 1) {
      signals.push({
        market: 'total',
        magnitude: 'moderate',
        direction: totalMovement > 0 ? 'toward OVER' : 'toward UNDER',
        movement: totalMovement
      });
    }
  }

  return signals;
}

// ============================================================================
// THE ODDS API — REWRITTEN with caching, header logging, and proper error handling
// ============================================================================

/**
 * Fetch odds with cache, quota header logging, and detailed error reporting.
 *
 * KEY FIXES vs original:
 *   1. 5-minute in-memory cache so refreshing the page doesn't re-spend quota.
 *   2. Logs x-requests-remaining / x-requests-used after each call so we can
 *      see in Render logs whether we're burning through the 500/month free tier.
 *   3. Logs the FULL HTTP status and response body on failure so we can tell
 *      apart 401 (bad key), 422 (bad params), 429 (rate limit), and 5xx (upstream).
 *      The original logged everything as a generic "Error" with no detail.
 *   4. Increased timeout from 10s to 15s to survive Render free-tier slowness.
 *   5. Falls back to stale cache on error rather than returning null.
 */
async function fetchOdds(sport) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.log('[ODDS] No ODDS_API_KEY found');
    return null;
  }

  // Check cache first
  const cached = oddsCache[sport];
  if (cached && (Date.now() - cached.timestamp) < ODDS_CACHE_TTL_MS) {
    const ageSec = Math.round((Date.now() - cached.timestamp) / 1000);
    console.log(`[ODDS] Cache hit for ${sport} (${ageSec}s old, ${cached.data?.length || 0} games)`);
    return cached.data;
  }

  const sportMap = {
    'nba': 'basketball_nba',
    'nfl': 'americanfootball_nfl',
    'nhl': 'icehockey_nhl',
    'mlb': 'baseball_mlb',
    'cbb': 'basketball_ncaab'
  };
  const sportKey = sportMap[sport];
  if (!sportKey) {
    console.log(`[ODDS] Unknown sport: ${sport}`);
    return null;
  }

  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
  console.log(`[ODDS] Fetching ${sport} (${sportKey})...`);

  try {
    const response = await axios.get(url, {
      timeout: 15000,
      validateStatus: (status) => status < 500  // We'll inspect 4xx ourselves
    });

    // Log quota headers — these tell us if we're running out of the 500/month
    const remaining = response.headers['x-requests-remaining'];
    const used = response.headers['x-requests-used'];
    const lastCost = response.headers['x-requests-last'];
    console.log(`[ODDS] Quota — remaining: ${remaining}, used: ${used}, this call cost: ${lastCost}`);

    if (response.status >= 400) {
      console.error(`[ODDS] HTTP ${response.status} for ${sport}:`, JSON.stringify(response.data));
      if (cached) {
        console.log(`[ODDS] Falling back to stale cache for ${sport}`);
        return cached.data;
      }
      return null;
    }

    const games = response.data || [];
    console.log(`[ODDS] Received ${games.length} ${sport} games with odds`);
    oddsCache[sport] = { timestamp: Date.now(), data: games };
    return games;

  } catch (error) {
    if (error.response) {
      console.error(`[ODDS] HTTP ${error.response.status} from Odds API for ${sport}:`, JSON.stringify(error.response.data));
    } else if (error.code === 'ECONNABORTED') {
      console.error(`[ODDS] Timeout fetching ${sport} odds (15s exceeded)`);
    } else {
      console.error(`[ODDS] Network error fetching ${sport}:`, error.message);
    }

    if (cached) {
      console.log(`[ODDS] Falling back to stale cache for ${sport}`);
      return cached.data;
    }
    return null;
  }
}

/**
 * Match odds data from The Odds API to a game built from ESPN data.
 *
 * KEY FIXES vs original inline matching:
 *   1. Original used `||` which matched the WRONG game when teams appeared in
 *      multiple slates (e.g., it would match a Lakers game from yesterday to
 *      today's Celtics game just because the Lakers played the Celtics last week).
 *      Now requires BOTH home AND away to match.
 *   2. Original only read bookmakers[0]. If that one bookmaker didn't offer a
 *      market, fields came back null. Now searches across ALL bookmakers and
 *      uses the first one that has each market.
 *   3. Original only pulled spread POINTS, never the spread PRICE (juice).
 *      Now returns spread point + both spread prices, total + over/under prices,
 *      both moneyline prices, AND the bookmaker name.
 *   4. Loose name matching handles "Lakers" vs "Los Angeles Lakers" mismatches
 *      between ESPN and The Odds API.
 */
function matchOddsToGame(oddsData, homeTeamFull, awayTeamFull) {
  if (!oddsData || oddsData.length === 0) return null;

  const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const homeNorm = normalize(homeTeamFull);
  const awayNorm = normalize(awayTeamFull);

  // FIX 1: Match BOTH teams (was OR), with loose substring matching
  const matchingOdds = oddsData.find(o => {
    const oHome = normalize(o.home_team);
    const oAway = normalize(o.away_team);
    const homeMatch = oHome.includes(homeNorm) || homeNorm.includes(oHome);
    const awayMatch = oAway.includes(awayNorm) || awayNorm.includes(oAway);
    return homeMatch && awayMatch;
  });

  if (!matchingOdds || !matchingOdds.bookmakers || matchingOdds.bookmakers.length === 0) {
    return null;
  }

  // FIX 2: Walk all bookmakers, take first that has each market
  let spreadOutcomes = null, totalOutcomes = null, h2hOutcomes = null;
  let spreadBook = null, totalBook = null, h2hBook = null;

  for (const book of matchingOdds.bookmakers) {
    if (!spreadOutcomes) {
      const m = book.markets?.find(m => m.key === 'spreads');
      if (m && m.outcomes?.length) { spreadOutcomes = m.outcomes; spreadBook = book.title; }
    }
    if (!totalOutcomes) {
      const m = book.markets?.find(m => m.key === 'totals');
      if (m && m.outcomes?.length) { totalOutcomes = m.outcomes; totalBook = book.title; }
    }
    if (!h2hOutcomes) {
      const m = book.markets?.find(m => m.key === 'h2h');
      if (m && m.outcomes?.length) { h2hOutcomes = m.outcomes; h2hBook = book.title; }
    }
    if (spreadOutcomes && totalOutcomes && h2hOutcomes) break;
  }

  // FIX 3: Pull points AND prices for everything
  const findOutcome = (outcomes, teamName) => {
    if (!outcomes) return null;
    const teamNorm = normalize(teamName);
    return outcomes.find(o => {
      const oNorm = normalize(o.name);
      return oNorm.includes(teamNorm) || teamNorm.includes(oNorm);
    });
  };

  const homeSpread = findOutcome(spreadOutcomes, homeTeamFull);
  const awaySpread = findOutcome(spreadOutcomes, awayTeamFull);
  const overOutcome = totalOutcomes?.find(o => o.name?.toLowerCase() === 'over');
  const underOutcome = totalOutcomes?.find(o => o.name?.toLowerCase() === 'under');
  const homeMLOutcome = findOutcome(h2hOutcomes, homeTeamFull);
  const awayMLOutcome = findOutcome(h2hOutcomes, awayTeamFull);

  return {
    spread: homeSpread?.point ?? null,
    spreadHomePrice: homeSpread?.price ?? null,
    spreadAwayPrice: awaySpread?.price ?? null,
    total: overOutcome?.point ?? underOutcome?.point ?? null,
    overPrice: overOutcome?.price ?? null,
    underPrice: underOutcome?.price ?? null,
    homeML: homeMLOutcome?.price ?? null,
    awayML: awayMLOutcome?.price ?? null,
    bookmaker: spreadBook || totalBook || h2hBook || 'Unknown',
    matchedHome: matchingOdds.home_team,
    matchedAway: matchingOdds.away_team
  };
}

function findArbitrageOpportunities(oddsData) {
  if (!oddsData) return [];
  const opportunities = [];
  oddsData.forEach(game => {
    const bookmakers = game.bookmakers || [];
    let bestHome = -Infinity, bestAway = -Infinity;
    bookmakers.forEach(book => {
      const h2h = book.markets?.find(m => m.key === 'h2h');
      if (h2h && h2h.outcomes) {
        h2h.outcomes.forEach(outcome => {
          const odds = outcome.price;
          if (outcome.name === game.home_team) bestHome = Math.max(bestHome, odds);
          else bestAway = Math.max(bestAway, odds);
        });
      }
    });
    if (bestHome !== -Infinity && bestAway !== -Infinity) {
      const homeImplied = bestHome > 0 ? 100 / (bestHome + 100) : Math.abs(bestHome) / (Math.abs(bestHome) + 100);
      const awayImplied = bestAway > 0 ? 100 / (bestAway + 100) : Math.abs(bestAway) / (Math.abs(bestAway) + 100);
      const totalImplied = homeImplied + awayImplied;
      if (totalImplied < 1) {
        opportunities.push({
          homeTeam: game.home_team,
          awayTeam: game.away_team,
          profit: ((1 - totalImplied) * 100).toFixed(2),
          description: `Bet ${game.away_team} at ${bestAway} and ${game.home_team} at ${bestHome}`
        });
      }
    }
  });
  return opportunities;
}

// ============================================================================
// MAIN PREDICTION ENDPOINT
// ============================================================================

// ============================================================================
// MODEL WIRING
// ============================================================================
// Every number the UI shows and every number saved as a pick now comes from
// model.js. Claude is left with the one job it is actually good at: writing the
// qualitative notes.
//
// MODEL_TRUST is how far the projection may pull away from the de-vigged market
// price. 0 reproduces the market and backs nothing; 1 asserts the model beats
// the closing line. Overridable by environment so it can be tuned without a
// deploy, and deliberately low until closing line value earns more.
const MODEL_TRUST = Number(process.env.MODEL_TRUST ?? 0.25);
const KELLY_FRACTION = Number(process.env.KELLY_FRACTION ?? 0.25);

// Recent-form field names differ per sport.
const FORM_FIELDS = {
  nba: ['avgScored', 'avgAllowed'],
  nfl: ['avgScored', 'avgAllowed'],
  nhl: ['avgGoalsFor', 'avgGoalsAgainst'],
  mlb: ['avgRunsFor', 'avgRunsAgainst'],
};

function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/** Claude's array keyed by matchup. Commentary only — no numbers are read. */
function commentaryByMatchup(predictions) {
  const out = {};
  for (const g of (predictions && predictions.games) || []) {
    if (g && g.homeTeam && g.awayTeam) out[g.homeTeam + '|' + g.awayTeam] = g.keyFactors || [];
  }
  return out;
}

/**
 * Build the response from REAL data, using Claude only for commentary.
 *
 * The old code mapped over Claude's array and looked up stats by the team names
 * Claude echoed back. When those did not match exactly the lookup returned
 * undefined and every odds field silently fell back to Claude's own values —
 * exactly what the "override Claude's odds" guard existed to prevent. Real data
 * is now the spine; commentary is optional decoration that cannot corrupt it.
 *
 * Edges and Kelly stakes are emitted in percentage points, which is what the
 * frontend formatters render and what the >= 2 save threshold compares against.
 */
/**
 * Ask Claude for the qualitative notes. Never throws.
 *
 * model.js supplies every number now, so a Claude outage, a rate limit or a
 * malformed reply should cost the commentary line and nothing else. Until this
 * change any of those returned a 500 and the whole slate vanished — which was
 * defensible when Claude produced the picks, and is not any more.
 *
 * Returns a matchup-keyed map, empty if anything at all went wrong.
 */
async function fetchCommentary(sport, prompt) {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });
    // Never index content[0] blindly: current models can return a thinking
    // block first, which has no .text and would throw before the JSON parse.
    const text = (message.content.find(b => b.type === 'text') || {}).text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn(`[${sport.toUpperCase()}] no JSON in commentary reply`);
      return {};
    }
    return commentaryByMatchup(JSON.parse(match[0]));
  } catch (err) {
    console.error(`[${sport.toUpperCase()}] commentary unavailable:`, err.message);
    return {};
  }
}

function buildGamesFromModel(sport, gamesWithStats, commentary, skipReason) {
  const fields = FORM_FIELDS[sport] || FORM_FIELDS.nba;
  const scoredKey = fields[0];
  const allowedKey = fields[1];

  return gamesWithStats.map(g => {
    const odds = g.odds || {};
    // skipReason states outright that we are declining to project, rather than
    // letting it look like data merely happened to be missing.
    const projection = skipReason ? null : model.projectFromScoringAverages({
      homeAvgScored: g.homeForm && g.homeForm[scoredKey],
      homeAvgAllowed: g.homeForm && g.homeForm[allowedKey],
      awayAvgScored: g.awayForm && g.awayForm[scoredKey],
      awayAvgAllowed: g.awayForm && g.awayForm[allowedKey],
      sport,
    });

    let priced = { spread: null, total: null };
    if (projection) {
      priced = model.priceGame({
        sport,
        predictedMargin: projection.predictedMargin,
        predictedTotal: projection.predictedTotal,
        spread: toNum(odds.spread),
        spreadHomePrice: toNum(odds.spreadHomePrice),
        spreadAwayPrice: toNum(odds.spreadAwayPrice),
        total: toNum(odds.total),
        overPrice: toNum(odds.overPrice),
        underPrice: toNum(odds.underPrice),
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        trust: MODEL_TRUST,
        kellyFraction: KELLY_FRACTION,
      });
    }
    const best = priced.spread || priced.total;

    return {
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      gameTime: g.gameTime,
      spread: odds.spread ?? null,
      total: odds.total ?? null,
      homeML: odds.homeML ?? null,
      awayML: odds.awayML ?? null,
      bookmaker: odds.bookmaker ?? null,
      lineMovement: g.lineMovement ?? null,
      sharpSignals: g.sharpSignals ?? [],

      predictedScore: projection
        ? { home: Math.round(projection.predictedHome), away: Math.round(projection.predictedAway) }
        : { home: null, away: null },

      // "No edge" is a real, common and correct answer. The old pipeline had no
      // way to say it — it produced a pick for every game, always.
      spreadPick: priced.spread ? priced.spread.pick : 'No edge',
      spreadEdge: priced.spread ? +(priced.spread.edge * 100).toFixed(2) : 0,
      kellySpread: priced.spread ? +(priced.spread.stake * 100).toFixed(2) : 0,
      totalPick: priced.total ? priced.total.pick : 'No edge',
      totalEdge: priced.total ? +(priced.total.edge * 100).toFixed(2) : 0,
      kellyTotal: priced.total ? +(priced.total.stake * 100).toFixed(2) : 0,
      confidence: best ? best.confidence : 'Low',

      keyFactors: commentary[g.homeTeam + '|' + g.awayTeam] || [],

      // Exposed so a number can be taken apart rather than trusted. An edge you
      // cannot decompose is how the old ones went unquestioned for months.
      modelDetail: projection ? {
        predictedMargin: +projection.predictedMargin.toFixed(2),
        predictedTotal: +projection.predictedTotal.toFixed(2),
        trust: MODEL_TRUST,
        marketProbSpread: priced.spread ? +priced.spread.marketProb.toFixed(4) : null,
        modelProbSpread: priced.spread ? +priced.spread.modelProb.toFixed(4) : null,
        hold: priced.spread ? +priced.spread.hold.toFixed(4) : null,
      } : { unavailable: skipReason || 'insufficient recent-form data' },

      stats: g,
    };
  });
}

// ============================================================================
// PREDICTION CACHE
// ============================================================================
// The finished prediction was never cached — only the raw odds were. Every
// request re-ran the whole pipeline: ~120 ESPN fetches plus a Claude call. A
// hundred people opening the app on an NFL Sunday produced a hundred identical
// Claude calls for the same slate, so cost scaled linearly with traffic for
// byte-identical output. This collapses that to one run per sport per TTL.
//
// It also stops duplicate picks being written on every request, and lets a
// cached slate return instantly instead of rebuilding — which matters on a
// sleeping free-tier instance where a cold rebuild can outlast the proxy.
const predictionCache = {};
const PREDICTION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Handlers write straight to res, so intercept .json() to capture the payload.
// .status() deliberately returns the real res, so error responses pass through
// uncached.
function makeCachingRes(res, sport) {
  return {
    json: (payload) => {
      if (payload && !payload.error) {
        predictionCache[sport] = { timestamp: Date.now(), data: payload };
      }
      return res.json(payload);
    },
    status: (code) => res.status(code)
  };
}

app.post('/api/predictions', async (req, res) => {
  try {
    const { sport } = req.body;
    if (!sport) return res.status(400).json({ error: 'Sport parameter required' });

    const cached = predictionCache[sport];
    if (cached && (Date.now() - cached.timestamp) < PREDICTION_CACHE_TTL_MS) {
      const ageSec = Math.round((Date.now() - cached.timestamp) / 1000);
      console.log(`[PREDICTIONS] Cache hit for ${sport} (${ageSec}s old) — no Claude call`);
      return res.json(cached.data);
    }

    console.log(`\n=== Fetching predictions for ${sport.toUpperCase()} ===`);
    const oddsData = await fetchOdds(sport);
    const arbitrageAlerts = findArbitrageOpportunities(oddsData);
    const cachingRes = makeCachingRes(res, sport);

    if (sport === 'nba') return await handleNBAPredictions(cachingRes, arbitrageAlerts, oddsData);
    if (sport === 'nhl') return await handleNHLPredictions(cachingRes, arbitrageAlerts, oddsData);
    if (sport === 'mlb') return await handleMLBPredictions(cachingRes, arbitrageAlerts, oddsData);
    if (sport === 'cbb') return res.json({ sport: 'CBB', games: [], arbitrageAlerts: [], message: 'Coming soon.' });
    if (sport === 'nfl') return await handleNFLPredictions(cachingRes, arbitrageAlerts, oddsData);

    return res.json({ sport: sport.toUpperCase(), games: [], arbitrageAlerts: [], message: `${sport.toUpperCase()} not supported.` });
  } catch (error) {
    console.error('Prediction error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// NBA HANDLER
// ============================================================================

// ============================================================================
// NFL HANDLER
// ============================================================================

async function handleNFLPredictions(res, arbitrageAlerts, oddsData) {
  try {
    const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?limit=50`;
    const scoreboardResponse = await cachedGet(scoreboardUrl, { timeout: 10000 });
    const payload = scoreboardResponse.data || {};
    let events = payload.events || [];
    events = events.filter(e => {
      const status = e.competitions?.[0]?.status?.type?.state;
      return status === 'pre' || status === 'in';
    });

    if (events.length === 0) {
      return res.json({ sport: 'NFL', games: [], arbitrageAlerts: [], message: 'No NFL games scheduled' });
    }

    // ESPN season types: 1 preseason, 2 regular, 3 post.
    const seasonType = Number(payload.season?.type ?? events[0]?.season?.type ?? 2);
    const isPreseason = seasonType === 1;
    const skipReason = isPreseason
      ? 'preseason — starters play a quarter, so scoring averages do not describe these teams'
      : null;

    const espnOpeningLines = await fetchEspnOpeningLines('nfl');
    const eventMap = {};

    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = teamNickname(homeTeam.team.displayName, nflTeamIds);
      const awayTeamName = teamNickname(awayTeam.team.displayName, nflTeamIds);
      const homeFullName = homeTeam.team.displayName;
      const awayFullName = awayTeam.team.displayName;

      eventMap[`${homeFullName}|${awayFullName}`] = event.id;

      // Skip the stats round-trips entirely in preseason; nothing would use them.
      const [homeStats, awayStats, homeForm, awayForm, travelData, homeInjuries, awayInjuries] =
        await Promise.all([
          fetchNFLTeamStats(homeTeamName),
          fetchNFLTeamStats(awayTeamName),
          isPreseason ? Promise.resolve(null) : fetchNFLRecentGames(homeTeamName),
          isPreseason ? Promise.resolve(null) : fetchNFLRecentGames(awayTeamName),
          fetchTravelData(awayTeamName, homeTeamName, 'nfl'),
          fetchInjuries(homeFullName, 'nfl'),
          fetchInjuries(awayFullName, 'nfl'),
        ]);

      const odds = matchOddsToGame(oddsData, homeFullName, awayFullName);
      const espnLines = espnOpeningLines[event.id] || null;
      const sharpSignals = espnLines
        ? analyzeSharpAction(espnLines.spreadMovement, espnLines.totalMovement)
        : [];

      const venue = nflTeamLocations[homeTeamName] || null;

      return {
        homeTeam: homeFullName,
        awayTeam: awayFullName,
        gameTime: new Date(event.date).toLocaleString(),
        homeData: homeStats,
        awayData: awayStats,
        homeForm,
        awayForm,
        travel: travelData,
        dome: venue ? venue.dome : null,
        injuries: { home: homeInjuries, away: awayInjuries },
        odds,
        lineMovement: espnLines,
        sharpSignals,
      };
    }));

    const matched = gamesWithStats.filter(g => g.odds).length;
    const withLines = gamesWithStats.filter(g => g.lineMovement).length;
    console.log(`[NFL] Matched odds to ${matched}/${gamesWithStats.length}, ESPN lines ${withLines}/${gamesWithStats.length}${isPreseason ? ' (PRESEASON — projections suppressed)' : ''}`);

    // Claude writes notes only; every number comes from model.js. Kept short on
    // purpose — the long legacy prompts still ask the other three sports for
    // figures that are now discarded.
    const prompt = `You are helping annotate NFL betting matchups. For each game below, write 2-3 short factual observations a bettor would care about: injuries, rest, travel, venue, form.

Do NOT predict scores, edges, probabilities or bet sizes. Those are computed elsewhere and anything you invent will be discarded.

${isPreseason ? 'NOTE: these are PRESEASON games. Starters play limited snaps and results are not predictive. Say so where relevant.\n' : ''}
Games:
${JSON.stringify(gamesWithStats.map(g => ({
      homeTeam: g.homeTeam, awayTeam: g.awayTeam, gameTime: g.gameTime,
      homeRecord: g.homeData?.record, awayRecord: g.awayData?.record,
      homeForm: g.homeForm, awayForm: g.awayForm,
      travel: g.travel, dome: g.dome,
      injuries: {
        home: (g.injuries.home || []).slice(0, 6),
        away: (g.injuries.away || []).slice(0, 6),
      },
    })), null, 1)}

Reply with JSON only:
{"games":[{"homeTeam":"<exact name>","awayTeam":"<exact name>","keyFactors":["...","..."]}]}`;

    console.log('[NFL] Fetching commentary...');
    const commentary = await fetchCommentary('nfl', prompt);
    const formattedGames = buildGamesFromModel('nfl', gamesWithStats, commentary, skipReason);

    await savePicksFromGames('nfl', formattedGames, eventMap);

    return res.json({
      sport: 'NFL',
      games: formattedGames,
      arbitrageAlerts,
      ...(isPreseason ? {
        message: 'Preseason: lines and injuries are shown, but no picks are made. Starters play a quarter and backups decide results, so scoring averages do not describe these teams. Projections resume automatically once regular-season games have been played.',
      } : {}),
    });
  } catch (error) {
    console.error('NFL Prediction error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function handleNBAPredictions(res, arbitrageAlerts, oddsData) {
  try {
    const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?limit=50`;
    const scoreboardResponse = await axios.get(scoreboardUrl, { timeout: 10000 });
    let events = scoreboardResponse.data.events || [];
    events = events.filter(e => {
      const status = e.competitions?.[0]?.status?.type?.state;
      return status === 'pre' || status === 'in';
    });

    if (events.length === 0) {
      return res.json({ sport: 'NBA', games: [], arbitrageAlerts: [], message: 'No NBA games scheduled' });
    }

    // Fetch ESPN opening lines once for all games (cached 5 min)
    const espnOpeningLines = await fetchEspnOpeningLines('nba');
    const eventMap = {};

    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = teamNickname(homeTeam.team.displayName, nbaTeamIds);
      const awayTeamName = teamNickname(awayTeam.team.displayName, nbaTeamIds);
      const homeFullName = homeTeam.team.displayName;
      const awayFullName = awayTeam.team.displayName;

      eventMap[`${homeFullName}|${awayFullName}`] = event.id;

      const [homeStats, awayStats, homeForm, awayForm, homePace, awayPace, travelData, homeInjuries, awayInjuries] = await Promise.all([
        fetchNBATeamStats(homeTeamName),
        fetchNBATeamStats(awayTeamName),
        fetchRecentGames(homeTeamName),
        fetchRecentGames(awayTeamName),
        fetchPaceData(homeTeamName),
        fetchPaceData(awayTeamName),
        fetchTravelData(awayTeamName, homeTeamName, 'nba'),
        fetchInjuries(homeFullName, 'nba'),  // FIX: pass full name not nickname
        fetchInjuries(awayFullName, 'nba')   // FIX: pass full name not nickname
      ]);

      const odds = matchOddsToGame(oddsData, homeFullName, awayFullName);

      // Look up opening lines from ESPN by game ID
      const espnLines = espnOpeningLines[event.id] || null;
      const sharpSignals = espnLines
        ? analyzeSharpAction(espnLines.spreadMovement, espnLines.totalMovement)
        : [];

      return {
        homeTeam: homeFullName,
        awayTeam: awayFullName,
        gameTime: new Date(event.date).toLocaleString(),
        homeData: homeStats,
        awayData: awayStats,
        homeForm: homeForm,
        awayForm: awayForm,
        pace: {
          homeAvgTotal: homePace?.avgTotal,
          awayAvgTotal: awayPace?.avgTotal,
          projectedTotal: calculateProjectedTotal(homePace, awayPace)
        },
        travel: travelData,
        injuries: { home: homeInjuries, away: awayInjuries },
        odds: odds,
        lineMovement: espnLines,
        sharpSignals: sharpSignals
      };
    }));

    const matched = gamesWithStats.filter(g => g.odds).length;
    const withMovement = gamesWithStats.filter(g => g.lineMovement).length;
    console.log(`[NBA] Matched odds to ${matched}/${gamesWithStats.length} games, opening lines for ${withMovement}/${gamesWithStats.length}`);

    const prompt = `You are an expert NBA analyst. Analyze these games and respond ONLY with a valid JSON object.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

For each game predict: spread pick (or "No edge" if edge < 2%), total pick, confidence (Low/Medium/High), and 3-5 key factors.

CRITICAL: Use the EXACT odds from the "odds" field for spread/total/homeML/awayML. Do not invent odds.

LINE MOVEMENT: Each game has a "lineMovement" field showing the OPENING line vs CURRENT line, and a "sharpSignals" field. Treat this as ONE factor among many — don't overweight it. When the line has moved significantly (1+ point on spread, 1+ point on total), mention which side the move suggests sharp money is on, and note it in keyFactors. Reverse line movement (line moving against where the public would bet) is a sharp signal but not definitive.

Respond ONLY with this JSON shape:
{
  "games": [
    {
      "homeTeam": "<full name>",
      "awayTeam": "<full name>",
      "gameTime": "<time>",
      "spread": "<from odds.spread or 'N/A'>",
      "total": "<from odds.total or 'N/A'>",
      "homeML": "<from odds.homeML or 'N/A'>",
      "awayML": "<from odds.awayML or 'N/A'>",
      "predictedScore": { "home": <int>, "away": <int> },
      "spreadPick": "<pick or 'No edge'>",
      "spreadEdge": <number>,
      "totalPick": "<pick or 'No edge'>",
      "totalEdge": <number>,
      "kellySpread": <number>,
      "kellyTotal": <number>,
      "confidence": "Low|Medium|High",
      "keyFactors": ["...", "..."]
    }
  ]
}`;

    // Numbers come from model.js; Claude only annotates, and may fail freely.
    console.log('[NBA] Fetching commentary...');
    const commentary = await fetchCommentary('nba', prompt);
    const formattedGames = buildGamesFromModel('nba', gamesWithStats, commentary);

    // Save picks to DB for tracking
    await savePicksFromGames('nba', formattedGames, eventMap);

    return res.json({ sport: 'NBA', games: formattedGames, arbitrageAlerts });
  } catch (error) {
    console.error('NBA Prediction error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================================================
// NHL HANDLER
// ============================================================================

async function handleNHLPredictions(res, arbitrageAlerts, oddsData) {
  try {
    const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?limit=50`;
    const scoreboardResponse = await axios.get(scoreboardUrl, { timeout: 10000 });
    let events = scoreboardResponse.data.events || [];
    events = events.filter(e => {
      const status = e.competitions?.[0]?.status?.type?.state;
      return status === 'pre' || status === 'in';
    });

    if (events.length === 0) {
      return res.json({ sport: 'NHL', games: [], arbitrageAlerts: [], message: 'No NHL games scheduled' });
    }

    const espnOpeningLines = await fetchEspnOpeningLines('nhl');
    const goalieMap = await fetchNHLGoalieMap();
    const eventMap = {};

    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = teamNickname(homeTeam.team.displayName, nhlTeamIds);
      const awayTeamName = teamNickname(awayTeam.team.displayName, nhlTeamIds);
      const homeFullName = homeTeam.team.displayName;
      const awayFullName = awayTeam.team.displayName;

      eventMap[`${homeFullName}|${awayFullName}`] = event.id;

      const [homeStats, awayStats, homeForm, awayForm, travelData, homeInjuries, awayInjuries] = await Promise.all([
        fetchNHLTeamStats(homeTeamName),
        fetchNHLTeamStats(awayTeamName),
        fetchNHLRecentGames(homeTeamName),
        fetchNHLRecentGames(awayTeamName),
        fetchTravelData(awayTeamName, homeTeamName, 'nhl'),
        fetchInjuries(homeFullName, 'nhl'),
        fetchInjuries(awayFullName, 'nhl')
      ]);

      const odds = matchOddsToGame(oddsData, homeFullName, awayFullName);
      const espnLines = espnOpeningLines[event.id] || null;
      const sharpSignals = espnLines
        ? analyzeSharpAction(espnLines.spreadMovement, espnLines.totalMovement)
        : [];

      return {
        homeTeam: homeFullName,
        awayTeam: awayFullName,
        gameTime: new Date(event.date).toLocaleString(),
        homeData: homeStats,
        awayData: awayStats,
        homeForm: homeForm,
        awayForm: awayForm,
        travel: travelData,
        goalies: {
          home: goalieMap[homeTeamName] || null,
          away: goalieMap[awayTeamName] || null
        },
        injuries: { home: homeInjuries, away: awayInjuries },
        odds: odds,
        lineMovement: espnLines,
        sharpSignals: sharpSignals
      };
    }));

    const matched = gamesWithStats.filter(g => g.odds).length;
    const withMovement = gamesWithStats.filter(g => g.lineMovement).length;
    const withGoalies = gamesWithStats.filter(g => g.goalies?.home || g.goalies?.away).length;
    console.log(`[NHL] Matched odds to ${matched}/${gamesWithStats.length}, opening lines ${withMovement}/${gamesWithStats.length}, goalies ${withGoalies}/${gamesWithStats.length}`);

    const prompt = `You are an expert NHL analyst. Analyze these games and respond ONLY with valid JSON.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

CRITICAL: Use the EXACT odds from the "odds" field. Do not invent odds.

GOALIE MATCHUPS: The "goalies" field contains projected starting goalies with status (CONFIRMED/PROJECTED), record, GAA (goals against average), and SV% (save percentage). GOALIE MATCHUP IS HUGE in NHL — second only to overall team strength. An elite goalie (GAA under 2.50, SV% over .920) vs. a backup (GAA over 3.00) is worth ~0.7 goals. CONFIRMED is more reliable than PROJECTED. Always reference goalies in keyFactors when data is available.

LINE MOVEMENT: "lineMovement" shows OPENING vs CURRENT. Treat as ONE factor among many. Significant movement (1+ pt spread / 0.5+ goals on total) suggests sharp money.

Respond ONLY with:
{
  "games": [
    {
      "homeTeam": "<full name>",
      "awayTeam": "<full name>",
      "gameTime": "<time>",
      "puckLine": "<from odds.spread or 'N/A'>",
      "total": "<from odds.total or 'N/A'>",
      "homeML": "<from odds.homeML or 'N/A'>",
      "awayML": "<from odds.awayML or 'N/A'>",
      "predictedScore": { "home": <int>, "away": <int> },
      "puckLinePick": "<pick or 'No edge'>",
      "puckLineEdge": <number>,
      "totalPick": "<pick or 'No edge'>",
      "totalEdge": <number>,
      "kellyPuckLine": <number>,
      "kellyTotal": <number>,
      "confidence": "Low|Medium|High",
      "keyFactors": ["...", "..."]
    }
  ]
}`;

    // Numbers come from model.js; Claude only annotates, and may fail freely.
    console.log('[NHL] Fetching commentary...');
    const commentary = await fetchCommentary('nhl', prompt);
    const formattedGames = buildGamesFromModel('nhl', gamesWithStats, commentary);

    // Save picks to DB for tracking
    await savePicksFromGames('nhl', formattedGames, eventMap);

    return res.json({ sport: 'NHL', games: formattedGames, arbitrageAlerts });
  } catch (error) {
    console.error('NHL Prediction error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================================================
// MLB HANDLER
// ============================================================================

async function handleMLBPredictions(res, arbitrageAlerts, oddsData) {
  try {
    const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?limit=50`;
    const scoreboardResponse = await axios.get(scoreboardUrl, { timeout: 10000 });
    let events = scoreboardResponse.data.events || [];
    events = events.filter(e => {
      const status = e.competitions?.[0]?.status?.type?.state;
      return status === 'pre' || status === 'in';
    });

    if (events.length === 0) {
      return res.json({ sport: 'MLB', games: [], arbitrageAlerts: [], message: 'No MLB games scheduled' });
    }

    const espnOpeningLines = await fetchEspnOpeningLines('mlb');
    const eventMap = {};

    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = teamNickname(homeTeam.team.displayName, mlbTeamIds);
      const awayTeamName = teamNickname(awayTeam.team.displayName, mlbTeamIds);
      const homeFullName = homeTeam.team.displayName;
      const awayFullName = awayTeam.team.displayName;
      const venueName = comp.venue?.fullName || '';

      // Map for savePicks lookup later
      eventMap[`${homeFullName}|${awayFullName}`] = event.id;

      // Extract probable pitchers from ESPN scoreboard data
      // ESPN puts them at competitions[0].competitors[].probables[]
      const homeProbable = homeTeam.probables?.[0] || null;
      const awayProbable = awayTeam.probables?.[0] || null;

      const [homeStats, awayStats, homeForm, awayForm, homePitcher, awayPitcher, homeInjuries, awayInjuries] = await Promise.all([
        fetchMLBTeamStats(homeTeamName),
        fetchMLBTeamStats(awayTeamName),
        fetchMLBRecentGames(homeTeamName),
        fetchMLBRecentGames(awayTeamName),
        fetchMLBPitcherFromProbable(homeProbable),
        fetchMLBPitcherFromProbable(awayProbable),
        fetchInjuries(homeFullName, 'mlb'),
        fetchInjuries(awayFullName, 'mlb')
      ]);

      const odds = matchOddsToGame(oddsData, homeFullName, awayFullName);
      const espnLines = espnOpeningLines[event.id] || null;
      const sharpSignals = espnLines
        ? analyzeSharpAction(espnLines.spreadMovement, espnLines.totalMovement)
        : [];

      return {
        homeTeam: homeFullName,
        awayTeam: awayFullName,
        gameTime: new Date(event.date).toLocaleString(),
        venue: venueName,
        ballparkFactor: getBallparkFactor(venueName),
        homeData: homeStats,
        awayData: awayStats,
        homeForm: homeForm,
        awayForm: awayForm,
        pitchers: {
          home: homePitcher,
          away: awayPitcher
        },
        injuries: { home: homeInjuries, away: awayInjuries },
        odds: odds,
        lineMovement: espnLines,
        sharpSignals: sharpSignals
      };
    }));

    const matched = gamesWithStats.filter(g => g.odds).length;
    const withMovement = gamesWithStats.filter(g => g.lineMovement).length;
    const withPitchers = gamesWithStats.filter(g => g.pitchers?.home?.era && g.pitchers.home.era !== 'N/A').length;
    console.log(`[MLB] Matched odds to ${matched}/${gamesWithStats.length}, opening lines ${withMovement}/${gamesWithStats.length}, pitchers ${withPitchers}/${gamesWithStats.length}`);

    const prompt = `You are an expert MLB analyst. Analyze these games and respond ONLY with valid JSON.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

CRITICAL: Use the EXACT odds from the "odds" field. Do not invent odds.

PITCHER MATCHUPS: The "pitchers" field contains the probable starting pitchers with ERA, WHIP, K/9. PITCHER MATCHUP IS THE #1 FACTOR IN MLB BETTING — weight it more than anything else. An ace (ERA under 3.00) vs. a weak starter (ERA over 4.50) is worth ~1.5 runs on the total and significant moneyline value. Two aces = strong UNDER lean. Two weak starters = OVER lean. Always reference pitchers in keyFactors.

LINE MOVEMENT: "lineMovement" shows OPENING vs CURRENT. Treat as ONE factor among many. In MLB, runline rarely moves (almost always ±1.5), so focus on TOTAL movement and moneyline movement. Significant movement suggests sharp action.

Respond ONLY with:
{
  "games": [
    {
      "homeTeam": "<full name>",
      "awayTeam": "<full name>",
      "gameTime": "<time>",
      "runLine": "<from odds.spread or 'N/A'>",
      "total": "<from odds.total or 'N/A'>",
      "homeML": "<from odds.homeML or 'N/A'>",
      "awayML": "<from odds.awayML or 'N/A'>",
      "predictedScore": { "home": <int>, "away": <int> },
      "runLinePick": "<pick or 'No edge'>",
      "runLineEdge": <number>,
      "totalPick": "<pick or 'No edge'>",
      "totalEdge": <number>,
      "kellyRunLine": <number>,
      "kellyTotal": <number>,
      "confidence": "Low|Medium|High",
      "keyFactors": ["...", "..."]
    }
  ]
}`;

    // Numbers come from model.js; Claude only annotates, and may fail freely.
    console.log('[MLB] Fetching commentary...');
    const commentary = await fetchCommentary('mlb', prompt);
    const formattedGames = buildGamesFromModel('mlb', gamesWithStats, commentary);

    // Save picks to DB for tracking
    await savePicksFromGames('mlb', formattedGames, eventMap);

    return res.json({ sport: 'MLB', games: formattedGames, arbitrageAlerts });
  } catch (error) {
    console.error('MLB Prediction error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================================================
// DEBUG ENDPOINT — verify Odds API status without running full predictions
// Visit https://sports-prediction-agent.onrender.com/api/debug/odds/nba in a browser
// ============================================================================

app.get('/api/debug/odds/:sport', async (req, res) => {
  const { sport } = req.params;
  const apiKey = process.env.ODDS_API_KEY;

  if (!apiKey) {
    return res.json({ ok: false, reason: 'ODDS_API_KEY environment variable is not set' });
  }

  const sportMap = {
    'nba': 'basketball_nba', 'nhl': 'icehockey_nhl',
    'mlb': 'baseball_mlb', 'nfl': 'americanfootball_nfl'
  };
  const sportKey = sportMap[sport];
  if (!sportKey) return res.json({ ok: false, reason: `Unknown sport: ${sport}` });

  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;

  try {
    const response = await axios.get(url, {
      timeout: 15000,
      validateStatus: () => true  // Don't throw on any status — return everything
    });

    return res.json({
      ok: response.status === 200,
      httpStatus: response.status,
      quotaRemaining: response.headers['x-requests-remaining'] || 'unknown',
      quotaUsed: response.headers['x-requests-used'] || 'unknown',
      lastCallCost: response.headers['x-requests-last'] || 'unknown',
      gamesReturned: Array.isArray(response.data) ? response.data.length : 0,
      firstGameSample: Array.isArray(response.data) && response.data.length > 0 ? {
        home: response.data[0].home_team,
        away: response.data[0].away_team,
        bookmakerCount: response.data[0].bookmakers?.length || 0,
        firstBookmaker: response.data[0].bookmakers?.[0]?.title || null,
        marketsAvailable: response.data[0].bookmakers?.[0]?.markets?.map(m => m.key) || []
      } : null,
      errorBody: response.status >= 400 ? response.data : null
    });
  } catch (error) {
    return res.json({
      ok: false,
      reason: 'Network/timeout error reaching The Odds API',
      errorMessage: error.message,
      errorCode: error.code || null
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasOddsKey: !!process.env.ODDS_API_KEY,
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasDatabase: dbReady,
    cachedSports: Object.keys(oddsCache)
  });
});

// History endpoint — returns picks history and W/L stats
app.get('/api/history', async (req, res) => {
  const sport = req.query.sport || null;
  const stats = await getHistoryStats(sport, req.query.limit);
  res.json(stats);
});

// One-time cleanup for rows written before savePick started deduplicating.
// A game sitting pre-game accumulated a fresh copy on every prediction run —
// one pick was stored ten times — which inflated the History tab's sample and
// made the record look far more certain than it was. Keeps the earliest row
// per (game, market, pick) and removes the later copies.
//
// Destructive, so it supports ?dryRun=1 to report the count without deleting.
// Rows with a NULL espn_game_id can never match and are left alone.
app.post('/api/dedupe', async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: 'Database not available' });
  const match = 'a.espn_game_id = b.espn_game_id AND a.market = b.market AND a.pick = b.pick';
  try {
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM picks');
    const dupes = await pool.query(
      `SELECT COUNT(DISTINCT a.id)::int AS n FROM picks a JOIN picks b ON a.id > b.id AND ${match}`);
    if (req.query.dryRun) {
      return res.json({ ok: true, dryRun: true, total: before.rows[0].n,
                        wouldDelete: dupes.rows[0].n });
    }
    const del = await pool.query(`DELETE FROM picks a USING picks b WHERE a.id > b.id AND ${match}`);
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM picks');
    console.log(`[DEDUPE] removed ${del.rowCount}: ${before.rows[0].n} -> ${after.rows[0].n}`);
    res.json({ ok: true, before: before.rows[0].n, deleted: del.rowCount, after: after.rows[0].n });
  } catch (err) {
    console.error('[DEDUPE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// One-time recompute for picks already graded under the broken away-spread
// logic. Final scores are already stored on each row, so this is pure
// arithmetic — no ESPN calls, and nothing is nulled out first.
app.post('/api/regrade', async (req, res) => {
  if (!dbReady || !pool) return res.status(503).json({ error: 'Database not available' });
  try {
    const graded = await pool.query(
      `SELECT * FROM picks WHERE actual_home IS NOT NULL AND actual_away IS NOT NULL`);
    let corrected = 0;
    for (const pick of graded.rows) {
      const result = gradePick(pick, pick.actual_home, pick.actual_away);
      if (result && result !== pick.result) {
        await pool.query(`UPDATE picks SET result = $1, graded_at = NOW() WHERE id = $2`,
          [result, pick.id]);
        corrected++;
      }
    }
    console.log(`[REGRADE] examined ${graded.rows.length}, corrected ${corrected}`);
    res.json({ ok: true, examined: graded.rows.length, corrected });
  } catch (err) {
    console.error('[REGRADE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Inspect what the ESPN line scrape actually returns for a sport. That parser
// strips tags and pattern-matches numeric tokens positionally, so it is brittle
// across sports and layout changes — and a wrong closing line makes CLV worse
// than no CLV, because it looks like a measurement.
app.get('/api/debug/lines/:sport', async (req, res) => {
  try {
    const lines = await fetchEspnOpeningLines(req.params.sport);
    const ids = Object.keys(lines || {});
    res.json({
      sport: req.params.sport,
      games: ids.length,
      sample: ids.slice(0, 6).map(id => ({ id, ...lines[id] })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual closing-line capture, for testing the job without waiting for a game.
app.post('/api/capture-closing', async (req, res) => {
  const cleared = req.query.reset ? await clearImplausibleClosingLines() : 0;
  await captureClosingLines();
  const clv = await getClvStats(req.query.sport || null);
  res.json({ ok: true, cleared, clv });
});

// Manual grade trigger (for testing)
app.post('/api/grade', async (req, res) => {
  await gradePendingPicks();
  res.json({ ok: true });
});

// Background grading job — runs every hour.
//
// This was previously wrapped in `if (dbReady !== false)`. That guard could
// never pass: dbReady is initialized to false and only flips to true inside an
// async IIFE that has not resolved yet when module evaluation reaches this
// line. So `false !== false` was always false, neither timer ever registered,
// and no pick was graded in the lifetime of the app.
//
// No outer guard is needed — gradePendingPicks() already returns early when
// !dbReady, and registering unconditionally means grading self-heals if the
// database connects late.
setInterval(() => {
  gradePendingPicks().catch(e => console.error('[GRADE_JOB]', e.message));
}, 60 * 60 * 1000);

// Closing lines every 10 minutes. The window in captureClosingLines is 30
// minutes wide, so every qualifying game is seen at least once before it
// starts. This only works because the service runs on a Starter instance and
// stays awake — on a free instance that spins down after 15 minutes idle,
// nothing would be running at kickoff and CLV would need an external trigger.
setInterval(() => {
  captureClosingLines().catch(e => console.error('[CLV_JOB]', e.message));
}, 10 * 60 * 1000);
setTimeout(() => {
  captureClosingLines().catch(e => console.error('[CLV_JOB]', e.message));
}, 45000);
// Also run once 30 seconds after startup (gives DB time to initialize)
setTimeout(() => {
  gradePendingPicks().catch(e => console.error('[GRADE_JOB]', e.message));
}, 30000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`ODDS_API_KEY present: ${!!process.env.ODDS_API_KEY}`);
  console.log(`ANTHROPIC_API_KEY present: ${!!process.env.ANTHROPIC_API_KEY}`);
});
