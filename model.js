'use strict';

// ============================================================================
// model.js — the actual maths
// ============================================================================
//
// Everything here is a pure function of its arguments. No network, no database,
// no Express, no Claude. That is deliberate: the reason the old numbers could
// not be trusted is that nothing was separable enough to test. Every claim this
// file makes can be checked against a hand-computed value in model.test.js.
//
// WHAT THIS REPLACES
//
// The handlers used to ask Claude for `spreadEdge`, `totalEdge` and
// `predictedScore`, then applied `edge * 0.5` as a Kelly stake. Those edges
// were never computed from anything — an LLM wrote plausible numbers and the
// sizing maths gave them a false air of rigour. Measured over 159 independent
// graded picks that approach returned 45.9%, about 1 SD below a coin flip and
// well under the 52.4% needed to break even at -110.
//
// THE CENTRAL DESIGN DECISION: THE MARKET IS THE PRIOR
//
// A de-vigged price from a liquid market is the best freely available estimate
// of a game's true probability. It already contains injuries, rest, travel,
// lineups and the opinion of everyone with money at stake. So `edge = model −
// market` is, by construction, a claim that this model knows better than that.
// A from-scratch Elo will make that claim constantly, and nearly every time it
// will be the model that is wrong.
//
// Hence `blendWithMarket`. The model does not replace the market price; it
// nudges it, by a configurable `trust` fraction that defaults to 0.25. Setting
// trust = 0 reproduces the market exactly and reports zero edge everywhere,
// which is the honest default before anything is calibrated. Raising trust is
// a deliberate act that should follow evidence — closing-line value, not a
// short-run win rate.
//
// WHAT IS NOT SOLVED HERE
//
//   * The sport constants below are published rules-of-thumb, not values fitted
//     to data. They are the first thing that should be re-estimated once enough
//     graded games exist. `calibrateSigma` is provided for exactly that.
//   * Key numbers ARE now handled for football and basketball, via a discrete
//     margin distribution with per-margin weights, which also makes pushes
//     representable. The weights themselves are still approximations rather
//     than values fitted to data — see calibrateMarginWeights.
//   * Totals now push correctly, using a FLAT discrete distribution. Whether
//     totals cluster on particular numbers the way margins do is still an open
//     empirical question, and the weights are left at 1 rather than guessed.
//   * De-vigging is proportional, which slightly overprices longshots relative
//     to Shin's method. Fine at typical spread and total prices; less fine on
//     big moneyline underdogs.

// ----------------------------------------------------------------------------
// Sport constants
// ----------------------------------------------------------------------------
// sigma       — SD of (actual margin − closing spread), in points/runs/goals
// totalSigma  — SD of (actual total − closing total)
// hfa         — home field advantage, same units
// eloPerPoint — Elo rating difference worth one point of margin
// k           — Elo update rate
//
// TREAT THESE AS PLACEHOLDERS. They are widely cited approximations, good
// enough to produce sane output and to test against, and not good enough to bet
// on. Recalibrate from your own graded results.

const SPORTS = {
  nfl: { sigma: 13.5, totalSigma: 10.5, hfa: 1.8,  eloPerPoint: 25, k: 20 },
  nba: { sigma: 11.5, totalSigma: 15.0, hfa: 2.5,  eloPerPoint: 28, k: 20 },
  mlb: { sigma: 4.4,  totalSigma: 4.4,  hfa: 0.20, eloPerPoint: 4,  k: 4  },
  nhl: { sigma: 2.2,  totalSigma: 2.4,  hfa: 0.25, eloPerPoint: 2,  k: 6  },
};

/** Kelly fractions at or below this are treated as no edge at all. */
const KELLY_EPSILON = 1e-12;

function sportConfig(sport) {
  const cfg = SPORTS[String(sport || '').toLowerCase()];
  if (!cfg) throw new Error(`Unknown sport: ${sport}`);
  return { ...cfg };
}

// ----------------------------------------------------------------------------
// Odds conversion
// ----------------------------------------------------------------------------

/** American odds -> decimal odds. -110 => 1.909..., +150 => 2.5 */
function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) throw new Error(`Bad American odds: ${american}`);
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

/** Decimal odds -> American. 2.5 => +150, 1.909... => -110 */
function decimalToAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) throw new Error(`Bad decimal odds: ${decimal}`);
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/**
 * Implied probability of a single American price, vig included.
 * -110 => 0.5238, which is the familiar 52.4% break-even line.
 */
function americanToImpliedProb(american) {
  return 1 / americanToDecimal(american);
}

// ----------------------------------------------------------------------------
// De-vigging
// ----------------------------------------------------------------------------

/**
 * Strip the bookmaker's margin from a set of raw implied probabilities.
 *
 * Raw probabilities across a market sum to more than 1; the excess is the hold.
 * Proportional (multiplicative) de-vigging divides it out pro rata. Simple,
 * standard, and easy to verify by hand — two -110 sides come back at exactly
 * 0.5 each. Its known weakness is the favourite-longshot bias: it takes too
 * much vig off longshots. Shin's method handles that better and is the natural
 * upgrade if moneyline dogs ever matter here.
 */
function removeVig(rawProbs) {
  if (!Array.isArray(rawProbs) || rawProbs.length < 2) {
    throw new Error('removeVig needs at least two probabilities');
  }
  const sum = rawProbs.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error('removeVig got non-positive total probability');
  return rawProbs.map(p => p / sum);
}

/**
 * De-vig a two-way market given both American prices.
 * Returns fair probabilities plus the hold, so a caller can compare books:
 * a lower hold is a better price before any model opinion is applied.
 */
function deVigTwoWay(americanA, americanB) {
  const rawA = americanToImpliedProb(americanA);
  const rawB = americanToImpliedProb(americanB);
  const [probA, probB] = removeVig([rawA, rawB]);
  return { probA, probB, hold: rawA + rawB - 1 };
}

// ----------------------------------------------------------------------------
// Normal distribution
// ----------------------------------------------------------------------------

/** Abramowitz & Stegun 7.1.26. Max absolute error ~1.5e-7. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * z);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return sign * y;
}

/** P(Z <= z) for a standard normal. */
function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * The seam for key numbers.
 *
 * Everything downstream asks this for P(margin > threshold). Today it answers
 * from a normal curve, which is smooth — and real football margins are not.
 * NFL results cluster hard on 3 and 7, so a normal materially misprices spreads
 * sitting on those numbers. Replacing this one function with an empirical
 * margin distribution fixes every caller at once, which is why the indirection
 * exists rather than calling normalCdf directly from the pricing functions.
 */
function marginDistribution(mean, sigma) {
  if (!(sigma > 0)) throw new Error(`sigma must be positive, got ${sigma}`);
  return {
    /** P(X > x) */
    probAbove(x) { return 1 - normalCdf((x - mean) / sigma); },
    /** P(X < x) */
    probBelow(x) { return normalCdf((x - mean) / sigma); },
  };
}

// ----------------------------------------------------------------------------
// Pricing a side from a predicted margin
// ----------------------------------------------------------------------------

/**
 * Probability the HOME side covers.
 *
 * `spread` is the home spread in the same convention the picks table uses:
 * negative means the home team is laying points. Home covers when
 * (margin + spread) > 0, i.e. margin > -spread.
 *
 * Returns a probability for the home side; the away side is 1 - that. Pushes
 * are ignored, which is exact for half-point spreads and a small distortion on
 * whole numbers — another thing an empirical distribution would handle.
 */
function coverProbability({ predictedMargin, spread, sigma }) {
  if (!Number.isFinite(predictedMargin)) throw new Error('predictedMargin must be finite');
  if (!Number.isFinite(spread)) throw new Error('spread must be finite');
  return marginDistribution(predictedMargin, sigma).probAbove(-spread);
}

/** Probability the total goes OVER `line`. */
function overProbability({ predictedTotal, line, sigma }) {
  if (!Number.isFinite(predictedTotal)) throw new Error('predictedTotal must be finite');
  if (!Number.isFinite(line)) throw new Error('line must be finite');
  return marginDistribution(predictedTotal, sigma).probAbove(line);
}

// ----------------------------------------------------------------------------
// The market anchor
// ----------------------------------------------------------------------------

/**
 * Move `trust` of the way from the market's fair probability toward the model's.
 *
 * trust = 0    -> the market, unchanged. Zero edge everywhere. The honest
 *                 default until something has been calibrated.
 * trust = 1    -> the model alone, which asserts it beats the closing line.
 * trust = 0.25 -> the shipped default: the model gets a quarter of a vote.
 *
 * This is the single most important knob in the file, and it should only be
 * raised on evidence from closing-line value, never from a short-run W/L record.
 * 159 picks cannot distinguish a real edge from noise; CLV can, in weeks.
 */
function blendWithMarket(marketProb, modelProb, trust = 0.25) {
  if (!(marketProb >= 0 && marketProb <= 1)) throw new Error('marketProb out of range');
  if (!(modelProb >= 0 && modelProb <= 1)) throw new Error('modelProb out of range');
  if (!(trust >= 0 && trust <= 1)) throw new Error('trust must be within [0,1]');
  return marketProb + trust * (modelProb - marketProb);
}

// ----------------------------------------------------------------------------
// Edge, expected value, stake
// ----------------------------------------------------------------------------

/**
 * Edge as a probability difference: how much more likely we think this is than
 * the fair price implies. Positive means value. This is the number the old code
 * invented; here it is derived.
 */
function edge({ modelProb, marketProb }) {
  return modelProb - marketProb;
}

/** Expected profit per 1 unit staked. Positive means a +EV bet. */
function expectedValue({ prob, decimalOdds }) {
  const b = decimalOdds - 1;
  return prob * b - (1 - prob);
}

/**
 * Kelly stake as a fraction of bankroll: f* = (bp - q) / b.
 *
 * `fraction` applies fractional Kelly and defaults to 0.25. Full Kelly is
 * correct only if the probability is exactly right, which it never is; with
 * estimated probabilities it is wildly over-aggressive, and the drawdowns are
 * brutal. Quarter-Kelly is the usual compromise.
 *
 * Never negative — a negative Kelly means "bet the other side", not "bet a
 * negative amount", so it clamps to zero and the caller simply passes.
 */
function kellyStake({ prob, decimalOdds, fraction = 0.25 }) {
  if (!(prob >= 0 && prob <= 1)) throw new Error('prob out of range');
  if (!(decimalOdds > 1)) throw new Error('decimalOdds must exceed 1');
  if (!(fraction > 0 && fraction <= 1)) throw new Error('fraction must be within (0,1]');
  const b = decimalOdds - 1;
  const raw = (b * prob - (1 - prob)) / b;
  // Epsilon rather than a bare `<= 0`. At exactly the break-even price the
  // arithmetic lands on ~3e-17 instead of 0, which would sneak a nonsense stake
  // past a strict zero check. Nothing here estimates probability to anywhere
  // near that precision, so any edge this small is noise and stakes nothing.
  return raw <= KELLY_EPSILON ? 0 : raw * fraction;
}

/**
 * The whole pipeline for one side of one market, in the order it should happen:
 * de-vig the price, form a model probability, blend toward the market, then
 * derive edge and stake from the blend.
 *
 * Returns every intermediate value, because a number you cannot decompose is a
 * number you cannot audit — which is exactly how the old edges got trusted.
 */
function priceSide({ americanOdds, oppositeAmericanOdds, modelProb, pushProb = 0,
                     trust = 0.25, kellyFraction = 0.25 }) {
  const { probA: marketProb, hold } = deVigTwoWay(americanOdds, oppositeAmericanOdds);
  if (!(pushProb >= 0 && pushProb < 1)) throw new Error('pushProb out of range');

  // `modelProb` is the CONDITIONAL win probability, given the bet resolves at
  // all. That is what the de-vigged market price is too: a two-way market
  // prices two payouts, and a push voids the bet rather than settling it. The
  // two are only comparable once pushes are excluded from both, so the blend
  // happens on the conditional and pushes are reintroduced afterwards.
  const blendedProb = blendWithMarket(marketProb, modelProb, trust);
  const decimalOdds = americanToDecimal(americanOdds);

  const live = 1 - pushProb;
  const pWin = blendedProb * live;
  const pLoss = (1 - blendedProb) * live;
  const b = decimalOdds - 1;

  // A push returns the stake, so it contributes nothing either way. With
  // pushProb = 0 both of these collapse to the plain two-outcome formulas.
  const ev = pWin * b - pLoss;
  const rawKelly = b > 0 ? (b * pWin - pLoss) / b : 0;

  return {
    marketProb,
    modelProb,
    blendedProb,
    pushProb,
    hold,
    decimalOdds,
    edge: edge({ modelProb: blendedProb, marketProb }),
    expectedValue: ev,
    stake: rawKelly <= KELLY_EPSILON ? 0 : rawKelly * kellyFraction,
  };
}

// ----------------------------------------------------------------------------
// Power ratings (margin-aware Elo)
// ----------------------------------------------------------------------------

/**
 * Elo where the size of a win matters, not just the result.
 *
 * The margin multiplier is the FiveThirtyEight form: log(|margin|+1) damped by
 * the rating gap, so a favourite blowing out a weak opponent moves less than an
 * underdog doing the same. Without that damping, ratings run away from strong
 * teams.
 */
function createRatings(teams, initial = 1500) {
  const ratings = {};
  for (const t of teams || []) ratings[t] = initial;
  return ratings;
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function marginMultiplier(margin, winnerRatingEdge) {
  return Math.log(Math.abs(margin) + 1) * (2.2 / (winnerRatingEdge * 0.001 + 2.2));
}

/**
 * Apply one finished game. Returns NEW ratings rather than mutating, so a
 * caller can replay a season without hidden state.
 */
function updateRatings(ratings, { home, away, homeScore, awayScore, sport = 'nfl' }) {
  const { k, hfa, eloPerPoint } = sportConfig(sport);
  const rHome = ratings[home] ?? 1500;
  const rAway = ratings[away] ?? 1500;

  // Home advantage enters as a rating bonus for the prediction only.
  const expHome = expectedScore(rHome + hfa * eloPerPoint, rAway);
  const margin = homeScore - awayScore;
  const actualHome = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;

  const winnerEdge = margin > 0
    ? (rHome + hfa * eloPerPoint) - rAway
    : rAway - (rHome + hfa * eloPerPoint);
  const mult = margin === 0 ? 1 : marginMultiplier(margin, Math.max(winnerEdge, -400));

  const delta = k * mult * (actualHome - expHome);
  return { ...ratings, [home]: rHome + delta, [away]: rAway - delta };
}

/** Convert a rating gap into an expected points margin, home perspective. */
function predictedMargin({ homeRating, awayRating, sport = 'nfl', neutralSite = false }) {
  const { eloPerPoint, hfa } = sportConfig(sport);
  return (homeRating - awayRating) / eloPerPoint + (neutralSite ? 0 : hfa);
}

// ----------------------------------------------------------------------------
// Calibration
// ----------------------------------------------------------------------------

/**
 * Re-estimate sigma from finished games: the SD of (actual margin − spread).
 *
 * This is how the placeholder constants stop being placeholders. Feed it graded
 * results and use the answer instead of the table at the top of this file.
 * Returns null below 30 samples, because a sigma fitted to a handful of games is
 * worse than the rule of thumb it would replace.
 */
function calibrateSigma(samples, minSamples = 30) {
  const errors = (samples || [])
    .filter(s => Number.isFinite(s.actualMargin) && Number.isFinite(s.spread))
    .map(s => s.actualMargin + s.spread);
  if (errors.length < minSamples) return null;
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const variance = errors.reduce((a, e) => a + (e - mean) ** 2, 0) / (errors.length - 1);
  return { sigma: Math.sqrt(variance), bias: mean, samples: errors.length };
}

/**
 * Closing line value: did we beat the number the market settled on?
 *
 * CLV is the only fast read on whether a model is doing anything. A win rate
 * needs on the order of a thousand bets to separate skill from noise; CLV says
 * something useful within weeks, because beating the closing line repeatedly is
 * itself the evidence. Positive means the line moved our way after we bet.
 */
function closingLineValue({ betSpread, closingSpread, side }) {
  if (!Number.isFinite(betSpread) || !Number.isFinite(closingSpread)) return null;
  return side === 'home' ? betSpread - closingSpread : closingSpread - betSpread;
}

// ----------------------------------------------------------------------------
// Projecting a game from scoring averages
// ----------------------------------------------------------------------------

/**
 * Project a score from each side's recent scoring averages.
 *
 * Expected home points are the average of what the home side scores and what
 * the away side concedes; expected away points are the mirror. Home advantage
 * is split across the two scores so it moves the margin by exactly `hfa`
 * without inflating the total.
 *
 * IMPORTANT LIMITATION: these averages are not opponent-adjusted. A team off a
 * soft run of fixtures looks better than it is, and this will systematically
 * misprice them. That is a real weakness and the honest reason `trust` defaults
 * low — this projection is not good enough to override a market price, only to
 * lean on it. Opponent adjustment (or the Elo path above, fed by results) is
 * the upgrade.
 */
function projectFromScoringAverages({
  homeAvgScored, homeAvgAllowed, awayAvgScored, awayAvgAllowed,
  sport, neutralSite = false,
}) {
  const nums = [homeAvgScored, homeAvgAllowed, awayAvgScored, awayAvgAllowed].map(Number);
  if (!nums.every(Number.isFinite)) return null;
  if (nums.some(n => n <= 0)) return null;      // a zero average means missing data, not a real average

  const [hs, ha, as, aa] = nums;
  const { hfa } = sportConfig(sport);
  const expHome = (hs + aa) / 2;
  const expAway = (as + ha) / 2;
  const homeEdge = neutralSite ? 0 : hfa;

  return {
    predictedHome: expHome + homeEdge / 2,
    predictedAway: expAway - homeEdge / 2,
    predictedMargin: (expHome - expAway) + homeEdge,
    predictedTotal: expHome + expAway,
  };
}

/**
 * Bucket an edge into the Low/Medium/High label the UI and picks table use.
 * Derived from the number rather than asserted by a language model.
 */
function confidenceFromEdge(edgeValue) {
  const e = Math.abs(edgeValue);
  if (e >= 0.04) return 'High';
  if (e >= 0.02) return 'Medium';
  return 'Low';
}

// ----------------------------------------------------------------------------
// Pricing a whole game
// ----------------------------------------------------------------------------

const DEFAULT_PRICE = -110;

function bestSide(a, b) {
  // Only one side of a two-way market can be +EV once the vig is removed, but
  // guard anyway and never return a side that is not worth betting.
  const candidates = [a, b].filter(x => x && x.expectedValue > 0 && x.stake > 0);
  if (!candidates.length) return null;
  return candidates.reduce((best, x) => (x.expectedValue > best.expectedValue ? x : best));
}

/**
 * Price both markets for one game and return only the sides worth backing.
 *
 * Returns `{ spread, total }`, each either a priced side or null. Null means
 * exactly what it says: after de-vigging and blending toward the market, no
 * side of that market clears the juice. That is the common and correct answer,
 * and the old code had no way to express it — it always produced a pick.
 */
function priceGame({
  sport, predictedMargin, predictedTotal,
  spread, spreadHomePrice, spreadAwayPrice,
  total, overPrice, underPrice,
  homeTeam = 'Home', awayTeam = 'Away',
  trust = 0.25, kellyFraction = 0.25,
}) {
  const cfg = sportConfig(sport);
  const out = { spread: null, total: null };

  if (Number.isFinite(spread) && Number.isFinite(predictedMargin)) {
    const hp = Number.isFinite(spreadHomePrice) ? spreadHomePrice : DEFAULT_PRICE;
    const ap = Number.isFinite(spreadAwayPrice) ? spreadAwayPrice : DEFAULT_PRICE;
    // Win/push/loss rather than a bare cover probability, so a whole-number
    // spread can push. Both sides share the same push chance.
    const outcomes = coverOutcomes({ predictedMargin, spread, sigma: cfg.sigma, sport });
    const resolved = outcomes.win + outcomes.loss;
    const homeProb = resolved > 0 ? outcomes.win / resolved : 0.5;
    const pushProb = outcomes.push;

    const home = { ...priceSide({ americanOdds: hp, oppositeAmericanOdds: ap, modelProb: homeProb, pushProb, trust, kellyFraction }),
                   side: 'home', line: spread, pick: `${homeTeam} ${spread > 0 ? '+' : ''}${spread}` };
    const away = { ...priceSide({ americanOdds: ap, oppositeAmericanOdds: hp, modelProb: 1 - homeProb, pushProb, trust, kellyFraction }),
                   side: 'away', line: -spread, pick: `${awayTeam} ${-spread > 0 ? '+' : ''}${-spread}` };

    const winner = bestSide(home, away);
    if (winner) out.spread = { ...winner, confidence: confidenceFromEdge(winner.edge) };
  }

  if (Number.isFinite(total) && Number.isFinite(predictedTotal)) {
    const op = Number.isFinite(overPrice) ? overPrice : DEFAULT_PRICE;
    const up = Number.isFinite(underPrice) ? underPrice : DEFAULT_PRICE;
    // Over/push/under, so a whole-number total can push. Both sides share it.
    const tOut = totalOutcomes({ predictedTotal, line: total, sigma: cfg.totalSigma });
    const tResolved = tOut.over + tOut.under;
    const overProb = tResolved > 0 ? tOut.over / tResolved : 0.5;
    const totalPush = tOut.push;

    const over = { ...priceSide({ americanOdds: op, oppositeAmericanOdds: up, modelProb: overProb, pushProb: totalPush, trust, kellyFraction }),
                   side: 'over', line: total, pick: `Over ${total}` };
    const under = { ...priceSide({ americanOdds: up, oppositeAmericanOdds: op, modelProb: 1 - overProb, pushProb: totalPush, trust, kellyFraction }),
                    side: 'under', line: total, pick: `Under ${total}` };

    const winner = bestSide(over, under);
    if (winner) out.total = { ...winner, confidence: confidenceFromEdge(winner.edge) };
  }

  return out;
}

// ----------------------------------------------------------------------------
// Sanity gate for scraped lines
// ----------------------------------------------------------------------------

/**
 * Largest credible spread per sport, in that sport's own units.
 * Baseball and hockey effectively only ever post 1.5 (occasionally 2.5).
 */
const SPREAD_LIMITS = { nfl: 30, nba: 30, mlb: 2.5, nhl: 2.5 };

/**
 * Is this a line a book could actually have posted?
 *
 * The ESPN line scrape pattern-matches numeric tokens positionally and, for
 * spreads, gets it wrong: it reported a constant openSpread of -8 for every MLB
 * game, -9 for every NHL game and -10 for every NBA game, plus current spreads
 * of 0 and -3 on runlines that are always 1.5. Totals and moneylines from the
 * same scrape are fine.
 *
 * A wrong closing line is worse than a missing one, because it still looks like
 * a measurement — it would quietly poison the one statistic meant to tell us
 * whether the model works. So anything failing this check is dropped rather
 * than stored, and the rejection is counted so a silently degrading scraper
 * shows up in the logs instead of in the numbers.
 */
function plausibleSpread(sport, value) {
  // Reject empties before Number(): Number(null) and Number('') are both 0, and
  // 0 is a legitimate pick-em spread in football and basketball. Exactly the
  // trap parseScore fell into with scores, so it is guarded the same way here.
  if (value === null || value === undefined || value === '') return false;
  const v = Number(value);
  if (!Number.isFinite(v)) return false;
  const limit = SPREAD_LIMITS[String(sport || '').toLowerCase()];
  if (!limit) return false;
  if (Math.abs(v) > limit) return false;
  // Every posted spread is a multiple of a half point.
  if (Math.abs(v * 2 - Math.round(v * 2)) > 1e-9) return false;
  // Baseball and hockey do not post a pick-em run line or puck line.
  const s = String(sport).toLowerCase();
  if ((s === 'mlb' || s === 'nhl') && v === 0) return false;
  return true;
}

// ----------------------------------------------------------------------------
// Key numbers and pushes
// ----------------------------------------------------------------------------

/**
 * Relative weight of each absolute NFL margin against a smooth curve.
 *
 * NFL margins are not smoothly distributed. Scoring comes in 3s and 7s, so
 * final margins pile up on 3 and 7 far above what any normal distribution
 * predicts, with smaller bumps on 6, 10 and 14 and troughs either side. A
 * normal curve therefore misprices exactly the spreads that occur most often —
 * and -3 is the single most common line in the sport.
 *
 * TREAT THESE AS APPROXIMATIONS. They are the widely reported shape of the
 * margin distribution, not values fitted to a specific dataset, and they are
 * the second thing (after sigma) that should be re-estimated from real results.
 * calibrateMarginWeights exists for that. What matters more than the exact
 * numbers is that the mechanism is here at all: a smooth curve cannot represent
 * a spike no matter how sigma is chosen.
 *
 * Anything not listed weighs 1, i.e. the smooth curve is left alone.
 */
const NFL_KEY_NUMBER_WEIGHTS = {
  0: 0.45,   // ties are rare and only possible after overtime
  1: 0.90,
  2: 0.90,
  3: 2.05,   // by far the most common margin: one field goal
  4: 1.10,
  5: 0.85,
  6: 1.20,
  7: 1.60,   // touchdown and extra point
  8: 0.90,
  9: 0.85,
  10: 1.25,  // touchdown plus field goal
  11: 0.90,
  13: 0.95,
  14: 1.20,  // two touchdowns
  17: 1.10,
  20: 1.05,
  21: 1.05,
};

/** Sports whose margins are integers, so a whole-number line can push. */
const DISCRETE_MARGIN_SPORTS = new Set(['nfl', 'nba']);

/**
 * Probability of each integer margin, as a Map from margin to probability.
 *
 * A normal density evaluated at each integer, multiplied by the key-number
 * weight for that margin, then renormalised so the whole thing sums to 1.
 * Weighting a density and renormalising keeps the mean close to `mean` without
 * pretending the shape is smooth.
 *
 * Only NFL supplies weights. Basketball uses this too, with flat weights: its
 * key numbers are weak, but its margins are still integers and its spreads are
 * often whole numbers, so it needs pushes represented even where the shape is
 * unremarkable. Baseball and hockey never come here — run lines and puck lines
 * are 1.5, so they cannot push and a continuous curve is fine.
 */
function buildIntegerPmf({ mean, sigma, lo, hi, weightFor }) {
  if (!(sigma > 0)) throw new Error(`sigma must be positive, got ${sigma}`);
  const pmf = new Map();
  let total = 0;
  for (let v = lo; v <= hi; v++) {
    const z = (v - mean) / sigma;
    const w = weightFor ? weightFor(v) : 1;
    const p = Math.exp(-0.5 * z * z) * w;
    pmf.set(v, p);
    total += p;
  }
  if (!(total > 0)) throw new Error('degenerate distribution');
  for (const [v, p] of pmf) pmf.set(v, p / total);
  return pmf;
}

function marginPmf({ mean, sigma, sport, maxMargin = 70 }) {
  const key = String(sport || '').toLowerCase();
  const weights = key === 'nfl' ? NFL_KEY_NUMBER_WEIGHTS : {};
  return buildIntegerPmf({
    mean, sigma, lo: -maxMargin, hi: maxMargin,
    weightFor: (m) => Object.prototype.hasOwnProperty.call(weights, Math.abs(m))
      ? weights[Math.abs(m)] : 1,
  });
}

/**
 * Probability of each integer combined score.
 *
 * Deliberately FLAT — no key-number weights. That is not an oversight, it is
 * the line between what can be justified and what would be invented. Final
 * totals are integers in all four sports, which is arithmetic and needs no
 * data; whether they cluster on particular numbers is an empirical claim, and a
 * total is a sum of two teams' scores so any clustering is far weaker and more
 * diffuse than it is for margins. Asserting a shape here without measuring it
 * would be exactly the kind of confident invention this rewrite exists to
 * remove. calibrateMarginWeights can be pointed at totals when there is enough
 * history to say something.
 *
 * Integrality alone is what makes pushes representable, and pushes were the
 * actual error.
 */
function totalPmf({ mean, sigma }) {
  const lo = Math.max(0, Math.floor(mean - 6 * sigma));
  const hi = Math.ceil(mean + 6 * sigma);
  return buildIntegerPmf({ mean, sigma, lo, hi });
}

/**
 * Win, push and loss probabilities for the HOME side of a spread.
 *
 * `spread` is the home spread. Home covers when margin + spread > 0, pushes
 * when it is exactly 0, and loses otherwise. The push branch is the point of
 * this function: a -3 in the NFL lands exactly on 3 often enough to matter, the
 * stake comes back, and treating that as a loss understates every whole-number
 * bet. coverProbability, kept for the continuous case, has no way to say it.
 *
 * Falls back to the smooth curve for sports whose lines cannot push.
 */
function coverOutcomes({ predictedMargin, spread, sigma, sport }) {
  if (!Number.isFinite(predictedMargin)) throw new Error('predictedMargin must be finite');
  if (!Number.isFinite(spread)) throw new Error('spread must be finite');
  const key = String(sport || '').toLowerCase();

  if (!DISCRETE_MARGIN_SPORTS.has(key)) {
    const win = coverProbability({ predictedMargin, spread, sigma });
    return { win, push: 0, loss: 1 - win };
  }

  const pmf = marginPmf({ mean: predictedMargin, sigma, sport: key });
  const threshold = -spread;            // home covers when margin > -spread
  let win = 0, push = 0;
  for (const [m, p] of pmf) {
    if (m > threshold) win += p;
    else if (m === threshold) push += p;
  }
  return { win, push, loss: Math.max(0, 1 - win - push) };
}

/**
 * Over, push and under probabilities for a total.
 *
 * A whole-number total can land exactly on the line and return the stake. Every
 * version of this code treated that as a loss, which understated every
 * whole-number total bet — and the error is larger here than on spreads,
 * because totals sigma is small in the low-scoring sports. A baseball total of
 * 9 at sigma 4.4 pushes roughly one time in eleven.
 *
 * Half-point lines cannot push and fall out of the arithmetic at zero without
 * needing a special case.
 */
function totalOutcomes({ predictedTotal, line, sigma }) {
  if (!Number.isFinite(predictedTotal)) throw new Error('predictedTotal must be finite');
  if (!Number.isFinite(line)) throw new Error('line must be finite');
  const pmf = totalPmf({ mean: predictedTotal, sigma });
  let over = 0, push = 0;
  for (const [v, p] of pmf) {
    if (v > line) over += p;
    else if (v === line) push += p;
  }
  return { over, push, under: Math.max(0, 1 - over - push) };
}

/**
 * Re-estimate the key-number weights from finished games.
 *
 * Counts how often each absolute margin occurred and compares it with what a
 * normal of the same spread would have produced, which is exactly the ratio the
 * table above holds. Returns null below 500 games: key numbers are a claim
 * about the tail shape of a distribution, and a few dozen results cannot
 * support one.
 */
function calibrateMarginWeights(margins, sigma, minSamples = 500) {
  const values = (margins || []).map(Number).filter(Number.isFinite);
  if (values.length < minSamples) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  const observed = new Map();
  for (const m of values) {
    const k = Math.abs(Math.round(m));
    observed.set(k, (observed.get(k) || 0) + 1);
  }
  const flat = marginPmf({ mean, sigma, sport: 'other' });
  const expected = new Map();
  for (const [m, p] of flat) {
    const k = Math.abs(m);
    expected.set(k, (expected.get(k) || 0) + p);
  }

  const weights = {};
  for (const [k, count] of observed) {
    const exp = expected.get(k);
    if (exp && exp > 0) weights[k] = +((count / values.length) / exp).toFixed(3);
  }
  return { weights, samples: values.length, mean: +mean.toFixed(3) };
}

// ----------------------------------------------------------------------------
// Opponent-adjusted ratings
// ----------------------------------------------------------------------------

/**
 * Split each team into an offensive and defensive rating, adjusted for who it
 * actually played.
 *
 * Raw scoring averages are the projection's weakness and it is measurable: over
 * 96 NFL games those averages disagreed with the closing line by 3.1 points on
 * average and leaned toward the underdog 72 percent of the time. That lean is
 * the signature of no opponent adjustment. A team off a soft run looks strong
 * and a team off a brutal one looks weak, the market already knows the
 * schedule, so the model systematically disbelieves good favourites.
 *
 * The method is the standard multiplicative one. A team that scored 30 against
 * a defence allowing 17 in a league averaging 22 did better than one that
 * scored 30 against a defence allowing 28. Each game is therefore rescaled by
 * the opponent's rating relative to league average, and the whole thing is
 * iterated a few times so an opponent's own strength is itself adjusted.
 *
 *   O*_i = mean over games of ( scored  * L / D*_opponent )
 *   D*_i = mean over games of ( allowed * L / O*_opponent )
 *
 * Ratings are in points per game, so a team with O* of 26 in a 22-point league
 * is an above-average offence. Expected score against a given opponent is
 * O*_team * D*_opponent / L.
 *
 * `logs` is { team: [{ opponent, scored, allowed }] }. Teams with fewer than
 * minGames are dropped rather than rated on noise.
 */
function opponentAdjustedRatings(logs, { iterations = 3, minGames = 3 } = {}) {
  const teams = Object.keys(logs || {}).filter(t => (logs[t] || []).length >= minGames);
  if (teams.length < 2) return null;

  let scored = 0, games = 0;
  for (const t of teams) {
    for (const g of logs[t]) {
      if (!Number.isFinite(g.scored) || !Number.isFinite(g.allowed)) continue;
      scored += g.scored;
      games += 1;
    }
  }
  if (!games) return null;
  const leagueAvg = scored / games;
  if (!(leagueAvg > 0)) return null;

  // Start from raw averages.
  const off = {}, def = {};
  for (const t of teams) {
    const gs = logs[t].filter(g => Number.isFinite(g.scored) && Number.isFinite(g.allowed));
    off[t] = gs.reduce((a, g) => a + g.scored, 0) / gs.length;
    def[t] = gs.reduce((a, g) => a + g.allowed, 0) / gs.length;
  }

  for (let it = 0; it < iterations; it++) {
    const nextOff = {}, nextDef = {};
    for (const t of teams) {
      const gs = logs[t].filter(g => Number.isFinite(g.scored) && Number.isFinite(g.allowed));
      let o = 0, d = 0, n = 0;
      for (const g of gs) {
        // An opponent outside the rated set contributes at league average,
        // which is the same as no adjustment for that game.
        const oppDef = def[g.opponent] || leagueAvg;
        const oppOff = off[g.opponent] || leagueAvg;
        o += g.scored * (leagueAvg / oppDef);
        d += g.allowed * (leagueAvg / oppOff);
        n++;
      }
      if (!n) continue;
      nextOff[t] = o / n;
      nextDef[t] = d / n;
    }
    for (const t of teams) {
      if (nextOff[t] !== undefined) off[t] = nextOff[t];
      if (nextDef[t] !== undefined) def[t] = nextDef[t];
    }
  }

  const ratings = {};
  for (const t of teams) ratings[t] = { offense: off[t], defense: def[t], games: logs[t].length };
  return { leagueAvg, ratings };
}

/**
 * Project a game from opponent-adjusted ratings.
 *
 * Same home-advantage handling as projectFromScoringAverages: split across the
 * two scores so it moves the margin by exactly hfa without inflating the total.
 */
function projectFromRatings({ homeOff, homeDef, awayOff, awayDef, leagueAvg, sport, neutralSite = false }) {
  const nums = [homeOff, homeDef, awayOff, awayDef, leagueAvg].map(Number);
  if (!nums.every(Number.isFinite)) return null;
  if (nums.some(n => n <= 0)) return null;
  const [ho, hd, ao, ad, L] = nums;
  const { hfa } = sportConfig(sport);

  const expHome = (ho * ad) / L;
  const expAway = (ao * hd) / L;
  const homeEdge = neutralSite ? 0 : hfa;

  return {
    predictedHome: expHome + homeEdge / 2,
    predictedAway: expAway - homeEdge / 2,
    predictedMargin: (expHome - expAway) + homeEdge,
    predictedTotal: expHome + expAway,
  };
}

/**
 * Pull ratings toward league average.
 *
 * Two uses. Early in a season a handful of games is mostly noise, so ratings
 * are regressed toward the mean by an amount that shrinks as games accumulate.
 * And carrying last season's ratings into week 1 requires regressing them hard,
 * because rosters change: a full-strength carryover would state last year's
 * table with this year's confidence.
 */
function regressRatings(rated, weight) {
  if (!rated || !rated.ratings) return rated;
  if (!(weight >= 0 && weight <= 1)) throw new Error('weight must be within [0,1]');
  const L = rated.leagueAvg;
  const out = {};
  for (const [team, r] of Object.entries(rated.ratings)) {
    out[team] = {
      offense: L + weight * (r.offense - L),
      defense: L + weight * (r.defense - L),
      games: r.games,
    };
  }
  return { leagueAvg: L, ratings: out };
}

module.exports = {
  SPORTS,
  sportConfig,
  americanToDecimal,
  decimalToAmerican,
  americanToImpliedProb,
  removeVig,
  deVigTwoWay,
  erf,
  normalCdf,
  marginDistribution,
  coverProbability,
  overProbability,
  blendWithMarket,
  edge,
  expectedValue,
  kellyStake,
  priceSide,
  createRatings,
  expectedScore,
  updateRatings,
  predictedMargin,
  calibrateSigma,
  closingLineValue,
  projectFromScoringAverages,
  confidenceFromEdge,
  priceGame,
  SPREAD_LIMITS,
  plausibleSpread,
  NFL_KEY_NUMBER_WEIGHTS,
  buildIntegerPmf,
  marginPmf,
  totalPmf,
  coverOutcomes,
  totalOutcomes,
  opponentAdjustedRatings,
  projectFromRatings,
  regressRatings,
  calibrateMarginWeights,
};
