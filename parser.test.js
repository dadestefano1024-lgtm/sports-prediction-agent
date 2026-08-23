'use strict';

// Run with:  node --test
//
// Guards the ESPN odds field paths against a real captured payload from each of
// the four sports. ESPN's API is undocumented and can change without notice,
// and the previous scraper failed silently and plausibly for months — a
// constant openSpread per sport that nothing checked. These tests fail loudly
// if a field path moves.
//
// The fixtures in espn-odds.fixtures.json are trimmed real responses, captured
// from in-season dates: NBA and NHL from 2026-01-15 because both are in
// offseason as of writing, MLB and NFL from a live slate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('./model');

const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'espn-odds.fixtures.json'), 'utf8'));

// The extraction the parser performs, kept in step with fetchEspnOpeningLines.
const parseAmericanValue = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^(even|ev|pk|pick)$/i.test(s)) return 0;
  const n = Number(s.replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
};

const readOdds = (item) => {
  const pick = (obj, phase, field) =>
    obj && obj[phase] && obj[phase][field] ? obj[phase][field].american : null;
  const hto = item.homeTeamOdds || {};
  const ato = item.awayTeamOdds || {};
  return {
    openSpread: parseAmericanValue(pick(hto, 'open', 'pointSpread')),
    currentSpread: parseAmericanValue(pick(hto, 'current', 'pointSpread')),
    openTotal: parseAmericanValue(item.open && item.open.total && item.open.total.american),
    currentTotal: parseAmericanValue(item.current && item.current.total && item.current.total.american),
    homeML: parseAmericanValue(hto.moneyLine),
    awayML: parseAmericanValue(ato.moneyLine),
  };
};

// Ranges a real posted line must fall inside, per sport.
const SANE_TOTALS = {
  nba: [180, 280],
  nhl: [4, 9],
  mlb: [5, 15],
  nfl: [28, 62],
};

test('every sport has a captured fixture', () => {
  for (const sport of ['nba', 'nhl', 'mlb', 'nfl']) {
    assert.ok(fixtures[sport], `missing fixture for ${sport} — recapture before trusting this suite`);
  }
});

for (const sport of ['nba', 'nhl', 'mlb', 'nfl']) {
  test(`${sport}: every field the parser reads is present`, () => {
    const o = readOdds(fixtures[sport]);
    for (const field of ['openSpread', 'currentSpread', 'openTotal', 'currentTotal']) {
      assert.notEqual(o[field], null,
        `${sport}.${field} came back null — the field path has probably moved`);
    }
  });

  test(`${sport}: spreads are lines a book could have posted`, () => {
    const o = readOdds(fixtures[sport]);
    assert.ok(model.plausibleSpread(sport, o.openSpread),
      `${sport} open spread ${o.openSpread} is not a postable line`);
    assert.ok(model.plausibleSpread(sport, o.currentSpread),
      `${sport} current spread ${o.currentSpread} is not a postable line`);
  });

  test(`${sport}: totals sit in a credible range`, () => {
    const o = readOdds(fixtures[sport]);
    const [lo, hi] = SANE_TOTALS[sport];
    for (const [name, v] of [['open', o.openTotal], ['current', o.currentTotal]]) {
      assert.ok(v >= lo && v <= hi,
        `${sport} ${name} total ${v} outside ${lo}-${hi} — this is how the old scraper's ` +
        `constant -8 openSpread went unnoticed`);
    }
  });

  test(`${sport}: moneylines are readable and never between -100 and +100`, () => {
    const o = readOdds(fixtures[sport]);
    for (const [name, v] of [['home', o.homeML], ['away', o.awayML]]) {
      if (v === null) continue;               // some books omit one side
      assert.ok(Math.abs(v) >= 100,
        `${sport} ${name} moneyline ${v} is not a real American price`);
    }
  });
}

test('run lines and puck lines are always 1.5', () => {
  // The single clearest signal the old scraper was broken: it reported 0 and -3
  // on markets that only ever post 1.5.
  for (const sport of ['mlb', 'nhl']) {
    const o = readOdds(fixtures[sport]);
    assert.equal(Math.abs(o.currentSpread), 1.5,
      `${sport} current spread should be 1.5, got ${o.currentSpread}`);
    assert.equal(Math.abs(o.openSpread), 1.5);
  }
});

test('parseAmericanValue handles the shapes ESPN actually returns', () => {
  assert.equal(parseAmericanValue('-1.5'), -1.5);
  assert.equal(parseAmericanValue('+1.5'), 1.5);     // ESPN signs positives
  assert.equal(parseAmericanValue('8'), 8);
  assert.equal(parseAmericanValue('EVEN'), 0);
  assert.equal(parseAmericanValue('PK'), 0);
  assert.equal(parseAmericanValue(-110), -110);
  assert.equal(parseAmericanValue(null), null);
  assert.equal(parseAmericanValue(''), null);
  assert.equal(parseAmericanValue('n/a'), null);
});

test('the captured fixtures show real line movement', () => {
  // If every sport came back with open === current for both markets, the
  // capture probably grabbed a placeholder rather than live data.
  const moved = ['nba', 'nhl', 'mlb', 'nfl'].filter(s => {
    const o = readOdds(fixtures[s]);
    return o.openSpread !== o.currentSpread || o.openTotal !== o.currentTotal;
  });
  assert.ok(moved.length >= 2,
    `expected at least two sports to show movement, got ${moved.join(', ') || 'none'}`);
});
