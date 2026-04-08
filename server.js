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

// Ballpark factors (runs per game multiplier)
const ballparkFactors = {
  'Coors Field': 1.25,        // Rockies - thin air, massive offense boost
  'Great American Ball Park': 1.15, // Reds - hitter friendly
  'Camden Yards': 1.10,       // Orioles - short porches
  'Globe Life Field': 1.10,   // Rangers - new park, hitter friendly
  'Fenway Park': 1.08,        // Red Sox - Green Monster
  'Yankee Stadium': 1.08,     // Yankees - short right porch
  'Citizens Bank Park': 1.08, // Phillies - hitter friendly
  'Truist Park': 1.05,        // Braves - neutral-slight hitter
  'Chase Field': 1.05,        // Diamondbacks - dome
  'Wrigley Field': 1.05,      // Cubs - wind dependent
  'T-Mobile Park': 0.92,      // Mariners - pitcher friendly
  'Oracle Park': 0.90,        // Giants - marine layer, big dimensions
  'Petco Park': 0.90,         // Padres - pitcher friendly
  'Tropicana Field': 0.95,    // Rays - dome, pitcher friendly
  'Marlins Park': 0.95        // Marlins - dome, pitcher friendly
  // Default: 1.0 for unlisted parks
};

// ============================================================================
// NCAAMB (College Basketball) TEAM IDS
// ============================================================================

const ncaambTeamIds = {
  // Top programs - expand as needed
  'Duke': 150, 'North Carolina': 153, 'Kansas': 2305, 'Kentucky': 96,
  'Michigan': 130, 'UConn': 41, 'Gonzaga': 2250, 'Villanova': 222,
  'UCLA': 26, 'Arizona': 12, 'Purdue': 2509, 'Houston': 248,
  'Tennessee': 2633, 'Alabama': 333, 'Baylor': 239, 'Texas': 251,
  'Illinois': 356, 'Marquette': 269, 'Creighton': 156, 'Xavier': 2752,
  'Arkansas': 8, 'Auburn': 2, 'Florida': 57, 'South Carolina': 2579,
  'Iowa State': 66, 'Wisconsin': 275, 'Maryland': 120, 'Indiana': 84,
  'Michigan State': 127, 'Ohio State': 194, 'Texas Tech': 2641, 'Virginia': 258,
  'Oregon': 2483, 'San Diego State': 21, 'Saint Mary\'s': 2608, 'BYU': 252,
  'TCU': 2628, 'West Virginia': 277, 'Oklahoma': 201, 'Kansas State': 2306,
  'Iowa': 2294, 'Memphis': 235, 'Florida Atlantic': 2226, 'Miami': 2390,
  'Providence': 2507, 'USC': 30, 'Northwestern': 77, 'Rutgers': 164
};

// ============================================================================
// ATS TRACKING (IN-MEMORY - WOULD USE DATABASE IN PRODUCTION)
// ============================================================================

const atsRecords = {};

function updateATSRecord(teamName, covered, isFavorite, isHome) {
  if (!atsRecords[teamName]) {
    atsRecords[teamName] = {
      overall: { games: 0, covers: 0 },
      home: { games: 0, covers: 0 },
      away: { games: 0, covers: 0 },
      favorite: { games: 0, covers: 0 },
      underdog: { games: 0, covers: 0 }
    };
  }
  
  const record = atsRecords[teamName];
  record.overall.games++;
  if (covered) record.overall.covers++;
  
  if (isHome) {
    record.home.games++;
    if (covered) record.home.covers++;
  } else {
    record.away.games++;
    if (covered) record.away.covers++;
  }
  
  if (isFavorite) {
    record.favorite.games++;
    if (covered) record.favorite.covers++;
  } else {
    record.underdog.games++;
    if (covered) record.underdog.covers++;
  }
}

function getATSRecord(teamName) {
  if (!atsRecords[teamName]) {
    return {
      overall: '0-0 (0%)',
      home: '0-0 (0%)',
      away: '0-0 (0%)',
      asFavorite: '0-0 (0%)',
      asUnderdog: '0-0 (0%)'
    };
  }
  
  const r = atsRecords[teamName];
  const format = (rec) => {
    if (rec.games === 0) return '0-0 (0%)';
    const pct = ((rec.covers / rec.games) * 100).toFixed(0);
    return `${rec.covers}-${rec.games - rec.covers} (${pct}%)`;
  };
  
  return {
    overall: format(r.overall),
    home: format(r.home),
    away: format(r.away),
    asFavorite: format(r.favorite),
    asUnderdog: format(r.underdog)
  };
}

// ============================================================================
// ESPN API FUNCTIONS
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
    console.error(`Error fetching stats for ${teamName}:`, error.message);
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
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    const recent10 = completedGames.slice(0, 10);
    const recent5 = recent10.slice(0, 5);
    
    const analyzeGames = (games) => {
      let wins = 0;
      let totalScored = 0;
      let totalAllowed = 0;
      
      games.forEach(game => {
        const comp = game.competitions[0];
        const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
        const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
        const isHome = homeTeam.team.id == teamId;
        const teamScore = isHome ? parseInt(homeTeam.score) : parseInt(awayTeam.score);
        const oppScore = isHome ? parseInt(awayTeam.score) : parseInt(homeTeam.score);
        
        if (teamScore > oppScore) wins++;
        totalScored += teamScore;
        totalAllowed += oppScore;
      });
      
      return {
        record: `${wins}-${games.length - wins}`,
        avgScored: games.length > 0 ? (totalScored / games.length).toFixed(1) : 0,
        avgAllowed: games.length > 0 ? (totalAllowed / games.length).toFixed(1) : 0
      };
    };
    
    const streak = calculateStreak(recent10);
    const last10Data = analyzeGames(recent10);
    const last5Data = analyzeGames(recent5);
    
    return {
      last10: last10Data.record,
      last5: last5Data.record,
      streak: streak,
      avgScored: last10Data.avgScored,
      avgAllowed: last10Data.avgAllowed
    };
  } catch (error) {
    console.error(`Error fetching recent games for ${teamName}:`, error.message);
    return null;
  }
}

function calculateStreak(games) {
  if (!games || games.length === 0) return 'N/A';
  
  let streak = 0;
  let streakType = null;
  
  for (const game of games) {
    const comp = game.competitions[0];
    const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
    const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
    const teamId = nbaTeamIds[games.teamName];
    const isHome = homeTeam.team.id == teamId;
    const won = isHome ? homeTeam.winner : awayTeam.winner;
    
    if (streakType === null) {
      streakType = won ? 'W' : 'L';
      streak = 1;
    } else if ((won && streakType === 'W') || (!won && streakType === 'L')) {
      streak++;
    } else {
      break;
    }
  }
  
  return `${streakType}${streak}`;
}

async function fetchRestDays(teamName, gameDate) {
  try {
    const teamId = nbaTeamIds[teamName];
    if (!teamId) return { restDays: null, isB2B: false, is3in4: false };
    
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/schedule`;
    const response = await axios.get(url, { timeout: 5000 });
    
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    
    if (completedGames.length === 0) {
      return { restDays: null, isB2B: false, is3in4: false };
    }
    
    const lastGame = completedGames[0];
    const lastGameDate = new Date(lastGame.date);
    const currentGameDate = new Date(gameDate);
    const diffTime = currentGameDate - lastGameDate;
    const restDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    const isB2B = restDays === 1;
    
    // Check for 3 games in 4 nights
    const last3Games = completedGames.slice(0, 3);
    let is3in4 = false;
    if (last3Games.length >= 2) {
      const firstGameDate = new Date(last3Games[2].date);
      const daysBetween = (currentGameDate - firstGameDate) / (1000 * 60 * 60 * 24);
      is3in4 = daysBetween <= 4;
    }
    
    return { restDays, isB2B, is3in4 };
  } catch (error) {
    console.error(`Error fetching rest days for ${teamName}:`, error.message);
    return { restDays: null, isB2B: false, is3in4: false };
  }
}

async function fetchHeadToHead(homeTeam, awayTeam) {
  try {
    const homeId = nbaTeamIds[homeTeam];
    if (!homeId) return null;
    
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${homeId}/schedule`;
    const response = await axios.get(url, { timeout: 5000 });
    
    const events = response.data.events || [];
    const h2hGames = events.filter(e => {
      const comp = e.competitions?.[0];
      if (!comp) return false;
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      return (home?.team?.displayName.includes(homeTeam) && away?.team?.displayName.includes(awayTeam)) ||
             (home?.team?.displayName.includes(awayTeam) && away?.team?.displayName.includes(homeTeam));
    }).filter(e => e.competitions?.[0]?.status?.type?.completed);
    
    if (h2hGames.length === 0) {
      return { games: 0, homeRecord: '0-0', avgMargin: 0, avgTotal: 0 };
    }
    
    let homeWins = 0;
    let totalMargin = 0;
    let totalPoints = 0;
    
    h2hGames.forEach(game => {
      const comp = game.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      const homeScore = parseInt(home.score);
      const awayScore = parseInt(away.score);
      
      if (home.team.displayName.includes(homeTeam) && homeScore > awayScore) homeWins++;
      if (away.team.displayName.includes(homeTeam) && awayScore > homeScore) homeWins++;
      
      totalMargin += Math.abs(homeScore - awayScore);
      totalPoints += homeScore + awayScore;
    });
    
    return {
      games: h2hGames.length,
      homeRecord: `${homeWins}-${h2hGames.length - homeWins}`,
      avgMargin: (totalMargin / h2hGames.length).toFixed(1),
      avgTotal: (totalPoints / h2hGames.length).toFixed(1)
    };
  } catch (error) {
    console.error(`Error fetching H2H for ${homeTeam} vs ${awayTeam}:`, error.message);
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
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      totalPoints += parseInt(home.score) + parseInt(away.score);
    });
    
    const avgTotal = totalPoints / completedGames.length;
    let pace = 'Average';
    if (avgTotal > 225) pace = 'Fast';
    else if (avgTotal < 215) pace = 'Slow';
    
    return {
      avgTotal: avgTotal.toFixed(1),
      pace: pace
    };
  } catch (error) {
    console.error(`Error fetching pace data for ${teamName}:`, error.message);
    return null;
  }
}

async function fetchTeamRatings(teamName) {
  try {
    const teamId = nbaTeamIds[teamName];
    if (!teamId) return null;
    
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/schedule`;
    const response = await axios.get(url, { timeout: 5000 });
    
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(0, 10);
    
    if (completedGames.length === 0) return null;
    
    let totalOffRtg = 0;
    let totalDefRtg = 0;
    
    completedGames.forEach(game => {
      const comp = game.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      const isHome = home.team.id == teamId;
      const teamScore = isHome ? parseInt(home.score) : parseInt(away.score);
      const oppScore = isHome ? parseInt(away.score) : parseInt(home.score);
      
      // Rough estimation: points per 100 possessions
      // Actual calculation would need possession data
      const estimatedPoss = 100;
      totalOffRtg += (teamScore / estimatedPoss) * 100;
      totalDefRtg += (oppScore / estimatedPoss) * 100;
    });
    
    const offRtg = (totalOffRtg / completedGames.length).toFixed(1);
    const defRtg = (totalDefRtg / completedGames.length).toFixed(1);
    const netRtg = (offRtg - defRtg).toFixed(1);
    
    return {
      offRtg: parseFloat(offRtg),
      defRtg: parseFloat(defRtg),
      netRtg: parseFloat(netRtg)
    };
  } catch (error) {
    console.error(`Error fetching ratings for ${teamName}:`, error.message);
    return null;
  }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function fetchTravelData(awayTeam, homeTeam, gameTime) {
  try {
    const awayLoc = nbaTeamLocations[awayTeam];
    const homeLoc = nbaTeamLocations[homeTeam];
    
    if (!awayLoc || !homeLoc) return null;
    
    const miles = calculateDistance(awayLoc.lat, awayLoc.lon, homeLoc.lat, homeLoc.lon);
    const tzChange = Math.abs(awayLoc.tz - homeLoc.tz);
    
    let impact = 'None';
    let adjustment = 0;
    
    if (miles > 2000 || tzChange >= 3) {
      impact = 'Severe';
      adjustment = -3;
    } else if (miles > 1000 || tzChange >= 2) {
      impact = 'Moderate';
      adjustment = -2;
    } else if (miles > 500) {
      impact = 'Minor';
      adjustment = -1;
    }
    
    // West to East early game penalty
    const gameHour = new Date(gameTime).getHours();
    if (awayLoc.tz < homeLoc.tz && gameHour < 13) {
      adjustment -= 1;
      impact += ' + Early Game';
    }
    
    return {
      miles: Math.round(miles),
      tzChange,
      impact,
      adjustment
    };
  } catch (error) {
    console.error(`Error calculating travel data:`, error.message);
    return null;
  }
}

async function fetchStartingLineup(teamName) {
  try {
    // ESPN doesn't have a direct starting lineup API
    // This would require scraping or a paid service
    // Placeholder for now
    return {
      confirmed: false,
      injuries: [],
      lastMinuteChanges: []
    };
  } catch (error) {
    console.error(`Error fetching lineup for ${teamName}:`, error.message);
    return null;
  }
}

function calculateProjectedTotal(homePace, awayPace) {
  const homeAvg = parseFloat(homePace?.avgTotal || 220);
  const awayAvg = parseFloat(awayPace?.avgTotal || 220);
  return ((homeAvg + awayAvg) / 2).toFixed(1);
}

// ============================================================================
// NHL API FUNCTIONS
// ============================================================================

async function fetchNHLTeamStats(teamName) {
  try {
    const teamId = nhlTeamIds[teamName];
    if (!teamId) return null;
    
    const url = `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/${teamId}`;
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
      losses: record?.stats?.find(s => s.name === 'losses')?.value || 0,
      otLosses: record?.stats?.find(s => s.name === 'otLosses')?.value || 0
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
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    const recent10 = completedGames.slice(0, 10);
    const recent5 = recent10.slice(0, 5);
    
    const analyzeGames = (games) => {
      let wins = 0;
      let totalGoalsFor = 0;
      let totalGoalsAgainst = 0;
      
      games.forEach(game => {
        const comp = game.competitions[0];
        const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
        const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
        const isHome = homeTeam.team.id == teamId;
        const teamScore = isHome ? parseInt(homeTeam.score) : parseInt(awayTeam.score);
        const oppScore = isHome ? parseInt(awayTeam.score) : parseInt(homeTeam.score);
        
        if (teamScore > oppScore) wins++;
        totalGoalsFor += teamScore;
        totalGoalsAgainst += oppScore;
      });
      
      return {
        record: `${wins}-${games.length - wins}`,
        avgGoalsFor: games.length > 0 ? (totalGoalsFor / games.length).toFixed(1) : 0,
        avgGoalsAgainst: games.length > 0 ? (totalGoalsAgainst / games.length).toFixed(1) : 0
      };
    };
    
    const streak = calculateNHLStreak(recent10, teamId);
    const last10Data = analyzeGames(recent10);
    const last5Data = analyzeGames(recent5);
    
    return {
      last10: last10Data.record,
      last5: last5Data.record,
      streak: streak,
      avgGoalsFor: last10Data.avgGoalsFor,
      avgGoalsAgainst: last10Data.avgGoalsAgainst
    };
  } catch (error) {
    console.error(`Error fetching NHL recent games for ${teamName}:`, error.message);
    return null;
  }
}

function calculateNHLStreak(games, teamId) {
  if (!games || games.length === 0) return 'N/A';
  
  let streak = 0;
  let streakType = null;
  
  for (const game of games) {
    const comp = game.competitions[0];
    const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
    const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
    const isHome = homeTeam.team.id == teamId;
    const won = isHome ? homeTeam.winner : awayTeam.winner;
    
    if (streakType === null) {
      streakType = won ? 'W' : 'L';
      streak = 1;
    } else if ((won && streakType === 'W') || (!won && streakType === 'L')) {
      streak++;
    } else {
      break;
    }
  }
  
  return `${streakType}${streak}`;
}

async function fetchNHLGoalieStats(teamName) {
  try {
    // Goalie stats would require additional ESPN endpoints
    // For now, return placeholder that can be enhanced later
    return {
      starter: 'TBD',
      savePct: 'N/A',
      gaa: 'N/A'
    };
  } catch (error) {
    console.error(`Error fetching goalie stats for ${teamName}:`, error.message);
    return null;
  }
}

async function fetchNHLSpecialTeams(teamName) {
  try {
    // Special teams stats (power play, penalty kill)
    // Would need additional ESPN endpoints
    return {
      powerPlayPct: 'N/A',
      penaltyKillPct: 'N/A'
    };
  } catch (error) {
    console.error(`Error fetching special teams for ${teamName}:`, error.message);
    return null;
  }
}

// ============================================================================
// MLB API FUNCTIONS
// ============================================================================

async function fetchMLBTeamStats(teamName) {
  try {
    const teamId = mlbTeamIds[teamName];
    if (!teamId) return null;
    
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${teamId}`;
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
    console.error(`Error fetching MLB stats for ${teamName}:`, error.message);
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
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    const recent10 = completedGames.slice(0, 10);
    const recent5 = recent10.slice(0, 5);
    
    const analyzeGames = (games) => {
      let wins = 0;
      let totalRunsFor = 0;
      let totalRunsAgainst = 0;
      
      games.forEach(game => {
        const comp = game.competitions[0];
        const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
        const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
        const isHome = homeTeam.team.id == teamId;
        const teamScore = isHome ? parseInt(homeTeam.score) : parseInt(awayTeam.score);
        const oppScore = isHome ? parseInt(awayTeam.score) : parseInt(homeTeam.score);
        
        if (teamScore > oppScore) wins++;
        totalRunsFor += teamScore;
        totalRunsAgainst += oppScore;
      });
      
      return {
        record: `${wins}-${games.length - wins}`,
        avgRunsFor: games.length > 0 ? (totalRunsFor / games.length).toFixed(1) : 0,
        avgRunsAgainst: games.length > 0 ? (totalRunsAgainst / games.length).toFixed(1) : 0
      };
    };
    
    const streak = calculateMLBStreak(recent10, teamId);
    const last10Data = analyzeGames(recent10);
    const last5Data = analyzeGames(recent5);
    
    return {
      last10: last10Data.record,
      last5: last5Data.record,
      streak: streak,
      avgRunsFor: last10Data.avgRunsFor,
      avgRunsAgainst: last10Data.avgRunsAgainst
    };
  } catch (error) {
    console.error(`Error fetching MLB recent games for ${teamName}:`, error.message);
    return null;
  }
}

function calculateMLBStreak(games, teamId) {
  if (!games || games.length === 0) return 'N/A';
  
  let streak = 0;
  let streakType = null;
  
  for (const game of games) {
    const comp = game.competitions[0];
    const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
    const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
    const isHome = homeTeam.team.id == teamId;
    const won = isHome ? homeTeam.winner : awayTeam.winner;
    
    if (streakType === null) {
      streakType = won ? 'W' : 'L';
      streak = 1;
    } else if ((won && streakType === 'W') || (!won && streakType === 'L')) {
      streak++;
    } else {
      break;
    }
  }
  
  return `${streakType}${streak}`;
}

async function fetchMLBPitcherStats(teamName) {
  try {
    // Pitcher stats require game-specific data
    // Would need to fetch probable pitchers from today's game
    // Placeholder for now - can be enhanced with roster API
    return {
      starter: 'TBD',
      era: 'N/A',
      whip: 'N/A',
      k9: 'N/A'
    };
  } catch (error) {
    console.error(`Error fetching pitcher stats for ${teamName}:`, error.message);
    return null;
  }
}

function getBallparkFactor(venueName) {
  // Match venue name to ballpark factor
  for (const [park, factor] of Object.entries(ballparkFactors)) {
    if (venueName && venueName.includes(park.split(' ')[0])) {
      return factor;
    }
  }
  return 1.0; // Neutral park
}

async function fetchMLBWeather(gameId) {
  try {
    // Weather is crucial for MLB totals
    // Wind blowing out = OVER, wind blowing in = UNDER
    // Would need weather API integration
    return {
      temp: 'N/A',
      wind: 'N/A',
      conditions: 'N/A'
    };
  } catch (error) {
    console.error(`Error fetching MLB weather:`, error.message);
    return null;
  }
}

// ============================================================================
// NCAAMB (COLLEGE BASKETBALL) API FUNCTIONS
// ============================================================================

async function fetchNCAAMBTeamStats(teamName) {
  try {
    const teamId = ncaambTeamIds[teamName];
    if (!teamId) return null;
    
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${teamId}`;
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
    console.error(`Error fetching NCAAMB stats for ${teamName}:`, error.message);
    return null;
  }
}

async function fetchNCAAMBRecentGames(teamName) {
  try {
    const teamId = ncaambTeamIds[teamName];
    if (!teamId) return null;
    
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${teamId}/schedule`;
    const response = await axios.get(url, { timeout: 5000 });
    
    const events = response.data.events || [];
    const completedGames = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    const recent10 = completedGames.slice(0, 10);
    const recent5 = recent10.slice(0, 5);
    
    const analyzeGames = (games) => {
      let wins = 0;
      let totalScored = 0;
      let totalAllowed = 0;
      
      games.forEach(game => {
        const comp = game.competitions[0];
        const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
        const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
        const isHome = homeTeam.team.id == teamId;
        const teamScore = isHome ? parseInt(homeTeam.score) : parseInt(awayTeam.score);
        const oppScore = isHome ? parseInt(awayTeam.score) : parseInt(homeTeam.score);
        
        if (teamScore > oppScore) wins++;
        totalScored += teamScore;
        totalAllowed += oppScore;
      });
      
      return {
        record: `${wins}-${games.length - wins}`,
        avgScored: games.length > 0 ? (totalScored / games.length).toFixed(1) : 0,
        avgAllowed: games.length > 0 ? (totalAllowed / games.length).toFixed(1) : 0
      };
    };
    
    const streak = calculateNCAAMBStreak(recent10, teamId);
    const last10Data = analyzeGames(recent10);
    const last5Data = analyzeGames(recent5);
    
    return {
      last10: last10Data.record,
      last5: last5Data.record,
      streak: streak,
      avgScored: last10Data.avgScored,
      avgAllowed: last10Data.avgAllowed
    };
  } catch (error) {
    console.error(`Error fetching NCAAMB recent games for ${teamName}:`, error.message);
    return null;
  }
}

function calculateNCAAMBStreak(games, teamId) {
  if (!games || games.length === 0) return 'N/A';
  
  let streak = 0;
  let streakType = null;
  
  for (const game of games) {
    const comp = game.competitions[0];
    const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
    const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
    const isHome = homeTeam.team.id == teamId;
    const won = isHome ? homeTeam.winner : awayTeam.winner;
    
    if (streakType === null) {
      streakType = won ? 'W' : 'L';
      streak = 1;
    } else if ((won && streakType === 'W') || (!won && streakType === 'L')) {
      streak++;
    } else {
      break;
    }
  }
  
  return `${streakType}${streak}`;
}

// ============================================================================
// ODDS API FUNCTIONS
// ============================================================================

async function fetchOdds(sport) {
  try {
    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) {
      console.log('No ODDS_API_KEY found - using mock odds');
      return null;
    }
    
    const sportMap = {
      'nba': 'basketball_nba',
      'nfl': 'americanfootball_nfl',
      'nhl': 'icehockey_nhl',
      'mlb': 'baseball_mlb',
      'cbb': 'basketball_ncaab'
    };
    
    const sportKey = sportMap[sport];
    if (!sportKey) return null;
    
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=us&markets=spreads,totals,h2h&oddsFormat=american`;
    const response = await axios.get(url, { timeout: 10000 });
    
    return response.data;
  } catch (error) {
    console.error('Error fetching odds:', error.message);
    return null;
  }
}

function findArbitrageOpportunities(oddsData) {
  if (!oddsData) return [];
  
  const opportunities = [];
  
  oddsData.forEach(game => {
    const bookmakers = game.bookmakers || [];
    
    // Check for arbitrage on moneylines
    let bestHome = -Infinity;
    let bestAway = -Infinity;
    
    bookmakers.forEach(book => {
      const h2h = book.markets?.find(m => m.key === 'h2h');
      if (h2h && h2h.outcomes) {
        h2h.outcomes.forEach(outcome => {
          const odds = outcome.price;
          if (outcome.name === game.home_team) {
            bestHome = Math.max(bestHome, odds);
          } else {
            bestAway = Math.max(bestAway, odds);
          }
        });
      }
    });
    
    if (bestHome !== -Infinity && bestAway !== -Infinity) {
      const homeImplied = bestHome > 0 ? 100 / (bestHome + 100) : Math.abs(bestHome) / (Math.abs(bestHome) + 100);
      const awayImplied = bestAway > 0 ? 100 / (bestAway + 100) : Math.abs(bestAway) / (Math.abs(bestAway) + 100);
      const totalImplied = homeImplied + awayImplied;
      
      if (totalImplied < 1) {
        const profit = ((1 - totalImplied) * 100).toFixed(2);
        opportunities.push({
          homeTeam: game.home_team,
          awayTeam: game.away_team,
          profit: profit,
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
    
    if (!sport) {
      return res.status(400).json({ error: 'Sport parameter required' });
    }
    
    console.log(`Fetching predictions for ${sport.toUpperCase()}...`);
    
    // Fetch odds from API
    const oddsData = await fetchOdds(sport);
    const arbitrageAlerts = findArbitrageOpportunities(oddsData);
    
    // Handle different sports
    if (sport === 'nba') {
      return await handleNBAPredictions(res, arbitrageAlerts, oddsData);
    } else if (sport === 'nhl') {
      return await handleNHLPredictions(res, arbitrageAlerts, oddsData);
    } else if (sport === 'mlb') {
      return await handleMLBPredictions(res, arbitrageAlerts, oddsData);
    } else if (sport === 'nfl') {
      return res.json({
        sport: 'NFL',
        games: [],
        arbitrageAlerts: [],
        message: 'NFL support coming soon! Will include: weather impact, injury analysis, home field advantage, rest days, and game script predictions.'
      });
    } else if (sport === 'cbb') {
      return await handleNCAAMBPredictions(res, arbitrageAlerts, oddsData);
    } else {
      return res.json({
        sport: sport.toUpperCase(),
        games: [],
        arbitrageAlerts: [],
        message: `${sport.toUpperCase()} support coming soon. Currently available: NBA, NHL, MLB`
      });
    }
    
  } catch (error) {
    console.error('Prediction error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ============================================================================
// NBA PREDICTION HANDLER
// ============================================================================

async function handleNBAPredictions(res, arbitrageAlerts, oddsData) {
  try {
    // Fetch NBA games from ESPN - get games from last 24 hours to catch live games
    // ESPN returns live, completed, and upcoming games
    const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?limit=50`;
    const scoreboardResponse = await axios.get(scoreboardUrl, { timeout: 10000 });
    let events = scoreboardResponse.data.events || [];
    
    // Filter to only include live and upcoming games (exclude completed)
    events = events.filter(e => {
      const status = e.competitions?.[0]?.status?.type?.state;
      return status === 'pre' || status === 'in'; // pre = upcoming, in = live
    });
    
    if (events.length === 0) {
      return res.json({
        sport: 'NBA',
        games: [],
        arbitrageAlerts: [],
        message: 'No NBA games scheduled for today'
      });
    }
    
    // Process each game with comprehensive stats
    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();
      
      // Fetch all data sources
      const [
        homeStats,
        awayStats,
        homeForm,
        awayForm,
        homeRest,
        awayRest,
        h2h,
        homePace,
        awayPace,
        homeRatings,
        awayRatings,
        travelData,
        homeATS,
        awayATS,
        homeLineup,
        awayLineup
      ] = await Promise.all([
        fetchNBATeamStats(homeTeamName),
        fetchNBATeamStats(awayTeamName),
        fetchRecentGames(homeTeamName),
        fetchRecentGames(awayTeamName),
        fetchRestDays(homeTeamName, event.date),
        fetchRestDays(awayTeamName, event.date),
        fetchHeadToHead(homeTeamName, awayTeamName),
        fetchPaceData(homeTeamName),
        fetchPaceData(awayTeamName),
        fetchTeamRatings(homeTeamName),
        fetchTeamRatings(awayTeamName),
        fetchTravelData(awayTeamName, homeTeamName, event.date),
        Promise.resolve(getATSRecord(homeTeamName)),
        Promise.resolve(getATSRecord(awayTeamName)),
        fetchStartingLineup(homeTeamName),
        fetchStartingLineup(awayTeamName)
      ]);
      
      const projectedTotal = calculateProjectedTotal(homePace, awayPace);
      
      return {
        homeTeam: homeTeam.team.displayName,
        awayTeam: awayTeam.team.displayName,
        gameTime: new Date(event.date).toLocaleString(),
        homeData: homeStats,
        awayData: awayStats,
        homeForm: homeForm,
        awayForm: awayForm,
        restData: {
          homeRestDays: homeRest?.restDays,
          homeB2B: homeRest?.isB2B,
          home3in4: homeRest?.is3in4,
          awayRestDays: awayRest?.restDays,
          awayB2B: awayRest?.isB2B,
          away3in4: awayRest?.is3in4
        },
        h2h: h2h,
        pace: {
          homeAvgTotal: homePace?.avgTotal,
          homePace: homePace?.pace,
          awayAvgTotal: awayPace?.avgTotal,
          awayPace: awayPace?.pace,
          projectedTotal: projectedTotal
        },
        ratings: {
          homeOffRtg: homeRatings?.offRtg,
          homeDefRtg: homeRatings?.defRtg,
          homeNetRtg: homeRatings?.netRtg,
          awayOffRtg: awayRatings?.offRtg,
          awayDefRtg: awayRatings?.defRtg,
          awayNetRtg: awayRatings?.netRtg
        },
        travel: travelData,
        ats: {
          home: homeATS,
          away: awayATS
        },
        lineups: {
          home: homeLineup,
          away: awayLineup
        },
        odds: null // Will be filled from odds API
      };
    }));
    
    // Match odds data to games
    if (oddsData && oddsData.length > 0) {
      gamesWithStats.forEach(game => {
        const matchingOdds = oddsData.find(o => 
          o.home_team === game.homeTeam || o.away_team === game.awayTeam
        );
        
        if (matchingOdds && matchingOdds.bookmakers?.length > 0) {
          const bookmaker = matchingOdds.bookmakers[0];
          const spreads = bookmaker.markets?.find(m => m.key === 'spreads');
          const totals = bookmaker.markets?.find(m => m.key === 'totals');
          const h2h = bookmaker.markets?.find(m => m.key === 'h2h');
          
          game.odds = {
            spread: spreads?.outcomes?.find(o => o.name === game.homeTeam)?.point || null,
            total: totals?.outcomes?.[0]?.point || null,
            homeML: h2h?.outcomes?.find(o => o.name === game.homeTeam)?.price || null,
            awayML: h2h?.outcomes?.find(o => o.name === game.awayTeam)?.price || null
          };
        }
      });
    }
    
    // Send to Claude for predictions
    const prompt = `You are an expert NBA sports analyst and sharp bettor. Analyze the following games and provide predictions.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

DATA EXPLANATION:
- homeData/awayData: Season records, home/away splits
- homeForm/awayForm: Recent performance (L5, L10, streaks, avg scored/allowed in last 10)
- restData: Days since last game, back-to-back detection, 3 games in 4 nights
- h2h: Head-to-head matchup history this season
- pace: Team tempo and projected total based on pace
- ratings: Offensive/Defensive ratings (points per 100 possessions), Net Rating
- travel: Distance traveled, timezone changes, fatigue impact
- ats: Against The Spread records (overall, home/away, as favorite/underdog)
- lineups: Starting lineup status and injuries
- odds: Current betting lines (spread, total, moneylines)

ANALYSIS METHODOLOGY:

1. REST & FATIGUE IMPACT:
   - Back-to-back (B2B): -3 to -5 points expected performance drop
   - 3 games in 4 nights: Additional -1 to -2 points
   - Well-rested (3+ days): +1 to +2 points boost

2. TRAVEL IMPACT:
   - 2000+ miles OR 3+ timezone changes: -3 points (Severe)
   - 1000-2000 miles OR 2 timezone changes: -2 points (Moderate)
   - 500-1000 miles: -1 point (Minor)
   - West→East early games (<1pm ET): Additional -1 point

3. MATCHUP ANALYSIS (Offense vs Defense):
   - Elite Offense (OffRtg >115) vs Poor Defense (DefRtg >115): Expect high scoring, lean OVER
   - Elite Offense vs Elite Defense (DefRtg <105): Balanced, use pace factor
   - Poor Offense (OffRtg <108) vs Elite Defense: Expect low scoring, lean UNDER
   - Poor Offense vs Poor Defense: Pace-dependent, could go either way

4. PACE FACTOR (Total Predictions):
   - Fast (>225 avg) + Fast: Strong OVER (+4-6 points to projected total)
   - Fast + Average (215-225): Slight OVER (+2-3 points)
   - Average + Average: Use projected total as baseline
   - Slow (<215) + Average: Slight UNDER (-2-3 points)
   - Slow + Slow: Strong UNDER (-4-6 points to projected total)

5. HEAD-TO-HEAD HISTORY:
   - Use avgTotal from H2H as baseline for total prediction
   - Use avgMargin to inform spread prediction
   - Recent series dominance (e.g., 3-0) = stronger confidence in favorite

6. NET RATING DIFFERENTIAL:
   - Every +10 point NetRtg difference ≈ 3-4 point spread advantage
   - Example: Team A NetRtg +8, Team B NetRtg -4 = 12 point difference = ~4.5 point edge for Team A

7. ATS PERFORMANCE:
   - Team with 55%+ ATS record = trust them to cover more
   - Team with <45% ATS record = fade them covering
   - Check home/away ATS splits (some teams only cover at home)
   - Favorite/Underdog ATS splits (some teams better as dogs)

8. RECENT FORM:
   - W5+ streak: +2 confidence boost
   - L5+ streak: -2 confidence penalty
   - Consider avg points scored/allowed in L10 for scoring trends

9. EDGE CALCULATION:
   - Compare your predicted score to betting line
   - Edge = |Your Prediction - Line| as percentage
   - 3%+ edge = Value Bet
   - 5%+ edge = Strong Value Bet

10. KELLY CRITERION:
    - Half Kelly = (Edge% × 0.5)
    - Example: 6% edge = 3% half-kelly bet size

RESPONSE FORMAT (JSON):
{
  "games": [
    {
      "homeTeam": "Lakers",
      "awayTeam": "Celtics",
      "gameTime": "7:00 PM ET",
      "spread": "-5.5",
      "total": "225.5",
      "homeML": "-220",
      "awayML": "+180",
      "favorite": "Lakers -5.5",
      "predictedScore": { "home": 115, "away": 108 },
      "spreadPick": "Lakers -5.5",
      "spreadEdge": 3.2,
      "totalPick": "OVER 225.5",
      "totalEdge": -1.5,
      "kellySpread": 1.6,
      "kellyTotal": 0,
      "confidence": "Medium",
      "keyFactors": [
        "Celtics on B2B after West Coast trip (-3 pts)",
        "Lakers elite defense (108.5 DefRtg) vs Celtics average offense",
        "Slow pace matchup suggests UNDER (-3 pts to total)"
      ],
      "lineMovement": {
        "spreadMove": -0.5,
        "totalMove": 2.0
      }
    }
  ]
}

CRITICAL RULES:
- Only recommend picks where edge ≥ 2%
- If edge < 2%, set pick to "No edge" and edge to 0
- Be honest about uncertainty - assign "Low" confidence when data is mixed
- Factor in ALL data sources - rest, travel, pace, matchups, ATS, H2H
- For totals, pace factor is critical - don't ignore it
- Back-to-back games are HUGE - always apply -3 to -5 point adjustment`;

    console.log('Sending data to Claude for predictions...');
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    const responseText = message.content[0].text;
    console.log('Claude response received');
    
    // Parse Claude's JSON response
    let predictions;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        predictions = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Error parsing Claude response:', parseError);
      return res.status(500).json({ error: 'Failed to parse predictions' });
    }
    
    // Format for frontend
    const formattedGames = predictions.games.map(game => ({
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      gameTime: game.gameTime,
      spread: game.spread,
      total: game.total,
      homeML: game.homeML,
      awayML: game.awayML,
      favorite: game.favorite,
      predictedScore: game.predictedScore,
      spreadPick: game.spreadPick,
      spreadEdge: game.spreadEdge,
      totalPick: game.totalPick,
      totalEdge: game.totalEdge,
      kellySpread: game.kellySpread,
      kellyTotal: game.kellyTotal,
      confidence: game.confidence,
      keyFactors: game.keyFactors,
      lineMovement: game.lineMovement,
      stats: gamesWithStats.find(g => 
        g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam
      )
    }));
    
    return res.json({
      sport: 'NBA',
      games: formattedGames,
      arbitrageAlerts: arbitrageAlerts
    });
    
  } catch (error) {
    console.error('NBA Prediction error:', error);
    return res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// ============================================================================
// NHL PREDICTION HANDLER  
// ============================================================================

async function handleNHLPredictions(res, arbitrageAlerts, oddsData) {
  try {
    // Fetch NHL games from ESPN
    const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?limit=50`;
    const scoreboardResponse = await axios.get(scoreboardUrl, { timeout: 10000 });
    let events = scoreboardResponse.data.events || [];
    
    // Filter to only include live and upcoming games
    events = events.filter(e => {
      const status = e.competitions?.[0]?.status?.type?.state;
      return status === 'pre' || status === 'in';
    });
    
    if (events.length === 0) {
      return res.json({
        sport: 'NHL',
        games: [],
        arbitrageAlerts: [],
        message: 'No NHL games scheduled for today'
      });
    }
    
    // Process each NHL game with comprehensive stats
    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();
      
      // Fetch all NHL data sources
      const [
        homeStats,
        awayStats,
        homeForm,
        awayForm,
        homeRest,
        awayRest,
        travelData,
        homeGoalie,
        awayGoalie,
        homeSpecialTeams,
        awaySpecialTeams,
        homeATS,
        awayATS
      ] = await Promise.all([
        fetchNHLTeamStats(homeTeamName),
        fetchNHLTeamStats(awayTeamName),
        fetchNHLRecentGames(homeTeamName),
        fetchNHLRecentGames(awayTeamName),
        fetchRestDays(homeTeamName, event.date),
        fetchRestDays(awayTeamName, event.date),
        fetchTravelData(awayTeamName, homeTeamName, event.date),
        fetchNHLGoalieStats(homeTeamName),
        fetchNHLGoalieStats(awayTeamName),
        fetchNHLSpecialTeams(homeTeamName),
        fetchNHLSpecialTeams(awayTeamName),
        Promise.resolve(getATSRecord(homeTeamName)),
        Promise.resolve(getATSRecord(awayTeamName))
      ]);
      
      return {
        homeTeam: homeTeam.team.displayName,
        awayTeam: awayTeam.team.displayName,
        gameTime: new Date(event.date).toLocaleString(),
        homeData: homeStats,
        awayData: awayStats,
        homeForm: homeForm,
        awayForm: awayForm,
        restData: {
          homeRestDays: homeRest?.restDays,
          homeB2B: homeRest?.isB2B,
          home3in4: homeRest?.is3in4,
          awayRestDays: awayRest?.restDays,
          awayB2B: awayRest?.isB2B,
          away3in4: awayRest?.is3in4
        },
        travel: travelData,
        goalies: {
          home: homeGoalie,
          away: awayGoalie
        },
        specialTeams: {
          home: homeSpecialTeams,
          away: awaySpecialTeams
        },
        ats: {
          home: homeATS,
          away: awayATS
        },
        odds: null
      };
    }));
    
    // Send to Claude for NHL predictions
    const prompt = `You are an expert NHL sports analyst and sharp bettor. Analyze the following games and provide predictions.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

DATA EXPLANATION:
- homeData/awayData: Season records (W-L-OTL), home/away splits
- homeForm/awayForm: Recent performance (L5, L10, streaks, avg goals for/against in last 10)
- restData: Days since last game, back-to-back detection, 3 games in 4 nights
- travel: Distance traveled, timezone changes, fatigue impact
- goalies: Starting goalie stats (placeholder for now - will be enhanced)
- specialTeams: Power play % and penalty kill % (placeholder - will be enhanced)
- ats: Against The Spread records
- odds: Current betting lines (spread/puck line, total, moneylines)

NHL-SPECIFIC ANALYSIS METHODOLOGY:

1. REST & FATIGUE IMPACT:
   - Back-to-back (B2B): -0.5 to -1.0 goals expected
   - NHL teams play 82 games, fatigue is CRITICAL
   - Well-rested (3+ days): +0.3 to +0.5 goals boost

2. TRAVEL IMPACT:
   - 2000+ miles OR 3+ timezone changes: -0.5 goals (Severe)
   - 1000-2000 miles OR 2 timezone changes: -0.3 goals (Moderate)
   - West→East early games: Additional -0.2 goals

3. GOALIE MATCHUPS:
   - Elite goalie (placeholder) vs weak offense: lean UNDER
   - Backup goalies: typically +0.5 goals against
   - Goalie on B2B: +0.3 to +0.5 goals against

4. SPECIAL TEAMS:
   - Elite PP vs weak PK: +0.5 goals lean OVER
   - Poor PP vs elite PK: -0.3 goals lean UNDER
   - Special teams score ~20% of NHL goals

5. HOME ICE ADVANTAGE:
   - NHL home ice worth ~0.3 goals
   - Some buildings (Edmonton, Vegas) worth more
   - Last line change = matchup advantage

6. SCORING TRENDS:
   - Use avgGoalsFor and avgGoalsAgainst from recent form
   - High-scoring teams (>3.5 GPG) vs low-scoring (<2.5 GPG)
   - Defensive teams (<2.5 GA/G) suppress totals

7. PUCK LINE (1.5 GOALS):
   - Favorites -1.5 = must win by 2+ (risky, empty net scenarios)
   - Underdogs +1.5 = can lose by 1 in regulation
   - Close games common in NHL - puck line value on heavy favorites

8. OVERTIME/SHOOTOUT:
   - ~25% of NHL games go to OT
   - Affects totals (extra 5 min 3v3 = goals)
   - Check OT record in team stats

9. EDGE CALCULATION:
   - Compare predicted score to betting line
   - Edge = |Your Prediction - Line| as percentage
   - 5%+ edge = Value Bet (NHL has tighter margins than NBA)

10. KELLY CRITERION:
    - Half Kelly = (Edge% × 0.5)

RESPONSE FORMAT (JSON):
{
  "games": [
    {
      "homeTeam": "Bruins",
      "awayTeam": "Maple Leafs",
      "gameTime": "7:00 PM ET",
      "puckLine": "-1.5 (+180)",
      "total": "6.5",
      "homeML": "-150",
      "awayML": "+130",
      "predictedScore": { "home": 4, "away": 2 },
      "puckLinePick": "Bruins -1.5",
      "puckLineEdge": 3.5,
      "totalPick": "OVER 6.5",
      "totalEdge": 2.1,
      "kellyPuckLine": 1.75,
      "kellyTotal": 1.05,
      "confidence": "Medium",
      "keyFactors": [
        "Maple Leafs on B2B with travel (-0.5 goals)",
        "Bruins strong home record",
        "Both teams trending over in recent games"
      ]
    }
  ]
}

CRITICAL RULES FOR NHL:
- Only recommend picks where edge ≥ 3% (tighter than NBA)
- If edge < 3%, set pick to "No edge" and edge to 0
- Goalie matchups are HUGE - factor heavily when available
- Back-to-back games matter MORE in NHL than NBA
- Home ice = ~0.3 goal advantage
- Totals in NHL typically 5.5-6.5 (much lower than NBA)
- Empty net goals affect puck line heavily`;

    console.log('Sending NHL data to Claude for predictions...');
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    const responseText = message.content[0].text;
    console.log('Claude NHL response received');
    
    // Parse Claude's JSON response
    let predictions;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        predictions = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Error parsing Claude NHL response:', parseError);
      return res.status(500).json({ error: 'Failed to parse NHL predictions' });
    }
    
    // Format for frontend
    const formattedGames = predictions.games.map(game => ({
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      gameTime: game.gameTime,
      spread: game.puckLine,
      total: game.total,
      homeML: game.homeML,
      awayML: game.awayML,
      predictedScore: game.predictedScore,
      spreadPick: game.puckLinePick,
      spreadEdge: game.puckLineEdge,
      totalPick: game.totalPick,
      totalEdge: game.totalEdge,
      kellySpread: game.kellyPuckLine,
      kellyTotal: game.kellyTotal,
      confidence: game.confidence,
      keyFactors: game.keyFactors,
      stats: gamesWithStats.find(g => 
        g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam
      )
    }));
    
    return res.json({
      sport: 'NHL',
      games: formattedGames,
      arbitrageAlerts: arbitrageAlerts
    });
    
  } catch (error) {
    console.error('NHL Prediction error:', error);
    return res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// ============================================================================
// MLB PREDICTION HANDLER
// ============================================================================

async function handleMLBPredictions(res, arbitrageAlerts, oddsData) {
  try {
    // Fetch MLB games from ESPN
    const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?limit=50`;
    const scoreboardResponse = await axios.get(scoreboardUrl, { timeout: 10000 });
    let events = scoreboardResponse.data.events || [];
    
    // Filter to only include live and upcoming games
    events = events.filter(e => {
      const status = e.competitions?.[0]?.status?.type?.state;
      return status === 'pre' || status === 'in';
    });
    
    if (events.length === 0) {
      return res.json({
        sport: 'MLB',
        games: [],
        arbitrageAlerts: [],
        message: 'No MLB games scheduled for today'
      });
    }
    
    // Process each MLB game with comprehensive stats
    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();
      const venueName = comp.venue?.fullName || '';
      
      // Fetch all MLB data sources
      const [
        homeStats,
        awayStats,
        homeForm,
        awayForm,
        homePitcher,
        awayPitcher,
        weather,
        homeATS,
        awayATS
      ] = await Promise.all([
        fetchMLBTeamStats(homeTeamName),
        fetchMLBTeamStats(awayTeamName),
        fetchMLBRecentGames(homeTeamName),
        fetchMLBRecentGames(awayTeamName),
        fetchMLBPitcherStats(homeTeamName),
        fetchMLBPitcherStats(awayTeamName),
        fetchMLBWeather(event.id),
        Promise.resolve(getATSRecord(homeTeamName)),
        Promise.resolve(getATSRecord(awayTeamName))
      ]);
      
      const ballparkFactor = getBallparkFactor(venueName);
      
      return {
        homeTeam: homeTeam.team.displayName,
        awayTeam: awayTeam.team.displayName,
        gameTime: new Date(event.date).toLocaleString(),
        venue: venueName,
        ballparkFactor: ballparkFactor,
        homeData: homeStats,
        awayData: awayStats,
        homeForm: homeForm,
        awayForm: awayForm,
        pitchers: {
          home: homePitcher,
          away: awayPitcher
        },
        weather: weather,
        ats: {
          home: homeATS,
          away: awayATS
        },
        odds: null
      };
    }));
    
    // Send to Claude for MLB predictions
    const prompt = `You are an expert MLB sports analyst and sharp bettor. Analyze the following games and provide predictions.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

DATA EXPLANATION:
- homeData/awayData: Season records, home/away splits
- homeForm/awayForm: Recent performance (L5, L10, streaks, avg runs for/against in last 10)
- pitchers: Starting pitcher stats (placeholder - will be enhanced with probable starters)
- weather: Temperature, wind speed/direction, conditions (placeholder - will be enhanced)
- ballparkFactor: Run environment multiplier (1.0 = neutral, >1.0 = hitter friendly, <1.0 = pitcher friendly)
- venue: Stadium name
- ats: Against The Spread records (runline performance)

MLB-SPECIFIC ANALYSIS METHODOLOGY:

1. PITCHER MATCHUPS (MOST IMPORTANT):
   - Ace vs weak lineup: -1.5 to -2.0 runs, lean UNDER
   - Two aces: Strong UNDER lean (-1.0 runs)
   - Weak starter vs elite offense: +1.5 to +2.0 runs, lean OVER
   - Bullpen games: More volatile, check bullpen ERA
   - Day game after night game: Tired bullpen = OVER risk

2. BALLPARK FACTORS (CRITICAL FOR TOTALS):
   - Coors Field (1.25x): Add +2.5 runs to total projection
   - Great American (1.15x): Add +1.5 runs
   - Oracle Park/Petco (0.90x): Subtract -1.0 runs
   - Dome vs outdoor: Weather not a factor in dome

3. WEATHER IMPACT:
   - Wind blowing OUT 10+ mph: +1.0 to +1.5 runs (OVER)
   - Wind blowing IN 10+ mph: -1.0 runs (UNDER)
   - Hot weather (85°F+): +0.5 runs (ball carries better)
   - Cold weather (<50°F): -0.5 runs (dead ball)
   - Rain forecast: Possible postponement, avoid

4. HOME FIELD ADVANTAGE:
   - Worth ~0.2 runs in MLB (less than other sports)
   - Last at-bat = walk-off potential
   - Familiar with ballpark dimensions

5. RECENT FORM & STREAKS:
   - Hot team (6+ game win streak): Riding momentum
   - Cold team (5+ game losing streak): Fade them
   - Runs per game trending up/down

6. RUNLINE (Usually ±1.5):
   - Favorites -1.5: Need to win by 2+ (risky, ~45% hit rate)
   - Underdogs +1.5: High hit rate (~65%), lower payout
   - Alternative: Look at -2.5/+2.5 for value

7. TOTALS PROJECTION:
   - Start with league average: ~9.0 runs
   - Apply ballpark factor
   - Adjust for pitcher quality (±1.5 runs each)
   - Adjust for weather/wind
   - Check recent team totals (over/under trends)

8. DIVISION GAMES:
   - Teams know each other well = lower scoring
   - Rivalry games can go either way

9. EDGE CALCULATION:
   - Compare predicted total to betting line
   - MLB totals typically 7.5-9.5 runs
   - 5%+ edge = Value Bet

10. KELLY CRITERION:
    - Half Kelly = (Edge% × 0.5)

RESPONSE FORMAT (JSON):
{
  "games": [
    {
      "homeTeam": "Yankees",
      "awayTeam": "Red Sox",
      "gameTime": "7:00 PM ET",
      "runLine": "-1.5 (+140)",
      "total": "9.0",
      "homeML": "-180",
      "awayML": "+155",
      "predictedScore": { "home": 5, "away": 3 },
      "runLinePick": "Yankees -1.5",
      "runLineEdge": 4.2,
      "totalPick": "UNDER 9.0",
      "totalEdge": 5.5,
      "kellyRunLine": 2.1,
      "kellyTotal": 2.75,
      "confidence": "High",
      "keyFactors": [
        "Ace pitcher (2.50 ERA) vs struggling Red Sox offense",
        "Wind blowing IN at 12 mph - strong UNDER indicator",
        "Fenway Park neutral factor (1.08x)"
      ]
    }
  ]
}

CRITICAL RULES FOR MLB:
- Pitcher matchup is #1 factor - weight heavily
- Ballpark factor is #2 - Coors Field games are VERY different than Oracle Park
- Wind direction matters MORE than wind speed
- Only recommend picks where edge ≥ 4% (MLB has variance)
- Day games after night games = tired bullpens
- Check if it's a series finale (teams might rest starters)
- First inning lines can offer value (starting pitcher only)`;

    console.log('Sending MLB data to Claude for predictions...');
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    const responseText = message.content[0].text;
    console.log('Claude MLB response received');
    
    // Parse Claude's JSON response
    let predictions;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        predictions = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Error parsing Claude MLB response:', parseError);
      return res.status(500).json({ error: 'Failed to parse MLB predictions' });
    }
    
    // Format for frontend
    const formattedGames = predictions.games.map(game => ({
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      gameTime: game.gameTime,
      spread: game.runLine,
      total: game.total,
      homeML: game.homeML,
      awayML: game.awayML,
      predictedScore: game.predictedScore,
      spreadPick: game.runLinePick,
      spreadEdge: game.runLineEdge,
      totalPick: game.totalPick,
      totalEdge: game.totalEdge,
      kellySpread: game.kellyRunLine,
      kellyTotal: game.kellyTotal,
      confidence: game.confidence,
      keyFactors: game.keyFactors,
      stats: gamesWithStats.find(g => 
        g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam
      )
    }));
    
    return res.json({
      sport: 'MLB',
      games: formattedGames,
      arbitrageAlerts: arbitrageAlerts
    });
    
  } catch (error) {
    console.error('MLB Prediction error:', error);
    return res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// ============================================================================
// NCAAMB (COLLEGE BASKETBALL) PREDICTION HANDLER
// ============================================================================

async function handleNCAAMBPredictions(res, arbitrageAlerts, oddsData) {
  try {
    // Fetch NCAAMB games from ESPN
    const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?limit=50&groups=50`;
    const scoreboardResponse = await axios.get(scoreboardUrl, { timeout: 10000 });
    let events = scoreboardResponse.data.events || [];
    
    // Filter to live and upcoming games
    events = events.filter(e => {
      const status = e.competitions?.[0]?.status?.type?.state;
      return status === 'pre' || status === 'in';
    });
    
    if (events.length === 0) {
      return res.json({
        sport: 'CBB',
        games: [],
        arbitrageAlerts: [],
        message: 'No college basketball games scheduled right now'
      });
    }
    
    // Process each game
    const gamesWithStats = await Promise.all(events.map(async (event) => {
      const comp = event.competitions[0];
      const homeTeam = comp.competitors.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors.find(c => c.homeAway === 'away');
      
      // Extract team names (last word typically)
      const homeTeamName = homeTeam.team.displayName.split(' ').pop();
      const awayTeamName = awayTeam.team.displayName.split(' ').pop();
      
      // Fetch stats
      const [
        homeStats,
        awayStats,
        homeForm,
        awayForm,
        homeATS,
        awayATS
      ] = await Promise.all([
        fetchNCAAMBTeamStats(homeTeamName),
        fetchNCAAMBTeamStats(awayTeamName),
        fetchNCAAMBRecentGames(homeTeamName),
        fetchNCAAMBRecentGames(awayTeamName),
        Promise.resolve(getATSRecord(homeTeamName)),
        Promise.resolve(getATSRecord(awayTeamName))
      ]);
      
      return {
        homeTeam: homeTeam.team.displayName,
        awayTeam: awayTeam.team.displayName,
        gameTime: new Date(event.date).toLocaleString(),
        homeData: homeStats,
        awayData: awayStats,
        homeForm: homeForm,
        awayForm: awayForm,
        ats: {
          home: homeATS,
          away: awayATS
        },
        tournament: event.name?.includes('NCAA') || event.name?.includes('Final Four') || event.name?.includes('Championship'),
        odds: null
      };
    }));
    
    // Send to Claude
    const prompt = `You are an expert college basketball analyst and sharp bettor. Analyze the following games and provide predictions.

GAMES DATA:
${JSON.stringify(gamesWithStats, null, 2)}

DATA EXPLANATION:
- homeData/awayData: Season records, home/away splits
- homeForm/awayForm: Recent performance (L5, L10, streaks, avg points scored/allowed)
- tournament: Is this an NCAA Tournament game?
- ats: Against The Spread records

COLLEGE BASKETBALL ANALYSIS METHODOLOGY:

1. HOME COURT ADVANTAGE (MASSIVE IN COLLEGE):
   - Worth 3-5 points (bigger than NBA/NHL/MLB)
   - Student sections matter
   - Familiar rims, depth perception
   - Tournament games = NEUTRAL COURT (no home advantage)

2. TOURNAMENT CONTEXT:
   - March Madness = single elimination, high variance
   - Upsets are common (seed doesn't guarantee outcome)
   - Experience matters (teams that have "been there")
   - Coaching critical in tournament

3. RECENT FORM & MOMENTUM:
   - Teams on 5+ game win streaks have confidence
   - Coming off big wins = momentum
   - Teams that lost in conference tournament = extra rest or rust?

4. PACE & TEMPO:
   - Fast-paced teams (75+ possessions) = higher totals
   - Slow-paced teams (65- possessions) = lower totals
   - Use avgScored to infer pace

5. DEFENSIVE IDENTITY:
   - Elite defense (allow <65 PPG) suppresses totals
   - High-scoring offenses (80+ PPG) push totals up
   - Check avgAllowed from recent form

6. SPREADS IN COLLEGE BASKETBALL:
   - Much higher variance than NBA
   - Double-digit spreads common
   - Blowouts happen more frequently
   - Close games also very common (down to final possession)

7. TOTALS RANGE:
   - College typically 130-150 points
   - Tournament games often UNDER (tighter defense, nerves)
   - Regular season = more scoring

8. INTANGIBLES:
   - Star player impact (one player can dominate college game)
   - Foul trouble (college has only 5 fouls vs NBA's 6)
   - Free throw shooting matters late game
   - Three-point variance (hot/cold shooting)

9. EDGE CALCULATION:
   - Compare predicted score to betting line
   - 4%+ edge = Value Bet (high variance sport)

10. KELLY CRITERION:
    - Half Kelly = (Edge% × 0.5)

RESPONSE FORMAT (JSON):
{
  "games": [
    {
      "homeTeam": "UConn",
      "awayTeam": "Michigan",
      "gameTime": "9:00 PM ET",
      "spread": "-4.5",
      "total": "140.5",
      "homeML": "-180",
      "awayML": "+155",
      "predictedScore": { "home": 73, "away": 68 },
      "spreadPick": "UConn -4.5",
      "spreadEdge": 5.2,
      "totalPick": "UNDER 140.5",
      "totalEdge": 3.8,
      "kellySpread": 2.6,
      "kellyTotal": 1.9,
      "confidence": "Medium",
      "keyFactors": [
        "National Championship - neutral court, no home advantage",
        "UConn elite defense, tournament experience",
        "Tournament games trend UNDER - tight defense, nerves"
      ]
    }
  ]
}

CRITICAL RULES:
- Tournament games = NEUTRAL COURT (no home court edge)
- Only recommend picks where edge ≥ 4%
- College basketball is HIGH VARIANCE
- One hot shooter can swing a game
- Defense wins championships`;

    console.log('Sending NCAAMB data to Claude for predictions...');
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    const responseText = message.content[0].text;
    console.log('Claude NCAAMB response received');
    
    // Parse response
    let predictions;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        predictions = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Error parsing Claude NCAAMB response:', parseError);
      return res.status(500).json({ error: 'Failed to parse NCAAMB predictions' });
    }
    
    // Format for frontend
    const formattedGames = predictions.games.map(game => ({
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      gameTime: game.gameTime,
      spread: game.spread,
      total: game.total,
      homeML: game.homeML,
      awayML: game.awayML,
      predictedScore: game.predictedScore,
      spreadPick: game.spreadPick,
      spreadEdge: game.spreadEdge,
      totalPick: game.totalPick,
      totalEdge: game.totalEdge,
      kellySpread: game.kellySpread,
      kellyTotal: game.kellyTotal,
      confidence: game.confidence,
      keyFactors: game.keyFactors,
      stats: gamesWithStats.find(g => 
        g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam
      )
    }));
    
    return res.json({
      sport: 'CBB',
      games: formattedGames,
      arbitrageAlerts: arbitrageAlerts
    });
    
  } catch (error) {
    console.error('NCAAMB Prediction error:', error);
    return res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
