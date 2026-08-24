// Capture a real ESPN odds payload carrying the open/current price fields the
// odds board reads, and append it to the fixture file.
//
// The existing fixtures predate the board and were trimmed to the three fields
// the old parser used, which is why two independent reviewers concluded from
// them that the board renders blank — it does not, but the suite could not tell
// either way. That is the same silent-degradation mode parser.test.js exists to
// catch.
//
// Run: node capture-board.js

const fs = require('fs');

const SPORTS = {
  // The core API inserts /leagues/ where the site API does not. Getting this
  // wrong 404s every request, and the catch below turns that into "nothing
  // found" rather than an error — which is exactly how it wasted a run.
  nfl: { site: 'football/nfl', core: 'football/leagues/nfl' },
  mlb: { site: 'baseball/mlb', core: 'baseball/leagues/mlb' },
};

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Keep only what the board actually reads, so the fixture stays legible.
function trim(item) {
  const side = (o) => {
    if (!o) return undefined;
    const phase = (p) => o[p] ? {
      pointSpread: o[p].pointSpread && { american: o[p].pointSpread.american },
      spread: o[p].spread && { american: o[p].spread.american },
      moneyLine: o[p].moneyLine && { american: o[p].moneyLine.american },
    } : undefined;
    return {
      moneyLine: o.moneyLine,
      open: phase('open'),
      current: phase('current'),
    };
  };
  const totals = (p) => item[p] ? {
    total: item[p].total && { american: item[p].total.american },
    over: item[p].over && { american: item[p].over.american },
    under: item[p].under && { american: item[p].under.american },
  } : undefined;
  return {
    provider: item.provider && { name: item.provider.name },
    spread: item.spread,
    overUnder: item.overUnder,
    homeTeamOdds: side(item.homeTeamOdds),
    awayTeamOdds: side(item.awayTeamOdds),
    open: totals('open'),
    current: totals('current'),
  };
}

(async () => {
  const out = {};
  for (const [sport, p] of Object.entries(SPORTS)) {
    // Same look-ahead the app uses, so a sport with nothing on today still
    // yields a fixture.
    const stamp = (d) => {
      const x = new Date(Date.now() + d * 864e5);
      return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
    };
    const board = await getJson(
      `https://site.api.espn.com/apis/site/v2/sports/${p.site}/scoreboard` +
      `?dates=${stamp(0)}-${stamp(30)}&limit=100`);
    let picked = null;
    for (const ev of board.events || []) {
      if (ev.competitions?.[0]?.status?.type?.state !== 'pre') continue;
      let odds;
      try {
        odds = await getJson(
          `https://sports.core.api.espn.com/v2/sports/${p.core}/events/${ev.id}/competitions/${ev.id}/odds`);
      } catch (e) { console.log(`   ${ev.shortName}: odds fetch failed — ${e.message}`); continue; }
      const item = (odds.items || []).find(x =>
        !/live/i.test((x.provider && x.provider.name) || '') &&
        x.homeTeamOdds && x.homeTeamOdds.open && x.homeTeamOdds.current);
      if (!item) continue;
      picked = { matchup: ev.shortName, date: ev.date, item: trim(item) };
      break;
    }
    if (picked) {
      out[sport] = picked;
      console.log(`${sport}: captured ${picked.matchup} from ${picked.item.provider?.name}`);
    } else {
      console.log(`${sport}: nothing with open+current right now`);
    }
  }
  if (!Object.keys(out).length) { console.log('nothing captured'); return; }
  fs.writeFileSync('./espn-board.fixtures.json', JSON.stringify(out, null, 1));
  console.log(`\nwrote espn-board.fixtures.json (${Object.keys(out).join(', ')})`);
  console.log(JSON.stringify(out[Object.keys(out)[0]].item, null, 1).slice(0, 700));
})();
