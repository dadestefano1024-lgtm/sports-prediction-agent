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
// fixedSpread — the spread is 1.5 by convention no matter who is playing,
//               so the NUMBER carries no information about expected margin and
//               the price alongside it carries all of it. Run lines and puck
//               lines are the two. Anything that reads a spread as the market's
//               estimate of the result has to skip these.
//
// TREAT THESE AS PLACEHOLDERS. They are widely cited approximations, good
// enough to produce sane output and to test against, and not good enough to bet
// on. Recalibrate from your own graded results.

const SPORTS = {
  nfl: { sigma: 13.5, totalSigma: 10.5, hfa: 1.8,  eloPerPoint: 25, k: 20 },
  nba: { sigma: 11.5, totalSigma: 15.0, hfa: 2.5,  eloPerPoint: 28, k: 20 },
  mlb: { sigma: 4.4,  totalSigma: 4.4,  hfa: 0.20, eloPerPoint: 4,  k: 4,  fixedSpread: true },
  nhl: { sigma: 2.2,  totalSigma: 2.4,  hfa: 0.25, eloPerPoint: 2,  k: 6,  fixedSpread: true },
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
// Cross-market pricing
// ----------------------------------------------------------------------------

/**
 * Inverse normal CDF, by bisection on normalCdf.
 *
 * Bisection rather than one of the rational approximations because normalCdf is
 * already here and already tested, so this inherits its correctness instead of
 * introducing a second approximation with its own error to characterise. It
 * also inherits its accuracy: A&S 7.1.26 is good to about 1.5e-7, so this is
 * too, which is several orders of magnitude finer than any betting price.
 */
function normalInv(p) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error(`normalInv needs a probability strictly between 0 and 1, got ${p}`);
  }
  let lo = -12, hi = 12;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * What margin the MONEYLINE thinks the game will be won by.
 *
 * Baseball and hockey cannot end level, so the probability the home team wins
 * is exactly the probability the margin is above zero. That single fact makes
 * the moneyline invertible: given a spread of outcomes sigma wide, the mean
 * that produces the observed win probability is sigma * Phi-inverse(p). No
 * continuity correction, because the boundary at zero is where the symmetry
 * actually sits — a pick-em moneyline returns a mean of exactly zero, which is
 * the check that the correction would break.
 *
 * This exists because the run line carries no information in these sports. It
 * is 1.5 whoever is playing. The moneyline is the market that actually moves,
 * and it is also the deepest one, so it is the better thing to read.
 */
function marketMarginFromMoneyline({ homeML, awayML, sigma }) {
  if (!Number.isFinite(sigma) || sigma <= 0) throw new Error('sigma must be positive');
  const { probA: pHome, hold } = deVigTwoWay(homeML, awayML);
  if (!Number.isFinite(pHome) || pHome <= 0 || pHome >= 1) {
    throw new Error(`moneyline did not de-vig to a usable probability: ${pHome}`);
  }
  return { predictedMargin: sigma * normalInv(pHome), homeWinProb: pHome, hold };
}

/**
 * Price both sides of a spread from a margin and a spread of outcomes.
 *
 * Returned prices are FAIR — no vig — so they are what the bet is worth, not
 * what anyone would offer. Comparing an offered price against these is the
 * whole point, and the offered price is expected to be worse; the question is
 * by how much, and whether one side is worse by less than the other.
 */
function fairSpreadPrice({ predictedMargin, spread, sigma }) {
  const homeProb = coverProbability({ predictedMargin, spread, sigma });
  const awayProb = 1 - homeProb;
  return {
    homeProb,
    awayProb,
    homeFair: decimalToAmerican(1 / homeProb),
    awayFair: decimalToAmerican(1 / awayProb),
  };
}

/**
 * Does the run line agree with the moneyline about the same game?
 *
 * Two markets on one scoreboard describe one distribution of results. Read the
 * moneyline for where that distribution sits, and the run line has only one
 * consistent price. When the offered price is better than that, the two markets
 * disagree with each other and the cheaper one is worth taking — and this needs
 * no forecast whatsoever, only that both prices refer to the same game. That is
 * the one kind of edge available to somebody holding a single account.
 *
 * `edgePts` compares the fair probability against the RAW offered price, vig
 * included, because the vig is paid. A positive number is what is left after
 * paying it. `disagreementPts` compares the two markets after de-vigging both,
 * which says whether they differ at all, separately from whether the difference
 * survives the cost of betting.
 *
 * Everything depends on sigma being right, and a wrong sigma tips EVERY game
 * the same way — see calibrateSigmaFromMarkets, and check the direction of the
 * results before believing any of them.
 */
function crossMarketEdge({
  homeML, awayML, spread, spreadHomePrice, spreadAwayPrice, sigma,
} = {}) {
  if (!Number.isFinite(spread)) return null;
  if (!Number.isFinite(spreadHomePrice) || !Number.isFinite(spreadAwayPrice)) return null;

  let anchor;
  try {
    anchor = marketMarginFromMoneyline({ homeML, awayML, sigma });
  } catch (e) {
    return null;
  }

  const fair = fairSpreadPrice({ predictedMargin: anchor.predictedMargin, spread, sigma });

  const rawHome = americanToImpliedProb(spreadHomePrice);
  const rawAway = americanToImpliedProb(spreadAwayPrice);
  const devigged = removeVig([rawHome, rawAway]);

  return {
    predictedMargin: anchor.predictedMargin,
    homeWinProb: anchor.homeWinProb,
    fairHomeProb: fair.homeProb,
    fairHomePrice: fair.homeFair,
    fairAwayPrice: fair.awayFair,
    // Percentage points left after the vig, per side.
    homeEdgePts: +((fair.homeProb - rawHome) * 100).toFixed(2),
    awayEdgePts: +((fair.awayProb - rawAway) * 100).toFixed(2),
    // How far apart the two markets are once both are stripped of vig. Signed
    // toward home: positive means the run line is cheaper on the home side than
    // the moneyline says it should be.
    disagreementPts: +((fair.homeProb - devigged[0]) * 100).toFixed(2),
    spreadHold: +((rawHome + rawAway - 1) * 100).toFixed(2),
  };
}

/**
 * Find the sigma at which the two markets agree, across a slate.
 *
 * A single game gives two equations and two unknowns, so it can always be
 * solved exactly and never disagrees with itself — which would make every game
 * look fairly priced. Fitting ONE sigma across many games removes that freedom:
 * the sigma that reconciles the slate as a whole is the market's own view of
 * how spread out results are, and the games that still disagree afterwards are
 * the ones worth looking at.
 *
 * Returns the fitted sigma along with the residual spread, because a fit whose
 * residuals are all one sign is a fit that has gone wrong rather than a slate
 * full of edges.
 */
function calibrateSigmaFromMarkets(games, { lo = 0.5, hi = 12, steps = 400 } = {}) {
  const usable = (games || []).filter(g =>
    Number.isFinite(g.spread) && Number.isFinite(g.spreadHomePrice) &&
    Number.isFinite(g.spreadAwayPrice) && Number.isFinite(g.homeML) && Number.isFinite(g.awayML));
  if (usable.length < 3) return null;

  const medianOf = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  let best = null;
  for (let i = 0; i <= steps; i++) {
    const sigma = lo + (hi - lo) * (i / steps);
    const resid = [];
    for (const g of usable) {
      const r = crossMarketEdge({ ...g, sigma });
      if (r) resid.push(r.disagreementPts);
    }
    if (resid.length < 3) continue;
    // Median absolute disagreement, so one badly priced game cannot drag the
    // fit toward itself.
    const score = medianOf(resid.map(Math.abs));
    if (!best || score < best.score) {
      best = { sigma, score, residuals: resid };
    }
  }
  if (!best) return null;

  const signed = best.residuals;
  const positive = signed.filter(x => x > 0).length;
  return {
    sigma: +best.sigma.toFixed(3),
    medianAbsDisagreementPts: +best.score.toFixed(3),
    games: signed.length,
    // If these are lopsided the fit is describing a bias, not a market.
    leaningHome: positive,
    leaningAway: signed.length - positive,
    maxDisagreementPts: +Math.max(...signed.map(Math.abs)).toFixed(2),
  };
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
  spreadQuotes, totalQuotes,
  homeTeam = 'Home', awayTeam = 'Away',
  trust = 0.25, kellyFraction = 0.25,
}) {
  const cfg = sportConfig(sport);
  const out = { spread: null, total: null };
  const sign = (n) => `${n > 0 ? '+' : ''}${n}`;

  // Per-book quotes when the caller has them, otherwise the single consensus
  // number. Each book is priced on its OWN point, because books disagree about
  // the number as often as about the price and a point is worth far more.
  if (Number.isFinite(predictedMargin)) {
    const quotes = (Array.isArray(spreadQuotes) && spreadQuotes.length)
      ? spreadQuotes
      : (Number.isFinite(spread)
        ? [{ book: null, point: spread, homePrice: spreadHomePrice, awayPrice: spreadAwayPrice }]
        : []);

    const side = (which) => bestOffer({
      quotes: quotes.map(q => ({
        book: q.book,
        point: q.point,
        price: (which === 'home' ? q.homePrice : q.awayPrice) ?? DEFAULT_PRICE,
        oppositePrice: (which === 'home' ? q.awayPrice : q.homePrice) ?? DEFAULT_PRICE,
      })),
      trust,
      kellyFraction,
      probFor: (pt) => {
        const o = coverOutcomes({ predictedMargin, spread: pt, sigma: cfg.sigma, sport });
        // The away side wins exactly when the home side does not.
        return which === 'home' ? o : { win: o.loss, push: o.push, loss: o.win };
      },
    });

    const home = side('home');
    const away = side('away');
    const withPick = [
      home && { ...home, side: 'home', line: home.point, pick: `${homeTeam} ${sign(home.point)}` },
      away && { ...away, side: 'away', line: -away.point, pick: `${awayTeam} ${sign(-away.point)}` },
    ].filter(x => x && x.expectedValue > 0 && x.stake > 0);

    if (withPick.length) {
      const winner = withPick.reduce((b, x) => (x.expectedValue > b.expectedValue ? x : b));
      out.spread = { ...winner, confidence: confidenceFromEdge(winner.edge) };
    }
  }

  if (Number.isFinite(predictedTotal)) {
    const quotes = (Array.isArray(totalQuotes) && totalQuotes.length)
      ? totalQuotes
      : (Number.isFinite(total)
        ? [{ book: null, point: total, overPrice, underPrice }]
        : []);

    const side = (which) => bestOffer({
      quotes: quotes.map(q => ({
        book: q.book,
        point: q.point,
        price: (which === 'over' ? q.overPrice : q.underPrice) ?? DEFAULT_PRICE,
        oppositePrice: (which === 'over' ? q.underPrice : q.overPrice) ?? DEFAULT_PRICE,
      })),
      trust,
      kellyFraction,
      probFor: (pt) => {
        const o = totalOutcomes({ predictedTotal, line: pt, sigma: cfg.totalSigma });
        return which === 'over'
          ? { win: o.over, push: o.push, loss: o.under }
          : { win: o.under, push: o.push, loss: o.over };
      },
    });

    const over = side('over');
    const under = side('under');
    const withPick = [
      over && { ...over, side: 'over', line: over.point, pick: `Over ${over.point}` },
      under && { ...under, side: 'under', line: under.point, pick: `Under ${under.point}` },
    ].filter(x => x && x.expectedValue > 0 && x.stake > 0);

    if (withPick.length) {
      const winner = withPick.reduce((b, x) => (x.expectedValue > b.expectedValue ? x : b));
      out.total = { ...winner, confidence: confidenceFromEdge(winner.edge) };
    }
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

/**
 * Combine last season's ratings with this season's, weighted by how much of
 * this season actually exists.
 *
 * Week 1 has no current games, so a model that needs them produces nothing at
 * all. Carrying last season forward fixes that, but a straight carryover would
 * state last year's table with this year's confidence — rosters, coaches and
 * quarterbacks change. So the prior is regressed toward league average first,
 * and then handed over progressively.
 *
 * THE WEIGHTING IS THE POINT, and it is why nothing needs switching off later.
 * Each team's own game count drives its own blend: w = games / gamesForFullWeight,
 * capped at 1. Week 1 is pure prior, by week 4 the current season carries about
 * a third, and from gamesForFullWeight onward the prior is gone entirely. The
 * handover is continuous and automatic — there is no flag to remember, and no
 * date at which behaviour jumps.
 *
 * Ratings are blended as RATIOS to their own league average rather than as raw
 * points, so a change in scoring environment between seasons does not leak in.
 * A team rated 10% above average last year stays 10% above average, expressed
 * in this season's points.
 */
function blendSeasonRatings({ prior, current, gamesForFullWeight = 8, priorRegression = 0.5 }) {
  if (!prior && !current) return null;
  if (!prior) return current;

  const regressed = regressRatings(prior, priorRegression);
  const priorAvg = regressed.leagueAvg;
  const leagueAvg = current ? current.leagueAvg : priorAvg;
  if (!(leagueAvg > 0) || !(priorAvg > 0)) return null;
  if (!(gamesForFullWeight > 0)) throw new Error('gamesForFullWeight must be positive');

  const teams = new Set([
    ...Object.keys(regressed.ratings),
    ...(current ? Object.keys(current.ratings) : []),
  ]);

  const ratings = {};
  for (const team of teams) {
    const p = regressed.ratings[team];
    const c = current && current.ratings[team];
    const games = c ? c.games : 0;
    const w = Math.min(1, games / gamesForFullWeight);

    // Ratios to each season's own league average, so scoring shifts do not leak.
    const pOff = p ? p.offense / priorAvg : 1;
    const pDef = p ? p.defense / priorAvg : 1;
    const cOff = c ? c.offense / current.leagueAvg : pOff;
    const cDef = c ? c.defense / current.leagueAvg : pDef;

    ratings[team] = {
      offense: (pOff * (1 - w) + cOff * w) * leagueAvg,
      defense: (pDef * (1 - w) + cDef * w) * leagueAvg,
      games,
      priorWeight: +(1 - w).toFixed(3),
    };
  }
  return { leagueAvg, ratings, blended: true };
}

/**
 * Price a side against every book's actual offer and keep the best.
 *
 * priceGame used to take one point and one price per side, which forced every
 * book onto a consensus number. That discards the larger half of line shopping:
 * books disagree on the POINT, not just the price, and a full point apart is
 * common. A point is worth several percent of win probability, where a price
 * difference is worth a fraction of one.
 *
 * Each quote is de-vigged against its OWN opposing price, which is the only
 * correct way to do it — two sides at different points are not a two-way market
 * and cannot be de-vigged against each other. The best offer is then whichever
 * quote produces the highest expected value, which naturally prefers a better
 * number over a better price without needing a rule about it.
 *
 * `quotes` is [{ book, point, price, oppositePrice }] and `probFor(point)`
 * returns { win, push } for that side at that number.
 */
function bestOffer({ quotes, probFor, trust = 0.25, kellyFraction = 0.25 }) {
  let best = null;
  for (const q of quotes || []) {
    if (!Number.isFinite(q.point)) continue;
    const outcome = probFor(q.point);
    if (!outcome) continue;
    const resolved = outcome.win + (outcome.loss ?? (1 - outcome.win - (outcome.push || 0)));
    const conditional = resolved > 0 ? outcome.win / resolved : 0.5;
    let priced;
    try {
      priced = priceSide({
        americanOdds: q.price,
        oppositeAmericanOdds: q.oppositePrice,
        modelProb: conditional,
        pushProb: outcome.push || 0,
        trust,
        kellyFraction,
      });
    } catch (e) { continue; }
    if (!best || priced.expectedValue > best.expectedValue) {
      best = { ...priced, point: q.point, book: q.book };
    }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Stale-line (pick-em pool) edge
// ----------------------------------------------------------------------------

/**
 * Value in a line that was set days ago and has not moved since.
 *
 * This is a different problem from the rest of this file, and a much more
 * tractable one. Everywhere else the market is the opponent: the model tries to
 * know better than the closing price, and measurably cannot. Here the market is
 * the SOURCE OF TRUTH, and the opponent is a number that stopped updating on
 * Wednesday. Beating a stale line does not require beating anybody.
 *
 * Measured over 269 NFL games of 2025: backing the side the market moved toward,
 * at the pre-move number, went 101-83 overall and 46-27 — 63 percent — when the
 * move was two points or more. Twenty-seven percent of games move that far.
 * Caveats worth keeping attached to those figures: one season, 73 games in the
 * strongest bucket, and the threshold was chosen after seeing the data.
 *
 * The method is simply to treat the market's current number as the expected
 * result and ask how the stale line prices against it. That inherits everything
 * already built and tested — key numbers, pushes, the lot — rather than
 * inventing a second way to compute a probability.
 *
 * Both spreads are HOME spreads, matching the convention used everywhere else.
 */
function poolEdge({ sport, poolSpread, marketSpread, poolTotal, marketTotal,
                    homeTeam = 'Home', awayTeam = 'Away' }) {
  const cfg = sportConfig(sport);
  const out = { spread: null, total: null };
  const sign = (n) => `${n > 0 ? '+' : ''}${n}`;

  if (Number.isFinite(poolSpread) && Number.isFinite(marketSpread)) {
    // The market expects the home side to win by -marketSpread.
    const o = coverOutcomes({
      predictedMargin: -marketSpread, spread: poolSpread, sigma: cfg.sigma, sport,
    });
    const resolved = o.win + o.loss;
    const homeProb = resolved > 0 ? o.win / resolved : 0.5;
    const backHome = homeProb >= 0.5;
    out.spread = {
      side: backHome ? 'home' : 'away',
      pick: backHome ? `${homeTeam} ${sign(poolSpread)}` : `${awayTeam} ${sign(-poolSpread)}`,
      poolLine: backHome ? poolSpread : -poolSpread,
      marketLine: backHome ? marketSpread : -marketSpread,
      // How many points of stale value the pool line is giving away.
      gap: +Math.abs(poolSpread - marketSpread).toFixed(2),
      winProb: +(backHome ? homeProb : 1 - homeProb).toFixed(4),
      pushProb: +o.push.toFixed(4),
    };
  }

  if (Number.isFinite(poolTotal) && Number.isFinite(marketTotal)) {
    const o = totalOutcomes({
      predictedTotal: marketTotal, line: poolTotal, sigma: cfg.totalSigma,
    });
    const resolved = o.over + o.under;
    const overProb = resolved > 0 ? o.over / resolved : 0.5;
    const backOver = overProb >= 0.5;
    out.total = {
      side: backOver ? 'over' : 'under',
      pick: `${backOver ? 'Over' : 'Under'} ${poolTotal}`,
      poolLine: poolTotal,
      marketLine: marketTotal,
      gap: +Math.abs(poolTotal - marketTotal).toFixed(2),
      winProb: +(backOver ? overProb : 1 - overProb).toFixed(4),
      pushProb: +o.push.toFixed(4),
    };
  }

  return out;
}

/**
 * Rank every candidate from a slate and hand back the best `count`.
 *
 * Ranked on win probability rather than the raw point gap, because a two-point
 * move across a key number is worth more than a three-point move through empty
 * space — the whole reason the discrete margin distribution exists. Ties break
 * on the gap, which is the more legible number of the two.
 */
function rankPoolPicks(candidates, count = 6) {
  return (candidates || [])
    .filter(c => c && Number.isFinite(c.winProb))
    .sort((a, b) => (b.winProb - a.winProb) || (b.gap - a.gap))
    .slice(0, count);
}

// ----------------------------------------------------------------------------
// Bet recommendation
// ----------------------------------------------------------------------------

/**
 * What to do about a game, based only on things that have been measured.
 *
 * The tempting input here is line movement, and it does not work at a live
 * price. Over 269 games of 2025, backing the side the line moved toward at the
 * CURRENT number went 90-97, or 48.1 percent; fading it went 51.9. Both sit
 * under the 52.4 needed to break even, and the two buckets that look good point
 * in opposite directions — following wins between two and three points while
 * fading wins between half and one — on about twenty games each. A real effect
 * would be directionally consistent. That is noise.
 *
 * Movement IS worth money against a line that has not moved with the market,
 * which is the pick-em pool case and is handled by poolEdge. The distinction is
 * the whole point: the same fact is an edge against a stale number and nothing
 * at all against a live one.
 *
 * So the only live input with a measured advantage is the book on offer having
 * a better NUMBER than the rest of the market. That is a fact about prices
 * rather than a forecast, and it is what this grades.
 */
function betRecommendation({ bookValuePts = 0, inProgress = false, hasLine = true,
                             bookName = 'your book', side = null } = {}) {
  if (inProgress) {
    return { level: 'pass', label: 'In progress',
             reason: 'the book is pricing the rest of the game, not the whole one' };
  }
  if (!hasLine) {
    return { level: 'pass', label: 'No line',
             reason: 'no market price available for this game yet' };
  }
  const pts = Number(bookValuePts) || 0;
  if (pts >= 1) {
    return { level: 'strong', label: 'Strong bet',
             reason: `${bookName} is ${pts} point${pts === 1 ? '' : 's'} better than the market` +
                     (side ? ` on the ${side}` : '') };
  }
  if (pts >= 0.5) {
    return { level: 'lean', label: 'Slight edge',
             reason: `${bookName} is ${pts} of a point better than the market` +
                     (side ? ` on the ${side}` : '') };
  }
  return { level: 'none', label: "Don't bet",
           reason: `${bookName} is at the market price, so there is no edge here` };
}

/**
 * Whether a game is worth checking against a frozen pool line.
 *
 * Not a recommendation about betting it live — it is a prompt to go and look at
 * whether the pool number has kept up. Two points is where the measured
 * stale-line record was strongest (46-27), so that is the threshold, with a
 * softer flag from one point.
 */
function poolCandidate(spreadMovement, totalMovement) {
  const biggest = Math.max(
    Number.isFinite(spreadMovement) ? Math.abs(spreadMovement) : 0,
    Number.isFinite(totalMovement) ? Math.abs(totalMovement) : 0);
  if (biggest >= 2) return { level: 'strong', points: +biggest.toFixed(2) };
  if (biggest >= 1) return { level: 'worth checking', points: +biggest.toFixed(2) };
  return null;
}

// ----------------------------------------------------------------------------
// Situation flags
// ----------------------------------------------------------------------------

/**
 * Where what we know and what the line shows disagree.
 *
 * Three attempts to out-predict the closing line have failed here — points,
 * yards per play and EPA all landed indistinguishable from the market. That
 * result is about knowing BETTER, and it is settled. It says nothing about
 * knowing SOONER, which is the one way public information beats a market: a
 * quarterback ruled out an hour ago is public, and the line may not have
 * finished moving.
 *
 * So this does not predict anything. It compares facts already gathered against
 * how far the line has travelled, and reports where the two do not line up. A
 * flag is a prompt to look, not a reason to bet, and the wording keeps it that
 * way — including the most useful flag of all, which is a large move with no
 * visible cause, meaning somebody knows something this app does not.
 *
 * IMPORTANT: none of this is backtested. Injury and weather timestamps are not
 * in any history available here, so the timing claim cannot be measured the way
 * the others were. These are stated as observations rather than edges precisely
 * because they are unvalidated.
 */
function situationFlags({
  spreadMovement = null, totalMovement = null,
  qbOut = null, qbOutSide = null,
  injuriesOut = 0, injuriesOutHome = 0, injuriesOutAway = 0,
  windy = false, windSpeed = null,
} = {}) {
  const flags = [];
  const spreadMoved = Number.isFinite(spreadMovement) ? Math.abs(spreadMovement) : null;
  const totalMoved = Number.isFinite(totalMovement) ? Math.abs(totalMovement) : null;

  // Every flag carries `against`: the side it is bad news FOR, or null where it
  // genuinely has no side. That field is the only thing downstream may read for
  // direction.
  //
  // The alternative was searching the prose for the words "home" and "away",
  // which quietly made Patrick Mahomes an argument for the home team and
  // matched nothing else at all. A side has to be passed in, not recovered from
  // a sentence written for a human.
  const bySide = injuriesOutHome + injuriesOutAway;
  const totalOut = bySide > 0 ? bySide : injuriesOut;

  // A quarterback is worth several points. If one is out and the number has not
  // moved, either it was priced before the line opened or it has not reacted.
  if (qbOut && spreadMoved !== null && spreadMoved < 1.5) {
    flags.push({
      type: 'qb-static-line', severity: 'high',
      against: qbOutSide === 'home' || qbOutSide === 'away' ? qbOutSide : null,
      note: `${qbOut} is out but the spread has moved only ${spreadMoved} pt. ` +
            `Either that was priced before the line opened, or the market has not finished reacting.`,
    });
  }

  // Wind is the largest weather effect on a total. It is an argument about how
  // many points get scored, not about who wins, so it has no side.
  if (windy && totalMoved !== null && totalMoved < 1.5) {
    flags.push({
      type: 'wind-static-total', severity: 'medium', against: null,
      note: `${windSpeed ? windSpeed + ' mph wind' : 'High wind'} forecast but the total has moved ` +
            `only ${totalMoved} pt. Worth checking how recent the forecast is.`,
    });
  }

  if (totalOut >= 3 && spreadMoved !== null && spreadMoved < 1) {
    // Whichever side is actually missing the players. Level, or not broken down
    // by side at all, means no side - better to say nothing than to guess.
    const against = injuriesOutHome > injuriesOutAway ? 'home'
      : injuriesOutAway > injuriesOutHome ? 'away' : null;
    flags.push({
      type: 'injuries-static-line', severity: 'medium', against,
      note: `${totalOut} players ruled out but the spread has barely moved.`,
    });
  }

  // The most useful one to read, and deliberately sideless. The move points at
  // a side, but backing that side at the CURRENT price went 90-97 across 269
  // games of 2025 - the information is already in the number being offered. It
  // is worth knowing about. It is not something to lean on.
  if (spreadMoved !== null && spreadMoved >= 2 && !qbOut && totalOut < 3) {
    flags.push({
      type: 'unexplained-move', severity: 'high', against: null,
      note: `The spread has moved ${spreadMoved} pts with no injury or quarterback reason ` +
            `visible here. Somebody is acting on something this app cannot see.`,
    });
  }

  return flags;
}

// ----------------------------------------------------------------------------
// Best available bet
// ----------------------------------------------------------------------------

/**
 * Which side of a game to take, and how much weight it deserves.
 *
 * This answers a different question from betRecommendation, and the difference
 * matters. betRecommendation answers "is there an edge here" — usually no.
 * This answers "if betting this game anyway, which side and how strongly",
 * which always has an answer and is the question actually being asked most of
 * the time.
 *
 * The grades are deliberately separated so a lean can never be mistaken for an
 * edge:
 *
 *   edge     the book's number beats the market by a full point. A price fact.
 *   slight   half a point better. Still a price fact.
 *   lean     no price advantage, but the projection and the situation point the
 *            same way. NOT an edge — the projection has been measured at 0.35
 *            points per game WORSE than the closing line, so this is a
 *            tiebreaker for someone already betting, not a reason to bet.
 *   coinflip nothing points anywhere. The honest answer for most games.
 *
 * A lean requires agreement. The projection alone is not enough to lean on,
 * because it loses to the market on its own; it only earns a mention when a
 * situation flag points the same way, or when it disagrees with the market by
 * more than a field goal, which is at least unusual enough to notice.
 */
function bestBet({
  sport, bookValuePts = 0, bookSide = null, bookPick = null,
  predictedMargin = null, marketSpread = null,
  situationFlags = [], inProgress = false,
  homeTeam = 'Home', awayTeam = 'Away',
} = {}) {
  if (inProgress) {
    return { level: 'pass', label: 'In progress', pick: null,
             reason: 'the book is pricing the rest of the game, not the whole one' };
  }

  // Runs and goals are not points, and a verdict that calls them points reads
  // like it does not know which sport it is looking at.
  const unit = sport === 'mlb' ? 'run' : sport === 'nhl' ? 'goal' : 'point';

  // A price advantage is the only thing here that is an edge.
  if (bookValuePts >= 1 && bookPick) {
    return { level: 'edge', label: 'Best bet', pick: bookPick, side: bookSide,
             reason: `the number is ${bookValuePts} ${unit}${bookValuePts === 1 ? '' : 's'} better than the market` };
  }
  if (bookValuePts >= 0.5 && bookPick) {
    return { level: 'slight', label: 'Slight edge', pick: bookPick, side: bookSide,
             reason: `the number is ${bookValuePts} of a ${unit} better than the market` };
  }

  // No price advantage. Is there anything else pointing one way?
  if (!Number.isFinite(predictedMargin) || !Number.isFinite(marketSpread)) {
    return { level: 'coinflip', label: 'No lean', pick: null,
             reason: 'not enough to separate the two sides' };
  }

  // Market's own expected margin is -marketSpread.
  const disagreement = predictedMargin - (-marketSpread);
  const leansHome = disagreement > 0;
  const size = Math.abs(disagreement);

  const cfg = SPORTS[sport] || SPORTS.nfl;

  // A run line and a puck line are 1.5 whoever is playing. That number is not
  // the market's estimate of the margin, so the projection disagreeing with it
  // measures nothing — and it disagrees in the SAME DIRECTION nearly every
  // time, because a projected baseball margin is a run or so while the line
  // stays at 1.5. Leaning on that produces "take the underdog run line" across
  // most of the slate, which is a property of the market's shape rather than
  // anything known about the teams.
  //
  // Caught by replaying a live ten-game card: six of the seven leans it
  // produced were the +1.5 side. The information in these markets sits in the
  // price next to the line, not in the line, and nothing here reads it yet.
  if (cfg.fixedSpread) {
    return { level: 'coinflip', label: 'No lean', pick: null,
             reason: `the ${sport === 'nhl' ? 'puck' : 'run'} line is 1.5 whoever is playing, ` +
                     'so there is no number here to disagree with' };
  }

  // How far the projection has to sit from the market before it is worth
  // saying. A field goal in football, and the same FRACTION of the other
  // sport's margin spread — three points of basketball being a good deal
  // less than three points of football. NFL sigma is 13.5, so the football
  // threshold is 0.22 of a standard deviation, which gives 2.5 for basketball.
  const threshold = Math.max(0.5, Math.round(cfg.sigma * (3 / SPORTS.nfl.sigma) * 2) / 2);

  // Only a flag that names the side it is against may corroborate, and a flag
  // against one side supports leaning to the OTHER - a quarterback ruled out is
  // an argument against his own team.
  const corroborated = (situationFlags || []).some(f =>
    f && (f.against === 'home' ? !leansHome
      : f.against === 'away' ? leansHome
        : false));

  if (size >= threshold || corroborated) {
    const team = leansHome ? homeTeam : awayTeam;
    const line = leansHome ? marketSpread : -marketSpread;
    return {
      level: 'lean',
      label: 'Lean',
      pick: `${team} ${line > 0 ? '+' : ''}${line}`,
      side: leansHome ? 'home' : 'away',
      reason: `the projection has this ${size.toFixed(1)} ${unit}s off the market` +
              (corroborated ? ', and the situation points the same way' : ''),
      caveat: 'this is a lean, not an edge — the projection loses to the closing line on its own',
    };
  }

  return { level: 'coinflip', label: 'No lean', pick: null,
           reason: 'the projection agrees with the market, and nothing else separates the sides' };
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
  normalInv,
  marketMarginFromMoneyline,
  fairSpreadPrice,
  crossMarketEdge,
  calibrateSigmaFromMarkets,
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
  bestOffer,
  poolEdge,
  betRecommendation,
  situationFlags,
  bestBet,
  poolCandidate,
  rankPoolPicks,
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
  blendSeasonRatings,
  calibrateMarginWeights,
};
