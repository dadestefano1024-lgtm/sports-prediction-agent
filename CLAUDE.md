# CLAUDE.md — Sharks R' Us

**Read this before touching anything.** It exists because the answers to "does the
app already do X" were only discoverable by grepping 10,879 lines, so they got
rediscovered every session and some of them got rebuilt. If anything here
disagrees with what you measure, the measurement wins — **fix this file in the
same commit.**

There *was* a README. It described a different application: NBA-only, Claude
generating the predictions, and "arbitrage opportunity detection" that appears
nowhere in the code. Its "Prediction Methodology" — rest, travel and pace point
adjustments — is exactly what `reach.js` shows moves nothing. A stale map is worse
than none, because it is believed. `README.md` is now setup only and points here.

Owner: Danny DeStefano. Not a programmer. Direct, no preambles, pushes back when
something is wrong and is usually right to.

- **Live:** https://sports-prediction-agent.onrender.com — push to `main` deploys.
- **Repo:** `dadestefano1024-lgtm/sports-prediction-agent`
- **Files:** `server.js` (5,380), `model.js` (3,146, pure maths, no I/O),
  `public/index.html` (2,353). Plus 17 analysis scripts.
- **Tests:** `npm test` (253). `npm run analyse` for the measurement scripts —
  never a bare `node --test`, which matches `*-test.js` and executes the
  harvesters against live ESPN.

---

## The two things it is for

1. **The Pick 6 pool.** ~300 entrants, six picks, **6-0 or nothing**, a push is a
   LOSS. Lines are posted by another entrant on Wednesday and frozen. Danny picks
   Sunday morning.
2. **Live betting at DraftKings**, where a push refunds.

These pull in opposite directions and almost every bug in this file's history
came from applying one's logic to the other.

---

## The ONE edge that works

**Back the side the market moved toward, holding a number the market has left
behind.** Everything else has been measured and rejected.

| measured on 690 games, 2023-25, push = loss | |
|---|---|
| all games | 54.1% |
| market moved ≥2pt | 59.8% |
| market moved ≥3pt | 66.0% |
| market moved ≥4pt | 67.9% |
| **the same bet at the CLOSING number** | **50.7%** |

That last row is the whole thesis: the edge is the **number**, not the side.
Separately holdout-tested at 55.4% over 325 bets (found on 2025, held on 2024).

**Why it is not "betting with the public":** the closing line is a better forecast
than the open (9.714 vs 9.878 mean error; 1.277 better on games that move 4+
points). If moves were public noise the close would be worse. Fading the move at
the frozen number goes 43.5%.

---

## Measured and REJECTED — do not re-propose these

Each cost real work. Numbers, not opinions.

| idea | result | where |
|---|---|---|
| The opponent-adjusted projection as a picker | 51.7% overall, **47.1%** where the market did not move | `frozen-test.js` |
| The projection as a *filter* on the rule | looked real (54.1%→56.9%, 3/3 seasons), died on two gates: entirely inside one movement bucket, and decayed 34.8→17.1→4.2 by season | `frozen-test.js` |
| Yards-per-play efficiency | 11.58 MAE vs market 10.06 | `efftest.js` |
| Recent form as a picker | 49.2% (−0.40 SD) | `increment-test.js` |
| Rest advantage (3+ days) | 50.9% (0.23 SD) | `increment-test.js` |
| Wind / cold / roof / short week / divisional | none clears three gates; wind has 41 games, cold 28, so unmeasured rather than disproven | `increment-test.js` |
| West-coast team travelling east for a 1pm kickoff — the most-cited travel effect in football | 63 games. Fading the traveller 49.2%, backing them 47.6%. The market expected home by 0.33 and the road team won by 0.17, so the jet-lagged side slightly OUTPERFORMED the line — the point estimate is backwards | `increment-test.js` |
| **NBA back-to-backs and rest** | Fully priced. Fading the tired side at the close is 49.2% over 301 games (-0.29 SD); away-tired 49.4%, home-tired 49.0%. A 3-in-4 looks real at 54.4% until the mirror is checked -- backing away against a tired HOME team is 49.3%, so it is asymmetric and therefore noise. Rest advantage of a day is 49.8%. And the totals run the wrong way: games with one tired side landed **1.78 points ABOVE** the line, not below | `nba-rest.js` |
| Totals (stale-line rule) | 50.8–54.3%, seasons disagree (49.5 vs 53.2) | `stale-totals-pool.js` |
| Correlation between covers in a week | variance ratio 0.97 = independent, so multiplying the six is correct | `week-correlation.js` |
| More confidence in last season | `priorRegression=1` is the WORST setting: 11.772 vs 11.066 | `regression-sweep.js` |
| **Using only this season's data, rebuilt weekly** | Worse than the blend in EVERY bucket and far worse than the market. Even at weeks 14-18 with thirteen games in hand: this-year-only 13.476, blend 12.102, market 10.122 | `regression-sweep.js` |
| Line movement at a live price | 48.1% following, 51.9% fading — both noise | `fade-the-move.js` |
| **An EPA-per-play model** (nflverse play-by-play, opponent-blended, scale fitted on 2023 and tested on 2024-25) | **0.67 points better than the points model** — 10.405 MAE against 11.07 — and still loses to the closing line at 9.807 and even the opening line at 9.939. Kill criterion met: no bet in it as a game-predictor | `epa-build.js`, `epa-test.js` |
| Using a model to PREDICT the line movement, then betting the opener | Fails, and only visibly so once the right baseline is used. Lines drift **+0.228 pts toward home** open-to-close, so raw CLV flatters anything home-leaning and the model leans home 56.6% of the time. Against backing home at every opener, the EXCESS CLV is negative in every bucket, and at 6+ points of disagreement it is −1.000 with a 28.6% win rate — the model's strongest opinions are its worst | `epa-test.js` |
| Backing home at every opener (the drift itself) | +0.228 CLV, which is below the ~0.25 needed to clear the vig, and the win rate is 49.0% | `epa-test.js`, `frozen-test.js` |

**The one live candidate:** fading a team starting a backup QB. 59.2% on 201 bets
(2.61 SD), and 58.4% vs the move's 37.7% on the 77 games where the two disagree.
Fails the season gate (2023 48.3%, 2024 63.9%, 2025 63.7%) and **cannot be
settled** — ESPN carries no opening lines before late 2023, so 2019-2022 harvest
zero rows. Surfaced on the card with its record attached, deliberately not scored.

### Three gates for any new signal
A 2-SD cell is guaranteed at this much slicing. A signal counts only if it
(1) appears in BOTH movement buckets, (2) holds direction every season without
decaying, and (3) clears 2.5 SD. The first version of `increment-test.js` omitted
the third and printed "divisional game" as a survivor at 1.26 SD.

---

## Why the card is all underdogs (asked many times; the answer below is the right one)

**Not the push rule.** With pushes refunded it is still 11 dogs / 4 favourites,
identical. An earlier explanation blamed the push and was wrong.

The sheet's whole numbers are the market **rounded away from zero** — measured
16 up against 2 down over two weeks, and re-measured every week by
`detectPoolRounding`, which abstains if it ever flips. So:

- dog's gap = **0.5** + movement toward the dog
- favourite's gap = movement toward the favourite − **0.5**

A dog needs 0.5 of movement to reach a full point of edge; a favourite needs 1.5.
Three times as far, so it clears less often. Pure arithmetic on the sheet.

Backing big stale dogs is also the *best* bucket in the data — 68.6% at 7-9.5
(n=35), above break-even in all three seasons — though thin at 2.2 SD.

---

## What the app does NOT score (this is deliberate, and measured)

`reach.js` perturbs every input and reports whether the answer moves. QB, weather,
injuries, travel, form and the efficiency projection all move **nothing** about
which side is picked. They drive the projected score and the write-up.

The reason is in the comment above the depth-chart fetcher, written long before
any of the tests: *a QB injury that is public is already in the market price, so
adding our own adjustment on top of a market-anchored model would count it
twice.* The market move **is** the news.

**The general principle, and the answer to "but travel and rest obviously matter
to humans".** They do. They matter to the players and they are already in the
line, so there is nothing left to win. A factor only becomes an edge if the market
MIS-prices it, and the better known a factor is, the more thoroughly it is priced.
Past a point it is over-priced: the famous west-coast-early-kickoff effect has the
travelling team beating the line, not losing to it. Anything that can be looked up
has been looked up by three hundred people with money on it.

This is why the one thing that works is not a fact about football at all. It is a
fact about a PRICE: holding a number the market has moved away from.

**The famous effects have their point estimates BACKWARDS.** Three times now:
the west-coast early kickoff (the travelling team beat the line), NBA fatigue on
the total (it went up, not down), and the public-money bucket in football (the
most profitable to follow, not fade). Well known does not mean priced -- it means
slightly over-priced, because everybody has heard of it.

**And the sharpest form of it: REACTING to movement works, ANTICIPATING it does
not.** Backing the side the market moved toward, at a number it has left behind,
is 67.9% on four-point moves. Trying to guess which way it will move next and bet
the opener ahead of it fails at every threshold, and fails worst where the model
is most confident. You cannot front-run the market. You can hold a number it
walked away from.

`MODEL_TRUST = 0.1`. Every pricing decision is 90% market, 10% projection. The
displayed score is the blend, not the raw model — showing the raw 10% is what made
Kansas City at Miami read 17-16 against a market of 47.

---

## Other sports: measured, not guessed

The non-football sigmas were all placeholders, and model.js said so. Measured
with `calibrate-sport.js`, which uses ESPN only and caches, so re-running costs
nothing.

**NBA** — 1,231 completed 2025-26 games. sigma 11.5 -> 11.97, totalSigma
15.0 -> **18.5** (the one that mattered: at 15.0 the model put a 20-point total
miss at 8.1% against a real 13.6%), hfa 2.5 -> **1.75**. Fit both sigmas THROUGH
the functions that consume them, at half-point offsets, because every NBA line
sits on a half point and all 1,231 residuals did too. Fitting against a normal
first gave 13.01, which is wrong by a point. The stale-line rule transfers and is
**stronger than football**: 62.1% at 2+ points, n=435, 5.03 SD, all seven months
positive. Back-to-backs and rest are fully priced (`nba-rest.js`).

**NHL** — 1,312 completed games, and the sigma was the least of it. **The SHAPE
was wrong.** Hockey has had no ties since 2005 and a normal puts 14.2% of its
mass on a 0-goal margin; overtime makes every extra-time game a one-goal game, so
43.2% of the season ends by one; and three-goal margins beat two-goal ones, 23.1%
to 17.5%, because a team trailing by one pulls its goalie. Before counting, the
BEST POSSIBLE sigma still missed "win by one or more" by 7.5 points. With
`NHL_MARGIN_WEIGHTS` the worst miss is 2.2. sigma 2.2 -> 2.94, hfa 0.25 -> 0.13,
totalSigma 2.4 -> 2.31 (already near right).

**A FIXED SPREAD CANNOT GO STALE, and the harness reported a five-sigma edge
before it was taught that.** ESPN carries only -1.5 and +1.5 for hockey across
all 1,312 games, so the only possible "move" is the favourite flipping sides —
and when the market moves toward a team, that team is the one that was getting
+1.5 at the open, in **118 of 118 cases, by construction**. The rule scored 72.9%
at 4.97 SD against a base rate of **73.3% for any +1.5 ticket**: slightly worse
than doing nothing, wearing five sigma. `calibrate-sport.js` now detects a fixed
spread and says so. The moneyline and the total are the live markets in hockey;
only two closing totals exist all season, 6.5 and 5.5.

**MLB is still a guess** — sigma 4.4 and totalSigma 4.4 are untouched, and
baseball deliberately keeps the plain normal until it is measured.

## Why no model built on team performance can be precise

**A team's own record is about 75% noise over half a season.** Measured across 861
team-seasons of nflverse: the correlation between first-half and second-half point
differential is r = 0.498, so r-squared = 0.248. Only a quarter of what a team has
done so far carries into what it does next.

That single number explains most of this file:

- why "use only this season, it is the most relevant data" is backwards — one
  season is 16 games of a high-variance thing, and the problem is sample size, not
  staleness. Last season regressed is another 17 games of evidence and adds more
  signal than it costs.
- why turning the model's confidence up makes it worse.
- why the market's number beats every model here: it aggregates far more than team
  scoring.
- and why single games sit near a coin flip against a fair line. That is football,
  not a defect in the app. It is also why a 2-point stale number is worth 55% and
  not 70% — small edges are the only kind that can exist on top of something this
  noisy.

**Where "this year only" IS correct, and is already done:** the pool's own
behaviour. Which way the sheet rounds, how big the gaps run, how the poster
behaves — there is no prior season to borrow from and a different person would
behave differently. `detectPoolRounding` re-measures it every week.

## The honest ceiling

| | per week | once in 17 weeks |
|---|---|---|
| pure coin flips | 1.56% | 23% |
| a real card | ~2.1% | 31% |
| a 57% handicapper on all six | 3.43% | 45% |

57% per pick means being **2.5 points better than the closing line**, every week.
Our projection is 1.45 points worse than it. Sustained 57-60% on NFL sides does
not exist; real professionals run 53-55%.

**The Pick 6 is a lottery ticket the app makes marginally better. The money is in
the book-price edge** — shop every book, take the best number, no prediction
required. `bestOffer` in `model.js` already prices every book's point and juice.
It has been dark all season because the quota ran out.

---

## Known dark / open

- **The paid odds feed.** Free tier is 500/month and was 498 spent by the 26th, so
  `myBook` is null, every verdict reads "No lean" and `spreadPick` "No edge".
  Quota now persists in `api_quota` and `ODDS_QUOTA_RESERVE` (12) is never spent
  automatically. **A paid tier is the highest-value change available to this app.**
- **Two entries** would double the chance of winning *a* week but does nothing for
  the best single card. Only Danny knows the pool rules.
- The card is naturally contrarian (dogs, by the rounding) and the prize splits
  among winners, so 6-0 weeks have fewer co-winners. Real EV nobody counts. Do
  not "fix" the dog lean — it is an accidental asset.

---

## The failure pattern — every bug this week was one of these

1. **Built, then shadowed or never read.** A duplicate `getClvStats` sat 4,200
   lines above the live one with a different return shape; editing it would have
   changed nothing, silently. `injuriesOutHome` was an argument and never a field.
   Prediction games had no `id`, so a join matched on team names and found nothing.
2. **A comment stating the rule, and code doing the opposite.** `getClvStats`
   averaged pool entries with live recommendations directly beneath a comment
   saying that describes neither.
3. **A filter deciding something it has no business deciding.** `minGames` gated
   who gets a rating *and* what the league average is, so in week 3 two teams set
   the scoring baseline for the league and every projection was ~8 points low.
4. **`Number(null) === 0` and `Number.isFinite(0) === true`.** Found three times
   in this file: blank pool boxes read as a real line of 0, and "Over 0" once
   ranked top of Best 6. Reject empties *before* coercing.
5. **Failing closed looks like an answer.** `detectPoolRounding` counted market
   movement as a rounding failure, so it lost confidence exactly when the
   reconstruction mattered most.
6. **A check that agrees with itself.** A uniform perturbation reported the
   headwind tiebreak as dead, because you cannot test an ordering by moving every
   item equally.

**So: grade a checker against known defects before believing a clean run, and
perturb an input to see whether it changes the answer rather than grepping for
its name.**

---

## Conventions

- `model.js` is pure. No network, no database, no Express. Everything testable.
- Every measured result lives in the header of the script that produced it **and**
  in the table above. A result recorded only in a script header gets rediscovered.
- **Check the tree before concluding a file is missing.** `fade-the-move.js`,
  `stale-oos.js`, `total-pmf.js`, `solve-keys.js` and `pool-math.js` are all
  tracked and always have been. They looked deleted only because the working copy
  had lost 26 tracked files, `README.md` among them, and `git ls-files --deleted`
  is the question to ask before `git log --diff-filter=D`.
- Never push without Danny's say-so; push = deploy.
- Never spend odds-API quota casually. Check `/api/health` first — it reports
  `quotaRemaining` without spending one.

*Last updated: 26 September 2026*
