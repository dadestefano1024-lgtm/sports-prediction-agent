# Sports Prediction Agent - Data-Driven Edition

Advanced NBA betting predictions powered by ESPN data and Claude AI analysis.

## 🎯 Features

### Comprehensive ESPN Data Integration
- **Team Stats**: Season records, home/away splits
- **Recent Form**: L5, L10, win/loss streaks, scoring averages
- **Rest & Fatigue**: Back-to-back detection, 3-in-4 nights tracking
- **Travel Impact**: Distance, timezone changes, fatigue adjustments
- **Head-to-Head**: Season series records and averages
- **Pace Factor**: Team tempo analysis for totals predictions
- **Advanced Ratings**: Offensive/Defensive ratings (per 100 possessions)
- **ATS Records**: Against The Spread performance tracking
- **Starting Lineups**: Injury and lineup confirmation

### AI-Powered Analysis
- Claude AI analyzes all data sources to generate predictions
- Edge calculation vs betting lines
- Kelly Criterion bet sizing (Half Kelly)
- Confidence ratings (High/Medium/Low)
- Key factors breakdown for each game

### Additional Features
- Multi-sportsbook odds comparison
- Arbitrage opportunity detection
- Line movement tracking
- Value bet highlighting

## 🚀 Deployment to Render

### Prerequisites
1. Anthropic API Key (get from console.anthropic.com)
2. The Odds API Key (optional - get from the-odds-api.com)

### Steps

1. **Push to GitHub**
   ```bash
   # In your local sports-prediction-agent folder
   git add .
   git commit -m "Add data-driven ESPN integration"
   git push origin main
   ```

2. **Deploy to Render**
   - Go to dashboard.render.com
   - Click "New +" → "Web Service"
   - Connect your GitHub repo: `dadestefano1024-lgtm/sports-prediction-agent`
   - Settings:
     - **Name**: `sports-prediction-agent`
     - **Environment**: `Node`
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
   - Add Environment Variables:
     - `ANTHROPIC_API_KEY` = your_key_here
     - `ODDS_API_KEY` = your_odds_api_key (optional)
     - `NODE_ENV` = production
   - Click "Create Web Service"

3. **Wait for deployment** (2-3 minutes)

4. **Test**: Visit `https://your-app.onrender.com`

## 📊 Data Sources

### ESPN APIs (Free)
- Team statistics and records
- Schedule and recent games
- Head-to-head history
- Calculated pace and ratings

### The Odds API (Optional)
- Live betting lines from multiple sportsbooks
- Line movement tracking
- Arbitrage detection

## 🔧 Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-xxx...  # Required - Claude AI API key
ODDS_API_KEY=xxx...              # Optional - Live odds data
NODE_ENV=production              # Optional - production/development
PORT=3000                        # Optional - defaults to 3000
```

## 📈 How It Works

1. **Fetch Games**: Gets today's NBA games from ESPN
2. **Gather Stats**: Pulls comprehensive data for each team
3. **AI Analysis**: Sends all data to Claude AI for prediction
4. **Calculate Edge**: Compares predictions vs actual betting lines
5. **Return Results**: Sends predictions with edges, picks, and Kelly percentages

## 🎲 Prediction Methodology

### Rest & Fatigue
- Back-to-back: -3 to -5 points
- 3 games in 4 nights: -1 to -2 points
- Well-rested (3+ days): +1 to +2 points

### Travel Impact
- 2000+ miles OR 3+ timezones: -3 points
- 1000-2000 miles OR 2 timezones: -2 points
- West→East early games: Additional -1 point

### Pace Factor
- Fast + Fast: OVER (+4-6 points)
- Slow + Slow: UNDER (-4-6 points)
- Mixed: Use projected total

### Edge Calculation
- 3%+ edge = Value Bet
- 5%+ edge = Strong Value Bet

## 🏀 Supported Sports

Currently: **NBA** (full data integration)

Coming Soon: NHL, NFL, MLB, CBB

## 📝 API Endpoints

### POST /api/predictions
Request:
```json
{ "sport": "nba" }
```

Response:
```json
{
  "sport": "NBA",
  "games": [
    {
      "homeTeam": "Lakers",
      "awayTeam": "Celtics",
      "predictedScore": { "home": 115, "away": 108 },
      "spreadPick": "Lakers -5.5",
      "spreadEdge": 3.2,
      "kellySpread": 1.6,
      "confidence": "High",
      "keyFactors": [...]
    }
  ],
  "arbitrageAlerts": []
}
```

## 🛠️ Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export ANTHROPIC_API_KEY=sk-ant-xxx...

# Run server
npm run dev

# Visit http://localhost:3000
```

## 📄 License

MIT

---

Built by Danny DeStefano
