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
// fixedSpread — the spread is 1.5 nearly always, whoever is playing, so the
//               NUMBER carries almost no information about expected margin and
//               the price alongside it carries essentially all of it. Run lines
//               and puck lines are the two. Anything that reads a spread as the
//               market's estimate of the result has to skip these.
//
//               "Nearly" is doing real work there. A sample of 112 quotes
//               across nine books came back 1.5 every time, and that was one
//               day's card — far too small to see a rare event. Books do post
//               2.5 on a bad mismatch. Everything here prices whatever line it
//               is handed: the measured conditional applies at 1.5, where it
//               was measured, and any other number falls back to the plain
//               counted table rather than extrapolating a relationship that was
//               never checked there.
//
// TREAT THESE AS PLACEHOLDERS. They are widely cited approximations, good
// enough to produce sane output and to test against, and not good enough to bet
// on. Recalibrate from your own graded results.

const SPORTS = {
  // nfl sigma is MEASURED, not cited. 1,087 games across 2022-2025 with a
  // closing spread and a final score: the residual (margin + closing spread)
  // has a standard deviation of 12.38 and is slightly peaked, 71.1% inside one
  // SD against a normal's 68.3%.
  //
  // 10.82 rather than 12.38 because of what this number is used FOR. Nearly
  // every call asks how much probability is bought by moving a line a few
  // points — which is a question about the middle of the distribution, and the
  // middle is where the peak is. Fitting to what actually happened at offsets
  // of one to seven points gives 10.82, and it tracks:
  //
  //   line 2 pts stale   real 58.3%   at 10.82 57.3%   at 13.5 55.9%
  //   line 5 pts stale   real 68.6%   at 10.82 67.8%   at 13.5 64.4%
  //   line 7 pts stale   real 74.1%   at 10.82 74.1%   at 13.5 69.8%
  //
  // The old 13.5 was understating a stale line by up to 4.3 points, which the
  // Pick 6 tab has been quietly paying for the whole time.
  //
  // leanThreshold is stated per sport rather than derived from nfl sigma. It
  // used to be a fraction of it, which meant correcting a MEASURED football
  // number silently moved basketball's behaviour — and basketball's sigma is
  // still an unmeasured placeholder, so the ratio meant nothing.
  nfl: { sigma: 10.82, totalSigma: 10.5, hfa: 1.8,  eloPerPoint: 25, k: 20, leanThreshold: 3 },
  nba: { sigma: 11.5, totalSigma: 15.0, hfa: 2.5,  eloPerPoint: 28, k: 20, leanThreshold: 2.5 },
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


/**
 * Shin de-vigging: strip the margin while allowing for insider money.
 *
 * Proportional de-vigging divides the hold out pro rata, which assumes the book
 * marks up every outcome by the same factor. Books do not: they take more out
 * of longshots, because the people betting longshots are on average worse and
 * because a book carries more risk on them. Dividing pro rata therefore hands
 * back too much probability to the underdog, and a pipeline that then prices
 * something off that number finds the underdog cheap everywhere.
 *
 * Which is exactly what happened. With proportional de-vigging, fourteen of
 * fourteen positive puck-line edges on a thirty-two game card landed on the
 * +1.5 dog — a clean sweep of the sort that has been an artifact every previous
 * time it has appeared here. Baseball, whose moneylines are far less extreme,
 * came out even.
 *
 * Shin models the market as a mixture: a proportion z of the money is informed,
 * the rest is noise, and the quoted price is what a book must post to break
 * even against both. Inverting that gives
 *
 *   p_i = [sqrt(z^2 + 4(1-z) * pi_i^2 / PI) - z] / (2 * (1 - z))
 *
 * where pi_i are the raw implied probabilities and PI is their sum. z is
 * whatever makes the results sum to one, found by bisection because z enters
 * through a square root and a closed form for it is not worth the trouble.
 *
 * z = 0 recovers proportional de-vigging exactly, so a market with no hold is
 * unchanged and the two methods agree on a balanced one.
 */
function removeVigShin(rawProbs) {
  if (!Array.isArray(rawProbs) || rawProbs.length < 2) {
    throw new Error('removeVigShin needs at least two outcomes');
  }
  for (const p of rawProbs) {
    if (!Number.isFinite(p) || p <= 0) throw new Error(`bad implied probability: ${p}`);
  }
  const total = rawProbs.reduce((a, b) => a + b, 0);
  if (total <= 1) return removeVig(rawProbs);   // nothing to take out

  const atZ = (z) => rawProbs.map(pi =>
    (Math.sqrt(z * z + 4 * (1 - z) * pi * pi / total) - z) / (2 * (1 - z)));

  // Sum is 1 at the right z and falls as z rises, so bisect on it.
  let lo = 0, hi = 0.9;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const sum = atZ(mid).reduce((a, b) => a + b, 0);
    if (sum > 1) lo = mid; else hi = mid;
  }
  const z = (lo + hi) / 2;
  const out = atZ(z);
  // Re-normalise away the last few ulps of bisection error.
  const sum = out.reduce((a, b) => a + b, 0);
  return out.map(p => p / sum);
}

/**
 * De-vig a two-way market with whichever method is asked for.
 *
 * Defaults to Shin, because everything reading this is pricing one market off
 * another and the favourite-longshot bias goes straight into that comparison.
 * Pass method 'proportional' for the older behaviour.
 */
function deVigTwoWayShin(americanA, americanB, method = 'shin') {
  const rawA = americanToImpliedProb(americanA);
  const rawB = americanToImpliedProb(americanB);
  const [probA, probB] = method === 'shin'
    ? removeVigShin([rawA, rawB])
    : removeVig([rawA, rawB]);
  return { probA, probB, hold: rawA + rawB - 1, method };
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
// Winning margins, counted rather than assumed
// ----------------------------------------------------------------------------

/**
 * How often a game is won by exactly one, by exactly two, and so on.
 *
 * Counted from ESPN final scores: 1,950 MLB games across the 2026 season to
 * 23 August, and 1,450 NHL games across the 2025-26 season to the same date.
 * Index 0 is a margin of 1. There is no entry for zero because neither sport
 * can end level.
 *
 * This exists because the normal curve is wrong in precisely the place the run
 * line asks about. Baseball is decided by exactly one run 27.4% of the time; a
 * normal at the sigma this file carries says 17.6%. Hockey is 43.4% against the
 * curve's 32.5%. Both understate by around ten points, and both do it at the
 * single value that decides every 1.5 line — so pricing a run line off a normal
 * makes the favourite laying 1.5 look systematically cheap when it is not.
 *
 * That error is not academic. It produced two confident "edges" on a live
 * ten-game card, both on favourites, worth 3.7 and 2.7 percentage points. Both
 * vanish when the real distribution is used.
 *
 * Football and basketball are absent deliberately. Their spreads are genuine
 * estimates of the margin rather than a fixed 1.5, so nothing there hinges on
 * one specific value the way a run line does.
 */
const MARGIN_TABLES = {
  mlb: {
    games: 1950, source: 'ESPN finals, 2026 season through Aug 23',
    counts: [534, 373, 280, 192, 171, 135, 74, 71, 35, 22, 21, 15, 8, 9, 3, 2, 1, 0, 1, 1, 1, 1],
    // P(won by 2+ | this side won) against how likely that side was to win,
    // measured over 1,949 of those games. Pre-game probability came from log5
    // on season records, so no odds source is involved.
    //
    //   winner <40% to win  68.31%     50-55%  74.31%
    //   40-45%              73.68%     55-60%  74.86%
    //   45-50%              69.55%     >60%    72.95%
    //
    // Which is to say: flat. The strongest bucket sits BELOW the one before it
    // and barely above the weakest. In baseball, how likely a side was to win
    // says almost nothing about how big the win is, and the slope below is
    // small enough to be mostly noise.
    conditional: { base: 0.7239, mismatch: 0.1484, games: 1949 },
    // Checked against results: over 3,898 laying-1.5 observations the formula
    // predicted 36.30% and 36.30% happened, every bucket inside 1.5 points.
    // On a live card its positives split two laying, two taking. Trusted.
    verdict: true,
  },
  nhl: {
    games: 1450, source: 'ESPN finals, 2025-26 season through Aug 23',
    counts: [629, 266, 325, 150, 57, 11, 8, 3, 1],
    // Same measurement over 1,450 games, and here the effect is real:
    //
    //   winner <40% to win  55.19%     50-55%  56.98%
    //   40-45%              50.60%     55-60%  58.33%
    //   45-50%              48.91%     >60%    63.56%
    //
    // Monotone from 48.9% up to 63.6% once past a coin flip. Empty-net goals
    // are the obvious mechanism — a stronger side protecting a lead turns
    // one-goal wins into two-goal wins — and the slope is nearly three times
    // baseball's.
    conditional: { base: 0.5559, mismatch: 0.4031, games: 1450 },
    // Calibration is just as good as baseball's — 2,900 observations,
    // predicted 27.93% against 28.00% actual. What is NOT good is the shape of
    // what it finds: on a thirty-two game card every single positive edge was
    // the +1.5 dog, twelve for twelve, and it stayed twelve for twelve after
    // switching to Shin de-vigging specifically to correct that bias.
    //
    // A clean sweep in one direction has been an artifact every previous time
    // it has shown up in this project. It may well be real here — those games
    // are opening night, priced five weeks out, in the thinnest market hockey
    // has all year — but "may well be real" is not the standard for telling
    // somebody to bet. The numbers are computed and shown; they do not produce
    // a verdict until the season starts and they can be checked against
    // results.
    verdict: false,
    verdictNote: 'every positive edge on the card was the underdog, which has ' +
                 'been a modelling artifact before; waiting for results',
  },
};

/**
 * P(winning margin >= n), given somebody won. n = 1 is certain by definition.
 */
function marginAtLeast(sport, n) {
  const table = MARGIN_TABLES[String(sport || '').toLowerCase()];
  if (!table) throw new Error(`no measured margin table for ${sport}`);
  if (!Number.isFinite(n)) throw new Error('n must be finite');
  if (n <= 1) return 1;
  const total = table.counts.reduce((a, b) => a + b, 0);
  const below = table.counts.slice(0, Math.ceil(n) - 1).reduce((a, b) => a + b, 0);
  return (total - below) / total;
}

/**
 * P(a side covers when it lays `line`), given it wins outright `winProb` of the
 * time.
 *
 * A side laying 1.5 covers exactly when it wins by two or more, so the answer
 * is its win probability times the chance its win is a comfortable one. The
 * other side is the complement, which is what makes this usable from either
 * direction.
 *
 * The `conditional` numbers handle the one thing the raw table cannot: whether
 * a heavy favourite, when it wins, wins by more than a coin-flip team does.
 * They are MEASURED over a season of results, not fitted to prices.
 *
 * That distinction is the whole point. Fitting this parameter to a ten-game
 * slate of market prices returned 0.71 for baseball; measuring it over 1,949
 * actual games returned 0.148. The ten-game fit was reading noise, and it moved
 * the headline answer on a live game by six percentage points — from no edge to
 * a five-point edge. Prices are not evidence about how baseball behaves.
 *
 * Only the 1.5 line gets the conditional treatment, because 1.5 is where it was
 * measured — and 1.5 is what these sports post on all but the odd mismatch,
 * where a book may go to 2.5. Any other line falls back to the unconditional
 * counted table rather than running the measured slope out to a number the
 * measurement never covered.
 */
function coverProbFromWinProb({ sport, winProb, line = 1.5, mismatch = null } = {}) {
  if (!Number.isFinite(winProb) || winProb <= 0 || winProb >= 1) {
    throw new Error(`winProb must be strictly between 0 and 1, got ${winProb}`);
  }
  const key = String(sport || '').toLowerCase();
  const table = MARGIN_TABLES[key];
  if (!table) throw new Error(`no measured margin table for ${sport}`);

  const need = Math.abs(line) + 0.5;          // lay 1.5 -> must win by 2
  const measured = table.conditional;
  const atStandardLine = Math.abs(Math.abs(line) - 1.5) < 1e-9;

  // The measured intercept and slope apply at 1.5, which is what was measured.
  // Anywhere else, fall back to the unconditional table with no slope at all
  // rather than extrapolate a relationship that was never checked there.
  const baseProb = atStandardLine && measured ? measured.base : marginAtLeast(sport, need);
  const slope = mismatch !== null ? mismatch
    : (atStandardLine && measured ? measured.mismatch : 0);

  // Clamped so it can never leave probability space at an extreme price.
  const cond = Math.min(0.999, Math.max(0.001, baseProb + slope * (winProb - 0.5)));
  return winProb * cond;
}

/**
 * The fair price of a 1.5 line, read off the moneyline of the same game.
 *
 * No forecast anywhere in this. The moneyline says how often each side wins,
 * the counted table says how often a win is by two or more, and those two
 * together fix what the run line has to be worth. When the offered price is
 * better than that, the two markets contradict each other and the cheaper one
 * is worth taking — which is an edge available to somebody with one account.
 *
 * `edgePts` is measured against the RAW offered price, vig included, because
 * the vig is paid. `disagreementPts` strips vig from both and says only whether
 * the markets differ, which is the diagnostic rather than the bet.
 */
function runLineEdge({
  sport, homeML, awayML, spread, spreadHomePrice, spreadAwayPrice, mismatch = null,
  deVigMethod = 'shin',
} = {}) {
  if (!Number.isFinite(spread)) return null;
  if (!Number.isFinite(spreadHomePrice) || !Number.isFinite(spreadAwayPrice)) return null;
  // A price of 0 is finite and clears the guard above, but no book posts one —
  // it is what parseAmericanValue returns for "EVEN" and "PK". americanToDecimal
  // throws on it, and that call sits OUTSIDE the try below, so one unparsed
  // price failed the whole slate instead of dropping one game.
  if (spreadHomePrice === 0 || spreadAwayPrice === 0) return null;

  let pHome;
  try {
    // Shin rather than proportional. The moneyline is the input the whole
    // calculation rests on, and proportional de-vigging systematically hands
    // the underdog too much probability at the prices hockey posts.
    const dv = deVigTwoWayShin(homeML, awayML, deVigMethod);
    pHome = dv.probA;
  } catch (e) { return null; }
  if (!Number.isFinite(pHome) || pHome <= 0 || pHome >= 1) return null;

  // Whichever side is laying the points is the one the formula is written for.
  const homeLays = spread < 0;
  const layingProb = homeLays ? pHome : 1 - pHome;
  let layingCovers;
  try {
    layingCovers = coverProbFromWinProb({ sport, winProb: layingProb, line: spread, mismatch });
  } catch (e) { return null; }

  const fairHomeProb = homeLays ? layingCovers : 1 - layingCovers;
  const fairAwayProb = 1 - fairHomeProb;

  const rawHome = americanToImpliedProb(spreadHomePrice);
  const rawAway = americanToImpliedProb(spreadAwayPrice);
  const devigged = removeVig([rawHome, rawAway]);

  return {
    homeWinProb: pHome,
    fairHomeProb,
    fairHomePrice: decimalToAmerican(1 / fairHomeProb),
    fairAwayPrice: decimalToAmerican(1 / fairAwayProb),
    offeredHomePrice: spreadHomePrice,
    offeredAwayPrice: spreadAwayPrice,
    homeEdgePts: +((fairHomeProb - rawHome) * 100).toFixed(2),
    awayEdgePts: +((fairAwayProb - rawAway) * 100).toFixed(2),
    disagreementPts: +((fairHomeProb - devigged[0]) * 100).toFixed(2),
    spreadHold: +((rawHome + rawAway - 1) * 100).toFixed(2),
  };
}

/**
 * Fit the mismatch parameter to a slate of prices. DIAGNOSTIC ONLY.
 *
 * Kept because comparing what the market implies against what the season
 * actually did is a useful check — if a slate's fitted value drifts miles from
 * the measured one, something has changed and is worth looking at.
 *
 * It is NOT how the shipped number is chosen, and must not become that. Run
 * over ten baseball games it returned 0.71 where the season says 0.148, and
 * pricing off that difference invented a five-point edge on a fairly priced
 * game. A slate is too small to fit anything to.
 */
function fitMismatch(sport, games, { lo = -1, hi = 1.5, steps = 500 } = {}) {
  const usable = (games || []).filter(g =>
    Number.isFinite(g.spread) && Number.isFinite(g.spreadHomePrice) &&
    Number.isFinite(g.spreadAwayPrice) && Number.isFinite(g.homeML) && Number.isFinite(g.awayML));
  if (usable.length < 3) return null;

  const medianOf = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    const i = a.length >> 1;
    return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
  };

  let best = null;
  for (let i = 0; i <= steps; i++) {
    const mismatch = lo + (hi - lo) * (i / steps);
    const resid = [];
    for (const g of usable) {
      const r = runLineEdge({ sport, ...g, mismatch });
      if (r) resid.push(r.disagreementPts);
    }
    if (resid.length < 3) continue;
    const score = medianOf(resid.map(Math.abs));
    if (!best || score < best.score) best = { mismatch, score, resid };
  }
  if (!best) return null;

  const positive = best.resid.filter(x => x > 0).length;
  return {
    mismatch: +best.mismatch.toFixed(3),
    medianAbsDisagreementPts: +best.score.toFixed(3),
    games: best.resid.length,
    leaningHome: positive,
    leaningAway: best.resid.length - positive,
    maxDisagreementPts: +Math.max(...best.resid.map(Math.abs)).toFixed(2),
  };
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
// Fitted, not chosen. The values at 3, 4, 6 and 7 were hand-set round numbers
// and the verdict now PRINTS what a half point across them is worth, which
// turned a rough table into a wrong published figure: it priced the half point
// across the 3 at 7.0 points when 1,112 games lined at exactly 3 landed on 3
// 9.2% of the time.
//
// Each of those four is solved against its CONDITIONAL rate — how often a game
// lined at k finishes on k — rather than against the pooled distribution. The
// pooled fit was tried and rejected: dividing every margin by a smooth curve
// with all lines mixed together wanted a weight of 2.32 at a margin of 24, on a
// handful of games. Numbers with fewer than 300 games behind them are left at
// their hand-set values, 10 and 14 among them.
//
//   key   games   counted   was    now
//     3    1112      9.2%   7.0%   9.3%
//     7     469      6.4%   6.3%   6.3%
//     6     338      3.8%   4.1%   3.8%
//     4     324      2.5%   3.7%   2.5%
const NFL_KEY_NUMBER_WEIGHTS = {
  0: 0.45,   // ties are rare and only possible after overtime
  1: 0.90,
  2: 0.90,
  3: 2.834,  // by far the most common margin: one field goal
  4: 0.709,
  5: 0.85,
  6: 1.122,
  7: 1.897,  // touchdown and extra point
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


/**
 * What actually happened to 7,239 closing spreads.
 *
 * Every number the Pick 6 tab reports is P(final margin beats a line N points
 * away from the market's). That was answered with a normal curve at a fitted
 * sigma, and the fit was made on 1,087 games. Re-measured on every regular
 * season nflverse publishes back to 1999, the curve is wrong in the direction
 * that flatters the bet:
 *
 *   stale by   reality   sigma 10.82   best-fit normal 11.25
 *      2 pts    56.5%      57.3%           57.1%
 *      5 pts    65.8%      67.8%           67.2%
 *      7 pts    71.7%      74.1%           73.3%
 *
 * A better sigma does not fix it, because the shape is the problem: football
 * margins pile up on 3 and 7 and the tails are thinner than a bell. So this is
 * counted rather than modelled, exactly as the baseball and hockey margin
 * tables are.
 *
 * `survival[i]` is P(residual > from + i*step), where residual is
 * (final margin + closing spread). Half-point resolution, because every line a
 * book posts lands on a half point.
 *
 * Football only. Basketball has no equivalent measurement yet and still uses
 * the curve; baseball and hockey never used this path at all, since their
 * spread is fixed and priced through the moneyline instead.
 */
const NFL_RESIDUALS = {
  games: 7239,
  from: -28, step: 0.5,
  survival: [
    0.98121, 0.97942, 0.97734, 0.97652, 0.97458, 0.97292, 0.97044, 0.96809, 0.96464, 0.9627,
    0.96022, 0.95842, 0.95552, 0.95207, 0.94723, 0.94281, 0.93728, 0.933, 0.92844, 0.92361,
    0.91656, 0.91311, 0.90634, 0.9004, 0.89446, 0.88963, 0.88244, 0.87554, 0.86808, 0.86034,
    0.85122, 0.84321, 0.83561, 0.82788, 0.81572, 0.80412, 0.78989, 0.78008, 0.76751, 0.75632,
    0.74292, 0.73215, 0.71667, 0.70355, 0.68366, 0.67192, 0.65755, 0.64595, 0.62743, 0.61182,
    0.59663, 0.5824, 0.56486, 0.54718, 0.53046, 0.51153, 0.46332, 0.44716, 0.43017, 0.41636,
    0.40309, 0.38969, 0.37505, 0.36207, 0.34287, 0.32905, 0.31579, 0.30474, 0.28996, 0.27504,
    0.26012, 0.25128, 0.23954, 0.23111, 0.2202, 0.21205, 0.19726, 0.18746, 0.17627, 0.16964,
    0.16245, 0.15624, 0.1474, 0.14063, 0.13248, 0.12585, 0.11922, 0.11438, 0.10899, 0.10402,
    0.09767, 0.09103, 0.08523, 0.08095, 0.07708, 0.07335, 0.06797, 0.06258, 0.05719, 0.05415,
    0.05056, 0.0489, 0.04462, 0.04227, 0.03785, 0.0355, 0.03136, 0.02929, 0.02721, 0.02528,
    0.02321, 0.021, 0.01865,
  ],
};

/**
 * P(margin + spread > offset) for football, read off the counted table.
 *
 * Linear interpolation between half-point steps, which only matters for a
 * caller asking about a quarter point; every real line lands on a step. Returns
 * null outside the measured range so the caller can fall back rather than
 * silently extrapolate off the end of the data.
 */
function nflResidualAbove(offset) {
  if (!Number.isFinite(offset)) return null;
  const { from, step, survival } = NFL_RESIDUALS;
  const idx = (offset - from) / step;
  if (idx < 0) return 1;
  if (idx > survival.length - 1) return 0;
  const lo = Math.floor(idx);
  if (lo === idx) return survival[lo];
  const frac = idx - lo;
  return survival[lo] * (1 - frac) + survival[lo + 1] * frac;
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
 *
 * `poolAwaySpread` is the AWAY side's own number, and it exists because a pool
 * does not have to post a two-sided line at all. On a tight matchup this one
 * posts -2 against -2: both teams lay two points, there is no plus money, and
 * whichever side is picked has to win by three.
 *
 * That is not a spread, and pricing it as one is wrong in a way that flatters
 * it. A normal line has the two sides as complements, so somebody always wins
 * and the probabilities add to one. Here they do not: if the game lands inside
 * two points either way, BOTH picks lose. That dead zone is the pool's edge
 * over its players, and it is not small — around one NFL game in nine finishes
 * inside two points.
 *
 * So the two sides are priced independently and their probabilities are left
 * unconditional. A -2/-2 game returns something like 44% and 44% with 12%
 * belonging to neither, rather than the 50/50 the old arithmetic produced by
 * assuming away.
 *
 * When the away number is the mirror of the home one, or is not supplied, this
 * reduces exactly to the two-sided case.
 */
function poolEdge({ sport, poolSpread, poolAwaySpread = null, marketSpread,
                    poolTotal, marketTotal,
                    homeTeam = 'Home', awayTeam = 'Away' }) {
  const cfg = sportConfig(sport);
  const out = { spread: null, total: null };
  const sign = (n) => `${n > 0 ? '+' : ''}${n}`;

  // P(margin + offset > 0) for a line sitting `offset` from the market's.
  //
  // Football reads it off 7,239 counted games; anything else falls back to the
  // curve. The counted version matters because a normal overstates a stale line
  // by up to 2.4 points at the offsets a pool actually produces, and it
  // overstates in the direction that flatters the bet.
  const above = (threshold, expected) => {
    if (sport === 'nfl') {
      const counted = nflResidualAbove(threshold - expected);
      if (counted !== null) return counted;
    }
    return coverOutcomes({ predictedMargin: expected, spread: -threshold,
                           sigma: cfg.sigma, sport }).win;
  };
  // Push probability stays on the discrete margin PMF rather than the counted
  // table. The two are good at different things: the table is measured, but it
  // pools whole-number and half-point spreads together, so a residual of
  // exactly -3 is averaged with residuals of -2.5 and -3.5 and the key-number
  // spike smears out. marginPmf keeps 3 and 7 sharp, which is the entire
  // question when asking whether a line can land on its own number.
  const exactly = (value, expected) => {
    if (Math.abs(value - Math.round(value)) > 1e-9) return 0;   // half points cannot push
    return coverOutcomes({ predictedMargin: expected, spread: -value,
                           sigma: cfg.sigma, sport }).push;
  };

  if (Number.isFinite(poolSpread) && Number.isFinite(marketSpread)) {
    // Absent an away number the pool is two-sided and it mirrors the home one.
    const awayLine = Number.isFinite(poolAwaySpread) ? poolAwaySpread : -poolSpread;
    const expected = -marketSpread;              // the market's expected margin

    // Home wins its side when margin > -poolSpread. Away wins when margin <
    // awayLine. Those are only complements when the two numbers mirror.
    const homeProb = above(-poolSpread, expected);
    const awayProb = 1 - above(awayLine, expected) - exactly(awayLine, expected);
    const push = exactly(-poolSpread, expected);

    // How the two numbers sit relative to each other decides what the leftover
    // probability MEANS, and there are three cases rather than two:
    //
    //   mirrored   -3 / +3    ordinary line; leftover is the push, a loss here
    //   both lay   -2 / -2    a gap neither side wins; leftover is dead
    //   overlap    -3 / +7    a MIDDLE; margins of 4-6 win BOTH picks
    //
    // The third was being reported as a both-lay trap with a zero dead zone,
    // because the leftover was clamped at zero and anything not mirrored was
    // called both-lay. A middle is the opposite of a trap.
    const offset = +(awayLine + poolSpread).toFixed(4);
    const shape = Math.abs(offset) < 1e-9 ? 'mirrored' : offset < 0 ? 'both-lay' : 'overlap';
    const leftover = 1 - homeProb - awayProb;
    const dead = shape === 'both-lay' ? Math.max(0, leftover) : 0;
    const overlap = shape === 'overlap' ? Math.max(0, -leftover) : 0;

    const backHome = homeProb >= awayProb;
    out.spread = {
      side: backHome ? 'home' : 'away',
      pick: backHome ? `${homeTeam} ${sign(poolSpread)}` : `${awayTeam} ${sign(awayLine)}`,
      poolLine: backHome ? poolSpread : awayLine,
      marketLine: backHome ? marketSpread : -marketSpread,
      gap: +Math.abs((backHome ? poolSpread : awayLine) -
                     (backHome ? marketSpread : -marketSpread)).toFixed(2),
      // Unconditional. A push is a loss in this pool, confirmed by the person
      // who plays in it, so nothing is divided out of the denominator.
      winProb: +(backHome ? homeProb : awayProb).toFixed(4),
      otherSideProb: +(backHome ? awayProb : homeProb).toFixed(4),
      // Kept distinct, because they are different things that were being
      // reported under one name: a push lands exactly on the number, a dead
      // zone is a range neither side wins, and an overlap is a range BOTH win.
      shape,
      pushProb: +push.toFixed(4),
      deadProb: +dead.toFixed(4),
      overlapProb: +overlap.toFixed(4),
      // Worth warning about when a push cannot be refunded, which in this pool
      // it cannot. In football the whole numbers that matter are 3 and 7.
      pushRisk: push >= 0.04 || dead >= 0.04,
      bothLay: shape === 'both-lay',
      homeLine: poolSpread,
      awayLine,
      // Spreads are the half of this with a holdout season behind them.
      tested: true,
    };
  }

  if (Number.isFinite(poolTotal) && Number.isFinite(marketTotal)) {
    const o = totalOutcomes({
      predictedTotal: marketTotal, line: poolTotal, sigma: cfg.totalSigma,
    });
    // Unconditional, to match the spread. This used to be over/(over+under),
    // which refunds a push — so a stale total was quoted two to three points
    // higher than a stale spread of the same size and outranked it in Best 6,
    // which is the reverse of what the measurement says to do.
    const backOver = o.over >= o.under;
    out.total = {
      side: backOver ? 'over' : 'under',
      pick: `${backOver ? 'Over' : 'Under'} ${poolTotal}`,
      poolLine: poolTotal,
      marketLine: marketTotal,
      gap: +Math.abs(poolTotal - marketTotal).toFixed(2),
      winProb: +(backOver ? o.over : o.under).toFixed(4),
      otherSideProb: +(backOver ? o.under : o.over).toFixed(4),
      shape: 'mirrored',
      pushProb: +o.push.toFixed(4),
      pushRisk: o.push >= 0.04,
      deadProb: 0,
      overlapProb: 0,
      bothLay: false,
      // The same arithmetic as the spread without the evidence: a stale total
      // was measured at 51.4% over 401 bets against 55.4% for a stale spread,
      // under the 52.4% needed to break even. A fair price, not a shown edge.
      tested: false,
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
    // A candidate with no usable probability is dropped rather than sorted to
    // the bottom — it is a game the market had no line for, not a bad bet.
    .filter(c => c && Number.isFinite(c.winProb))
    .slice()
    .sort((a, b) => {
      // Tested before untested. A stale spread has a holdout season behind it
      // (55.4% over 325 bets); a stale total was measured at 51.4% over 401 and
      // does not clear the vig. Sorting them together on win probability alone
      // let the untested one win on an accounting difference, which is exactly
      // backwards. Probability still decides within each group.
      const at = a.tested === false ? 1 : 0;
      const bt = b.tested === false ? 1 : 0;
      if (at !== bt) return at - bt;
      return (b.winProb - a.winProb) || (b.gap - a.gap);
    })
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
 * whether the pool number has kept up.
 *
 * This is the one rule in the file that has survived a real holdout test. It
 * was found on 2025, where a two-point move went 46-27. That is exactly the
 * shape of a result that evaporates: one season, and a threshold picked after
 * seeing the numbers. So it was re-run on 2024, which had never been looked at,
 * with the rule and the threshold unchanged:
 *
 *              2025 (found)      2024 (holdout)     both
 *   move >= 1     57.1%             53.5%           55.4% on 325 bets
 *   move >= 1.5   62.7%             56.5%           —
 *   move >= 2     63.0%             56.7%           60.0% on 140 bets
 *   move >= 3     59.6%             63.3%           61.0% on 77 bets
 *
 * Break-even is 52.4%. Every threshold clears it in a season it was never
 * fitted to. 2024 on its own is only about one standard deviation, so it is
 * corroboration rather than proof — but it replicates at every threshold, in
 * the same direction, which is what a real effect looks like and what a fluke
 * usually does not.
 *
 * The control matters as much: backing the home side at the opening number
 * regardless of which way the market moved went 267-264, 50.3%. So the edge is
 * in the DIRECTION of the move, not in opening lines being soft.
 *
 * The one-point threshold is kept and no longer called soft. It wins on 325
 * bets across both seasons, and it fires on roughly 60% of games where two
 * points fires on 26% — which matters when six picks are needed and a slate
 * only offers four numbers that moved two points.
 */
function poolCandidate(spreadMovement, totalMovement) {
  // SPREAD movement only. This used to take whichever of the two had moved
  // furthest and flag on that, which quietly applied a spread result to a
  // market it was never tested on.
  //
  // It has now been tested. Same rule, same seasons, 543 games with an opening
  // total, a closing total and a final score:
  //
  //                 spreads          totals
  //   move >= 1     55.4% / 325      51.4% / 401
  //   move >= 2     60.0% / 140      50.8% / 183
  //   2025 / 2024   63.0% / 56.7%    53.2% / 49.5%
  //
  // Break-even is 52.4%. Totals miss it, do not replicate between seasons, and
  // fading them does no better — 48.6% at a point. The control says why: taking
  // the over at the opening number regardless of movement went 51.9%, so the
  // movement adds essentially nothing. A closing spread is a better estimate
  // than an opening spread; a closing total apparently is not.
  //
  // Totals are still PRICED on the Pick 6 tab, because pricing a frozen number
  // against the market number is arithmetic either way. They are simply no
  // longer advertised as candidates, and the tab marks them as untested so a
  // stale total cannot outrank a stale spread on a claim that was never
  // supported.
  const moved = Number.isFinite(spreadMovement) ? Math.abs(spreadMovement) : 0;
  if (moved >= 2) return { level: 'strong', points: +moved.toFixed(2), market: 'spread' };
  if (moved >= 1) return { level: 'worth checking', points: +moved.toFixed(2), market: 'spread' };
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
  injuryBaseline = null, spreadCanMove = true,
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

  // Unusual for THIS league, not three in absolute terms.
  //
  // Three players out is remarkable in football and completely routine in
  // baseball, where every roster carries a rolling handful on the 10- and
  // 15-day IL and the league median short-term count is around four per team.
  // An absolute threshold of three therefore fired on essentially every
  // baseball and hockey card and was handed to Claude as "the most interesting
  // thing about the game" — noise dressed as signal.
  //
  // The baseline is the league's own median, measured from the same feed that
  // produced the counts, so the flag means "more than usual" rather than "more
  // than a number chosen for a different sport".
  //
  // The stillness test is dropped where the spread CANNOT move: a run line and
  // a puck line are fixed at 1.5, so "the spread has barely moved" is true by
  // construction there and adds nothing to the condition.
  // Compared PER TEAM, because the baseline is per team.
  //
  // The first version of this compared the two sides added together against a
  // one-team norm, which is close to guaranteed to clear it: baseball's median
  // is about four short-term absences a team, so a combined count averages
  // eight against a bar of seven. It fired on eight of ten baseball games —
  // better than the twenty-nine of thirty it replaced, and still noise.
  //
  // What the flag is for is one team being unusually depleted, so that is what
  // it now measures, and the side it names is the one that cleared the bar.
  const bar = Number.isFinite(injuryBaseline) ? Math.max(3, Math.ceil(injuryBaseline) + 3) : 3;
  const lineIsStill = !spreadCanMove || (spreadMoved !== null && spreadMoved < 1);
  const bySideKnown = injuriesOutHome > 0 || injuriesOutAway > 0;
  const worst = bySideKnown ? Math.max(injuriesOutHome, injuriesOutAway) : totalOut;
  if (worst >= bar && lineIsStill) {
    // The side that actually cleared the bar. Level means neither is the story.
    const against = !bySideKnown ? null
      : injuriesOutHome > injuriesOutAway ? 'home'
        : injuriesOutAway > injuriesOutHome ? 'away' : null;
    flags.push({
      type: 'injuries-static-line', severity: 'medium', against,
      note: `${worst} players ruled out on one side${Number.isFinite(injuryBaseline)
        ? `, against a league norm of about ${Math.round(injuryBaseline)} a team` : ''}` +
        `${spreadCanMove ? ', but the spread has barely moved' : ''}.`,
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
/**
 * What a difference between two numbers is actually worth, in win probability.
 *
 * The verdict has been able to say "this number is a point better" for a while
 * and that is the least interesting true thing about it. A point is worth about
 * three and a half points of win probability at a spread of 3 and barely two at
 * a spread of 12, and the reader cannot be expected to carry that table around.
 *
 * Priced at the MARKET's view of the game rather than this app's, deliberately.
 * The market number is the best estimate of the margin available here — the
 * projection has been measured losing to it on both spreads and totals — so the
 * question "what does moving from -3.5 to -2.5 buy" is answered by evaluating
 * both numbers against a game expected to land where the market says. Pricing
 * it with our own projection would let a forecast that loses to the market
 * inflate or deflate a price fact that stands without it.
 *
 * Uses the counted margin distribution, so the 3 and the 7 cost what they
 * actually cost rather than what a bell curve imagines.
 */
function lineValueProb({ sport, market = 'spread', side, marketNumber, bookNumber } = {}) {
  if (!Number.isFinite(marketNumber) || !Number.isFinite(bookNumber)) return null;
  const cfg = sportConfig(sport);
  if (market === 'total') {
    if (side !== 'over' && side !== 'under') return null;
    const at = (line) => {
      const o = totalOutcomes({ predictedTotal: marketNumber, line, sigma: cfg.totalSigma });
      return { p: side === 'over' ? o.over : o.under, push: o.push };
    };
    const book = at(bookNumber), mkt = at(marketNumber);
    return { gain: book.p - mkt.p, pushGain: book.push - mkt.push,
             bookProb: book.p, marketProb: mkt.p, push: book.push };
  }
  if (side !== 'home' && side !== 'away') return null;
  const at = (spread) => {
    const o = coverOutcomes({ predictedMargin: -marketNumber, spread,
                              sigma: cfg.sigma, sport });
    return { p: side === 'home' ? o.win : o.loss, push: o.push };
  };
  const book = at(bookNumber), mkt = at(marketNumber);
  return { gain: book.p - mkt.p, pushGain: book.push - mkt.push,
           bookProb: book.p, marketProb: mkt.p, push: book.push };
}

function bestBet({
  sport, bookValuePts = 0, bookSide = null, bookPick = null,
  predictedMargin = null, marketSpread = null, bookSpread = null,
  predictedTotal = null, bookTotal = null, marketTotal = null,
  situationFlags = [], inProgress = false,
  homeTeam = 'Home', awayTeam = 'Away',
  runLine = null,
} = {}) {
  if (inProgress) {
    return { level: 'pass', label: 'In progress', pick: null,
             reason: 'the book is pricing the rest of the game, not the whole one' };
  }

  const no = (reason) => ({ level: 'coinflip', label: 'No lean', pick: null, reason });

  // Runs and goals are not points, and a verdict that calls them points reads
  // like it does not know which sport it is looking at.
  const unit = sport === 'mlb' ? 'run' : sport === 'nhl' ? 'goal' : 'point';
  const cfg = SPORTS[sport] || SPORTS.nfl;

  // --------------------------------------------------------------------
  // 1. A better NUMBER than the market. A fact about what is on offer.
  // --------------------------------------------------------------------
  //
  // This is a statement about PRICE and it is worded as one, because it was
  // being read as a forecast. A card saying "Best bet: Over 48.5" above a
  // predicted score of 20-26 looks like the app arguing with itself, and the
  // question it raises — which half is wrong? — has an answer worth stating
  // rather than leaving the reader to guess.
  //
  // Neither half is wrong. They answer different questions. The number being a
  // point better here than at eight other books is a fact about what is on
  // offer, true whoever wins. The projection is a description of recent
  // scoring, and it has been measured against exactly this question — projected
  // total against market total — at 49.6% across 6,672 games, which is nothing.
  //
  // So the price edge stands and the projection does not override it. But where
  // they point opposite ways the card says so, because a reader who notices the
  // contradiction unaided will trust neither.
  const projectionObjects = (() => {
    if (!bookPick) return null;
    const isTotal = /^(Over|Under)/i.test(bookPick);
    if (isTotal) {
      if (!Number.isFinite(predictedTotal) || !Number.isFinite(bookTotal)) return null;
      const projSaysOver = predictedTotal > bookTotal;
      const pickIsOver = /^Over/i.test(bookPick);
      if (projSaysOver === pickIsOver) return null;
      return `the projection has this at ${predictedTotal.toFixed(0)}, which points the other way — ` +
             `it is recent scoring only and loses to the market on totals, so it is not a reason to pass`;
    }
    if (!Number.isFinite(predictedMargin) || !Number.isFinite(marketSpread)) return null;
    const projLeansHome = predictedMargin > -marketSpread;
    if (bookSide !== 'home' && bookSide !== 'away') return null;
    if (projLeansHome === (bookSide === 'home')) return null;
    return 'the projection leans the other way — it loses to the closing line, ' +
           'so it is not a reason to pass on a better number';
  })();

  // The working, not just the answer.
  //
  // "This number is a point better than the market" is true and it is the least
  // useful true thing available. It does not say what a point is worth, whether
  // it crosses a number games actually land on, or what else was looked at and
  // found nothing. All of that is measured already and was simply not being
  // shown, which left a verdict that reads like an assertion.
  //
  // Every line below is either a number off the board or a figure from a
  // counted table, and where something was checked and came back empty it says
  // so — a check that found nothing is evidence, and hiding it makes the case
  // look thinner than it is.
  const basis = (() => {
    if (!bookPick) return null;
    const rows = [];
    const isTotal = /^(Over|Under)/i.test(bookPick);
    const pct = (x) => `${(x * 100).toFixed(1)}%`;

    const val = isTotal
      ? lineValueProb({ sport, market: 'total', side: /^Over/i.test(bookPick) ? 'over' : 'under',
                        marketNumber: marketTotal, bookNumber: bookTotal })
      : lineValueProb({ sport, market: 'spread', side: bookSide,
                        marketNumber: marketSpread, bookNumber: bookSpread });

    // 1. What is on offer, against what everyone else is offering.
    if (isTotal && Number.isFinite(bookTotal) && Number.isFinite(marketTotal)) {
      rows.push({ label: 'the number', text:
        `your book has ${bookTotal}, the rest of the market is at ${marketTotal}` });
    } else if (!isTotal && Number.isFinite(bookSpread) && Number.isFinite(marketSpread)) {
      const sgn = (n) => `${n > 0 ? '+' : ''}${n}`;
      const mine = bookSide === 'away' ? -bookSpread : bookSpread;
      const theirs = bookSide === 'away' ? -marketSpread : marketSpread;
      rows.push({ label: 'the number', text:
        `your book has ${sgn(mine)}, the rest of the market is at ${sgn(theirs)}` });
    }

    // 2. What that difference actually buys. The point of the whole exercise:
    //    a point is worth about three and a half at a spread of 3 and barely
    //    two at 12, and nobody carries that table in their head.
    // A better number buys two different things and they are not worth the same
    // to this reader. Extra WINS are worth the same everywhere. Extra PUSHES are
    // worth a refund at a book and nothing at all in the pool, where a push is a
    // loss — so a half point that only converts losses into pushes is a real
    // edge on Sunday and literally zero in the Pick 6.
    //
    // Reported separately because collapsing them printed "0.0 points of win
    // probability" under a verdict reading "Slight edge" on Broncos +3, which
    // is both true and useless: +2.5 to +3 wins no extra games, it turns 9.3%
    // of losses into refunds.
    if (val) {
      const win = val.gain, extraPush = val.pushGain || 0;
      const counted = DISCRETE_MARGIN_SPORTS.has(String(sport).toLowerCase()) && !isTotal
        ? ', priced on counted game margins rather than a bell curve' : '';
      const refundLine = `${pct(extraPush)} of outcomes turn from a loss into a refund — ` +
        'which your book pays back and the Pick 6 does not, because a push is a loss there';
      if (win >= 0.005 && extraPush >= 0.005) {
        rows.push({ label: 'what it buys', text:
          `${(win * 100).toFixed(1)} points of win probability — ${pct(val.marketProb)} at the ` +
          `market number, ${pct(val.bookProb)} at yours${counted}` });
        rows.push({ label: 'and at the book', text: refundLine });
      } else if (win >= 0.005) {
        rows.push({ label: 'what it buys', text:
          `${(win * 100).toFixed(1)} points of win probability — ${pct(val.marketProb)} at the ` +
          `market number, ${pct(val.bookProb)} at yours${counted}` });
      } else if (extraPush >= 0.005) {
        rows.push({ label: 'what it buys', text:
          `no extra wins at all — both numbers win ${pct(val.bookProb)} of the time. ` + refundLine });
        rows.push({ label: 'in the Pick 6', text:
          'this one is worth nothing. Do not spend a pick on it' });
      }
    }

    // 3. Whether it lands on a number games actually finish on. Worth saying in
    //    both directions, because a push is a refund at the book and a LOSS in
    //    the pool, and the same half point means opposite things across the two.
    // Only when the push was NOT the thing being bought — otherwise the rows
    // above have already said it, at more length and more usefully.
    if (val && val.push >= 0.03 && (val.pushGain || 0) < 0.005) {
      rows.push({ label: 'lands exactly there', text:
        `${pct(val.push)} of games finish on that number — a refund at your book, ` +
        'but a loss in the Pick 6' });
    }

    // 4. What was checked and came back with nothing to add.
    if (situationFlags && situationFlags.length) {
      for (const f of situationFlags) {
        rows.push({ label: 'but note', text: f.note });
      }
    } else {
      rows.push({ label: 'checked', text: 'no injury, rest or travel flag on either side' });
    }

    // Deliberately NOT repeated here when it disagrees. The same sentence was
    // printing twice on the same card — once as the caveat above, which is
    // visible without expanding anything, and again inside the working. The
    // caveat is the right home for it: a verdict that contradicts its own
    // projection has to say so before it is clicked, not after.
    if (!projectionObjects
        && (isTotal ? Number.isFinite(predictedTotal) : Number.isFinite(predictedMargin))) {
      rows.push({ label: 'checked', text: 'the projection agrees, for what little that is worth — ' +
        'it loses to the market, so it is corroboration and not a reason' });
    }

    rows.push({ label: 'the bottom line', text:
      'this is an edge on the PRICE. It does not say who wins — it says you are ' +
      'getting a number the rest of the market is not offering' });

    return rows;
  })();

  if (bookValuePts >= 1 && bookPick) {
    return { level: 'edge', label: 'Best bet', pick: bookPick, side: bookSide,
             reason: `that number is ${bookValuePts} ${unit}${bookValuePts === 1 ? '' : 's'} better here ` +
                     'than the rest of the market — a fact about the price, not a forecast',
             ...(projectionObjects ? { caveat: projectionObjects } : {}),
             ...(basis ? { basis } : {}) };
  }
  if (bookValuePts >= 0.5 && bookPick) {
    return { level: 'slight', label: 'Slight edge', pick: bookPick, side: bookSide,
             reason: `that number is half a ${unit} better here than the rest of the market — ` +
                     'a fact about the price, not a forecast',
             ...(projectionObjects ? { caveat: projectionObjects } : {}),
             ...(basis ? { basis } : {}) };
  }

  // --------------------------------------------------------------------
  // 2. A better PRICE than the same game's other market.
  // --------------------------------------------------------------------
  // A run line and a puck line are 1.5 whoever is playing, so the number never
  // moves and the comparison above is always zero. The price beside it moves
  // constantly, and `runLine` is what the moneyline of this same game, at this
  // same book, says that 1.5 has to be worth.
  //
  // No forecast anywhere in it. Two markets on one scoreboard describe one set
  // of results; when they contradict each other, the cheaper one is worth
  // taking. That is why this counts as an edge where the projection does not.
  if (cfg.fixedSpread) {
    const table = MARGIN_TABLES[sport];
    const noun = sport === 'nhl' ? 'puck' : 'run';

    // The line to NAME is the one that was priced. runLine is built entirely
    // from the book's own spread and its two prices, so labelling the pick with
    // a consensus point taken from nine other books could name a number that
    // was never priced — "Home -1.5" quoting a fair price computed for -2.5.
    const priceLine = Number.isFinite(bookSpread) ? bookSpread : marketSpread;

    if (!Number.isFinite(priceLine)) return no(`there is no ${noun} line here to price`);
    if (!runLine || !table) {
      return no(`the ${noun} line barely moves whoever is playing, and there is ` +
                'no moneyline here to price it against');
    }

    const takeHome = runLine.homeEdgePts >= runLine.awayEdgePts;
    const pts = takeHome ? runLine.homeEdgePts : runLine.awayEdgePts;
    const line = takeHome ? priceLine : -priceLine;
    const fair = takeHome ? runLine.fairHomePrice : runLine.fairAwayPrice;
    const offered = takeHome ? runLine.offeredHomePrice : runLine.offeredAwayPrice;
    const priced = `${takeHome ? homeTeam : awayTeam} ${line > 0 ? '+' : ''}${line}`;
    const show = (n) => `${n > 0 ? '+' : ''}${Math.round(n)}`;
    const side = takeHome ? 'home' : 'away';

    // A sport can be priced without being trusted, and that is worth SAYING
    // rather than swallowing. Hockey calibrates as well as baseball but every
    // positive edge on a live card was the underdog, twelve for twelve, so the
    // numbers are shown and the recommendation is withheld.
    //
    // Its own level, because 'coinflip' is rendered as silence — which meant
    // this explanation was written carefully and then never displayed to
    // anybody.
    if (!table.verdict) {
      return {
        level: 'withheld', label: 'Priced, not advised', pick: null,
        reason: `the moneyline makes ${priced} worth ${show(fair)} against ${show(offered)} on ` +
                `offer (${pts > 0 ? '+' : ''}${pts} points), but ${table.verdictNote}`,
      };
    }

    // Two points of probability is roughly four percent on the stake, which is
    // a real bet. One point is thin but on the right side of the price. Below
    // that the market is doing its job, which is most of the time.
    if (pts >= 2) {
      return { level: 'edge', label: 'Best bet', pick: priced, side,
               reason: `the moneyline on this game says that is worth ${show(fair)} and it is ` +
                       `offered at ${show(offered)} — ${pts} points of value` };
    }
    if (pts >= 1) {
      return { level: 'slight', label: 'Slight edge', pick: priced, side,
               reason: `a little better than this game's own moneyline says it is worth ` +
                       `(fair ${show(fair)}, offered ${show(offered)}), ${pts} points` };
    }

    // No price edge — but a situation flag is a different kind of signal and
    // was being thrown away here.
    //
    // The projection is skipped for these sports because a fixed 1.5 gives it
    // nothing to disagree with. A flag is not the projection: it says something
    // is publicly known that the price may not have absorbed yet, which is the
    // one way public information beats a market. Injury classification was
    // fixed this session specifically so these fire in baseball and hockey, and
    // then every one of them died at this return.
    const flagged = (situationFlags || []).find(f => f && (f.against === 'home' || f.against === 'away'));
    if (flagged) {
      const backHome = flagged.against === 'away';
      const flagLine = backHome ? priceLine : -priceLine;
      return {
        level: 'lean', label: 'Lean', side: backHome ? 'home' : 'away',
        pick: `${backHome ? homeTeam : awayTeam} ${flagLine > 0 ? '+' : ''}${flagLine}`,
        reason: `the price is fair, but ${flagged.note ? flagged.note.replace(/\.$/, '') : 'the situation points one way'}`,
        caveat: 'this is a lean on a situation, not a price edge — the number itself is fair',
      };
    }

    return no(`${Math.abs(priceLine) === 1.5 ? 'the ' + noun + ' line' : `the ${Math.abs(priceLine)} line`} ` +
              'agrees with the moneyline on this game, so neither side is mispriced');
  }

  // --------------------------------------------------------------------
  // 3. No better number and no second market. Does anything else point?
  // --------------------------------------------------------------------
  if (!Number.isFinite(predictedMargin) || !Number.isFinite(marketSpread)) {
    return no('not enough to separate the two sides');
  }

  // Market's own expected margin is -marketSpread.
  const disagreement = predictedMargin - (-marketSpread);
  const leansHome = disagreement > 0;
  const size = Math.abs(disagreement);

  // How far the projection has to sit from the market before it is worth
  // saying: a field goal in football, and a little less in basketball where a
  // point is worth less. Stated per sport in SPORTS, deliberately not derived
  // from one sport's sigma — see the note there.
  const threshold = cfg.leanThreshold || 3;

  // Only a flag that names the side it is against may corroborate, and a flag
  // against one side supports leaning to the OTHER — a quarterback ruled out is
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

  return no('the projection agrees with the market, and nothing else separates the sides');
}

module.exports = {
  SPORTS,
  sportConfig,
  americanToDecimal,
  decimalToAmerican,
  americanToImpliedProb,
  removeVig,
  removeVigShin,
  deVigTwoWay,
  deVigTwoWayShin,
  erf,
  normalCdf,
  marginDistribution,
  coverProbability,
  overProbability,
  MARGIN_TABLES,
  NFL_RESIDUALS,
  nflResidualAbove,
  marginAtLeast,
  coverProbFromWinProb,
  runLineEdge,
  fitMismatch,
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
  lineValueProb,
  totalOutcomes,
  opponentAdjustedRatings,
  projectFromRatings,
  regressRatings,
  blendSeasonRatings,
  calibrateMarginWeights,
};
