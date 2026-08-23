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
//   * `coverProbability` uses a normal distribution. Real margins are lumpy —
//     NFL margins pile up on 3 and 7 — so probabilities near key numbers are
//     wrong in a way no choice of sigma fixes. `marginDistribution` is the
//     documented seam for swapping in an empirical distribution later.
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
function priceSide({ americanOdds, oppositeAmericanOdds, modelProb, trust = 0.25, kellyFraction = 0.25 }) {
  const { probA: marketProb, hold } = deVigTwoWay(americanOdds, oppositeAmericanOdds);
  const blendedProb = blendWithMarket(marketProb, modelProb, trust);
  const decimalOdds = americanToDecimal(americanOdds);
  return {
    marketProb,
    modelProb,
    blendedProb,
    hold,
    decimalOdds,
    edge: edge({ modelProb: blendedProb, marketProb }),
    expectedValue: expectedValue({ prob: blendedProb, decimalOdds }),
    stake: kellyStake({ prob: blendedProb, decimalOdds, fraction: kellyFraction }),
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
};
