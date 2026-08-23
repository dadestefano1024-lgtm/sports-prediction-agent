'use strict';

// Run with:  node --test
//
// Expected values here are hand-computed or standard reference figures, not
// captured from a previous run of the code. A test that only asserts "the same
// thing it did last time" would have happily locked in the away-spread grading
// bug, so every number below is derived independently.

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./model');

const close = (actual, expected, tol = 1e-6, msg) =>
  assert.ok(Math.abs(actual - expected) < tol,
    `${msg || ''} expected ${expected}, got ${actual} (tol ${tol})`);

// ----------------------------------------------------------------------------
test('americanToDecimal', () => {
  close(m.americanToDecimal(-110), 1 + 100 / 110);   // 1.9090909...
  close(m.americanToDecimal(+150), 2.5);
  close(m.americanToDecimal(+100), 2.0);
  close(m.americanToDecimal(-200), 1.5);
  assert.throws(() => m.americanToDecimal(0));
  assert.throws(() => m.americanToDecimal('abc'));
});

test('decimalToAmerican round-trips', () => {
  for (const a of [-500, -200, -110, +100, +150, +400]) {
    assert.equal(m.decimalToAmerican(m.americanToDecimal(a)), a);
  }
  assert.throws(() => m.decimalToAmerican(1));
});

test('americanToImpliedProb reproduces the 52.4% break-even line', () => {
  // A -110 bet must win 110/210 of the time to break even.
  close(m.americanToImpliedProb(-110), 110 / 210);
  close(m.americanToImpliedProb(-110), 0.5238095, 1e-6);
  close(m.americanToImpliedProb(+100), 0.5);
});

// ----------------------------------------------------------------------------
test('removeVig: two -110 sides are a coin flip once the hold is stripped', () => {
  const raw = [m.americanToImpliedProb(-110), m.americanToImpliedProb(-110)];
  const fair = m.removeVig(raw);
  close(fair[0], 0.5);
  close(fair[1], 0.5);
  close(fair[0] + fair[1], 1);
});

test('removeVig rejects degenerate input', () => {
  assert.throws(() => m.removeVig([0.5]));
  assert.throws(() => m.removeVig([]));
  assert.throws(() => m.removeVig([0, 0]));
});

test('deVigTwoWay on a standard -110/-110 market', () => {
  const { probA, probB, hold } = m.deVigTwoWay(-110, -110);
  close(probA, 0.5);
  close(probB, 0.5);
  close(hold, 2 * (110 / 210) - 1);      // 0.047619..., the familiar 4.76%
  close(hold, 0.0476190, 1e-6);
});

test('deVigTwoWay on an asymmetric market', () => {
  // -200 => 200/300 = 0.666667 ; +170 => 100/270 = 0.370370
  // sum 1.037037 -> hold 0.037037 ; fair 0.642857 / 0.357143
  const { probA, probB, hold } = m.deVigTwoWay(-200, +170);
  close(hold, 0.0370370, 1e-6);
  close(probA, 0.6428571, 1e-6);
  close(probB, 0.3571429, 1e-6);
  close(probA + probB, 1);
});

// ----------------------------------------------------------------------------
test('normalCdf against reference values', () => {
  close(m.normalCdf(0), 0.5, 1e-7);
  close(m.normalCdf(1.6448536), 0.95, 1e-6);
  close(m.normalCdf(1.959964), 0.975, 1e-6);
  close(m.normalCdf(2.5758293), 0.995, 1e-6);
  close(m.normalCdf(-1.959964), 0.025, 1e-6);
});

test('normalCdf is symmetric and monotonic', () => {
  for (const z of [0.1, 0.5, 1, 2, 3]) {
    close(m.normalCdf(z) + m.normalCdf(-z), 1, 1e-7);
  }
  let prev = -Infinity;
  for (let z = -4; z <= 4; z += 0.25) {
    const v = m.normalCdf(z);
    assert.ok(v > prev, `not monotonic at ${z}`);
    prev = v;
  }
});

// ----------------------------------------------------------------------------
test('coverProbability: a pick-em with no edge is a coin flip', () => {
  close(m.coverProbability({ predictedMargin: 0, spread: 0, sigma: 13.5 }), 0.5, 1e-7);
});

test('coverProbability: predicted margin with a flat spread', () => {
  // P(margin > 0) where margin ~ N(3, 13.5) = Phi(3/13.5) = Phi(0.222222)
  const expected = m.normalCdf(3 / 13.5);
  close(m.coverProbability({ predictedMargin: 3, spread: 0, sigma: 13.5 }), expected, 1e-9);
  close(expected, 0.5879, 1e-4);
});

test('coverProbability: laying points eats most of the edge', () => {
  // Home projected by 7 but laying 3: only the 4-point surplus counts.
  const p = m.coverProbability({ predictedMargin: 7, spread: -3, sigma: 13.5 });
  close(p, m.normalCdf(4 / 13.5), 1e-9);
  close(p, 0.6165, 1e-4);
  // and laying exactly what you project is a coin flip
  close(m.coverProbability({ predictedMargin: 7, spread: -7, sigma: 13.5 }), 0.5, 1e-7);
});

test('coverProbability: home and away are complements', () => {
  // Away covering is the same event as home failing to.
  const home = m.coverProbability({ predictedMargin: 2.5, spread: -1.5, sigma: 11.5 });
  const awayAsHome = m.coverProbability({ predictedMargin: -2.5, spread: 1.5, sigma: 11.5 });
  close(home + awayAsHome, 1, 1e-7);
});

test('coverProbability rejects bad input', () => {
  assert.throws(() => m.coverProbability({ predictedMargin: NaN, spread: 0, sigma: 13.5 }));
  assert.throws(() => m.coverProbability({ predictedMargin: 0, spread: 0, sigma: 0 }));
  assert.throws(() => m.coverProbability({ predictedMargin: 0, spread: 0, sigma: -1 }));
});

test('overProbability', () => {
  close(m.overProbability({ predictedTotal: 220, line: 220, sigma: 15 }), 0.5, 1e-7);
  close(m.overProbability({ predictedTotal: 225, line: 220, sigma: 15 }),
        m.normalCdf(5 / 15), 1e-9);
  // over and under partition the space
  const over = m.overProbability({ predictedTotal: 47.5, line: 44, sigma: 10.5 });
  const under = 1 - over;
  close(over + under, 1, 1e-12);
  assert.ok(over > under, 'projecting above the line should favour the over');
});

// ----------------------------------------------------------------------------
test('blendWithMarket honours its endpoints', () => {
  close(m.blendWithMarket(0.52, 0.60, 0), 0.52, 1e-12, 'trust 0 must be the market');
  close(m.blendWithMarket(0.52, 0.60, 1), 0.60, 1e-12, 'trust 1 must be the model');
  close(m.blendWithMarket(0.52, 0.60, 0.25), 0.54, 1e-12);
  close(m.blendWithMarket(0.52, 0.60, 0.5), 0.56, 1e-12);
});

test('blendWithMarket rejects out-of-range input', () => {
  assert.throws(() => m.blendWithMarket(1.2, 0.5, 0.25));
  assert.throws(() => m.blendWithMarket(0.5, -0.1, 0.25));
  assert.throws(() => m.blendWithMarket(0.5, 0.5, 1.5));
});

// ----------------------------------------------------------------------------
test('expectedValue is exactly zero at the break-even price', () => {
  // -110 with a 52.38% win probability is the definition of break-even.
  const ev = m.expectedValue({
    prob: m.americanToImpliedProb(-110),
    decimalOdds: m.americanToDecimal(-110),
  });
  close(ev, 0, 1e-12);
});

test('expectedValue sign follows the edge', () => {
  const d = m.americanToDecimal(-110);
  assert.ok(m.expectedValue({ prob: 0.60, decimalOdds: d }) > 0);
  assert.ok(m.expectedValue({ prob: 0.45, decimalOdds: d }) < 0);
});

test('kellyStake matches the hand-computed fraction', () => {
  // b = 10/11; f* = (b*0.55 - 0.45)/b = (0.5 - 0.45)/(10/11) = 0.055
  const full = m.kellyStake({ prob: 0.55, decimalOdds: m.americanToDecimal(-110), fraction: 1 });
  close(full, 0.055, 1e-9);
  const quarter = m.kellyStake({ prob: 0.55, decimalOdds: m.americanToDecimal(-110), fraction: 0.25 });
  close(quarter, 0.055 * 0.25, 1e-9);
});

test('kellyStake never returns a negative stake', () => {
  const d = m.americanToDecimal(-110);
  assert.equal(m.kellyStake({ prob: 0.40, decimalOdds: d }), 0);
  assert.equal(m.kellyStake({ prob: 0.50, decimalOdds: d }), 0, 'a coin flip at -110 is -EV');
  assert.equal(m.kellyStake({ prob: m.americanToImpliedProb(-110), decimalOdds: d }), 0,
    'break-even must stake nothing');
});

test('kellyStake rejects bad input', () => {
  assert.throws(() => m.kellyStake({ prob: 1.5, decimalOdds: 2 }));
  assert.throws(() => m.kellyStake({ prob: 0.5, decimalOdds: 1 }));
  assert.throws(() => m.kellyStake({ prob: 0.5, decimalOdds: 2, fraction: 0 }));
});

// ----------------------------------------------------------------------------
test('priceSide at trust=0 reports no edge and stakes nothing', () => {
  // The honest default: before calibration the model must not claim to know
  // better than the market, however confident its own probability looks.
  const r = m.priceSide({
    americanOdds: -110, oppositeAmericanOdds: -110,
    modelProb: 0.75, trust: 0,
  });
  close(r.marketProb, 0.5);
  close(r.blendedProb, 0.5);
  close(r.edge, 0, 1e-12);
  assert.equal(r.stake, 0);
});

test('priceSide surfaces every intermediate value', () => {
  const r = m.priceSide({
    americanOdds: -110, oppositeAmericanOdds: -110,
    modelProb: 0.60, trust: 0.25, kellyFraction: 0.25,
  });
  close(r.marketProb, 0.5);
  close(r.modelProb, 0.60);
  close(r.blendedProb, 0.525, 1e-12);        // 0.5 + 0.25*(0.6-0.5)
  close(r.edge, 0.025, 1e-12);
  close(r.hold, 0.0476190, 1e-6);
  close(r.decimalOdds, 1 + 100 / 110);
  assert.ok(r.expectedValue > 0, 'a 52.5% side at -110 should be +EV');
  assert.ok(r.stake > 0 && r.stake < 0.01, `stake should be small, got ${r.stake}`);
});

test('priceSide: a genuinely bad side stakes nothing', () => {
  const r = m.priceSide({
    americanOdds: -110, oppositeAmericanOdds: -110,
    modelProb: 0.30, trust: 0.25,
  });
  assert.ok(r.edge < 0);
  assert.equal(r.stake, 0);
});

// ----------------------------------------------------------------------------
test('expectedScore', () => {
  close(m.expectedScore(1500, 1500), 0.5, 1e-12);
  close(m.expectedScore(1900, 1500), 1 / (1 + Math.pow(10, -1)), 1e-12);  // ~0.909
  assert.ok(m.expectedScore(1600, 1500) > 0.5);
  assert.ok(m.expectedScore(1400, 1500) < 0.5);
});

test('updateRatings is zero-sum and moves the winner up', () => {
  const before = m.createRatings(['A', 'B']);
  const after = m.updateRatings(before, {
    home: 'A', away: 'B', homeScore: 27, awayScore: 10, sport: 'nfl',
  });
  assert.ok(after.A > before.A, 'home winner should gain');
  assert.ok(after.B < before.B, 'away loser should lose');
  close((after.A - before.A) + (after.B - before.B), 0, 1e-9, 'zero-sum');
  assert.ok(before.A === 1500, 'input must not be mutated');
});

test('updateRatings: a bigger win moves ratings further', () => {
  const base = m.createRatings(['A', 'B']);
  const narrow = m.updateRatings(base, { home: 'A', away: 'B', homeScore: 20, awayScore: 17 });
  const blowout = m.updateRatings(base, { home: 'A', away: 'B', homeScore: 45, awayScore: 3 });
  assert.ok(blowout.A - base.A > narrow.A - base.A);
});

test('updateRatings: an away upset moves more than a home favourite holding serve', () => {
  const r = { Strong: 1700, Weak: 1300 };
  const upset = m.updateRatings(r, { home: 'Strong', away: 'Weak', homeScore: 10, awayScore: 24 });
  const expected = m.updateRatings(r, { home: 'Strong', away: 'Weak', homeScore: 24, awayScore: 10 });
  assert.ok(Math.abs(upset.Weak - 1300) > Math.abs(expected.Weak - 1300),
    'the surprising result should carry more information');
});

test('predictedMargin: equal teams at home is exactly the home-field edge', () => {
  for (const sport of ['nfl', 'nba', 'mlb', 'nhl']) {
    const { hfa } = m.sportConfig(sport);
    close(m.predictedMargin({ homeRating: 1500, awayRating: 1500, sport }), hfa, 1e-12);
    close(m.predictedMargin({ homeRating: 1500, awayRating: 1500, sport, neutralSite: true }), 0, 1e-12);
  }
});

test('predictedMargin scales with the rating gap', () => {
  const { eloPerPoint, hfa } = m.sportConfig('nfl');
  close(m.predictedMargin({ homeRating: 1500 + 5 * eloPerPoint, awayRating: 1500, sport: 'nfl' }),
        5 + hfa, 1e-9);
});

// ----------------------------------------------------------------------------
test('calibrateSigma refuses to fit on too little data', () => {
  const few = Array.from({ length: 10 }, () => ({ actualMargin: 3, spread: -3 }));
  assert.equal(m.calibrateSigma(few), null);
  assert.equal(m.calibrateSigma([]), null);
});

test('calibrateSigma recovers a known spread', () => {
  // errors alternate +5 / -5 about zero -> sd of 5, mean 0
  const samples = Array.from({ length: 100 }, (_, i) => ({
    actualMargin: i % 2 === 0 ? 5 : -5, spread: 0,
  }));
  const out = m.calibrateSigma(samples);
  assert.equal(out.samples, 100);
  close(out.bias, 0, 1e-9);
  close(out.sigma, 5, 0.05);
});

test('calibrateSigma reports directional bias', () => {
  // every result lands 2 points above the spread
  const samples = Array.from({ length: 60 }, () => ({ actualMargin: 2, spread: 0 }));
  const out = m.calibrateSigma(samples);
  close(out.bias, 2, 1e-9);
});

// ----------------------------------------------------------------------------
test('closingLineValue', () => {
  // Took home -3, line closed home -5: we got 2 points the better of it.
  close(m.closingLineValue({ betSpread: -3, closingSpread: -5, side: 'home' }), 2);
  // Same move seen from the away side is 2 points worse.
  close(m.closingLineValue({ betSpread: -3, closingSpread: -5, side: 'away' }), -2);
  // No movement is no value either way.
  close(m.closingLineValue({ betSpread: -3, closingSpread: -3, side: 'home' }), 0);
  assert.equal(m.closingLineValue({ betSpread: null, closingSpread: -3, side: 'home' }), null);
});

test('sportConfig', () => {
  assert.throws(() => m.sportConfig('cricket'));
  for (const s of ['nfl', 'nba', 'mlb', 'nhl']) {
    const c = m.sportConfig(s);
    assert.ok(c.sigma > 0 && c.totalSigma > 0 && c.eloPerPoint > 0 && c.k > 0);
  }
  m.sportConfig('nfl').sigma = 999;
  assert.equal(m.sportConfig('nfl').sigma, 13.5, 'config must be returned by value');
});

// ----------------------------------------------------------------------------
test('projectFromScoringAverages: hand-computed NBA game', () => {
  // expHome = (115 + 112)/2 = 113.5 ; expAway = (108 + 110)/2 = 109
  // hfa 2.5 splits +1.25 / -1.25 -> margin 7.0, total unchanged at 222.5
  const p = m.projectFromScoringAverages({
    homeAvgScored: 115, homeAvgAllowed: 110,
    awayAvgScored: 108, awayAvgAllowed: 112,
    sport: 'nba',
  });
  close(p.predictedHome, 114.75, 1e-9);
  close(p.predictedAway, 107.75, 1e-9);
  close(p.predictedMargin, 7.0, 1e-9);
  close(p.predictedTotal, 222.5, 1e-9);
  // internal consistency: the score must reproduce the margin and the total
  close(p.predictedHome - p.predictedAway, p.predictedMargin, 1e-9);
  close(p.predictedHome + p.predictedAway, p.predictedTotal, 1e-9);
});

test('projectFromScoringAverages: home advantage moves margin but not total', () => {
  const args = {
    homeAvgScored: 115, homeAvgAllowed: 110,
    awayAvgScored: 108, awayAvgAllowed: 112, sport: 'nba',
  };
  const home = m.projectFromScoringAverages(args);
  const neutral = m.projectFromScoringAverages({ ...args, neutralSite: true });
  close(home.predictedMargin - neutral.predictedMargin, m.sportConfig('nba').hfa, 1e-9);
  close(home.predictedTotal, neutral.predictedTotal, 1e-9);
});

test('projectFromScoringAverages returns null on missing or zero data', () => {
  const base = { homeAvgScored: 115, homeAvgAllowed: 110, awayAvgScored: 108, awayAvgAllowed: 112, sport: 'nba' };
  assert.equal(m.projectFromScoringAverages({ ...base, homeAvgScored: 0 }), null,
    'a zero average means missing data, not a real average');
  assert.equal(m.projectFromScoringAverages({ ...base, awayAvgAllowed: null }), null);
  assert.equal(m.projectFromScoringAverages({ ...base, homeAvgScored: undefined }), null);
});

test('projectFromScoringAverages accepts numeric strings', () => {
  // fetchRecentGames returns toFixed(1) strings, not numbers
  const p = m.projectFromScoringAverages({
    homeAvgScored: '115.0', homeAvgAllowed: '110.0',
    awayAvgScored: '108.0', awayAvgAllowed: '112.0', sport: 'nba',
  });
  close(p.predictedMargin, 7.0, 1e-9);
});

test('confidenceFromEdge', () => {
  assert.equal(m.confidenceFromEdge(0.05), 'High');
  assert.equal(m.confidenceFromEdge(0.04), 'High');
  assert.equal(m.confidenceFromEdge(0.03), 'Medium');
  assert.equal(m.confidenceFromEdge(0.02), 'Medium');
  assert.equal(m.confidenceFromEdge(0.01), 'Low');
  assert.equal(m.confidenceFromEdge(-0.05), 'High', 'magnitude, not direction');
});

// ----------------------------------------------------------------------------
test('priceGame at trust=0 backs nothing at all', () => {
  // The market is reproduced exactly, so no side can clear the vig.
  const g = m.priceGame({
    sport: 'nba', predictedMargin: 7, predictedTotal: 230,
    spread: -3, spreadHomePrice: -110, spreadAwayPrice: -110,
    total: 220, overPrice: -110, underPrice: -110,
    trust: 0,
  });
  assert.equal(g.spread, null);
  assert.equal(g.total, null);
});

test('priceGame backs the side the projection likes', () => {
  const g = m.priceGame({
    sport: 'nba', predictedMargin: 7, predictedTotal: 230,
    spread: -3, spreadHomePrice: -110, spreadAwayPrice: -110,
    total: 220, overPrice: -110, underPrice: -110,
    homeTeam: 'Lakers', awayTeam: 'Suns', trust: 0.25,
  });
  assert.equal(g.spread.side, 'home', 'projected by 7 while laying 3 favours home');
  assert.equal(g.spread.pick, 'Lakers -3');
  assert.ok(g.spread.expectedValue > 0);
  assert.ok(g.spread.stake > 0);
  assert.equal(g.total.side, 'over', 'projecting 230 against a 220 line favours the over');
  assert.equal(g.total.pick, 'Over 220');
});

test('priceGame backs the away side and labels the line from its perspective', () => {
  const g = m.priceGame({
    sport: 'nba', predictedMargin: -8,
    spread: -3, spreadHomePrice: -110, spreadAwayPrice: -110,
    homeTeam: 'Lakers', awayTeam: 'Suns', trust: 0.25,
  });
  assert.equal(g.spread.side, 'away');
  assert.equal(g.spread.pick, 'Suns +3');
  close(g.spread.line, 3, 1e-9);
  assert.equal(g.total, null, 'no total offered means no total pick');
});

test('priceGame declines when the projection agrees with the market', () => {
  // Projected margin equals the spread: a true coin flip, which loses to the vig.
  const g = m.priceGame({
    sport: 'nfl', predictedMargin: 3, predictedTotal: 44,
    spread: -3, spreadHomePrice: -110, spreadAwayPrice: -110,
    total: 44, overPrice: -110, underPrice: -110,
    trust: 1,
  });
  assert.equal(g.spread, null, 'agreeing with the market is not a bet');
  assert.equal(g.total, null);
});

test('priceGame never returns both sides of the same market', () => {
  for (const margin of [-14, -3, 0, 3, 14]) {
    const g = m.priceGame({
      sport: 'nfl', predictedMargin: margin,
      spread: -3, spreadHomePrice: -110, spreadAwayPrice: -110,
      trust: 1,
    });
    if (g.spread) assert.ok(['home', 'away'].includes(g.spread.side));
  }
});

test('priceGame defaults missing prices to -110 rather than crashing', () => {
  const g = m.priceGame({
    sport: 'nba', predictedMargin: 9,
    spread: -3, spreadHomePrice: null, spreadAwayPrice: undefined,
    trust: 0.5,
  });
  assert.ok(g.spread, 'should still price with default juice');
  close(g.spread.decimalOdds, m.americanToDecimal(-110), 1e-9);
});

test('priceGame skips a market with no line', () => {
  const g = m.priceGame({
    sport: 'nba', predictedMargin: 9, predictedTotal: 230,
    spread: null, total: null, trust: 1,
  });
  assert.equal(g.spread, null);
  assert.equal(g.total, null);
});

test('priceGame respects a worse price', () => {
  // Same projection, but laying -140 instead of -110 should shrink the stake.
  const args = {
    sport: 'nba', predictedMargin: 9,
    spread: -3, total: null, trust: 0.5,
  };
  const cheap = m.priceGame({ ...args, spreadHomePrice: -110, spreadAwayPrice: -110 });
  const dear = m.priceGame({ ...args, spreadHomePrice: -140, spreadAwayPrice: +120 });
  assert.ok(cheap.spread && dear.spread);
  assert.ok(dear.spread.stake < cheap.spread.stake,
    `paying more juice should stake less: ${dear.spread.stake} vs ${cheap.spread.stake}`);
});

// ----------------------------------------------------------------------------
test('plausibleSpread accepts real lines', () => {
  assert.ok(m.plausibleSpread('nfl', -3));
  assert.ok(m.plausibleSpread('nfl', 7.5));
  assert.ok(m.plausibleSpread('nba', -12.5));
  assert.ok(m.plausibleSpread('mlb', -1.5));
  assert.ok(m.plausibleSpread('nhl', 1.5));
  assert.ok(m.plausibleSpread('mlb', 2.5), 'alternate run lines exist');
});

test('plausibleSpread rejects what the ESPN scrape actually produced', () => {
  // Observed live: a constant openSpread per sport, and impossible run lines.
  assert.equal(m.plausibleSpread('mlb', -8), false, 'MLB never posts -8');
  assert.equal(m.plausibleSpread('nhl', -9), false);
  assert.equal(m.plausibleSpread('nba', -10), true, 'plausible for basketball, just wrong here');
  assert.equal(m.plausibleSpread('mlb', 0), false, 'no pick-em run line');
  assert.equal(m.plausibleSpread('nhl', 0), false);
  assert.equal(m.plausibleSpread('mlb', -3), false, 'out of range for a run line');
});

test('plausibleSpread rejects malformed values', () => {
  assert.equal(m.plausibleSpread('nfl', NaN), false);
  assert.equal(m.plausibleSpread('nfl', null), false);
  assert.equal(m.plausibleSpread('nfl', undefined), false);
  assert.equal(m.plausibleSpread('nfl', ''), false);
  assert.ok(m.plausibleSpread('nfl', 0), 'but a real pick-em is valid in football');
  assert.equal(m.plausibleSpread('nfl', -3.3), false, 'spreads move in half points');
  assert.equal(m.plausibleSpread('nfl', 99), false);
  assert.equal(m.plausibleSpread('cricket', -3), false, 'unknown sport is not trusted');
});
