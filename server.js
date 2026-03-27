const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

console.log(
  "API Key found:",
  process.env.ANTHROPIC_API_KEY
    ? "YES (length: " + process.env.ANTHROPIC_API_KEY.length + ")"
    : "NO"
);
console.log("Odds API Key found:", process.env.ODDS_API_KEY ? "YES" : "NO");

// ══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ══════════════════════════════════════════════════════════════════════════════
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
      error: `Rate limit exceeded. You can make ${maxRequests} requests per hour. Try again in ${minutesLeft} minutes.`,
    });
  }

  tracker.count += 1;
  next();
}

// ══════════════════════════════════════════════════════════════════════════════
// CACHING (5 min TTL)
// ══════════════════════════════════════════════════════════════════════════════
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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

// ══════════════════════════════════════════════════════════════════════════════
// LINE MOVEMENT TRACKING (in-memory)
// ══════════════════════════════════════════════════════════════════════════════
const openingLines = new Map();

function trackLineMovement(gameId, currentSpread, currentTotal, currentML) {
  if (!openingLines.has(gameId)) {
    // First time seeing this game - store as opening line
    openingLines.set(gameId, {
      spread: currentSpread,
      total: currentTotal,
      moneyline: currentML,
      timestamp: Date.now(),
    });
    return { spreadMove: 0, totalMove: 0, mlMove: 0 };
  }

  const opening = openingLines.get(gameId);
  return {
    spreadMove: currentSpread - opening.spread,
    totalMove: currentTotal - opening.total,
    mlMove: currentML - opening.moneyline,
    openingSpread: opening.spread,
    openingTotal: opening.total,
    openingML: opening.moneyline,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SPORT CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
const sportMap = {
  nba: "basketball_nba",
  nhl: "icehockey_nhl",
  cbb: "basketball_ncaab",
  nfl: "americanfootball_nfl",
  mlb: "baseball_mlb",
};

// Outdoor sports that need weather data
const outdoorSports = ["nfl", "mlb"];

// ESPN API endpoints for injuries
const espnInjuryEndpoints = {
  nba: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries",
  nhl: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries",
  nfl: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
  mlb: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries",
  cbb: null, // No reliable CBB injury endpoint
};

// ══════════════════════════════════════════════════════════════════════════════
// FETCH INJURY DATA FROM ESPN
// ══════════════════════════════════════════════════════════════════════════════
async function fetchInjuryData(sport) {
  const endpoint = espnInjuryEndpoints[sport];
  if (!endpoint) return [];

  const cacheKey = `injuries_${sport}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      console.log(`ESPN injury API returned ${response.status} for ${sport}`);
      return [];
    }

    const data = await response.json();
    const injuries = [];

    // Parse ESPN's injury format
    if (data.items) {
      for (const team of data.items) {
        const teamName = team.team?.displayName || team.team?.name || "Unknown";
        if (team.injuries) {
          for (const injury of team.injuries) {
            injuries.push({
              team: teamName,
              player: injury.athlete?.displayName || "Unknown",
              position: injury.athlete?.position?.abbreviation || "",
              status: injury.status || "Unknown",
              injury: injury.details?.type || injury.details?.detail || "Undisclosed",
              impact: injury.status === "Out" ? "HIGH" : injury.status === "Doubtful" ? "HIGH" : "MEDIUM",
            });
          }
        }
      }
    }

    console.log(`Fetched ${injuries.length} injuries for ${sport}`);
    setCache(cacheKey, injuries);
    return injuries;
  } catch (err) {
    console.error(`Error fetching injuries for ${sport}:`, err.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FETCH WEATHER DATA (Open-Meteo - free, no API key needed)
// ══════════════════════════════════════════════════════════════════════════════
async function fetchWeatherData(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,wind_speed_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const current = data.current;

    return {
      temperature: Math.round(current.temperature_2m),
      precipitation: current.precipitation,
      windSpeed: Math.round(current.wind_speed_10m),
      weatherCode: current.weather_code,
      description: getWeatherDescription(current.weather_code),
    };
  } catch (err) {
    console.error("Weather fetch error:", err.message);
    return null;
  }
}

function getWeatherDescription(code) {
  const codes = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow",
    73: "Moderate snow",
    75: "Heavy snow",
    95: "Thunderstorm",
  };
  return codes[code] || "Unknown";
}

// Stadium coordinates for weather (major outdoor venues)
const stadiumCoords = {
  // NFL Stadiums (outdoor only)
  "Buffalo Bills": { lat: 42.7738, lon: -78.787 },
  "Miami Dolphins": { lat: 25.958, lon: -80.2389 },
  "New England Patriots": { lat: 42.0909, lon: -71.2643 },
  "New York Jets": { lat: 40.8135, lon: -74.0745 },
  "New York Giants": { lat: 40.8135, lon: -74.0745 },
  "Baltimore Ravens": { lat: 39.278, lon: -76.6227 },
  "Cincinnati Bengals": { lat: 39.0954, lon: -84.516 },
  "Cleveland Browns": { lat: 41.506, lon: -81.6994 },
  "Pittsburgh Steelers": { lat: 40.4468, lon: -80.0158 },
  "Tennessee Titans": { lat: 36.1665, lon: -86.7713 },
  "Jacksonville Jaguars": { lat: 30.324, lon: -81.6373 },
  "Denver Broncos": { lat: 39.7439, lon: -105.02 },
  "Kansas City Chiefs": { lat: 39.0489, lon: -94.4839 },
  "Las Vegas Raiders": { lat: 36.0909, lon: -115.1833 }, // Dome
  "Los Angeles Chargers": { lat: 33.9535, lon: -118.3392 }, // SoFi has roof
  "Los Angeles Rams": { lat: 33.9535, lon: -118.3392 },
  "Chicago Bears": { lat: 41.8623, lon: -87.6167 },
  "Green Bay Packers": { lat: 44.5013, lon: -88.0622 },
  "Philadelphia Eagles": { lat: 39.9008, lon: -75.1675 },
  "Washington Commanders": { lat: 38.9076, lon: -76.8645 },
  "Carolina Panthers": { lat: 35.2258, lon: -80.8528 },
  "Tampa Bay Buccaneers": { lat: 27.9759, lon: -82.5033 },
  "San Francisco 49ers": { lat: 37.4033, lon: -121.9694 },
  "Seattle Seahawks": { lat: 47.5952, lon: -122.3316 },
  // Dome teams (skip weather)
  "Arizona Cardinals": null,
  "Atlanta Falcons": null,
  "Dallas Cowboys": null,
  "Detroit Lions": null,
  "Houston Texans": null,
  "Indianapolis Colts": null,
  "Minnesota Vikings": null,
  "New Orleans Saints": null,
  // MLB (all outdoor except domes)
  // Add as needed...
};

// ══════════════════════════════════════════════════════════════════════════════
// FETCH ODDS DATA FROM THE ODDS API
// ══════════════════════════════════════════════════════════════════════════════
async function fetchOddsData(sport) {
  const oddsApiSport = sportMap[sport];
  if (!oddsApiSport) throw new Error("Invalid sport");

  const cacheKey = `odds_${sport}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`Using cached data for ${sport}`);
    return cached;
  }

  // Request ALL bookmakers for comparison
  const url = `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us,us2&markets=spreads,totals,h2h&oddsFormat=american`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Odds API error: ${response.status}`);

  const data = await response.json();
  console.log(`Fetched ${data.length} games for ${sport} from Odds API`);

  setCache(cacheKey, data);
  return data;
}

// ══════════════════════════════════════════════════════════════════════════════
// FIND BEST LINES ACROSS SPORTSBOOKS
// ══════════════════════════════════════════════════════════════════════════════
function findBestLines(game) {
  const bestLines = {
    spread: { home: null, away: null },
    total: { over: null, under: null },
    moneyline: { home: null, away: null },
  };

  if (!game.bookmakers || game.bookmakers.length === 0) {
    return bestLines;
  }

  for (const book of game.bookmakers) {
    const bookName = book.title;

    // Check spreads
    const spreads = book.markets?.find((m) => m.key === "spreads");
    if (spreads) {
      for (const outcome of spreads.outcomes) {
        const isHome = outcome.name === game.home_team;
        const key = isHome ? "home" : "away";

        if (!bestLines.spread[key] || outcome.price > bestLines.spread[key].price) {
          bestLines.spread[key] = {
            point: outcome.point,
            price: outcome.price,
            book: bookName,
          };
        }
      }
    }

    // Check totals
    const totals = book.markets?.find((m) => m.key === "totals");
    if (totals) {
      for (const outcome of totals.outcomes) {
        const key = outcome.name.toLowerCase();
        if (!bestLines.total[key] || outcome.price > bestLines.total[key].price) {
          bestLines.total[key] = {
            point: outcome.point,
            price: outcome.price,
            book: bookName,
          };
        }
      }
    }

    // Check moneyline (h2h)
    const h2h = book.markets?.find((m) => m.key === "h2h");
    if (h2h) {
      for (const outcome of h2h.outcomes) {
        const isHome = outcome.name === game.home_team;
        const key = isHome ? "home" : "away";

        if (!bestLines.moneyline[key] || outcome.price > bestLines.moneyline[key].price) {
          bestLines.moneyline[key] = {
            price: outcome.price,
            book: bookName,
          };
        }
      }
    }
  }

  return bestLines;
}

// ══════════════════════════════════════════════════════════════════════════════
// DETECT ARBITRAGE OPPORTUNITIES
// ══════════════════════════════════════════════════════════════════════════════
function detectArbitrage(game) {
  const opportunities = [];

  if (!game.bookmakers || game.bookmakers.length < 2) {
    return opportunities;
  }

  // Check moneyline arbitrage
  let bestHomeML = { price: -Infinity, book: null };
  let bestAwayML = { price: -Infinity, book: null };

  for (const book of game.bookmakers) {
    const h2h = book.markets?.find((m) => m.key === "h2h");
    if (!h2h) continue;

    for (const outcome of h2h.outcomes) {
      if (outcome.name === game.home_team) {
        if (outcome.price > bestHomeML.price) {
          bestHomeML = { price: outcome.price, book: book.title };
        }
      } else {
        if (outcome.price > bestAwayML.price) {
          bestAwayML = { price: outcome.price, book: book.title };
        }
      }
    }
  }

  // Calculate arbitrage percentage
  if (bestHomeML.book && bestAwayML.book) {
    const homeDecimal = bestHomeML.price > 0 ? (bestHomeML.price / 100) + 1 : (100 / Math.abs(bestHomeML.price)) + 1;
    const awayDecimal = bestAwayML.price > 0 ? (bestAwayML.price / 100) + 1 : (100 / Math.abs(bestAwayML.price)) + 1;

    const arbPercentage = (1 / homeDecimal + 1 / awayDecimal) * 100;

    if (arbPercentage < 100) {
      const profit = ((100 - arbPercentage) / arbPercentage) * 100;
      opportunities.push({
        type: "MONEYLINE",
        profit: profit.toFixed(2),
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        homeBet: { price: bestHomeML.price, book: bestHomeML.book },
        awayBet: { price: bestAwayML.price, book: bestAwayML.book },
        description: `${profit.toFixed(2)}% guaranteed profit: ${game.home_team} ML @ ${bestHomeML.price} (${bestHomeML.book}) + ${game.away_team} ML @ ${bestAwayML.price} (${bestAwayML.book})`,
      });
    }
  }

  return opportunities;
}

// ══════════════════════════════════════════════════════════════════════════════
// CORE PREDICTION ENDPOINT
// ══════════════════════════════════════════════════════════════════════════════
app.post("/api/predictions", rateLimitMiddleware, async (req, res) => {
  const { sport } = req.body;

  try {
    // Fetch odds data
    const oddsData = await fetchOddsData(sport);

    if (!oddsData || oddsData.length === 0) {
      return res.json({
        games: [],
        lastUpdated: new Date().toISOString(),
        sport: sport.toUpperCase(),
      });
    }

    // Fetch injury data
    const injuries = await fetchInjuryData(sport);

    // Take up to 6 games (no Top 25 filter - show ALL games)
    let gamesToAnalyze = oddsData.slice(0, 6);

    if (gamesToAnalyze.length === 0) {
      return res.json({
        games: [],
        lastUpdated: new Date().toISOString(),
        sport: sport.toUpperCase(),
        message: "No games found",
      });
    }

    // Process each game
    const gamesFormatted = [];
    const allArbitrageOpps = [];

    for (const game of gamesToAnalyze) {
      const bookmaker = game.bookmakers?.[0];
      const spreads = bookmaker?.markets?.find((m) => m.key === "spreads");
      const totals = bookmaker?.markets?.find((m) => m.key === "totals");
      const h2h = bookmaker?.markets?.find((m) => m.key === "h2h");

      // Get spread, total, and moneyline
      const homeSpread = spreads?.outcomes?.find((o) => o.name === game.home_team)?.point || 0;
      const totalLine = totals?.outcomes?.[0]?.point || 0;
      const homeML = h2h?.outcomes?.find((o) => o.name === game.home_team)?.price || -110;
      const awayML = h2h?.outcomes?.find((o) => o.name === game.away_team)?.price || -110;

      // Determine favorite using MONEYLINE (negative = favorite)
      const homeFavorite = homeML < awayML;
      const favorite = homeFavorite ? game.home_team : game.away_team;
      const favoriteML = homeFavorite ? homeML : awayML;

      // Track line movement
      const lineMovement = trackLineMovement(game.id, homeSpread, totalLine, homeML);

      // Find best lines across books
      const bestLines = findBestLines(game);

      // Detect arbitrage
      const arbOpps = detectArbitrage(game);
      allArbitrageOpps.push(...arbOpps);

      // Get relevant injuries for this game
      const homeInjuries = injuries.filter((inj) =>
        game.home_team.toLowerCase().includes(inj.team.toLowerCase().split(" ").pop())
      );
      const awayInjuries = injuries.filter((inj) =>
        game.away_team.toLowerCase().includes(inj.team.toLowerCase().split(" ").pop())
      );

      // Get weather for outdoor sports
      let weather = null;
      if (outdoorSports.includes(sport)) {
        const coords = stadiumCoords[game.home_team];
        if (coords) {
          weather = await fetchWeatherData(coords.lat, coords.lon);
        }
      }

      gamesFormatted.push({
        id: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        gameTime: game.commence_time,
        spread: homeSpread,
        total: totalLine,
        homeML: homeML,
        awayML: awayML,
        favorite: favorite,
        favoriteML: favoriteML,
        lineMovement: lineMovement,
        bestLines: bestLines,
        arbitrage: arbOpps.length > 0 ? arbOpps[0] : null,
        injuries: {
          home: homeInjuries.slice(0, 5),
          away: awayInjuries.slice(0, 5),
        },
        weather: weather,
      });
    }

    // Build the Claude prompt with all the data
    const prompt = `You are an expert sports analyst. Analyze these ${sport.toUpperCase()} games.

GAMES:
${JSON.stringify(gamesFormatted, null, 2)}

RULES:
1. FAVORITE = more negative moneyline (use "favorite" field provided)
2. Factor in injuries (Out/Doubtful = HIGH impact)
3. Factor in weather for outdoor games
4. Use HALF KELLY for bet sizing
5. Flag |edge| > 3% as strong plays

Return ONLY valid JSON (no markdown):
{
  "games": [
    {
      "id": "game_id",
      "homeTeam": "Team",
      "awayTeam": "Team",
      "gameTime": "ISO",
      "spread": -4.5,
      "total": 224.5,
      "homeML": -180,
      "awayML": 155,
      "favorite": "Team",
      "predictedScore": {"home": 112, "away": 108},
      "spreadPick": "TEAM -4.5",
      "spreadEdge": 2.5,
      "totalPick": "OVER 224.5",
      "totalEdge": 1.8,
      "kellySpread": 1.05,
      "kellyTotal": 0.8,
      "confidence": "High",
      "keyFactors": ["factor1", "factor2"]
    }
  ],
  "lastUpdated": "${new Date().toISOString()}",
  "sport": "${sport.toUpperCase()}"
}`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    let textContent = "";
    for (const block of message.content) {
      if (block.type === "text") {
        textContent += block.text;
      }
    }

    console.log("Claude response:", textContent.substring(0, 500));

    let jsonText = textContent.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/```json\s*/g, "").replace(/```\s*/g, "");
    }

    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");

    const data = JSON.parse(jsonMatch[0]);

    // Add the raw best lines and arbitrage data to response
    data.arbitrageAlerts = allArbitrageOpps;

    res.json(data);
  } catch (err) {
    console.error(`Error fetching ${sport} predictions:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ARBITRAGE ENDPOINT (standalone)
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/arbitrage/:sport", rateLimitMiddleware, async (req, res) => {
  const { sport } = req.params;

  try {
    const oddsData = await fetchOddsData(sport);
    const opportunities = [];

    for (const game of oddsData) {
      const arbOpps = detectArbitrage(game);
      opportunities.push(...arbOpps);
    }

    res.json({
      sport: sport.toUpperCase(),
      opportunities: opportunities,
      count: opportunities.length,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`Arbitrage error for ${sport}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// INJURIES ENDPOINT (standalone)
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/injuries/:sport", async (req, res) => {
  const { sport } = req.params;

  try {
    const injuries = await fetchInjuryData(sport);
    res.json({
      sport: sport.toUpperCase(),
      injuries: injuries,
      count: injuries.length,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`Injuries error for ${sport}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BEST LINES ENDPOINT (standalone)
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/best-lines/:sport", rateLimitMiddleware, async (req, res) => {
  const { sport } = req.params;

  try {
    const oddsData = await fetchOddsData(sport);
    const gamesWithBestLines = [];

    for (const game of oddsData.slice(0, 15)) {
      const bestLines = findBestLines(game);
      gamesWithBestLines.push({
        id: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        gameTime: game.commence_time,
        bestLines: bestLines,
        bookmakerCount: game.bookmakers?.length || 0,
      });
    }

    res.json({
      sport: sport.toUpperCase(),
      games: gamesWithBestLines,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`Best lines error for ${sport}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════════
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sports Prediction Agent running on port ${PORT}`);
  console.log(`Features enabled: Line Movement, Multi-Book Comparison, Arbitrage Detection, Injuries, Weather`);
});
