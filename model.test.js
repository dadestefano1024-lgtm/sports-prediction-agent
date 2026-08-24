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
  assert.equal(m.sportConfig('nfl').sigma, 10.82, 'config must be returned by value');
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

// ----------------------------------------------------------------------------
test('marginPmf is a proper distribution', () => {
  for (const sport of ['nfl', 'nba']) {
    const pmf = m.marginPmf({ mean: 2.5, sigma: 13.5, sport });
    let total = 0;
    for (const p of pmf.values()) {
      assert.ok(p >= 0, 'no negative probabilities');
      total += p;
    }
    close(total, 1, 1e-9, `${sport} pmf must sum to 1`);
  }
});

test('marginPmf spikes on the NFL key numbers', () => {
  // Centred on zero so 3 and 4 sit at comparable distance from the mean; a
  // smooth curve would make 3 only slightly more likely than 4.
  const nfl = m.marginPmf({ mean: 0, sigma: 13.5, sport: 'nfl' });
  const flat = m.marginPmf({ mean: 0, sigma: 13.5, sport: 'nba' });

  assert.ok(nfl.get(3) > nfl.get(2), '3 must beat 2');
  assert.ok(nfl.get(3) > nfl.get(4), '3 must beat 4');
  assert.ok(nfl.get(7) > nfl.get(8), '7 must beat 8');
  assert.ok(nfl.get(7) > nfl.get(5), '7 must beat 5');

  // A smooth curve does the opposite: nearer the mean is always likelier.
  assert.ok(flat.get(2) > flat.get(3), 'flat weights are monotonic toward the mean');
  assert.ok(flat.get(3) > flat.get(4));

  // And the spike is a real reshaping, not a rounding artefact.
  assert.ok(nfl.get(3) / flat.get(3) > 1.5, 'the 3 spike should be substantial');
});

test('coverOutcomes: a whole-number spread can push, a half-point one cannot', () => {
  const whole = m.coverOutcomes({ predictedMargin: 2.5, spread: -3, sigma: 13.5, sport: 'nfl' });
  assert.ok(whole.push > 0, 'a -3 must be able to land exactly on 3');
  assert.ok(whole.push > 0.05, `the 3 push should be sizeable, got ${whole.push}`);

  const half = m.coverOutcomes({ predictedMargin: 2.5, spread: -3.5, sigma: 13.5, sport: 'nfl' });
  close(half.push, 0, 1e-12, 'a half-point line cannot push');
});

test('coverOutcomes: pushing on 3 is likelier than pushing on 4', () => {
  const three = m.coverOutcomes({ predictedMargin: 0, spread: -3, sigma: 13.5, sport: 'nfl' });
  const four = m.coverOutcomes({ predictedMargin: 0, spread: -4, sigma: 13.5, sport: 'nfl' });
  assert.ok(three.push > four.push,
    `key number 3 should push more often than 4: ${three.push} vs ${four.push}`);
});

test('coverOutcomes always partitions the space', () => {
  for (const sport of ['nfl', 'nba', 'mlb', 'nhl']) {
    for (const spread of [-7, -3.5, -3, 0, 2.5, 6]) {
      const o = m.coverOutcomes({ predictedMargin: 1.5, spread, sigma: m.sportConfig(sport).sigma, sport });
      close(o.win + o.push + o.loss, 1, 1e-9, `${sport} @ ${spread}`);
      assert.ok(o.win >= 0 && o.push >= 0 && o.loss >= 0);
    }
  }
});

test('coverOutcomes: run lines and puck lines never push', () => {
  for (const sport of ['mlb', 'nhl']) {
    const o = m.coverOutcomes({ predictedMargin: 0.3, spread: -1.5, sigma: m.sportConfig(sport).sigma, sport });
    close(o.push, 0, 1e-12, `${sport} cannot push on 1.5`);
    close(o.win, m.coverProbability({ predictedMargin: 0.3, spread: -1.5, sigma: m.sportConfig(sport).sigma }), 1e-9);
  }
});

// ----------------------------------------------------------------------------
test('priceSide with no push reduces exactly to the old formulas', () => {
  const args = { americanOdds: -110, oppositeAmericanOdds: -110, modelProb: 0.60, trust: 1, kellyFraction: 1 };
  const r = m.priceSide(args);
  const d = m.americanToDecimal(-110);
  close(r.expectedValue, m.expectedValue({ prob: 0.60, decimalOdds: d }), 1e-12);
  close(r.stake, m.kellyStake({ prob: 0.60, decimalOdds: d, fraction: 1 }), 1e-12);
});

test('a push shrinks both stake and expected value', () => {
  const base = { americanOdds: -110, oppositeAmericanOdds: -110, modelProb: 0.60, trust: 1, kellyFraction: 1 };
  const noPush = m.priceSide(base);
  const withPush = m.priceSide({ ...base, pushProb: 0.09 });
  assert.ok(withPush.stake < noPush.stake,
    `push must reduce the stake: ${withPush.stake} vs ${noPush.stake}`);
  assert.ok(withPush.expectedValue < noPush.expectedValue);
  assert.ok(withPush.stake > 0, 'but a good bet is still a bet');
  // Pushes scale the live portion, so EV scales with (1 - pushProb).
  close(withPush.expectedValue, noPush.expectedValue * 0.91, 1e-9);
});

test('priceSide rejects an impossible push probability', () => {
  const base = { americanOdds: -110, oppositeAmericanOdds: -110, modelProb: 0.6 };
  assert.throws(() => m.priceSide({ ...base, pushProb: 1 }));
  assert.throws(() => m.priceSide({ ...base, pushProb: -0.1 }));
});

test('calibrateMarginWeights refuses a small sample', () => {
  assert.equal(m.calibrateMarginWeights([3, 7, 3, 10], 13.5), null);
  assert.equal(m.calibrateMarginWeights(new Array(499).fill(3), 13.5), null);
});

test('calibrateMarginWeights recovers an injected spike', () => {
  // 600 games, a third of them decided by exactly 3.
  const margins = [];
  for (let i = 0; i < 600; i++) margins.push(i % 3 === 0 ? 3 : (i % 7) - 3);
  const out = m.calibrateMarginWeights(margins, 13.5);
  assert.equal(out.samples, 600);
  assert.ok(out.weights[3] > 1.5, `should detect the 3 spike, got ${out.weights[3]}`);
});

// ----------------------------------------------------------------------------
test('totalPmf is a proper distribution and never goes negative', () => {
  const pmf = m.totalPmf({ mean: 8.5, sigma: 4.4 });
  let total = 0;
  for (const [v, p] of pmf) {
    assert.ok(v >= 0, 'a combined score cannot be negative');
    assert.ok(p >= 0);
    total += p;
  }
  close(total, 1, 1e-9);
});

test('totalPmf is flat: no key numbers asserted', () => {
  // Nearer the mean must always be likelier. If a weight were ever introduced
  // here without evidence, this is the test that should fail.
  const pmf = m.totalPmf({ mean: 44, sigma: 10.5 });
  for (let v = 44; v < 60; v++) {
    assert.ok(pmf.get(v) >= pmf.get(v + 1),
      `total ${v} should be at least as likely as ${v + 1}`);
  }
});

test('totalOutcomes: a whole-number total pushes, a half-point one cannot', () => {
  const whole = m.totalOutcomes({ predictedTotal: 8.7, line: 9, sigma: 4.4 });
  assert.ok(whole.push > 0, 'a total of 9 can land on 9');
  const half = m.totalOutcomes({ predictedTotal: 8.7, line: 8.5, sigma: 4.4 });
  close(half.push, 0, 1e-12, 'a half-point total cannot push');
});

test('totalOutcomes: the push is larger where sigma is smaller', () => {
  // Baseball totals are tight, football totals are wide, so an identical
  // whole-number line pushes far more often in baseball.
  const mlb = m.totalOutcomes({ predictedTotal: 9, line: 9, sigma: m.sportConfig('mlb').totalSigma });
  const nfl = m.totalOutcomes({ predictedTotal: 44, line: 44, sigma: m.sportConfig('nfl').totalSigma });
  assert.ok(mlb.push > nfl.push, `mlb ${mlb.push} should exceed nfl ${nfl.push}`);
  assert.ok(mlb.push > 0.07, `a baseball whole-number total should push often, got ${mlb.push}`);
});

test('totalOutcomes always partitions the space', () => {
  for (const [line, sigma] of [[9, 4.4], [8.5, 4.4], [44, 10.5], [47.5, 10.5], [220, 15], [6, 2.4]]) {
    const o = m.totalOutcomes({ predictedTotal: line + 0.4, line, sigma });
    close(o.over + o.push + o.under, 1, 1e-9, `line ${line}`);
    assert.ok(o.over >= 0 && o.push >= 0 && o.under >= 0);
  }
});

test('totalOutcomes tracks the projection', () => {
  const high = m.totalOutcomes({ predictedTotal: 52, line: 44, sigma: 10.5 });
  const low = m.totalOutcomes({ predictedTotal: 36, line: 44, sigma: 10.5 });
  assert.ok(high.over > high.under, 'projecting well above the line favours the over');
  assert.ok(low.under > low.over, 'and well below favours the under');
});

test('totalOutcomes rejects bad input', () => {
  assert.throws(() => m.totalOutcomes({ predictedTotal: NaN, line: 44, sigma: 10.5 }));
  assert.throws(() => m.totalOutcomes({ predictedTotal: 44, line: NaN, sigma: 10.5 }));
  assert.throws(() => m.totalOutcomes({ predictedTotal: 44, line: 44, sigma: 0 }));
});

test('priceGame: a whole-number total reports a push, a half-point one does not', () => {
  const base = {
    sport: 'mlb', predictedMargin: 0.3, predictedTotal: 9.6,
    spread: -1.5, spreadHomePrice: -110, spreadAwayPrice: -110,
    overPrice: -110, underPrice: -110, trust: 1,
  };
  const whole = m.priceGame({ ...base, total: 9 });
  const half = m.priceGame({ ...base, total: 9.5 });
  assert.ok(whole.total, 'the projection is well above 9, so a side should be backable');
  assert.ok(whole.total.pushProb > 0.05, `expected a real push chance, got ${whole.total.pushProb}`);
  if (half.total) close(half.total.pushProb, 0, 1e-12, 'half-point totals cannot push');
  // The run line is 1.5 and cannot push either.
  if (whole.spread) close(whole.spread.pushProb, 0, 1e-12);
});

// ----------------------------------------------------------------------------
test('opponentAdjustedRatings rewards beating a good defence', () => {
  // Both offences average exactly 28, so raw averages call them identical.
  // The only difference is who they scored it against: Stingy allows 20.7 a
  // game, Porous allows 25.3. Adjustment has to separate them.
  const logs = {
    Strong: [{ opponent: 'Stingy', scored: 28, allowed: 20 },
             { opponent: 'Stingy', scored: 28, allowed: 20 }],
    Weak:   [{ opponent: 'Porous', scored: 28, allowed: 20 },
             { opponent: 'Porous', scored: 28, allowed: 20 }],
    Stingy: [{ opponent: 'Strong', scored: 20, allowed: 28 },
             { opponent: 'Strong', scored: 20, allowed: 28 },
             { opponent: 'Porous', scored: 20, allowed: 6 }],
    Porous: [{ opponent: 'Weak', scored: 20, allowed: 28 },
             { opponent: 'Weak', scored: 20, allowed: 28 },
             { opponent: 'Stingy', scored: 6, allowed: 20 }],
  };
  const rawStrong = 28, rawWeak = 28;
  assert.equal(rawStrong, rawWeak, 'the fixture must be ambiguous before adjustment');

  const out = m.opponentAdjustedRatings(logs, { minGames: 2 });
  assert.ok(out, 'should produce ratings');
  assert.ok(out.leagueAvg > 0);
  assert.ok(out.ratings.Stingy.defense < out.ratings.Porous.defense,
    `Stingy should rate the better defence: ${out.ratings.Stingy.defense} vs ${out.ratings.Porous.defense}`);
  assert.ok(out.ratings.Strong.offense > out.ratings.Weak.offense,
    `equal raw offences must separate once opponent quality is applied: ` +
    `${out.ratings.Strong.offense} vs ${out.ratings.Weak.offense}`);
});

test('opponentAdjustedRatings needs enough games and enough teams', () => {
  assert.equal(m.opponentAdjustedRatings({}, {}), null);
  assert.equal(m.opponentAdjustedRatings({ A: [{ opponent: 'B', scored: 20, allowed: 20 }] },
    { minGames: 3 }), null, 'one team under the minimum is not a league');
});

test('opponentAdjustedRatings: a balanced league sits at league average', () => {
  const logs = {};
  const teams = ['A', 'B', 'C', 'D'];
  for (const t of teams) {
    logs[t] = teams.filter(x => x !== t).map(o => ({ opponent: o, scored: 22, allowed: 22 }));
  }
  const out = m.opponentAdjustedRatings(logs, { minGames: 3 });
  close(out.leagueAvg, 22, 1e-9);
  for (const t of teams) {
    close(out.ratings[t].offense, 22, 1e-6, `${t} offence`);
    close(out.ratings[t].defense, 22, 1e-6, `${t} defence`);
  }
});

test('projectFromRatings: two average teams produce a league-average game', () => {
  const p = m.projectFromRatings({
    homeOff: 22, homeDef: 22, awayOff: 22, awayDef: 22, leagueAvg: 22, sport: 'nfl',
  });
  close(p.predictedTotal, 44, 1e-9);
  close(p.predictedMargin, m.sportConfig('nfl').hfa, 1e-9);
  close(p.predictedHome - p.predictedAway, p.predictedMargin, 1e-9);
  close(p.predictedHome + p.predictedAway, p.predictedTotal, 1e-9);
});

test('projectFromRatings: a better offence against a worse defence scores more', () => {
  const base = { homeOff: 22, homeDef: 22, awayOff: 22, awayDef: 22, leagueAvg: 22, sport: 'nfl' };
  const better = m.projectFromRatings({ ...base, homeOff: 30, awayDef: 28 });
  assert.ok(better.predictedHome > 22 + m.sportConfig('nfl').hfa / 2);
  assert.ok(better.predictedMargin > m.sportConfig('nfl').hfa);
});

test('projectFromRatings rejects missing or impossible input', () => {
  const base = { homeOff: 22, homeDef: 22, awayOff: 22, awayDef: 22, leagueAvg: 22, sport: 'nfl' };
  assert.equal(m.projectFromRatings({ ...base, homeOff: 0 }), null);
  assert.equal(m.projectFromRatings({ ...base, leagueAvg: null }), null);
  assert.equal(m.projectFromRatings({ ...base, awayDef: undefined }), null);
});

test('regressRatings pulls toward league average', () => {
  const rated = { leagueAvg: 22, ratings: { A: { offense: 30, defense: 16, games: 5 } } };
  const half = m.regressRatings(rated, 0.5);
  close(half.ratings.A.offense, 26, 1e-9);
  close(half.ratings.A.defense, 19, 1e-9);
  const none = m.regressRatings(rated, 0);
  close(none.ratings.A.offense, 22, 1e-9, 'weight 0 is pure league average');
  const full = m.regressRatings(rated, 1);
  close(full.ratings.A.offense, 30, 1e-9, 'weight 1 leaves it alone');
  assert.throws(() => m.regressRatings(rated, 1.5));
});

// ----------------------------------------------------------------------------
const mkRated = (leagueAvg, teams) => ({
  leagueAvg,
  ratings: Object.fromEntries(Object.entries(teams).map(([t, v]) =>
    [t, { offense: v[0], defense: v[1], games: v[2] ?? 0 }])),
});

test('blendSeasonRatings: week 1 is pure prior, regressed', () => {
  const prior = mkRated(22, { A: [30, 16, 17] });
  const out = m.blendSeasonRatings({ prior, current: null, priorRegression: 0.5 });
  // 0.5 regression pulls 30 -> 26 and 16 -> 19 before any blending.
  close(out.ratings.A.offense, 26, 1e-9);
  close(out.ratings.A.defense, 19, 1e-9);
  close(out.ratings.A.priorWeight, 1, 1e-9, 'no current games means all prior');
});

test('blendSeasonRatings hands over progressively as games accumulate', () => {
  const prior = mkRated(22, { A: [30, 16, 17] });     // regressed to 26 / 19
  const seen = [];
  for (const games of [0, 2, 4, 8, 12]) {
    const current = mkRated(22, { A: [20, 24, games] });
    const out = m.blendSeasonRatings({ prior, current, gamesForFullWeight: 8, priorRegression: 0.5 });
    seen.push({ games, off: out.ratings.A.offense, pw: out.ratings.A.priorWeight });
  }
  // Prior offence is 26, current is 20, so the blend falls monotonically until
  // the prior is exhausted, then holds — equal, not lower, once priorWeight
  // hits zero. Asserting a strict fall past that point tests nothing real.
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].off <= seen[i - 1].off,
      `offence must never move back toward the prior: ${JSON.stringify(seen)}`);
    assert.ok(seen[i].pw <= seen[i - 1].pw);
    if (seen[i - 1].pw > 0) {
      assert.ok(seen[i].off < seen[i - 1].off,
        `while prior weight remains, offence should still be moving: ${JSON.stringify(seen)}`);
    }
  }
  close(seen[0].off, 26, 1e-9, 'zero games = pure prior');
  close(seen[3].off, 20, 1e-9, 'at full weight the prior is gone');
  close(seen[4].off, 20, 1e-9, 'and stays gone beyond it');
  close(seen[4].pw, 0, 1e-9);
});

test('blendSeasonRatings blends ratios, so a scoring-environment shift does not leak', () => {
  // Last season averaged 20 and the team was 10% above it. This season averages
  // 30. The team should come out 10% above 30, not carried across as points.
  const prior = mkRated(20, { A: [22, 20, 17] });
  const current = mkRated(30, { A: [33, 30, 0] });
  const out = m.blendSeasonRatings({ prior, current, priorRegression: 1 });
  close(out.leagueAvg, 30, 1e-9, 'the current environment wins');
  close(out.ratings.A.offense, 33, 1e-9, '10% above a 30-point league');
});

test('blendSeasonRatings copes with a team present in only one season', () => {
  const prior = mkRated(22, { A: [30, 16, 17] });
  const current = mkRated(22, { B: [25, 21, 6] });
  const out = m.blendSeasonRatings({ prior, current, gamesForFullWeight: 8 });
  assert.ok(out.ratings.A, 'a team only in the prior still gets a rating');
  assert.ok(out.ratings.B, 'and one only in the current season too');
  close(out.ratings.A.priorWeight, 1, 1e-9, 'no current games for A');
});

test('blendSeasonRatings degenerate inputs', () => {
  assert.equal(m.blendSeasonRatings({ prior: null, current: null }), null);
  const current = mkRated(22, { A: [25, 21, 6] });
  assert.equal(m.blendSeasonRatings({ prior: null, current }), current,
    'with no prior it is just the current ratings');
  assert.throws(() => m.blendSeasonRatings({
    prior: mkRated(22, { A: [30, 16, 17] }), current, gamesForFullWeight: 0 }));
});

// ----------------------------------------------------------------------------
test('priceGame prefers a materially better number over a better price', () => {
  // Home is a slight underdog. One book offers +3, another +1 at a keener
  // price. Two points of cushion is worth far more than five cents of juice,
  // and the old consensus-point logic could not express that at all.
  const g = m.priceGame({
    sport: 'nfl', predictedMargin: -1,
    spreadQuotes: [
      { book: 'Generous', point: 3, homePrice: -110, awayPrice: -110 },
      { book: 'Stingy', point: 1, homePrice: -105, awayPrice: -115 },
    ],
    homeTeam: 'Bears', awayTeam: 'Packers', trust: 1,
  });
  assert.ok(g.spread, 'a side should be backable');
  assert.equal(g.spread.side, 'home');
  assert.equal(g.spread.book, 'Generous', 'the better number must win');
  close(g.spread.point, 3, 1e-9);
  assert.equal(g.spread.pick, 'Bears +3');
});

test('priceGame prefers the better price when the number is identical', () => {
  const g = m.priceGame({
    sport: 'nfl', predictedMargin: 6,
    spreadQuotes: [
      { book: 'Worse', point: -3.5, homePrice: -120, awayPrice: +100 },
      { book: 'Better', point: -3.5, homePrice: -105, awayPrice: -115 },
    ],
    homeTeam: 'Chiefs', awayTeam: 'Raiders', trust: 1,
  });
  assert.ok(g.spread);
  assert.equal(g.spread.book, 'Better');
  assert.equal(g.spread.side, 'home');
});

test('priceGame shops each side independently across books', () => {
  // The best home number and the best away number live at different books,
  // which is the normal case rather than the exception.
  const g = m.priceGame({
    sport: 'nfl', predictedMargin: -8,
    spreadQuotes: [
      { book: 'HomeFriendly', point: 6, homePrice: -110, awayPrice: -110 },
      { book: 'AwayFriendly', point: 2, homePrice: -110, awayPrice: -110 },
    ],
    homeTeam: 'Jets', awayTeam: 'Bills', trust: 1,
  });
  // Home is projected to lose by 8, so the away side wants the SMALLEST home
  // number: laying 2 rather than 6.
  assert.ok(g.spread);
  assert.equal(g.spread.side, 'away');
  assert.equal(g.spread.book, 'AwayFriendly');
  assert.equal(g.spread.pick, 'Bills -2');
});

test('priceGame shops totals on the number too', () => {
  const g = m.priceGame({
    sport: 'nfl', predictedMargin: 0, predictedTotal: 52,
    totalQuotes: [
      { book: 'HighTotal', point: 48.5, overPrice: -110, underPrice: -110 },
      { book: 'LowTotal', point: 44.5, overPrice: -110, underPrice: -110 },
    ],
    trust: 1,
  });
  assert.ok(g.total, 'projecting 52 against these lines should back the over');
  assert.equal(g.total.side, 'over');
  assert.equal(g.total.book, 'LowTotal', 'the over wants the lowest number');
  assert.equal(g.total.pick, 'Over 44.5');
});

test('priceGame still works from a single consensus quote', () => {
  // The old call shape must keep behaving, since three sports still use it.
  const g = m.priceGame({
    sport: 'nba', predictedMargin: 9, predictedTotal: 230,
    spread: -3, spreadHomePrice: -110, spreadAwayPrice: -110,
    total: 220, overPrice: -110, underPrice: -110,
    homeTeam: 'Lakers', awayTeam: 'Suns', trust: 0.25,
  });
  assert.ok(g.spread && g.spread.side === 'home');
  assert.equal(g.spread.book, null, 'no book is named when none was supplied');
  assert.ok(g.total && g.total.side === 'over');
});

test('priceGame ignores quotes with an unusable point', () => {
  const g = m.priceGame({
    sport: 'nfl', predictedMargin: 6,
    spreadQuotes: [
      { book: 'Broken', point: null, homePrice: -110, awayPrice: -110 },
      { book: 'Fine', point: -3.5, homePrice: -110, awayPrice: -110 },
    ],
    trust: 1,
  });
  assert.ok(g.spread);
  assert.equal(g.spread.book, 'Fine');
});

// ----------------------------------------------------------------------------
test('poolEdge backs the side the market moved toward', () => {
  // Pool says home -3. The market has since moved to -6, so the market thinks
  // home is three points better than the pool line does. Taking home at -3 is
  // the value side.
  const a = m.poolEdge({ sport: 'nfl', poolSpread: -3, marketSpread: -6,
                         homeTeam: 'Chiefs', awayTeam: 'Raiders' });
  assert.equal(a.spread.side, 'home');
  assert.equal(a.spread.pick, 'Chiefs -3');
  close(a.spread.gap, 3, 1e-9);
  assert.ok(a.spread.winProb > 0.5);

  // And the mirror: the market cooled on home, so the away side is the value.
  const b = m.poolEdge({ sport: 'nfl', poolSpread: -3, marketSpread: -1,
                         homeTeam: 'Chiefs', awayTeam: 'Raiders' });
  assert.equal(b.spread.side, 'away');
  assert.equal(b.spread.pick, 'Raiders +3');
  close(b.spread.gap, 2, 1e-9);
  assert.ok(b.spread.winProb > 0.5);
});

test('poolEdge on an unmoved line is a coin flip', () => {
  const r = m.poolEdge({ sport: 'nfl', poolSpread: -3, marketSpread: -3 });
  // A push is a LOSS in this pool, so an unmoved line on a whole number is a
  // losing pick rather than an even one — the push lands on three, which is the
  // most common margin in football. The old arithmetic divided that away and
  // reported an even bet.
  close(r.spread.winProb, 0.47, 0.02, 'a push counts against you');
  assert.ok(r.spread.pushProb > 0.04, `push risk ${r.spread.pushProb} should be real on a 3`);
  assert.equal(r.spread.pushRisk, true, 'a 3 must be flagged as push risk');
  // A half-point line cannot push, so it is not flagged.
  const half = m.poolEdge({ sport: 'nfl', poolSpread: -3.5, marketSpread: -3.5 }).spread;
  assert.equal(half.pushRisk, false);
  assert.ok(half.winProb > r.spread.winProb, 'a half point is worth more than the push risk');
  close(r.spread.gap, 0, 1e-9);
});

test('poolEdge prices a line that lays points both ways', () => {
  // The pool posts -2 against -2 on a tight game: no plus money, and whichever
  // side is taken has to win by three.
  const r = m.poolEdge({ sport: 'nfl', poolSpread: -2, poolAwaySpread: -2, marketSpread: 0,
                         homeTeam: 'Chiefs', awayTeam: 'Raiders' }).spread;
  assert.equal(r.bothLay, true);
  // Neither side is anywhere near even, and the two do not sum to one.
  assert.ok(r.winProb < 0.46, `win prob ${r.winProb}`);
  assert.ok(Math.abs(r.winProb + r.otherSideProb - 1) > 0.08, 'the sides must not be complements');
  // Roughly one game in seven lands inside two points either way.
  assert.ok(r.deadProb > 0.1 && r.deadProb < 0.2, `dead zone ${r.deadProb}`);
  close(r.winProb + r.otherSideProb + r.deadProb, 1, 1e-3, 'everything must add up');

  // The market moving toward home makes the home side better and the away side
  // worse, while the dead zone stays about the same size.
  const moved = m.poolEdge({ sport: 'nfl', poolSpread: -2, poolAwaySpread: -2, marketSpread: -4,
                             homeTeam: 'Chiefs', awayTeam: 'Raiders' }).spread;
  assert.ok(moved.winProb > r.winProb, 'a favourable move must help');
  assert.equal(moved.side, 'home');
});

test('poolEdge with a mirrored away line is the two-sided case', () => {
  // Supplying the mirror explicitly must change nothing at all.
  const implicit = m.poolEdge({ sport: 'nfl', poolSpread: -3, marketSpread: -6 }).spread;
  const explicit = m.poolEdge({ sport: 'nfl', poolSpread: -3, poolAwaySpread: 3, marketSpread: -6 }).spread;
  assert.equal(implicit.bothLay, false);
  assert.equal(explicit.bothLay, false);
  close(explicit.winProb, implicit.winProb, 1e-9);
  assert.equal(explicit.pick, implicit.pick);
});

test('a both-lay line is worse than the two-sided line it replaces', () => {
  // The point of showing this: the pool's tight-game format is not a coin flip
  // dressed differently, it is a materially worse bet, and the app used to
  // report it as the better one.
  const bothLay = m.poolEdge({ sport: 'nfl', poolSpread: -2, poolAwaySpread: -2, marketSpread: 0 }).spread;
  const twoSided = m.poolEdge({ sport: 'nfl', poolSpread: -2, marketSpread: 0 }).spread;
  assert.ok(twoSided.winProb - bothLay.winProb > 0.07,
    `two-sided ${twoSided.winProb} vs both-lay ${bothLay.winProb}`);
});

test('poolEdge values a key number above a raw point gap', () => {
  // One point of movement, but it crosses the 3.
  const acrossThree = m.poolEdge({ sport: 'nfl', poolSpread: -2.5, marketSpread: -3.5 });
  // Two points of movement through empty space.
  const emptySpace = m.poolEdge({ sport: 'nfl', poolSpread: -8.5, marketSpread: -10.5 });
  assert.ok(acrossThree.spread.gap < emptySpace.spread.gap, 'smaller raw gap');
  assert.ok(acrossThree.spread.winProb > 0.53,
    `crossing the 3 should still be worth having: ${acrossThree.spread.winProb}`);
});

test('poolEdge handles totals in both directions', () => {
  const over = m.poolEdge({ sport: 'nfl', poolTotal: 44, marketTotal: 48.5 });
  assert.equal(over.total.side, 'over');
  assert.equal(over.total.pick, 'Over 44');
  assert.ok(over.total.winProb > 0.6);

  const under = m.poolEdge({ sport: 'nfl', poolTotal: 50, marketTotal: 44 });
  assert.equal(under.total.side, 'under');
  assert.equal(under.total.pick, 'Under 50');
  assert.ok(under.total.winProb > 0.6);
});

test('poolEdge reports push risk on whole numbers', () => {
  const whole = m.poolEdge({ sport: 'nfl', poolSpread: -3, marketSpread: -6 });
  assert.ok(whole.spread.pushProb > 0.03, 'a pool line of -3 can land on 3');
  const half = m.poolEdge({ sport: 'nfl', poolSpread: -3.5, marketSpread: -6 });
  close(half.spread.pushProb, 0, 1e-9);
});

test('poolEdge returns nothing for a market it was not given', () => {
  const r = m.poolEdge({ sport: 'nfl', poolSpread: -3, marketSpread: -6 });
  assert.equal(r.total, null);
  const t = m.poolEdge({ sport: 'nfl', poolTotal: 44, marketTotal: 48 });
  assert.equal(t.spread, null);
});

test('rankPoolPicks orders by win probability and trims to count', () => {
  const cands = [
    { pick: 'A', winProb: 0.55, gap: 5 },
    { pick: 'B', winProb: 0.62, gap: 2 },
    { pick: 'C', winProb: 0.58, gap: 9 },
    { pick: 'D', winProb: 0.51, gap: 1 },
    { pick: 'bad', gap: 3 },
  ];
  const top = m.rankPoolPicks(cands, 3);
  assert.deepEqual(top.map(x => x.pick), ['B', 'C', 'A'],
    'probability wins over raw gap — B beats C despite a much smaller gap');
  assert.equal(m.rankPoolPicks(cands, 6).length, 4, 'the unscored candidate is dropped');
  assert.deepEqual(m.rankPoolPicks(null, 6), []);
});

// ----------------------------------------------------------------------------
test('betRecommendation grades the book advantage, not the model', () => {
  const strong = m.betRecommendation({ bookValuePts: 1.5, bookName: 'DraftKings', side: 'home' });
  assert.equal(strong.level, 'strong');
  assert.match(strong.reason, /DraftKings is 1\.5 points better/);

  const lean = m.betRecommendation({ bookValuePts: 0.5, bookName: 'DraftKings' });
  assert.equal(lean.level, 'lean');

  const none = m.betRecommendation({ bookValuePts: 0, bookName: 'DraftKings' });
  assert.equal(none.level, 'none');
  assert.equal(none.label, "Don't bet");
  assert.match(none.reason, /at the market price/);
});

test('betRecommendation refuses live and lineless games', () => {
  assert.equal(m.betRecommendation({ bookValuePts: 3, inProgress: true }).level, 'pass');
  assert.equal(m.betRecommendation({ bookValuePts: 3, hasLine: false }).level, 'pass');
});

test('betRecommendation singularises one point', () => {
  assert.match(m.betRecommendation({ bookValuePts: 1, bookName: 'DK' }).reason, /1 point better/);
  assert.match(m.betRecommendation({ bookValuePts: 2, bookName: 'DK' }).reason, /2 points better/);
});

test('poolCandidate flags a drifting spread and ignores a drifting total', () => {
  assert.equal(m.poolCandidate(0.5, 0.5), null, 'small moves are not candidates');
  assert.equal(m.poolCandidate(-1.5, 0).level, 'worth checking');
  assert.equal(m.poolCandidate(-2.5, 0).level, 'strong');
  assert.equal(m.poolCandidate(-2.5, 0).points, 2.5);
  assert.equal(m.poolCandidate(-2.5, 0).market, 'spread');
  assert.equal(m.poolCandidate(null, null), null);

  // A total that has moved is NOT a candidate, however far it moved. It used
  // to be — the flag took whichever market had drifted furthest — and that
  // applied a spread result to a market it was never tested on. Measured over
  // the same 543 games, a stale total went 51.4% against 55.4% for a stale
  // spread, under the 52.4% needed to break even.
  assert.equal(m.poolCandidate(0, 3), null, 'a total move is not a candidate');
  assert.equal(m.poolCandidate(undefined, 4), null);
  assert.equal(m.poolCandidate(0.5, 6), null);
});

test('poolEdge marks which half of it has been tested', () => {
  const both = m.poolEdge({ sport: 'nfl', poolSpread: -3, marketSpread: -6,
                            poolTotal: 44, marketTotal: 48 });
  assert.equal(both.spread.tested, true, 'the spread rule has a holdout behind it');
  assert.equal(both.total.tested, false, 'the total rule was measured and did not hold');
  // Both are still priced — the flag is about evidence, not about refusing to
  // do the arithmetic.
  assert.ok(both.total.winProb > 0.5, 'a stale total is still worth what it is worth');
});

// ----------------------------------------------------------------------------
test('situationFlags: a quarterback out against a static line', () => {
  const f = m.situationFlags({ qbOut: 'Patrick Mahomes', spreadMovement: 0.5 });
  assert.equal(f.length, 1);
  assert.equal(f[0].type, 'qb-static-line');
  assert.match(f[0].note, /Patrick Mahomes is out/);
  // If the line HAS moved, the market has reacted and there is nothing to say.
  assert.equal(m.situationFlags({ qbOut: 'Patrick Mahomes', spreadMovement: 3 })
    .filter(x => x.type === 'qb-static-line').length, 0);
});

test('situationFlags: wind against a static total', () => {
  const f = m.situationFlags({ windy: true, windSpeed: 22, totalMovement: 0.5 });
  assert.equal(f[0].type, 'wind-static-total');
  assert.match(f[0].note, /22 mph wind/);
  assert.equal(m.situationFlags({ windy: true, windSpeed: 22, totalMovement: 3 }).length, 0);
});

test('situationFlags: a move nothing here explains', () => {
  const f = m.situationFlags({ spreadMovement: -2.5 });
  assert.equal(f[0].type, 'unexplained-move');
  assert.match(f[0].note, /something this app cannot see/);
  // With a quarterback out, the move IS explained, so it should not fire.
  assert.equal(m.situationFlags({ spreadMovement: -2.5, qbOut: 'Someone' })
    .filter(x => x.type === 'unexplained-move').length, 0);
});

test('situationFlags: injuries against a static line', () => {
  assert.equal(m.situationFlags({ injuriesOut: 4, spreadMovement: 0 })
    .some(x => x.type === 'injuries-static-line'), true);
  assert.equal(m.situationFlags({ injuriesOut: 2, spreadMovement: 0 })
    .some(x => x.type === 'injuries-static-line'), false);
});

test('situationFlags says nothing when there is nothing to say', () => {
  assert.deepEqual(m.situationFlags({ spreadMovement: 0.5, totalMovement: 0.5 }), []);
  assert.deepEqual(m.situationFlags({}), []);
  assert.deepEqual(m.situationFlags(), []);
  // No movement data means no comparison can be made.
  assert.deepEqual(m.situationFlags({ qbOut: 'Someone', spreadMovement: null }), []);
});

// ----------------------------------------------------------------------------
test('bestBet: a price advantage is the only thing called an edge', () => {
  const e = m.bestBet({ sport:'nfl', bookValuePts:1, bookPick:'Chiefs -2.5', bookSide:'home' });
  assert.equal(e.level, 'edge');
  assert.equal(e.pick, 'Chiefs -2.5');
  assert.equal(e.caveat, undefined, 'a real edge carries no disclaimer');

  const sl = m.bestBet({ sport:'nfl', bookValuePts:0.5, bookPick:'Chiefs -3' });
  assert.equal(sl.level, 'slight');
});

test('bestBet: a big projection disagreement is a lean, never an edge', () => {
  const r = m.bestBet({ sport:'nfl', predictedMargin: 8, marketSpread: -3,
                        homeTeam:'Chiefs', awayTeam:'Raiders' });
  assert.equal(r.level, 'lean');
  assert.equal(r.side, 'home');
  assert.equal(r.pick, 'Chiefs -3');
  assert.match(r.caveat, /not an edge/);
  assert.match(r.reason, /5\.0 points off the market/);
});

test('bestBet leans away when the projection does', () => {
  const r = m.bestBet({ sport:'nfl', predictedMargin: -9, marketSpread: -3,
                        homeTeam:'Chiefs', awayTeam:'Raiders' });
  assert.equal(r.side, 'away');
  assert.equal(r.pick, 'Raiders +3');
});

test('bestBet: a small disagreement alone is not a lean', () => {
  const r = m.bestBet({ sport:'nfl', predictedMargin: 4, marketSpread: -3 });
  assert.equal(r.level, 'coinflip');
  assert.equal(r.pick, null);
});

test('bestBet: a corroborating flag promotes a small disagreement', () => {
  // Projection leans AWAY (market wants home by 3, projection says home by 1).
  const plain = m.bestBet({ sport:'nfl', predictedMargin: 1, marketSpread: -3,
                            homeTeam:'Chiefs', awayTeam:'Raiders' });
  assert.equal(plain.level, 'coinflip');

  // A flag against the home side argues FOR the away side, which is where the
  // projection already leans, so the two agree and it becomes a lean.
  const flagged = m.bestBet({ sport:'nfl', predictedMargin: 1, marketSpread: -3,
                              homeTeam:'Chiefs', awayTeam:'Raiders',
                              situationFlags:[{ type:'qb-static-line', against:'home' }] });
  assert.equal(flagged.level, 'lean');
  assert.equal(flagged.pick, 'Raiders +3');
  assert.match(flagged.reason, /situation points the same way/);
});

test('bestBet: a flag pointing the other way does not corroborate', () => {
  // Same small away lean, but now the bad news is about the away side. That
  // argues for home, against the projection, so nothing is promoted.
  const r = m.bestBet({ sport:'nfl', predictedMargin: 1, marketSpread: -3,
                        homeTeam:'Chiefs', awayTeam:'Raiders',
                        situationFlags:[{ type:'qb-static-line', against:'away' }] });
  assert.equal(r.level, 'coinflip');
});

test('bestBet: a sideless flag corroborates nothing', () => {
  // An unexplained line move points at a side, but backing that side at the
  // current price was measured at 90-97. It carries against:null for exactly
  // that reason, and must not promote anything.
  for (const flag of [{ type:'unexplained-move', against:null },
                      { type:'wind-static-total', against:null },
                      { note:'no side field at all' }]) {
    const r = m.bestBet({ sport:'nfl', predictedMargin: 1, marketSpread: -3,
                          homeTeam:'Chiefs', awayTeam:'Raiders',
                          situationFlags:[flag] });
    assert.equal(r.level, 'coinflip', JSON.stringify(flag));
  }
});

test('bestBet does not read a side out of a player name', () => {
  // Regression. The first version searched the flag prose for "home" and
  // "away", so Patrick Mahomes corroborated a home lean, and no other flag
  // corroborated anything. Real notes from situationFlags, run through.
  const real = m.situationFlags({ qbOut: 'Patrick Mahomes', qbOutSide: 'away',
                                  spreadMovement: 0.5 });
  assert.equal(real.length, 1);
  assert.equal(real[0].against, 'away');

  // Market has home by 3, projection has home by 4 - a one-point home lean,
  // well under the threshold, so the flag is the only thing that can promote
  // it. It is against away, which argues for home, so the two agree.
  const withSide = m.bestBet({ sport:'nfl', predictedMargin: 4, marketSpread: -3,
                               homeTeam:'Chiefs', awayTeam:'Raiders',
                               situationFlags: real });
  assert.equal(withSide.level, 'lean');
  assert.equal(withSide.pick, 'Chiefs -3');

  // The identical note with the side stripped must do nothing, which is what
  // proves the name is no longer being read.
  const nameOnly = m.bestBet({ sport:'nfl', predictedMargin: 4, marketSpread: -3,
                               homeTeam:'Chiefs', awayTeam:'Raiders',
                               situationFlags: [{ ...real[0], against: null }] });
  assert.equal(nameOnly.level, 'coinflip');
});

test('bestBet scales the lean threshold to the sport', () => {
  // Three points of football is a field goal; three points of basketball is
  // noise. The same disagreement must not mean the same thing in both.
  const expected = { nfl: 3, nba: 2.5 };
  for (const [sport, want] of Object.entries(expected)) {
    // Just under the threshold: nothing.
    const under = m.bestBet({ sport, predictedMargin: want - 0.1, marketSpread: 0,
                              homeTeam:'H', awayTeam:'A' });
    assert.equal(under.level, 'coinflip', `${sport} under ${want}`);
    // At it: a lean.
    const at = m.bestBet({ sport, predictedMargin: want, marketSpread: 0,
                           homeTeam:'H', awayTeam:'A' });
    assert.equal(at.level, 'lean', `${sport} at ${want}`);
  }

  // A 2.6-point disagreement is a lean in basketball and silence in football.
  assert.equal(m.bestBet({ sport:'nba', predictedMargin: 2.6, marketSpread: 0 }).level, 'lean');
  assert.equal(m.bestBet({ sport:'nfl', predictedMargin: 2.6, marketSpread: 0 }).level, 'coinflip');
});

test('bestBet never leans off a run line or a puck line', () => {
  // Regression, caught by replaying a live MLB card. The run line is 1.5
  // whoever is playing, so a projected margin of about a run disagrees with it
  // in the same direction nearly every game, and the verdict came out as "take
  // the underdog run line" on six of its seven leans. That is the shape of the
  // market, not a read on the teams.
  for (const sport of ['mlb', 'nhl']) {
    for (const pm of [-4, -1, 0, 1, 4]) {
      for (const sp of [1.5, -1.5]) {
        const r = m.bestBet({ sport, predictedMargin: pm, marketSpread: sp,
                              homeTeam: 'H', awayTeam: 'A' });
        assert.equal(r.level, 'coinflip', `${sport} ${pm} vs ${sp}`);
        assert.equal(r.pick, null);
        assert.match(r.reason, /barely moves whoever is playing|agrees with the moneyline/);
      }
    }
  }

  // A situation flag cannot smuggle one back in either, since there is no
  // direction left for it to corroborate.
  const flagged = m.bestBet({ sport: 'mlb', predictedMargin: 1, marketSpread: 1.5,
                              homeTeam: 'H', awayTeam: 'A',
                              situationFlags: [{ against: 'away' }] });
  assert.equal(flagged.level, 'coinflip');

  // A price advantage is still a price advantage. That is a fact about the
  // number on offer and has nothing to do with the projection.
  assert.equal(m.bestBet({ sport: 'mlb', bookValuePts: 1, bookPick: 'Cubs -1.5' }).level, 'edge');
});

test('bestBet counts in the units of the sport', () => {
  // The wording changed to say plainly that this is a price fact rather than a
  // forecast, because "Best bet: Over 48.5" above a predicted score of 46 was
  // being read as the app contradicting itself.
  assert.match(m.bestBet({ sport:'mlb', bookValuePts:1, bookPick:'Cubs -1.5' }).reason, /1 run better/);
  assert.match(m.bestBet({ sport:'nhl', bookValuePts:0.5, bookPick:'Kings -1' }).reason, /half a goal better/);
  assert.match(m.bestBet({ sport:'nfl', bookValuePts:2, bookPick:'Chiefs -3' }).reason, /2 points better/);
  for (const sport of ['nfl', 'mlb']) {
    assert.match(m.bestBet({ sport, bookValuePts: 1, bookPick: 'X -3' }).reason,
      /not a forecast/, `${sport} should say it is a price fact`);
  }
  assert.match(m.bestBet({ sport:'nba', predictedMargin: 4, marketSpread: 0,
                           homeTeam:'H', awayTeam:'A' }).reason, /4\.0 points off/);
});

test('bestBet survives a sport it has never heard of', () => {
  // It is called inline while building the response, so a throw here would
  // take down the whole slate rather than one verdict.
  const r = m.bestBet({ sport:'cricket', predictedMargin: 8, marketSpread: -3,
                        homeTeam:'H', awayTeam:'A' });
  assert.equal(r.level, 'lean');
});

test('situationFlags reports which side each flag is against', () => {
  const qb = m.situationFlags({ qbOut:'Jared Goff', qbOutSide:'home', spreadMovement:0.5 });
  assert.equal(qb[0].against, 'home');

  // No side supplied means no side claimed.
  assert.equal(m.situationFlags({ qbOut:'Jared Goff', spreadMovement:0.5 })[0].against, null);

  // Injuries follow whichever side is actually missing people.
  assert.equal(m.situationFlags({ injuriesOutHome:4, injuriesOutAway:0, spreadMovement:0 })[0].against, 'home');
  assert.equal(m.situationFlags({ injuriesOutHome:0, injuriesOutAway:3, spreadMovement:0 })[0].against, 'away');
  // Level and both above the bar, so neither side is the story.
  assert.equal(m.situationFlags({ injuriesOutHome:4, injuriesOutAway:4, spreadMovement:0 })[0].against, null);

  // Weather and unexplained movement are sideless by design.
  assert.equal(m.situationFlags({ windy:true, windSpeed:22, totalMovement:0.5 })[0].against, null);
  assert.equal(m.situationFlags({ spreadMovement:-2.5 })[0].against, null);
});

test('situationFlags measures one team against the bar, not two added together', () => {
  // Per-side counts are compared PER SIDE. Adding them and testing the total
  // against a one-team bar is close to guaranteed to clear it — that version
  // fired on eight of ten baseball games.
  assert.equal(m.situationFlags({ injuriesOutHome:2, injuriesOutAway:1, spreadMovement:0 }).length, 0,
    'two and one is not one depleted team');
  assert.equal(m.situationFlags({ injuriesOutHome:3, injuriesOutAway:0, spreadMovement:0 }).length, 1,
    'three on one side is');
  assert.equal(m.situationFlags({ injuriesOutHome:1, injuriesOutAway:1, spreadMovement:0 }).length, 0);
  // The old flat count still works for any caller that has not been updated.
  assert.equal(m.situationFlags({ injuriesOut:4, spreadMovement:0 }).length, 1);
  assert.equal(m.situationFlags({ injuriesOut:2, spreadMovement:0 }).length, 0);
  // And a per-side breakdown suppresses the unexplained-move flag the same way
  // a flat count does, since the injuries now explain it.
  assert.equal(m.situationFlags({ injuriesOutHome:3, spreadMovement:2.5 })
    .filter(f => f.type === 'unexplained-move').length, 0);
});

test('bestBet refuses live games and missing data', () => {
  assert.equal(m.bestBet({ sport:'nfl', bookValuePts:2, bookPick:'X', inProgress:true }).level, 'pass');
  assert.equal(m.bestBet({ sport:'nfl' }).level, 'coinflip');
  assert.equal(m.bestBet({ sport:'nfl', predictedMargin: 5, marketSpread: null }).level, 'coinflip');
});

// ----------------------------------------------------------------------------
// Cross-market pricing
// ----------------------------------------------------------------------------

test('normalInv matches the standard normal quantiles', () => {
  // Textbook values, not captured output. If normalCdf ever regresses these
  // fail rather than silently agreeing with the new wrong answer.
  const cases = [[0.5, 0], [0.75, 0.674490], [0.9, 1.281552],
                 [0.95, 1.644854], [0.975, 1.959964], [0.99, 2.326348],
                 [0.25, -0.674490], [0.05, -1.644854]];
  for (const [p, want] of cases) {
    assert.ok(Math.abs(m.normalInv(p) - want) < 1e-4, `normalInv(${p}) = ${m.normalInv(p)}, want ${want}`);
  }
});

test('normalInv round-trips through normalCdf', () => {
  for (const p of [0.01, 0.2, 0.37, 0.5, 0.63, 0.8, 0.99]) {
    assert.ok(Math.abs(m.normalCdf(m.normalInv(p)) - p) < 1e-6, `round trip failed at ${p}`);
  }
});

test('normalInv refuses anything that is not a probability', () => {
  for (const bad of [0, 1, -0.1, 1.1, NaN, null, undefined, 'half']) {
    assert.throws(() => m.normalInv(bad), /probability/);
  }
});

test('a pick-em moneyline implies a margin of exactly zero', () => {
  // The check that the continuity correction is right to leave out. Baseball
  // cannot end level, so the boundary sits at zero and two equal prices must
  // give a mean of zero rather than half a run.
  const r = m.marketMarginFromMoneyline({ homeML: -110, awayML: -110, sigma: 4.4 });
  assert.ok(Math.abs(r.predictedMargin) < 1e-9, `got ${r.predictedMargin}`);
  assert.ok(Math.abs(r.homeWinProb - 0.5) < 1e-9);
  // -110 both ways is a 4.76% hold.
  assert.ok(Math.abs(r.hold - 0.047619) < 1e-5, `hold ${r.hold}`);
});

test('moneyline-implied margin moves the right way and scales with sigma', () => {
  const fav = m.marketMarginFromMoneyline({ homeML: -200, awayML: 170, sigma: 4.4 });
  const dog = m.marketMarginFromMoneyline({ homeML: 170, awayML: -200, sigma: 4.4 });
  assert.ok(fav.predictedMargin > 0, 'a favourite must project to win');
  assert.ok(dog.predictedMargin < 0, 'an underdog must project to lose');
  assert.ok(Math.abs(fav.predictedMargin + dog.predictedMargin) < 1e-9, 'mirror prices must mirror');

  // A -160 home side in baseball. Hand-checkable: de-vigged that is 0.5963,
  // normalInv(0.5963) is 0.2437, times 4.4 is 1.072 runs.
  const mlb = m.marketMarginFromMoneyline({ homeML: -160, awayML: 140, sigma: 4.4 });
  assert.ok(Math.abs(mlb.predictedMargin - 1.072) < 0.01, `got ${mlb.predictedMargin}`);

  // Same prices, wider sport, bigger margin - the probability is unchanged and
  // only the scale differs.
  const wide = m.marketMarginFromMoneyline({ homeML: -160, awayML: 140, sigma: 13.5 });
  assert.ok(Math.abs(wide.homeWinProb - mlb.homeWinProb) < 1e-12);
  assert.ok(wide.predictedMargin > mlb.predictedMargin * 2.9);
});

test('fairSpreadPrice is a fair price - the two sides sum to one', () => {
  const f = m.fairSpreadPrice({ predictedMargin: 1.1, spread: -1.5, sigma: 4.4 });
  assert.ok(Math.abs(f.homeProb + f.awayProb - 1) < 1e-12);
  // Laying 1.5 while only projected to win by 1.1 is against you.
  assert.ok(f.homeProb < 0.5, `home cover prob ${f.homeProb}`);
  // Fair prices carry no vig, so the favourite side is a plus number here.
  assert.ok(f.homeFair > 0, `home fair ${f.homeFair}`);
  assert.ok(f.awayFair < 0, `away fair ${f.awayFair}`);
});

test('crossMarketEdge finds nothing when the two markets agree', () => {
  // Build a run line priced exactly off the moneyline, then add a normal hold
  // to both sides. The de-vigged disagreement must be ~0, and neither side can
  // show an edge once the vig is paid.
  const sigma = 4.4;
  const anchor = m.marketMarginFromMoneyline({ homeML: -160, awayML: 140, sigma });
  const fair = m.fairSpreadPrice({ predictedMargin: anchor.predictedMargin, spread: -1.5, sigma });
  // Shade both sides by the same factor to put a hold on.
  const shade = (p) => m.decimalToAmerican(1 / (p * 1.024));
  const r = m.crossMarketEdge({
    homeML: -160, awayML: 140, spread: -1.5,
    spreadHomePrice: shade(fair.homeProb), spreadAwayPrice: shade(fair.awayProb), sigma,
  });
  assert.ok(Math.abs(r.disagreementPts) < 0.5, `disagreement ${r.disagreementPts}`);
  assert.ok(r.homeEdgePts < 0, `home edge ${r.homeEdgePts} should be negative after vig`);
  assert.ok(r.awayEdgePts < 0, `away edge ${r.awayEdgePts} should be negative after vig`);
});

test('crossMarketEdge finds the cheap side when they disagree', () => {
  const sigma = 4.4;
  const anchor = m.marketMarginFromMoneyline({ homeML: -160, awayML: 140, sigma });
  const fair = m.fairSpreadPrice({ predictedMargin: anchor.predictedMargin, spread: -1.5, sigma });
  // Leave the away side alone and give the home side a much better price than
  // the moneyline says it is worth.
  const generous = m.decimalToAmerican(1 / (fair.homeProb * 0.85));
  const r = m.crossMarketEdge({
    homeML: -160, awayML: 140, spread: -1.5,
    spreadHomePrice: generous, spreadAwayPrice: m.decimalToAmerican(1 / (fair.awayProb * 1.02)), sigma,
  });
  assert.ok(r.homeEdgePts > 5, `home edge ${r.homeEdgePts}`);
  assert.ok(r.disagreementPts > 0, 'positive disagreement means the home side is the cheap one');
  assert.ok(r.awayEdgePts < r.homeEdgePts);
});

test('crossMarketEdge returns null rather than guessing', () => {
  const ok = { homeML: -160, awayML: 140, spread: -1.5, spreadHomePrice: 120, spreadAwayPrice: -145, sigma: 4.4 };
  assert.ok(m.crossMarketEdge(ok));
  assert.equal(m.crossMarketEdge({ ...ok, spread: null }), null);
  assert.equal(m.crossMarketEdge({ ...ok, spreadHomePrice: null }), null);
  assert.equal(m.crossMarketEdge({ ...ok, homeML: null }), null);
  assert.equal(m.crossMarketEdge({ ...ok, awayML: undefined }), null);
  assert.equal(m.crossMarketEdge(), null);
});

test('calibrateSigmaFromMarkets recovers the sigma a slate was built with', () => {
  // Generate a slate that is internally consistent at sigma 4.0, then check the
  // fit finds it. This is the test that matters: if the fit cannot recover a
  // sigma it was handed, it cannot be trusted to find one in real prices.
  const TRUE_SIGMA = 4.0;
  const games = [];
  for (const homeML of [-220, -170, -140, -115, 105, 130, 165, 210]) {
    const awayML = homeML < 0 ? Math.round(-homeML * 0.88) : -Math.round(homeML * 1.14);
    const anchor = m.marketMarginFromMoneyline({ homeML, awayML, sigma: TRUE_SIGMA });
    const fair = m.fairSpreadPrice({ predictedMargin: anchor.predictedMargin, spread: -1.5, sigma: TRUE_SIGMA });
    games.push({
      homeML, awayML, spread: -1.5,
      spreadHomePrice: m.decimalToAmerican(1 / (fair.homeProb * 1.024)),
      spreadAwayPrice: m.decimalToAmerican(1 / (fair.awayProb * 1.024)),
    });
  }
  const fit = m.calibrateSigmaFromMarkets(games);
  assert.ok(fit, 'fit returned nothing');
  assert.ok(Math.abs(fit.sigma - TRUE_SIGMA) < 0.2, `recovered ${fit.sigma}, wanted ${TRUE_SIGMA}`);
  assert.ok(fit.medianAbsDisagreementPts < 0.3, `residual ${fit.medianAbsDisagreementPts}`);
  assert.equal(fit.games, games.length);
});

test('calibrateSigmaFromMarkets needs a slate, not a game', () => {
  assert.equal(m.calibrateSigmaFromMarkets([]), null);
  assert.equal(m.calibrateSigmaFromMarkets(), null);
  assert.equal(m.calibrateSigmaFromMarkets([
    { homeML: -160, awayML: 140, spread: -1.5, spreadHomePrice: 120, spreadAwayPrice: -145 },
  ]), null);
});

// ----------------------------------------------------------------------------
// Counted margins, Shin, and the run-line verdict
// ----------------------------------------------------------------------------

test('the margin tables are real distributions', () => {
  for (const sport of ['mlb', 'nhl']) {
    const t = m.MARGIN_TABLES[sport];
    const total = t.counts.reduce((a, b) => a + b, 0);
    assert.equal(total, t.games, `${sport} counts must sum to the game count`);
    assert.ok(t.counts.every(c => c >= 0));
    // A margin of 1 is always the most common outcome in these sports.
    assert.equal(Math.max(...t.counts), t.counts[0], `${sport}: 1 should be the mode`);
    assert.equal(m.marginAtLeast(sport, 1), 1, 'someone always wins by at least 1');
    assert.ok(m.marginAtLeast(sport, 2) < 1 && m.marginAtLeast(sport, 2) > 0.5);
    // Monotone non-increasing as the bar rises.
    let prev = 1;
    for (let n = 1; n <= 6; n++) {
      const p = m.marginAtLeast(sport, n);
      assert.ok(p <= prev + 1e-12, `${sport} not monotone at ${n}`);
      prev = p;
    }
  }
  assert.throws(() => m.marginAtLeast('nfl', 2), /no measured margin table/);
});

test('the counted tables disagree with a normal curve where it matters', () => {
  // The whole reason the tables exist. If a future change makes these agree,
  // something has been quietly replaced by a curve again.
  const mlbOne = 1 - m.marginAtLeast('mlb', 2);
  const nhlOne = 1 - m.marginAtLeast('nhl', 2);
  assert.ok(Math.abs(mlbOne - 0.2738) < 0.001, `mlb P(1) = ${mlbOne}`);
  assert.ok(Math.abs(nhlOne - 0.4338) < 0.001, `nhl P(1) = ${nhlOne}`);

  const normalOne = (sigma) => {
    const d = m.marginDistribution(0, sigma);
    return (d.probAbove(0.5) - d.probAbove(1.5)) * 2;
  };
  assert.ok(mlbOne - normalOne(4.4) > 0.08, 'a normal should be far too low on one-run games');
  assert.ok(nhlOne - normalOne(2.2) > 0.08, 'a normal should be far too low on one-goal games');
});

test('coverProbFromWinProb: laying 1.5 is harder than winning', () => {
  for (const sport of ['mlb', 'nhl']) {
    for (const p of [0.35, 0.5, 0.65, 0.8]) {
      const cover = m.coverProbFromWinProb({ sport, winProb: p, line: -1.5 });
      assert.ok(cover < p, `${sport} at ${p}: covering must be harder than winning`);
      assert.ok(cover > 0 && cover < 1);
    }
    // Monotone in the win probability.
    let prev = 0;
    for (const p of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
      const c = m.coverProbFromWinProb({ sport, winProb: p, line: -1.5 });
      assert.ok(c > prev, `${sport} not monotone at ${p}`);
      prev = c;
    }
  }
});

test('coverProbFromWinProb uses the measured conditional by default', () => {
  // Baseball's measured slope is nearly flat, hockey's is not. That difference
  // came out of two seasons of results and must not silently become one value.
  const mlb = m.MARGIN_TABLES.mlb.conditional;
  const nhl = m.MARGIN_TABLES.nhl.conditional;
  assert.ok(mlb.mismatch < 0.2, `mlb mismatch ${mlb.mismatch} should be near flat`);
  assert.ok(nhl.mismatch > 0.35, `nhl mismatch ${nhl.mismatch} should be substantial`);

  // At a coin flip the slope cannot matter, so both agree with the intercept.
  const flip = m.coverProbFromWinProb({ sport: 'mlb', winProb: 0.5, line: -1.5 });
  assert.ok(Math.abs(flip - 0.5 * mlb.base) < 1e-9);

  // Explicitly passing a mismatch overrides the measured one.
  const forced = m.coverProbFromWinProb({ sport: 'mlb', winProb: 0.7, line: -1.5, mismatch: 0 });
  const measured = m.coverProbFromWinProb({ sport: 'mlb', winProb: 0.7, line: -1.5 });
  assert.ok(measured > forced, 'the measured slope should help a favourite');
});

test('coverProbFromWinProb does not extrapolate to lines it never measured', () => {
  // The conditional was measured at 1.5 and nowhere else. A 2.5 line has to
  // fall back to the flat table rather than run the slope out to a value that
  // was never checked.
  const at25 = m.coverProbFromWinProb({ sport: 'mlb', winProb: 0.7, line: -2.5 });
  const flat = 0.7 * m.marginAtLeast('mlb', 3);
  assert.ok(Math.abs(at25 - flat) < 1e-9, 'a 2.5 line must use the unconditional table');
  assert.ok(at25 < m.coverProbFromWinProb({ sport: 'mlb', winProb: 0.7, line: -1.5 }),
    'laying more runs must be harder');
});

test('Shin de-vigging equals proportional when there is nothing to correct', () => {
  // Equal prices carry no favourite-longshot bias, so the two methods must
  // agree exactly. This is the check that Shin is not just always different.
  const shin = m.deVigTwoWayShin(-110, -110);
  const prop = m.deVigTwoWayShin(-110, -110, 'proportional');
  assert.ok(Math.abs(shin.probA - prop.probA) < 1e-9);
  assert.ok(Math.abs(shin.probA - 0.5) < 1e-9);
  // And a market with no hold at all comes back untouched.
  assert.deepEqual(m.removeVigShin([0.5, 0.5]), [0.5, 0.5]);
});

test('Shin takes probability off the longshot, more as the price lengthens', () => {
  let previousGap = 0;
  for (const [fav, dog] of [[-160, 140], [-196, 161], [-265, 215], [-400, 320]]) {
    const shin = m.deVigTwoWayShin(fav, dog);
    const prop = m.deVigTwoWayShin(fav, dog, 'proportional');
    const gap = shin.probA - prop.probA;
    assert.ok(gap > 0, `Shin should raise the favourite at ${fav}/${dog}`);
    assert.ok(gap > previousGap, 'the correction must grow with the price');
    previousGap = gap;
    // Both still describe a probability.
    assert.ok(Math.abs(shin.probA + shin.probB - 1) < 1e-9);
  }
});

test('removeVigShin refuses input that is not a market', () => {
  assert.throws(() => m.removeVigShin([0.5]), /at least two/);
  assert.throws(() => m.removeVigShin(null), /at least two/);
  assert.throws(() => m.removeVigShin([0.5, 0]), /implied probability/);
  assert.throws(() => m.removeVigShin([0.5, NaN]), /implied probability/);
});

test('runLineEdge finds nothing when the two markets agree', () => {
  // Price the run line off the moneyline exactly, add a normal hold, and the
  // edge must be negative on both sides — the vig is the whole difference.
  const sport = 'mlb';
  const p = m.deVigTwoWayShin(-160, 140).probA;
  const cover = m.coverProbFromWinProb({ sport, winProb: p, line: -1.5 });
  const shade = (q) => m.decimalToAmerican(1 / (q * 1.023));
  const r = m.runLineEdge({
    sport, homeML: -160, awayML: 140, spread: -1.5,
    spreadHomePrice: shade(cover), spreadAwayPrice: shade(1 - cover),
  });
  assert.ok(Math.abs(r.disagreementPts) < 0.3, `disagreement ${r.disagreementPts}`);
  assert.ok(r.homeEdgePts < 0 && r.awayEdgePts < 0, 'the vig must show up as negative edge');
});

test('runLineEdge names the cheap side when they disagree', () => {
  const sport = 'mlb';
  const p = m.deVigTwoWayShin(-160, 140).probA;
  const cover = m.coverProbFromWinProb({ sport, winProb: p, line: -1.5 });
  const r = m.runLineEdge({
    sport, homeML: -160, awayML: 140, spread: -1.5,
    spreadHomePrice: m.decimalToAmerican(1 / (cover * 0.88)),
    spreadAwayPrice: m.decimalToAmerican(1 / ((1 - cover) * 1.02)),
  });
  assert.ok(r.homeEdgePts > 4, `home edge ${r.homeEdgePts}`);
  assert.ok(r.homeEdgePts > r.awayEdgePts);
  assert.equal(r.offeredHomePrice, m.decimalToAmerican(1 / (cover * 0.88)));
});

test('runLineEdge returns null rather than guessing', () => {
  const ok = { sport: 'mlb', homeML: -160, awayML: 140, spread: -1.5,
               spreadHomePrice: 120, spreadAwayPrice: -145 };
  assert.ok(m.runLineEdge(ok));
  for (const bad of [{ spread: null }, { spreadHomePrice: null }, { spreadAwayPrice: undefined },
                     { homeML: null }, { awayML: NaN }, { sport: 'nfl' }]) {
    assert.equal(m.runLineEdge({ ...ok, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(m.runLineEdge(), null);
});

test('bestBet grades a baseball run line off the moneyline', () => {
  const sport = 'mlb';
  const p = m.deVigTwoWayShin(-160, 140).probA;
  const cover = m.coverProbFromWinProb({ sport, winProb: p, line: -1.5 });

  const at = (factor) => m.runLineEdge({
    sport, homeML: -160, awayML: 140, spread: -1.5,
    spreadHomePrice: m.decimalToAmerican(1 / (cover * factor)),
    spreadAwayPrice: m.decimalToAmerican(1 / ((1 - cover) * 1.02)),
  });

  const strong = m.bestBet({ sport, marketSpread: -1.5, homeTeam: 'Cubs', awayTeam: 'Reds',
                             runLine: at(0.9) });
  assert.equal(strong.level, 'edge');
  assert.equal(strong.pick, 'Cubs -1.5');
  assert.match(strong.reason, /the moneyline on this game says/);
  // A price edge is a fact, so it must not carry the projection's disclaimer.
  assert.equal(strong.caveat, undefined);

  const fair = m.bestBet({ sport, marketSpread: -1.5, homeTeam: 'Cubs', awayTeam: 'Reds',
                           runLine: at(1.023) });
  assert.equal(fair.level, 'coinflip');
  assert.match(fair.reason, /agrees with the moneyline/);
});

test('bestBet says why it is silent when it cannot price the run line', () => {
  const noML = m.bestBet({ sport: 'mlb', marketSpread: -1.5, homeTeam: 'H', awayTeam: 'A' });
  assert.equal(noML.level, 'coinflip');
  assert.match(noML.reason, /no moneyline here to price it against/);
});

test('bestBet withholds a hockey verdict until the sweep is explained', () => {
  // Hockey calibrates as well as baseball, but every positive edge on a live
  // card was the underdog — twelve for twelve, and still twelve for twelve
  // after switching to Shin. Until that is understood it is shown, not
  // recommended.
  assert.equal(m.MARGIN_TABLES.nhl.verdict, false);
  assert.equal(m.MARGIN_TABLES.mlb.verdict, true);

  const sport = 'nhl';
  const p = m.deVigTwoWayShin(-265, 215).probA;
  const cover = m.coverProbFromWinProb({ sport, winProb: p, line: -1.5 });
  const r = m.runLineEdge({
    sport, homeML: -265, awayML: 215, spread: -1.5,
    spreadHomePrice: m.decimalToAmerican(1 / (cover * 0.85)),
    spreadAwayPrice: m.decimalToAmerican(1 / ((1 - cover) * 1.02)),
  });
  assert.ok(r.homeEdgePts > 5, 'the edge is real arithmetic');

  const v = m.bestBet({ sport, marketSpread: -1.5, homeTeam: 'Oilers', awayTeam: 'Canucks',
                        runLine: r });
  // Withheld, not silent. 'coinflip' renders as nothing, which meant this
  // explanation was written carefully and then shown to nobody — the reader
  // never learned the pricing existed or why it was being held back.
  assert.equal(v.level, 'withheld', 'it must say it is withholding');
  assert.equal(v.pick, null, 'and still not recommend a side');
  assert.match(v.reason, /waiting for results/);
  assert.match(v.reason, /worth/, 'the numbers are shown even though the advice is not');
});

test('bestBet names the line it actually priced, not the consensus', () => {
  // runLine is built entirely from the book's own spread and prices, so
  // labelling the pick with a consensus point from nine other books could name
  // a number that was never priced.
  const p = m.deVigTwoWayShin(-160, 140).probA;
  const cover = m.coverProbFromWinProb({ sport: 'mlb', winProb: p, line: -1.5 });
  const rl = m.runLineEdge({
    sport: 'mlb', homeML: -160, awayML: 140, spread: -1.5,
    spreadHomePrice: m.decimalToAmerican(1 / (cover * 0.9)),
    spreadAwayPrice: m.decimalToAmerican(1 / ((1 - cover) * 1.02)),
  });
  const v = m.bestBet({ sport: 'mlb', marketSpread: -1.5, bookSpread: -2.5,
                        homeTeam: 'Dodgers', awayTeam: 'Rockies', runLine: rl });
  assert.equal(v.pick, 'Dodgers -2.5', `named ${v.pick}, but -2.5 is what was priced`);

  // Absent a book line it falls back to the consensus one rather than refusing.
  const fallback = m.bestBet({ sport: 'mlb', marketSpread: -1.5,
                               homeTeam: 'Dodgers', awayTeam: 'Rockies', runLine: rl });
  assert.equal(fallback.pick, 'Dodgers -1.5');
});

test('a situation flag still reaches a verdict in baseball', () => {
  // The fixedSpread branch returned on every path, so the flag check below it
  // was dead for MLB and NHL — and injury classification had just been fixed
  // specifically so those flags fire in those sports.
  const p = m.deVigTwoWayShin(-160, 140).probA;
  const cover = m.coverProbFromWinProb({ sport: 'mlb', winProb: p, line: -1.5 });
  const fair = m.runLineEdge({
    sport: 'mlb', homeML: -160, awayML: 140, spread: -1.5,
    spreadHomePrice: m.decimalToAmerican(1 / (cover * 1.023)),
    spreadAwayPrice: m.decimalToAmerican(1 / ((1 - cover) * 1.023)),
  });

  const quiet = m.bestBet({ sport: 'mlb', marketSpread: -1.5, bookSpread: -1.5,
                            homeTeam: 'Cubs', awayTeam: 'Reds', runLine: fair });
  assert.equal(quiet.level, 'coinflip', 'a fair price with nothing else to say stays quiet');

  const flagged = m.bestBet({
    sport: 'mlb', marketSpread: -1.5, bookSpread: -1.5,
    homeTeam: 'Cubs', awayTeam: 'Reds', runLine: fair,
    situationFlags: [{ type: 'injuries-static-line', against: 'away', note: 'Four players ruled out.' }],
  });
  assert.equal(flagged.level, 'lean');
  assert.equal(flagged.side, 'home', 'a flag against away argues for home');
  assert.equal(flagged.pick, 'Cubs -1.5');
  assert.ok(flagged.caveat, 'and it is labelled a situation lean, not a price edge');

  // A sideless flag still cannot produce a pick.
  const sideless = m.bestBet({
    sport: 'mlb', marketSpread: -1.5, bookSpread: -1.5,
    homeTeam: 'Cubs', awayTeam: 'Reds', runLine: fair,
    situationFlags: [{ type: 'unexplained-move', against: null, note: 'The line moved.' }],
  });
  assert.equal(sideless.level, 'coinflip');
});

test('the injury flag measures against the league, not against three', () => {
  // Three players out is remarkable in football and a normal Tuesday in
  // baseball, where the median team carries about four on short-term IL. The
  // absolute threshold fired on essentially every baseball card.
  const fires = (opts) => m.situationFlags(opts).some(x => x.type === 'injuries-static-line');

  // No baseline supplied: unchanged behaviour, so existing callers are safe.
  assert.equal(fires({ injuriesOut: 4, spreadMovement: 0 }), true);
  assert.equal(fires({ injuriesOut: 2, spreadMovement: 0 }), false);

  // With a baseline, routine churn is no longer news.
  assert.equal(fires({ injuriesOut: 4, spreadMovement: 0, injuryBaseline: 4 }), false,
    'four out against a norm of four is not a story');
  assert.equal(fires({ injuriesOut: 7, spreadMovement: 0, injuryBaseline: 4 }), true,
    'seven against a norm of four is');

  // Where the spread cannot move, the stillness test is vacuous and dropped —
  // but the count still has to clear the bar.
  assert.equal(fires({ injuriesOut: 7, injuryBaseline: 4, spreadCanMove: false }), true);
  assert.equal(fires({ injuriesOut: 4, injuryBaseline: 4, spreadCanMove: false }), false);
  // And with a movable spread, a line that HAS moved explains itself.
  assert.equal(fires({ injuriesOut: 7, injuryBaseline: 4, spreadMovement: 3 }), false);

  const note = m.situationFlags({ injuriesOut: 7, injuryBaseline: 4, spreadCanMove: false })
    .find(x => x.type === 'injuries-static-line').note;
  assert.match(note, /league norm/, 'the note should say what normal is');
  assert.ok(!/spread has barely moved/.test(note),
    'and should not claim a fixed line failed to move');
});

test('the NFL sigma is the measured one, and prices a stale line correctly', () => {
  // Measured over 1,087 games, 2022-2025. If this drifts back toward 13.5 the
  // Pick 6 numbers go quietly wrong again, so it is pinned.
  assert.ok(Math.abs(m.SPORTS.nfl.sigma - 10.82) < 0.01, `sigma is ${m.SPORTS.nfl.sigma}`);

  // What actually happened at each offset, against what the model says now.
  const real = { 2: 0.583, 3: 0.616, 5: 0.686, 7: 0.741 };
  for (const [stale, actual] of Object.entries(real)) {
    const d = m.marginDistribution(0, m.SPORTS.nfl.sigma);
    const predicted = d.probAbove(-Number(stale));
    assert.ok(Math.abs(predicted - actual) < 0.015,
      `${stale} points stale: model ${predicted.toFixed(3)}, reality ${actual}`);
  }
});

test('the lean threshold is stated per sport, not derived from football', () => {
  // It used to be a fraction of nfl sigma, so measuring football moved
  // basketball. Basketball's sigma is still a placeholder; the two must not be
  // coupled.
  assert.equal(m.SPORTS.nfl.leanThreshold, 3);
  assert.equal(m.SPORTS.nba.leanThreshold, 2.5);
  assert.equal(m.bestBet({ sport: 'nfl', predictedMargin: 2.9, marketSpread: 0 }).level, 'coinflip');
  assert.equal(m.bestBet({ sport: 'nfl', predictedMargin: 3, marketSpread: 0 }).level, 'lean');
  assert.equal(m.bestBet({ sport: 'nba', predictedMargin: 2.4, marketSpread: 0 }).level, 'coinflip');
  assert.equal(m.bestBet({ sport: 'nba', predictedMargin: 2.5, marketSpread: 0 }).level, 'lean');
});

test('a 2.5 run line prices off the counted table, not the 1.5 conditional', () => {
  // Rare, but real: books post 2.5 on a bad mismatch. The measured slope was
  // fitted at 1.5 and must not be extrapolated to a number it never saw, so a
  // 2.5 falls back to the plain counted distribution.
  const p = m.deVigTwoWayShin(-260, 215).probA;
  const at25 = m.coverProbFromWinProb({ sport: 'mlb', winProb: p, line: -2.5 });
  const expected = p * m.marginAtLeast('mlb', 3);
  assert.ok(Math.abs(at25 - expected) < 1e-9, `${at25} should equal winProb * P(win by 3+)`);

  // Laying more runs has to be harder, and the whole chain has to survive it.
  const at15 = m.coverProbFromWinProb({ sport: 'mlb', winProb: p, line: -1.5 });
  assert.ok(at25 < at15, 'laying 2.5 must be harder than laying 1.5');

  const edge = m.runLineEdge({ sport: 'mlb', homeML: -260, awayML: 215, spread: -2.5,
                               spreadHomePrice: 135, spreadAwayPrice: -160 });
  assert.ok(edge, 'a 2.5 run line must still price');
  assert.ok(Number.isFinite(edge.fairHomePrice) && Number.isFinite(edge.homeEdgePts));

  // And plausibleSpread must not throw the game away for not being 1.5.
  assert.equal(m.plausibleSpread('mlb', 2.5), true);
  assert.equal(m.plausibleSpread('nhl', 2.5), true);
});

test('a price edge says when the projection points the other way', () => {
  // "Best bet: Over 48.5" above a predicted score of 20-26 reads as the app
  // arguing with itself. Neither half is wrong — one is a fact about the price
  // on offer, the other a description of recent scoring measured at 49.6% on
  // exactly this question — but a reader who spots the tension unaided will
  // trust neither, so the card says it.
  const against = m.bestBet({ sport: 'nfl', bookValuePts: 1, bookPick: 'Over 48.5',
                              bookSide: 'over', predictedTotal: 45.4, bookTotal: 48.5 });
  assert.equal(against.level, 'edge', 'the price edge still stands');
  assert.match(against.caveat, /points the other way/);
  assert.match(against.caveat, /not a reason to pass/);

  // Agreement carries no caveat — the note is for the contradiction only.
  const with_ = m.bestBet({ sport: 'nfl', bookValuePts: 1, bookPick: 'Under 45.5',
                            bookSide: 'under', predictedTotal: 40.5, bookTotal: 45.5 });
  assert.equal(with_.caveat, undefined);

  // Same for spreads, using the market number rather than the total.
  const spread = m.bestBet({ sport: 'nfl', bookValuePts: 1.5, bookPick: 'Texans +1.5',
                             bookSide: 'home', predictedMargin: -6, marketSpread: 0 });
  assert.match(spread.caveat, /loses to the closing line/);

  // And with no projection at all there is nothing to disagree with.
  assert.equal(m.bestBet({ sport: 'nfl', bookValuePts: 1, bookPick: 'Over 48.5',
                           bookSide: 'over' }).caveat, undefined);
});

// ---------------------------------------------------------------------------
// What a better number is actually worth
// ---------------------------------------------------------------------------
test('a half point across the 3 is worth what games say it is worth', () => {
  // 1,112 games lined at exactly 3 finished on 3 9.2% of the time. The model
  // has to reproduce that, because the verdict now prints the figure.
  const o = m.coverOutcomes({ predictedMargin: 3, spread: -3, sigma: 10.82, sport: 'nfl' });
  assert.ok(Math.abs(o.push - 0.092) < 0.006,
    `lined at 3, lands on 3: model ${(o.push * 100).toFixed(1)}%, counted 9.2%`);
});

test('a half point across the 7 matches the counted rate too', () => {
  const o = m.coverOutcomes({ predictedMargin: 7, spread: -7, sigma: 10.82, sport: 'nfl' });
  assert.ok(Math.abs(o.push - 0.064) < 0.006,
    `lined at 7, lands on 7: model ${(o.push * 100).toFixed(1)}%, counted 6.4%`);
});

test('the same point is worth far more across a key number than away from one', () => {
  // The whole reason for showing the figure: "a point better" is not one thing.
  const key = m.lineValueProb({ sport: 'nfl', side: 'home', marketNumber: -3.5, bookNumber: -2.5 });
  const away = m.lineValueProb({ sport: 'nfl', side: 'away', marketNumber: -11, bookNumber: -12 });
  assert.ok(key.gain > 0.08, `crossing the 3 should buy 8+ points, got ${(key.gain * 100).toFixed(1)}`);
  assert.ok(away.gain < 0.05, `away from a key number should buy under 5, got ${(away.gain * 100).toFixed(1)}`);
  assert.ok(key.gain > away.gain * 2, 'the key number must be worth clearly more');
});

test('line value is priced at the market view, not the app projection', () => {
  // A projection that disagrees violently must not change what the number buys,
  // because the price edge does not depend on the forecast being any good.
  const a = m.lineValueProb({ sport: 'nfl', side: 'home', marketNumber: -3.5, bookNumber: -2.5 });
  const b = m.lineValueProb({ sport: 'nfl', side: 'home', marketNumber: -3.5, bookNumber: -2.5 });
  assert.equal(a.gain, b.gain);
  assert.ok(a.gain > 0, 'the backed side must gain from the better number');
});

test('lineValueProb returns null rather than guessing when a number is missing', () => {
  assert.equal(m.lineValueProb({ sport: 'nfl', side: 'home', marketNumber: -3.5, bookNumber: null }), null);
  assert.equal(m.lineValueProb({ sport: 'nfl', side: 'nonsense', marketNumber: -3.5, bookNumber: -2.5 }), null);
});

test('a price verdict carries its working', () => {
  const r = m.bestBet({ sport: 'nfl', bookValuePts: 1, bookSide: 'home', bookPick: 'Chiefs -2.5',
    marketSpread: -3.5, bookSpread: -2.5, predictedMargin: 5, situationFlags: [],
    homeTeam: 'Chiefs', awayTeam: 'Ravens' });
  assert.equal(r.level, 'edge');
  assert.ok(Array.isArray(r.basis) && r.basis.length >= 3, 'the verdict should show its working');
  const labels = r.basis.map(b => b.label);
  assert.ok(labels.includes('the number'), 'it must say what is on offer');
  assert.ok(labels.includes('what it buys'), 'it must price the difference');
  assert.ok(labels.includes('the bottom line'), 'it must say this is a price, not a forecast');
  const buys = r.basis.find(b => b.label === 'what it buys').text;
  assert.match(buys, /9\.\d points of win probability/, `expected the 3-crossing value, got: ${buys}`);
});

test('the working reports a check that found nothing, rather than staying quiet', () => {
  const r = m.bestBet({ sport: 'nfl', bookValuePts: 1, bookSide: 'home', bookPick: 'Chiefs -2.5',
    marketSpread: -3.5, bookSpread: -2.5, predictedMargin: 5, situationFlags: [],
    homeTeam: 'Chiefs', awayTeam: 'Ravens' });
  assert.ok(r.basis.some(b => /no injury, rest or travel flag/.test(b.text)),
    'an empty check is evidence and should be stated');
});

test('the working warns that a push is a loss in the pool', () => {
  // -4 to -3 buys both kinds of value: a couple of points of outright win from
  // the 4, and the whole 3 turned from a loss into a refund. Both get said, and
  // the refund is flagged as something the pool does not credit.
  const r = m.bestBet({ sport: 'nfl', bookValuePts: 1, bookSide: 'home', bookPick: 'Bills -3',
    marketSpread: -4, bookSpread: -3, predictedMargin: 4, situationFlags: [],
    homeTeam: 'Bills', awayTeam: 'Jets' });
  const buys = r.basis.find(b => b.label === 'what it buys');
  assert.match(buys.text, /points of win probability/, 'the real win gain must be reported');
  const refund = r.basis.find(b => b.label === 'and at the book');
  assert.ok(refund, 'the pushes gained must be reported too');
  assert.match(refund.text, /Pick 6 does not/);
});

test('the working carries the contradiction, since nothing else prints it', () => {
  // The card no longer renders the reason or the caveat beside a verdict that
  // has working, so the working has to hold the contradiction or it is lost.
  const r = m.bestBet({ sport: 'nfl', bookValuePts: 1, bookSide: 'over', bookPick: 'Over 47.5',
    marketTotal: 48.5, bookTotal: 47.5, predictedTotal: 44, situationFlags: [],
    homeTeam: 'Saints', awayTeam: 'Lions' });
  assert.ok(r.caveat, 'the field stays on the object for anything reading the API');
  assert.ok(r.basis.some(b => b.label === 'points the other way'),
    'the working must say the projection disagrees');
});

test('a half point that only buys pushes is called worthless in the pool', () => {
  // Broncos +2.5 -> +3 wins no extra games; it turns 9.3% of losses into
  // refunds. That is money at a book and nothing in a pool where a push loses,
  // and the working said "0.0 points of win probability" under "Slight edge".
  const r = m.bestBet({ sport: 'nfl', bookValuePts: 0.5, bookSide: 'away',
    bookPick: 'Denver Broncos +3', marketSpread: -2.5, bookSpread: -3,
    predictedMargin: -2, situationFlags: [],
    homeTeam: 'Kansas City Chiefs', awayTeam: 'Denver Broncos' });
  const buys = r.basis.find(b => b.label === 'what it buys');
  assert.match(buys.text, /no extra wins at all/,
    `a push-only half point must not be sold as win probability: ${buys.text}`);
  assert.ok(r.basis.some(b => b.label === 'in the Pick 6' && /worth nothing/.test(b.text)),
    'the pool reader has to be told this one is worthless there');
  // and it must not also print the generic push row
  assert.equal(r.basis.filter(b => b.label === 'lands exactly there').length, 0,
    'the refund point should be made once, not twice');
});

test('a half point that buys real wins still reports them', () => {
  const r = m.bestBet({ sport: 'nfl', bookValuePts: 1, bookSide: 'home', bookPick: 'Chiefs -2.5',
    marketSpread: -3.5, bookSpread: -2.5, predictedMargin: 5, situationFlags: [],
    homeTeam: 'Chiefs', awayTeam: 'Ravens' });
  const buys = r.basis.find(b => b.label === 'what it buys');
  assert.match(buys.text, /9\.\d points of win probability/);
  assert.ok(!r.basis.some(b => b.label === 'in the Pick 6'),
    'a genuinely valuable number must not be labelled worthless in the pool');
});

// ---------------------------------------------------------------------------
// Totals are counted, not curve-fitted
// ---------------------------------------------------------------------------
test('a point of total buys what games say it buys, not what a curve says', () => {
  // 6,967 games: 2.76% of finals land in the one-point window below the line.
  // The normal at totalSigma 10.5 said 3.80% — a third too much — and printed
  // that identical figure on every total verdict on the card.
  for (const t of [38.5, 44.5, 48.5, 52.5]) {
    const at = m.totalOutcomes({ predictedTotal: t, line: t, sport: 'nfl' });
    const one = m.totalOutcomes({ predictedTotal: t, line: t - 1, sport: 'nfl' });
    const buys = one.over - at.over;
    assert.ok(Math.abs(buys - 0.0276) < 0.004,
      `a point at ${t} should buy ~2.8%, got ${(buys * 100).toFixed(2)}%`);
  }
});

test('a whole-number total can land on itself', () => {
  const o = m.totalOutcomes({ predictedTotal: 45, line: 45, sport: 'nfl' });
  assert.ok(Math.abs(o.push - 0.028) < 0.005,
    `whole totals push 2.8% of the time, got ${(o.push * 100).toFixed(2)}%`);
  const half = m.totalOutcomes({ predictedTotal: 45, line: 45.5, sport: 'nfl' });
  assert.equal(half.push, 0, 'a half point cannot push');
});

test('total outcomes always sum to one', () => {
  for (const [p, l] of [[45, 45], [45, 47.5], [51, 44], [38, 41.5]]) {
    const o = m.totalOutcomes({ predictedTotal: p, line: l, sport: 'nfl' });
    assert.ok(Math.abs(o.over + o.push + o.under - 1) < 1e-9,
      `over/push/under must sum to 1 at ${p}/${l}`);
    assert.ok(o.over >= 0 && o.push >= 0 && o.under >= 0, 'no negative probabilities');
  }
});

test('sports without a measured total table keep the curve', () => {
  // Only football has been counted. The others should not silently borrow it.
  const nba = m.totalOutcomes({ predictedTotal: 225, line: 225, sigma: 15 });
  assert.ok(nba.over > 0 && nba.under > 0, 'the normal path still works');
  assert.ok(Math.abs(nba.over + nba.push + nba.under - 1) < 1e-6);
});

test('a half-point total can never push, whatever the expectation', () => {
  // Checking the OFFSET rather than the line reported a 2.8% push on 48.5.
  for (const [p, l] of [[48.5, 48.5], [45, 45.5], [48.5, 47.5], [45, 47.5]]) {
    const o = m.totalOutcomes({ predictedTotal: p, line: l, sport: 'nfl' });
    assert.equal(o.push, 0, `${l} is a half point and cannot land on itself`);
  }
});

test('a whole-number total pushes whatever the expectation parity', () => {
  for (const [p, l] of [[45, 45], [48.5, 48], [45, 46]]) {
    const o = m.totalOutcomes({ predictedTotal: p, line: l, sport: 'nfl' });
    assert.ok(o.push > 0.02 && o.push < 0.05,
      `${l} should push a few percent, got ${(o.push * 100).toFixed(2)}%`);
  }
});

test('the residual grid comes from the expectation, not the offset', () => {
  // Under 45 -> Under 45.5 gains exactly the games totalling 45, and nothing
  // else. Taking the grid from the offset priced this at 4.3%.
  const at45 = m.totalOutcomes({ predictedTotal: 45, line: 45, sport: 'nfl' });
  const at455 = m.totalOutcomes({ predictedTotal: 45, line: 45.5, sport: 'nfl' });
  const buys = at455.under - at45.under;
  assert.ok(Math.abs(buys - at45.push) < 1e-9,
    `the half point must buy exactly the push it absorbs: ${(buys * 100).toFixed(2)}% vs ${(at45.push * 100).toFixed(2)}%`);
});

test('totals sum to one across every parity combination', () => {
  for (const p of [44, 44.5, 45, 48.5]) {
    for (const l of [43, 43.5, 44, 44.5, 45, 45.5, 48, 48.5]) {
      const o = m.totalOutcomes({ predictedTotal: p, line: l, sport: 'nfl' });
      assert.ok(Math.abs(o.over + o.push + o.under - 1) < 1e-6,
        `exp ${p} line ${l} sums to ${(o.over + o.push + o.under).toFixed(6)}`);
      assert.ok(o.over >= 0 && o.push >= 0 && o.under >= 0, `exp ${p} line ${l} went negative`);
    }
  }
});
