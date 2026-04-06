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
    
    // For now, focus on NBA
    if (sport !== 'nba') {
      return res.json({
        sport: sport.toUpperCase(),
        games: [],
        arbitrageAlerts: [],
        message: 'Only NBA is currently supported with full data integration'
      });
    }
    
    // Fetch current NBA games from ESPN (no date filter = gets current/upcoming games)
    const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard`;
    const scoreboardResponse = await axios.get(scoreboardUrl, { timeout: 10000 });
    const events = scoreboardResponse.data.events || [];
    
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
    
    res.json({
      sport: 'NBA',
      games: formattedGames,
      arbitrageAlerts: arbitrageAlerts
    });
    
  } catch (error) {
    console.error('Prediction error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
