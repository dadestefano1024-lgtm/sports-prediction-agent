# Sharks R' Us

NFL betting tools for two jobs: a weekly **Pick 6 pool** played against lines
frozen on a Wednesday, and **live betting** where the aim is to find a book
offering a better number than the rest of the market.

**For anything about how it works, what has been measured, and what has been
tried and rejected, read [CLAUDE.md](CLAUDE.md).** This file is setup only.

Live: https://sports-prediction-agent.onrender.com — pushing to `main` deploys.

---

## Run it

```bash
npm install
npm start          # serves on PORT, default 3000
npm test           # 253 tests
npm run analyse    # the measurement scripts — these hit live ESPN
```

Do **not** run a bare `node --test`. Node matches `*-test.js` as well as
`*.test.js`, so it executes `frozen-test.js` and the other harvesters against the
network and takes minutes. `npm test` is scoped to the two real suites.

## Environment

| variable | required | what it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | for the write-ups | Claude writes the per-game notes. It is told **not** to predict — see CLAUDE.md. |
| `DATABASE_URL` | recommended | Postgres. Stores the pool's shared lines, pick history, closing lines and the odds-API quota. Without it the app still runs but nothing persists and the shared card does not work. |
| `ODDS_API_KEY` | for live betting | The Odds API. **Free tier is 500 requests a month**, and that is the binding constraint on this app — see below. |
| `MY_BOOK` | no | The book you actually bet at. Default `DraftKings`. |
| `MODEL_TRUST` | no | How far the projection may pull away from the market. Default `0.1`, i.e. 90% market. Measured; do not raise it without reading CLAUDE.md. |
| `KELLY_FRACTION` | no | Stake sizing. Default is a fraction of full Kelly. |
| `ODDS_QUOTA_RESERVE` | no | Requests held back and never spent automatically. Default `12`. |
| `NODE_ENV` | no | `production` on Render. |
| `PORT` | no | Defaults to 3000. |
| `SPORTSDATA_API_KEY` | no | Legacy; nothing depends on it. |

## The odds quota is the thing that breaks

The free tier is 500 requests a month. Every cold start costs one, and Render's
free tier spins down when idle, so an unwatched app drains it: September was 498
spent by the 26th, which switched off the only live edge the app has measured.

The count now persists in the `api_quota` table and survives restarts, and
`ODDS_QUOTA_RESERVE` requests are never spent automatically.

Check what is left without spending one:

```bash
curl -s https://sports-prediction-agent.onrender.com/api/health | grep -o '"quotaRemaining":[0-9]*'
```

When the feed is out, every game reads **"No lean"** and **"No edge"**. That is
missing data, not a verdict — the app says so on the board. The Pick 6 tab keeps
working, because it only needs the pool numbers and free ESPN lines.

## Deploying

Render web service, Node environment, build `npm install`, start `npm start`, plus
the environment variables above. Pushing to `main` redeploys.

## Health

- `/healthz` — liveness. No I/O, always 200. Never make this fail; a 503 from a
  diagnostic endpoint once restart-looped the service into an outage.
- `/api/health` — dependency detail, 60s cache, returns 200 always. `?strict=1`
  for a 503 when degraded, `?deep=1` to include the paid Anthropic probe.

## Sports

**NFL** is the only one that is maintained and measured. NBA, MLB, NHL and CBB
code paths exist and are not calibrated — none of the measurements in CLAUDE.md
apply to them.
