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

test('run lines and puck lines are a number a book would post', () => {
  // The single clearest signal the old scraper was broken: it reported 0 and -3
  // on these markets.
  //
  // This used to assert exactly 1.5, which was over-fit to the fixtures. Books
  // do post 2.5 on a bad mismatch, so pinning the fixtures to 1.5 would have
  // turned a real line into a test failure. What actually matters is that the
  // value is one of the two, and never a football number.
  for (const sport of ['mlb', 'nhl']) {
    const o = readOdds(fixtures[sport]);
    for (const [label, v] of [['current', o.currentSpread], ['open', o.openSpread]]) {
      assert.ok([1.5, 2.5].includes(Math.abs(v)),
        `${sport} ${label} spread should be 1.5 or 2.5, got ${v}`);
    }
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

// ----------------------------------------------------------------------------
// The odds board
// ----------------------------------------------------------------------------
// Nine fields per phase, none of which the older fixtures carry — they were
// trimmed to the three the previous parser used. That gap is not academic: two
// independent reviewers read those fixtures and concluded the board renders
// blank on every card. It does not, but nothing in the suite could tell the
// difference either way, which is precisely the silent-degradation mode this
// file exists to catch.
//
// espn-board.fixtures.json is a real captured response per sport, kept trimmed
// to what the board reads.

const boardFixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'espn-board.fixtures.json'), 'utf8'));

// The extraction fetchEspnOpeningLines performs, kept in step with it.
const readBoardPhase = (item, w) => {
  const pick = (obj, phase, field) =>
    obj && obj[phase] && obj[phase][field] ? obj[phase][field].american : null;
  const hto = item.homeTeamOdds || {};
  const ato = item.awayTeamOdds || {};
  return {
    homeSpread: parseAmericanValue(pick(hto, w, 'pointSpread')),
    homeSpreadPrice: parseAmericanValue(pick(hto, w, 'spread')),
    awaySpread: parseAmericanValue(pick(ato, w, 'pointSpread')),
    awaySpreadPrice: parseAmericanValue(pick(ato, w, 'spread')),
    homeML: parseAmericanValue(pick(hto, w, 'moneyLine')),
    awayML: parseAmericanValue(pick(ato, w, 'moneyLine')),
    total: parseAmericanValue(item[w] && item[w].total && item[w].total.american),
    overPrice: parseAmericanValue(item[w] && item[w].over && item[w].over.american),
    underPrice: parseAmericanValue(item[w] && item[w].under && item[w].under.american),
  };
};

test('every sport has a captured board fixture', () => {
  for (const sport of ['nfl', 'mlb']) {
    assert.ok(boardFixtures[sport], `no board fixture for ${sport}`);
    assert.ok(boardFixtures[sport].item, `${sport} fixture has no odds item`);
  }
});

test('the board finds a price beside every number it displays', () => {
  // The whole premise of replacing the old lines row was "the prices — the part
  // that tells you what a bet actually costs — were fetched and thrown away".
  // If any of these come back null the board renders a column of blanks and
  // says less than what it replaced.
  for (const sport of ['nfl', 'mlb']) {
    for (const w of ['open', 'current']) {
      const p = readBoardPhase(boardFixtures[sport].item, w);
      for (const field of Object.keys(p)) {
        assert.notEqual(p[field], null, `${sport} ${w}.${field} came back null`);
      }
    }
  }
});

test('the board reads both teams, not just the home one', () => {
  // awayTeamOdds is the field the old parser never touched — it took the home
  // spread and negated it. If ESPN moves or drops that object the away row goes
  // to em-dashes while the home row still looks fine, which is the kind of
  // half-broken that survives a glance.
  for (const sport of ['nfl', 'mlb']) {
    const now = readBoardPhase(boardFixtures[sport].item, 'current');
    assert.ok(Number.isFinite(now.awaySpread), `${sport} away spread missing`);
    assert.ok(Number.isFinite(now.awayML), `${sport} away moneyline missing`);
    // The two sides of a spread mirror each other.
    assert.ok(Math.abs(now.homeSpread + now.awaySpread) < 1e-9,
      `${sport}: ${now.homeSpread} and ${now.awaySpread} should be mirrors`);
    // And the two moneylines sit on opposite sides of even.
    assert.ok((now.homeML > 0) !== (now.awayML > 0),
      `${sport}: both moneylines on the same side of even (${now.homeML}/${now.awayML})`);
  }
});

test('board prices are prices, and lines are lines', () => {
  for (const sport of ['nfl', 'mlb']) {
    for (const w of ['open', 'current']) {
      const p = readBoardPhase(boardFixtures[sport].item, w);
      // A price is an American number and never sits between -100 and +100.
      for (const [name, v] of [['homeSpreadPrice', p.homeSpreadPrice],
                               ['awaySpreadPrice', p.awaySpreadPrice],
                               ['overPrice', p.overPrice], ['underPrice', p.underPrice],
                               ['homeML', p.homeML], ['awayML', p.awayML]]) {
        assert.ok(Math.abs(v) >= 100, `${sport} ${w}.${name} = ${v} is not an American price`);
      }
      // Lines land on a half point.
      for (const [name, v] of [['homeSpread', p.homeSpread], ['total', p.total]]) {
        assert.ok(Math.abs(v * 2 - Math.round(v * 2)) < 1e-9,
          `${sport} ${w}.${name} = ${v} is not on a half point`);
      }
      assert.ok(p.total > 0, `${sport} ${w} total should be positive`);
    }
  }
});

test('the board can tell open from current', () => {
  // If the two phases were read from the same place every card would show two
  // identical columns and the movement highlight would never fire — which looks
  // like a quiet market rather than a bug.
  const nfl = boardFixtures.nfl.item;
  const open = readBoardPhase(nfl, 'open');
  const now = readBoardPhase(nfl, 'current');
  const moved = Object.keys(open).some(k => open[k] !== now[k]);
  assert.ok(moved, 'open and current are identical in every field, which is suspicious');
});

test('a fixture missing its phases yields nulls rather than throwing', () => {
  // The older fixtures in espn-odds.fixtures.json are exactly this shape, and
  // the board has to degrade to blanks rather than fail the whole slate.
  for (const sport of ['nba', 'nhl', 'mlb', 'nfl']) {
    const p = readBoardPhase(fixtures[sport], 'open');
    assert.equal(typeof p, 'object');
    for (const field of Object.keys(p)) {
      assert.ok(p[field] === null || Number.isFinite(p[field]),
        `${sport} ${field} should be null or a number, got ${p[field]}`);
    }
  }
  assert.doesNotThrow(() => readBoardPhase({}, 'open'));
  assert.doesNotThrow(() => readBoardPhase({ homeTeamOdds: null }, 'current'));
});
