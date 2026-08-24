// Does baseball ever post a run line other than 1.5?
//
// I asserted it does not, on the strength of a handful of captured fixtures.
// That is not evidence, so this goes and counts. Every MLB game ESPN has for a
// span of dates, every odds provider ESPN lists for it, and a tally of the
// actual pointSpread values. Same for hockey, since the puck line got the same
// blanket treatment.
//
// Run: node runlinesurvey.js [sport] [days]

const SPORT = process.argv[2] || 'mlb';
const DAYS = Number(process.argv[3] || 21);

const PATHS = {
  mlb: { site: 'baseball/mlb', core: 'baseball/mlb' },
  nhl: { site: 'hockey/nhl', core: 'hockey/nhl' },
  nfl: { site: 'football/nfl', core: 'football/nfl' },
  nba: { site: 'basketball/nba', core: 'basketball/nba' },
};

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function stamp(offsetDays) {
  const d = new Date(Date.UTC(2026, 7, 23));       // today, fixed so runs repeat
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

(async () => {
  const p = PATHS[SPORT];
  const spreads = new Map();      // value -> count
  const byProvider = new Map();   // provider -> Map(value -> count)
  const examples = [];
  let games = 0, withOdds = 0, quotes = 0;

  for (let i = 1; i <= DAYS; i++) {
    const date = stamp(i);
    let board;
    try {
      board = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${p.site}/scoreboard?dates=${date}`);
    } catch (e) { continue; }

    for (const ev of board.events || []) {
      games++;
      let odds;
      try {
        odds = await getJson(
          `https://sports.core.api.espn.com/v2/sports/${p.core}/events/${ev.id}/competitions/${ev.id}/odds`);
      } catch (e) { continue; }
      const items = odds.items || [];
      if (items.length) withOdds++;

      for (const it of items) {
        const provider = (it.provider && it.provider.name) || 'unknown';
        // ESPN exposes the line in several places; take whichever is present.
        const raw = [
          it.spread,
          it.homeTeamOdds && it.homeTeamOdds.current && it.homeTeamOdds.current.pointSpread
            && it.homeTeamOdds.current.pointSpread.american,
          it.homeTeamOdds && it.homeTeamOdds.open && it.homeTeamOdds.open.pointSpread
            && it.homeTeamOdds.open.pointSpread.american,
        ].find(v => v !== undefined && v !== null && v !== 'EVEN' && v !== 'OFF');
        if (raw === undefined) continue;

        const v = Math.abs(Number(String(raw).replace(/[^0-9.\-+]/g, '')));
        if (!Number.isFinite(v)) continue;
        quotes++;
        spreads.set(v, (spreads.get(v) || 0) + 1);
        if (!byProvider.has(provider)) byProvider.set(provider, new Map());
        const pm = byProvider.get(provider);
        pm.set(v, (pm.get(v) || 0) + 1);
        if (v !== 1.5 && examples.length < 12) {
          examples.push(`${date} ${ev.shortName} ${provider}: ${raw}`);
        }
      }
    }
  }

  console.log(`${SPORT.toUpperCase()} — ${DAYS} days back from 2026-08-23`);
  console.log(`  games seen: ${games}, with odds: ${withOdds}, individual quotes: ${quotes}`);
  console.log('  spread magnitudes:');
  const total = [...spreads.values()].reduce((a, b) => a + b, 0) || 1;
  [...spreads.entries()].sort((a, b) => b[1] - a[1]).forEach(([v, n]) =>
    console.log(`    ${String(v).padStart(5)}  ${String(n).padStart(5)}  ${(n / total * 100).toFixed(1)}%`));

  if (examples.length) {
    console.log('  examples that are NOT 1.5:');
    examples.forEach(e => console.log('    ' + e));
  } else {
    console.log('  no quote anywhere in this sample was other than 1.5');
  }

  console.log('  by provider:');
  [...byProvider.entries()].forEach(([name, m]) => {
    const parts = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}x${n}`);
    console.log(`    ${name}: ${parts.join(' ')}`);
  });
})();
