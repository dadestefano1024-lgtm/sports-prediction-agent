const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

console.log('API Key found:', process.env.ANTHROPIC_API_KEY ? 'YES (length: ' + process.env.ANTHROPIC_API_KEY.length + ')' : 'NO');
console.log('Odds API Key found:', process.env.ODDS_API_KEY ? 'YES' : 'NO');

// ── Rate limiting ─────────────────────────────────────────────────────────────
const requestTracker = new Map();

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const hourInMs = 60 * 60 * 1000;
  const maxRequests = 10;

  if (!requestTracker.has(ip)) {
    requestTracker.set(ip, { count: 1, resetTime: now + hourInMs });
    return next();
  }

  const tracker = requestTracker.get(ip);

  if (now > tracker.resetTime) {
    requestTracker.set(ip, { count: 1, resetTime: now + hourInMs });
    return next();
  }

  if (tracker.count >= maxRequests) {
    const minutesLeft = Math.ceil((tracker.resetTime - now) / 60000);
    return res.status(429).json({ 
      error: `Rate limit exceeded. You can make ${maxRequests} requests per hour. Try again in ${minutesLeft} minutes.` 
    });
  }

  tracker.count += 1;
  next();
}

// ── Simple in-memory cache (5 min TTL) ───────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ── Fetch games from The Odds API ────────────────────────────────────────────
async function fetchOddsData(sport) {
  const sportMap = {
    nba: 'basketball_nba',
    nhl: 'icehockey_nhl',
    cbb: 'basketball_ncaab',
    nfl: 'americanfootball_nfl',
    mlb: 'baseball_mlb'
  };

  const oddsApiSport = sportMap[sport];
  if (!oddsApiSport) throw new Error('Invalid sport');

  const cacheKey = `odds_${sport}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`Using cached data for ${sport}`);
    return cached;
  }

  const url = `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=spreads,totals,h2h&oddsFormat=american`;
  
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Odds API error: ${response.status}`);
  
  const data = await response.json();
  console.log(`Fetched ${data.length} games for ${sport} from Odds API`);
  
  setCache(cacheKey, data);
  return data;
}

// ── Core prediction endpoint ──────────────────────────────────────────────────
app.post('/api/predictions', rateLimitMiddleware, async (req, res) => {
  const { sport } = req.body;

  try {
    // Fetch odds data
    const oddsData = await fetchOddsData(sport);

    if (!oddsData || oddsData.length === 0) {
      return res.json({
        games: [],
        lastUpdated: new Date().toISOString(),
        sport: sport.toUpperCase()
      });
    }

    // Format games for Claude
    const gamesFormatted = oddsData.slice(0, 10).map(game => {
      const bookmaker = game.bookmakers?.[0];
      const spreads = bookmaker?.markets?.find(m => m.key === 'spreads');
      const totals = bookmaker?.markets?.find(m => m.key === 'totals');
      const h2h = bookmaker?.markets?.find(m => m.key === 'h2h');
      
      return {
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        gameTime: game.commence_time,
        spread: spreads?.outcomes?.[0]?.point || 'N/A',
        total: totals?.outcomes?.[0]?.point || 'N/A',
        moneylineHome: h2h?.outcomes?.find(o => o.name === game.home_team)?.price || 'N/A',
        moneylineAway: h2h?.outcomes?.find(o => o.name === game.away_team)?.price || 'N/A'
      };
    });

    const sportPrompts = {
      nba: `You are an expert NBA analyst. Analyze these games and predict with Half Kelly sizing.`,
      nhl: `You are an expert NHL analyst. Analyze these games with focus on goalie matchups and Half Kelly sizing.`,
      cbb: `You are an expert college basketball analyst focusing on AP Top 25 teams with Half Kelly sizing.`,
      nfl: `You are an expert NFL analyst. Analyze these games considering matchups, injuries, weather, and coaching with Half Kelly sizing.`,
      mlb: `You are an expert MLB analyst. Analyze these games considering pitching matchups, bullpen strength, ballpark factors, and weather with Half Kelly sizing.`
    };

    const prompt = `You are an expert sports analyst. Here are today's ${sport.toUpperCase()} games with current betting lines:

${JSON.stringify(gamesFormatted, null, 2)}

For each game:
1. Analyze team form, matchups, and efficiency
2. Generate predicted final score
3. Calculate edge %: (your win probability - implied odds probability) * 100
4. Apply Kelly Criterion: Kelly % = (edge * b - (1 - win_prob)) / b where b = (American odds to decimal - 1)
5. IMPORTANT: Calculate HALF KELLY (multiply Kelly result by 0.5) - this is what sharp bettors use
6. Flag games where |edge| > 3%

Return ONLY valid JSON in this exact format (no markdown, no explanations):
{
  "games": [
    {
      "id": "game1",
      "homeTeam": "Team",
      "awayTeam": "Team",
      "gameTime": "ISO timestamp",
      "spread": "-4.5",
      "total": "224.5",
      "predictedScore": {"home": 112, "away": 108},
      "predictedSpread": -4,
      "predictedTotal": 220,
      "spreadEdge": 2.5,
      "totalEdge": -1.8,
      "spreadWinProb": 0.54,
      "totalWinProb": 0.48,
      "kellySpread": 1.05,
      "kellyTotal": 0,
      "recommendation": "HOME -4.5",
      "confidence": "Medium",
      "keyFactors": ["Key insight 1", "Key insight 2"]
    }
  ],
  "lastUpdated": "${new Date().toISOString()}",
  "sport": "${sport.toUpperCase()}"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    let textContent = '';
    for (const block of message.content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }

    console.log('Claude response:', textContent.substring(0, 500));

    let jsonText = textContent.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    }

    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');

    const data = JSON.parse(jsonMatch[0]);
    res.json(data);

  } catch (err) {
    console.error(`Error fetching ${sport} predictions:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sports Prediction Agent running on port ${PORT}`);
});
