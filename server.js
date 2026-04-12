const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ============================================================================
// ODDS CACHE — prevents burning through Odds API quota on repeated page loads
// The Odds API free tier is 500 requests/month. Without caching, every refresh
// of the app burns 1 request per sport. Cache odds for 5 minutes.
// ============================================================================
const oddsCache = {};
const ODDS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
// INJURY SCRAPER (ESPN)
// ============================================================================

async function fetchInjuries(teamName, sport) {
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
    const teamMatch = html.match(new RegExp(`>${teamName}[^<]*<`, 'i'));
    if (!teamMatch) return [];

    const teamSectionStart = html.indexOf(teamMatch[0]);
    const nextTeamStart = html.indexOf('ResponsiveTable', teamSectionStart + 500);
    const teamSection = html.substring(teamSectionStart, nextTeamStart > 0 ? nextTeamStart : teamSectionStart + 3000);

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
    return injuries;
  } catch (error) {
    console.error(`Error fetching injuries for ${teamName}:`, error.message);
    return [];
  }
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

    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();

      const [homeStats, awayStats, homeForm, awayForm, homePace, awayPace, travelData, homeInjuries, awayInjuries] = await Promise.all([
        fetchNBATeamStats(homeTeamName),
        fetchNBATeamStats(awayTeamName),
        fetchRecentGames(homeTeamName),
        fetchRecentGames(awayTeamName),
        fetchPaceData(homeTeamName),
        fetchPaceData(awayTeamName),
        fetchTravelData(awayTeamName, homeTeamName),
        fetchInjuries(homeTeamName, 'nba'),
        fetchInjuries(awayTeamName, 'nba')
      ]);

      // FIX: Use new matchOddsToGame helper instead of broken inline matching
      const odds = matchOddsToGame(oddsData, homeTeam.team.displayName, awayTeam.team.displayName);

      return {
        homeTeam: homeTeam.team.displayName,
        awayTeam: awayTeam.team.displayName,
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
        odds: odds
      };
    }));

    const matched = gamesWithStats.filter(g => g.odds).length;
    console.log(`[NBA] Matched odds to ${matched}/${gamesWithStats.length} games`);

    const prompt = `You are an expert NBA analyst. Analyze these games and respond ONLY with a valid JSON object.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

For each game predict: spread pick (or "No edge" if edge < 2%), total pick, confidence (Low/Medium/High), and 3-5 key factors.

CRITICAL: Use the EXACT odds from the "odds" field for spread/total/homeML/awayML. Do not invent odds.

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
        stats
      };
    });

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

    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();

      const [homeStats, awayStats, homeForm, awayForm, travelData, homeInjuries, awayInjuries] = await Promise.all([
        fetchNHLTeamStats(homeTeamName),
        fetchNHLTeamStats(awayTeamName),
        fetchNHLRecentGames(homeTeamName),
        fetchNHLRecentGames(awayTeamName),
        fetchTravelData(awayTeamName, homeTeamName),
        fetchInjuries(homeTeamName, 'nhl'),
        fetchInjuries(awayTeamName, 'nhl')
      ]);

      const odds = matchOddsToGame(oddsData, homeTeam.team.displayName, awayTeam.team.displayName);

      return {
        homeTeam: homeTeam.team.displayName,
        awayTeam: awayTeam.team.displayName,
        gameTime: new Date(event.date).toLocaleString(),
        homeData: homeStats,
        awayData: awayStats,
        homeForm: homeForm,
        awayForm: awayForm,
        travel: travelData,
        injuries: { home: homeInjuries, away: awayInjuries },
        odds: odds
      };
    }));

    const matched = gamesWithStats.filter(g => g.odds).length;
    console.log(`[NHL] Matched odds to ${matched}/${gamesWithStats.length} games`);

    const prompt = `You are an expert NHL analyst. Analyze these games and respond ONLY with valid JSON.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

CRITICAL: Use the EXACT odds from the "odds" field. Do not invent odds.

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

    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();
      const venueName = comp.venue?.fullName || '';

      const [homeStats, awayStats, homeForm, awayForm, homeInjuries, awayInjuries] = await Promise.all([
        fetchMLBTeamStats(homeTeamName),
        fetchMLBTeamStats(awayTeamName),
        fetchMLBRecentGames(homeTeamName),
        fetchMLBRecentGames(awayTeamName),
        fetchInjuries(homeTeamName, 'mlb'),
        fetchInjuries(awayTeamName, 'mlb')
      ]);

      const odds = matchOddsToGame(oddsData, homeTeam.team.displayName, awayTeam.team.displayName);

      return {
        homeTeam: homeTeam.team.displayName,
        awayTeam: awayTeam.team.displayName,
        gameTime: new Date(event.date).toLocaleString(),
        venue: venueName,
        ballparkFactor: getBallparkFactor(venueName),
        homeData: homeStats,
        awayData: awayStats,
        homeForm: homeForm,
        awayForm: awayForm,
        injuries: { home: homeInjuries, away: awayInjuries },
        odds: odds
      };
    }));

    const matched = gamesWithStats.filter(g => g.odds).length;
    console.log(`[MLB] Matched odds to ${matched}/${gamesWithStats.length} games`);

    const prompt = `You are an expert MLB analyst. Analyze these games and respond ONLY with valid JSON.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

CRITICAL: Use the EXACT odds from the "odds" field. Do not invent odds.

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
    cachedSports: Object.keys(oddsCache)
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`ODDS_API_KEY present: ${!!process.env.ODDS_API_KEY}`);
  console.log(`ANTHROPIC_API_KEY present: ${!!process.env.ANTHROPIC_API_KEY}`);
});
