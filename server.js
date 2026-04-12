const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { Pool } = require('pg');

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
      'mlb': 'baseball/mlb'
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
        const homeScore = parseInt(home?.score);
        const awayScore = parseInt(away?.score);

        if (isNaN(homeScore) || isNaN(awayScore)) continue;

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
function gradePick(pick, homeScore, awayScore) {
  const line = parseFloat(pick.line);
  if (isNaN(line)) return null;

  if (pick.market === 'spread') {
    // pick.pick contains text like "Lakers -5.5" or "Celtics +3.5"
    // Determine which team was picked: if pick contains home team name, picked home
    const pickText = (pick.pick || '').toLowerCase();
    const homeNickname = (pick.home_team || '').split(' ').pop().toLowerCase();
    const awayNickname = (pick.away_team || '').split(' ').pop().toLowerCase();

    const pickedHome = pickText.includes(homeNickname);
    const pickedAway = pickText.includes(awayNickname);

    if (!pickedHome && !pickedAway) return null;

    // The line stored is the home spread (negative = home favored)
    // Home covers if (homeScore + homeSpread) > awayScore — i.e., homeScore - awayScore > -homeSpread
    const margin = homeScore - awayScore;
    const homeSpread = pickedHome ? line : -line;
    const adjusted = margin + homeSpread;

    if (adjusted > 0) return pickedHome ? 'win' : 'loss';
    if (adjusted < 0) return pickedHome ? 'loss' : 'win';
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
 * Get aggregated history stats for the History tab.
 */
async function getHistoryStats(sport = null) {
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
    const recent = await pool.query(`
      SELECT id, created_at, sport, home_team, away_team, market, pick, line, edge, confidence, result, actual_home, actual_away
      FROM picks
      ${sportFilter}
      ORDER BY created_at DESC
      LIMIT 50;
    `, params);

    return {
      available: true,
      overall: overall.rows[0],
      byMarket: byMarket.rows,
      byConfidence: byConfidence.rows,
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
// of the app burns 1 request per sport. Cache odds for 5 minutes.
// ============================================================================
const oddsCache = {};
const ODDS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

async function fetchNBATeamStats(teamName) {
  try {
    const teamId = nbaTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}`;
    const response = await axios.get(url, { timeout: 5000 });
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
    const response = await axios.get(url, { timeout: 5000 });
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(0, 10);

    let wins = 0, totalScored = 0, totalAllowed = 0;
    completedGames.forEach(game => {
      const comp = game.competitions[0];
      const h = comp.competitors.find(c => c.homeAway === 'home');
      const a = comp.competitors.find(c => c.homeAway === 'away');
      const isHome = h.team.id == teamId;
      const ts = isHome ? parseInt(h.score) : parseInt(a.score);
      const os = isHome ? parseInt(a.score) : parseInt(h.score);
      if (ts > os) wins++;
      totalScored += ts;
      totalAllowed += os;
    });

    return {
      last10: `${wins}-${completedGames.length - wins}`,
      avgScored: completedGames.length > 0 ? (totalScored / completedGames.length).toFixed(1) : 0,
      avgAllowed: completedGames.length > 0 ? (totalAllowed / completedGames.length).toFixed(1) : 0
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
    const response = await axios.get(url, { timeout: 5000 });
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(0, 10);
    if (completedGames.length === 0) return null;
    let totalPoints = 0;
    completedGames.forEach(game => {
      const comp = game.competitions[0];
      const h = comp.competitors.find(c => c.homeAway === 'home');
      const a = comp.competitors.find(c => c.homeAway === 'away');
      totalPoints += parseInt(h.score) + parseInt(a.score);
    });
    const avgTotal = totalPoints / completedGames.length;
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

async function fetchTravelData(awayTeam, homeTeam) {
  try {
    const awayLoc = nbaTeamLocations[awayTeam] || nhlTeamLocations[awayTeam] || mlbTeamLocations[awayTeam];
    const homeLoc = nbaTeamLocations[homeTeam] || nhlTeamLocations[homeTeam] || mlbTeamLocations[homeTeam];
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

async function fetchNHLTeamStats(teamName) {
  try {
    const teamId = nhlTeamIds[teamName];
    if (!teamId) return null;
    const url = `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/${teamId}`;
    const response = await axios.get(url, { timeout: 5000 });
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
    const response = await axios.get(url, { timeout: 5000 });
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(0, 10);
    let wins = 0, gf = 0, ga = 0;
    completedGames.forEach(game => {
      const comp = game.competitions[0];
      const h = comp.competitors.find(c => c.homeAway === 'home');
      const a = comp.competitors.find(c => c.homeAway === 'away');
      const isHome = h.team.id == teamId;
      const ts = isHome ? parseInt(h.score) : parseInt(a.score);
      const os = isHome ? parseInt(a.score) : parseInt(h.score);
      if (ts > os) wins++;
      gf += ts; ga += os;
    });
    return {
      last10: `${wins}-${completedGames.length - wins}`,
      avgGoalsFor: completedGames.length > 0 ? (gf / completedGames.length).toFixed(1) : 0,
      avgGoalsAgainst: completedGames.length > 0 ? (ga / completedGames.length).toFixed(1) : 0
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
    const response = await axios.get(url, { timeout: 5000 });
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
    const response = await axios.get(url, { timeout: 5000 });
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(0, 10);
    let wins = 0, rf = 0, ra = 0;
    completedGames.forEach(game => {
      const comp = game.competitions[0];
      const h = comp.competitors.find(c => c.homeAway === 'home');
      const a = comp.competitors.find(c => c.homeAway === 'away');
      const isHome = h.team.id == teamId;
      const ts = isHome ? parseInt(h.score) : parseInt(a.score);
      const os = isHome ? parseInt(a.score) : parseInt(h.score);
      if (ts > os) wins++;
      rf += ts; ra += os;
    });
    return {
      last10: `${wins}-${completedGames.length - wins}`,
      avgRunsFor: completedGames.length > 0 ? (rf / completedGames.length).toFixed(1) : 0,
      avgRunsAgainst: completedGames.length > 0 ? (ra / completedGames.length).toFixed(1) : 0
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
    const response = await axios.get(url, { timeout: 5000 });

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
      'mlb': 'https://www.espn.com/mlb/injuries'
    };
    const url = sportUrls[sport];
    if (!url) return [];

    const response = await axios.get(url, {
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

async function fetchEspnOpeningLines(sport) {
  // Check cache first
  const cached = espnOddsCache[sport];
  if (cached && (Date.now() - cached.timestamp) < ESPN_ODDS_CACHE_TTL_MS) {
    const ageSec = Math.round((Date.now() - cached.timestamp) / 1000);
    console.log(`[ESPN_ODDS] Cache hit for ${sport} (${ageSec}s old, ${Object.keys(cached.data).length} games)`);
    return cached.data;
  }

  const sportUrls = {
    'nba': 'https://www.espn.com/nba/odds',
    'nhl': 'https://www.espn.com/nhl/odds',
    'mlb': 'https://www.espn.com/mlb/odds'
  };
  const url = sportUrls[sport];
  if (!url) return {};

  console.log(`[ESPN_ODDS] Fetching ${sport} opening lines from ESPN...`);

  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = response.data;

    // Result map: gameId -> { openSpread, currentSpread, openTotal, currentTotal, openHomeML, currentHomeML, ... }
    const result = {};

    // Find all game blocks. Each game is anchored by a /nba/game/_/gameId/<NUMBER>/ link.
    // Use that link to identify the game and extract the surrounding row data.
    const gameIdPattern = new RegExp(`/${sport}/game/_/gameId/(\\d+)/`, 'g');
    const gameIdMatches = [...html.matchAll(gameIdPattern)];

    // De-duplicate game IDs (each game ID appears multiple times in the HTML)
    const seenGameIds = new Set();

    for (const gidMatch of gameIdMatches) {
      const gameId = gidMatch[1];
      if (seenGameIds.has(gameId)) continue;
      seenGameIds.add(gameId);

      // Get a chunk of HTML around this game ID — should contain both team rows
      const startIdx = gidMatch.index;
      // Look for the next game ID or end of slate to bound this game's HTML
      const nextGameMatch = html.indexOf('/game/_/gameId/', startIdx + 50);
      const endIdx = nextGameMatch > 0 ? nextGameMatch + 200 : startIdx + 8000;
      const gameHtml = html.substring(startIdx, endIdx);

      // Strip HTML tags and decode entities to get plain text we can pattern-match
      const plainText = gameHtml
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();

      // Extract all betting numbers from the row in order.
      // Patterns we expect: spreads like "-1.5" or "+12.5", totals like "o226.5" or "u228.5",
      // moneylines like "-122" or "+102" or "+550", and prices like "-110" or "-115".
      // Numbers appear in this column order for each team row:
      //   [team name + record] [OPEN value + price] [SPREAD pt + price] [TOTAL ou + price] [ML]
      //
      // Strategy: pull out all "betting tokens" in order and assign them by position.

      // Pull tokens: a spread/ML number is just +/- digits with optional .5
      //              a total is "o" or "u" followed by digits
      //              a price is +/- digits (typically -100 to -120 range, or +100 to +200)
      const tokenPattern = /([ou][\d.]+|[+\-]\d+\.?\d*)/g;
      const tokens = plainText.match(tokenPattern) || [];

      // Filter out the team records like "(46-25)" — these come through as "-25" "+46" etc.
      // A valid betting token is either: starts with o/u, OR is between -2000 and +2000 ish.
      // Records are typically small numbers in parens; we can spot them by checking if
      // they're surrounded by parens in the original text.
      const recordPattern = /\(\d+-\d+\)/g;
      const records = plainText.match(recordPattern) || [];
      // Remove record numbers from our token list
      const recordNumbers = new Set();
      records.forEach(r => {
        const nums = r.match(/\d+/g);
        if (nums) nums.forEach(n => recordNumbers.add(n));
      });

      const cleanTokens = tokens.filter(t => {
        if (t.startsWith('o') || t.startsWith('u')) return true;
        const num = t.replace(/[+\-]/, '');
        // If this number appears in a record, it's not a betting token
        // (this is imperfect but catches most cases)
        return !recordNumbers.has(num) || Math.abs(parseFloat(t)) >= 100;
      });

      // For each game we expect roughly 14 tokens (7 per team row):
      //   open_value, open_price, current_spread, current_spread_price,
      //   current_total, current_total_price, current_ml
      // Times two teams = 14. In practice ESPN's layout varies, so we'll be lenient.

      if (cleanTokens.length >= 10) {
        // Try to identify the OPEN spread (first +/- number that isn't a price)
        // and OPEN total (first o/u number)
        let openSpread = null, openTotal = null;
        let currentSpread = null, currentTotal = null;
        let homeML = null, awayML = null;

        // First team row tokens: typically [open_spread, open_spread_price, current_spread, current_spread_price, current_total, current_total_price, current_ml]
        // Find the first o/u token — that's an OPEN total (since one team's open is total, one's is spread)
        const firstTotalIdx = cleanTokens.findIndex(t => t.startsWith('o') || t.startsWith('u'));

        if (firstTotalIdx !== -1) {
          openTotal = parseFloat(cleanTokens[firstTotalIdx].replace(/[ou]/, ''));
        }

        // First +/- token that's a "spread-shaped" number (between -30 and +30, often with .5)
        const isSpreadShaped = (t) => {
          const n = parseFloat(t);
          return !isNaN(n) && Math.abs(n) <= 30 && (t.includes('.') || Math.abs(n) <= 20);
        };
        const firstSpreadIdx = cleanTokens.findIndex(t => !t.startsWith('o') && !t.startsWith('u') && isSpreadShaped(t));
        if (firstSpreadIdx !== -1) {
          openSpread = parseFloat(cleanTokens[firstSpreadIdx]);
        }

        // Find current spread: the SECOND spread-shaped number
        let spreadCount = 0;
        for (const t of cleanTokens) {
          if (!t.startsWith('o') && !t.startsWith('u') && isSpreadShaped(t)) {
            spreadCount++;
            if (spreadCount === 2) {
              currentSpread = parseFloat(t);
              break;
            }
          }
        }

        // Find current total: the SECOND o/u number
        let totalCount = 0;
        for (const t of cleanTokens) {
          if (t.startsWith('o') || t.startsWith('u')) {
            totalCount++;
            if (totalCount === 2) {
              currentTotal = parseFloat(t.replace(/[ou]/, ''));
              break;
            }
          }
        }

        // Moneylines: typically larger absolute numbers (>= 100), and they appear last in each row
        const mlCandidates = cleanTokens.filter(t => {
          if (t.startsWith('o') || t.startsWith('u')) return false;
          const n = parseFloat(t);
          return !isNaN(n) && Math.abs(n) >= 100 && Math.abs(n) <= 5000;
        });

        if (mlCandidates.length >= 2) {
          awayML = parseFloat(mlCandidates[mlCandidates.length - 2]);
          homeML = parseFloat(mlCandidates[mlCandidates.length - 1]);
        }

        result[gameId] = {
          openSpread,
          currentSpread,
          openTotal,
          currentTotal,
          homeML,
          awayML,
          spreadMovement: (openSpread !== null && currentSpread !== null)
            ? +(currentSpread - openSpread).toFixed(1)
            : null,
          totalMovement: (openTotal !== null && currentTotal !== null)
            ? +(currentTotal - openTotal).toFixed(1)
            : null
        };
      }
    }

    console.log(`[ESPN_ODDS] Parsed ${Object.keys(result).length} ${sport} games with opening lines`);
    espnOddsCache[sport] = { timestamp: Date.now(), data: result };
    return result;
  } catch (error) {
    console.error(`[ESPN_ODDS] Error fetching ${sport}:`, error.message);
    if (cached) {
      console.log(`[ESPN_ODDS] Falling back to stale cache for ${sport}`);
      return cached.data;
    }
    return {};
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

app.post('/api/predictions', async (req, res) => {
  try {
    const { sport } = req.body;
    if (!sport) return res.status(400).json({ error: 'Sport parameter required' });

    console.log(`\n=== Fetching predictions for ${sport.toUpperCase()} ===`);
    const oddsData = await fetchOdds(sport);
    const arbitrageAlerts = findArbitrageOpportunities(oddsData);

    if (sport === 'nba') return await handleNBAPredictions(res, arbitrageAlerts, oddsData);
    if (sport === 'nhl') return await handleNHLPredictions(res, arbitrageAlerts, oddsData);
    if (sport === 'mlb') return await handleMLBPredictions(res, arbitrageAlerts, oddsData);
    if (sport === 'cbb') return res.json({ sport: 'CBB', games: [], arbitrageAlerts: [], message: 'Coming soon.' });
    if (sport === 'nfl') return res.json({ sport: 'NFL', games: [], arbitrageAlerts: [], message: 'Coming soon.' });

    return res.json({ sport: sport.toUpperCase(), games: [], arbitrageAlerts: [], message: `${sport.toUpperCase()} not supported.` });
  } catch (error) {
    console.error('Prediction error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// NBA HANDLER
// ============================================================================

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
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();
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
        fetchTravelData(awayTeamName, homeTeamName),
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

    console.log('[NBA] Sending to Claude...');
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    let predictions;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      predictions = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('[NBA] Parse error:', parseError);
      return res.status(500).json({ error: 'Failed to parse predictions' });
    }

    // Override Claude's odds fields with the real fetched odds (in case Claude hallucinated)
    const formattedGames = predictions.games.map(game => {
      const stats = gamesWithStats.find(g => g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam);
      return {
        ...game,
        spread: stats?.odds?.spread ?? game.spread,
        total: stats?.odds?.total ?? game.total,
        homeML: stats?.odds?.homeML ?? game.homeML,
        awayML: stats?.odds?.awayML ?? game.awayML,
        bookmaker: stats?.odds?.bookmaker ?? null,
        lineMovement: stats?.lineMovement ?? null,
        sharpSignals: stats?.sharpSignals ?? [],
        stats
      };
    });

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
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();
      const homeFullName = homeTeam.team.displayName;
      const awayFullName = awayTeam.team.displayName;

      eventMap[`${homeFullName}|${awayFullName}`] = event.id;

      const [homeStats, awayStats, homeForm, awayForm, travelData, homeInjuries, awayInjuries] = await Promise.all([
        fetchNHLTeamStats(homeTeamName),
        fetchNHLTeamStats(awayTeamName),
        fetchNHLRecentGames(homeTeamName),
        fetchNHLRecentGames(awayTeamName),
        fetchTravelData(awayTeamName, homeTeamName),
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

    console.log('[NHL] Sending to Claude...');
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    let predictions;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      predictions = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('[NHL] Parse error:', parseError);
      return res.status(500).json({ error: 'Failed to parse NHL predictions' });
    }

    const formattedGames = predictions.games.map(game => {
      const stats = gamesWithStats.find(g => g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam);
      return {
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        gameTime: game.gameTime,
        spread: stats?.odds?.spread ?? game.puckLine,
        total: stats?.odds?.total ?? game.total,
        homeML: stats?.odds?.homeML ?? game.homeML,
        awayML: stats?.odds?.awayML ?? game.awayML,
        bookmaker: stats?.odds?.bookmaker ?? null,
        lineMovement: stats?.lineMovement ?? null,
        sharpSignals: stats?.sharpSignals ?? [],
        predictedScore: game.predictedScore,
        spreadPick: game.puckLinePick,
        spreadEdge: game.puckLineEdge,
        totalPick: game.totalPick,
        totalEdge: game.totalEdge,
        kellySpread: game.kellyPuckLine,
        kellyTotal: game.kellyTotal,
        confidence: game.confidence,
        keyFactors: game.keyFactors,
        stats
      };
    });

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
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();
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

    console.log('[MLB] Sending to Claude...');
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    let predictions;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      predictions = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('[MLB] Parse error:', parseError);
      return res.status(500).json({ error: 'Failed to parse MLB predictions' });
    }

    const formattedGames = predictions.games.map(game => {
      const stats = gamesWithStats.find(g => g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam);
      return {
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        gameTime: game.gameTime,
        spread: stats?.odds?.spread ?? game.runLine,
        total: stats?.odds?.total ?? game.total,
        homeML: stats?.odds?.homeML ?? game.homeML,
        awayML: stats?.odds?.awayML ?? game.awayML,
        bookmaker: stats?.odds?.bookmaker ?? null,
        lineMovement: stats?.lineMovement ?? null,
        sharpSignals: stats?.sharpSignals ?? [],
        predictedScore: game.predictedScore,
        spreadPick: game.runLinePick,
        spreadEdge: game.runLineEdge,
        totalPick: game.totalPick,
        totalEdge: game.totalEdge,
        kellySpread: game.kellyRunLine,
        kellyTotal: game.kellyTotal,
        confidence: game.confidence,
        keyFactors: game.keyFactors,
        stats
      };
    });

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
  const stats = await getHistoryStats(sport);
  res.json(stats);
});

// Manual grade trigger (for testing)
app.post('/api/grade', async (req, res) => {
  await gradePendingPicks();
  res.json({ ok: true });
});

// Background grading job — runs every hour
if (dbReady !== false) {
  setInterval(() => {
    gradePendingPicks().catch(e => console.error('[GRADE_JOB]', e.message));
  }, 60 * 60 * 1000);
  // Also run once 30 seconds after startup (gives DB time to initialize)
  setTimeout(() => {
    gradePendingPicks().catch(e => console.error('[GRADE_JOB]', e.message));
  }, 30000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`ODDS_API_KEY present: ${!!process.env.ODDS_API_KEY}`);
  console.log(`ANTHROPIC_API_KEY present: ${!!process.env.ANTHROPIC_API_KEY}`);
});
