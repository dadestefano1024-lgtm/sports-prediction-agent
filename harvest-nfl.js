// Harvest closing spread, closing moneyline and final score for NFL seasons.
//
// ESPN keeps odds on completed football games — it does not for baseball — and
// it keeps the moneyline next to the spread. That is exactly the pair needed to
// ask whether the two markets ever disagreed, and whether the side they
// disagreed about went on to win.
//
// Cached to disk so the analysis can be re-run without re-fetching.
//
// Run: node harvest-nfl.js [firstYear] [lastYear]

const fs = require('fs');

const FIRST = Number(process.argv[2] || 2022);
const LAST = Number(process.argv[3] || 2025);
const OUT = './nfl-history.json';

async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) return r.json();
      if (r.status === 404) return null;
    } catch (e) { /* retry */ }
  }
  return null;
}

const readScore = (c) => {
  const raw = typeof c.score === 'object' ? (c.score && c.score.value) : c.score;
  return (raw === null || raw === undefined || raw === '') ? null : Number(raw);
};

(async () => {
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const games = existing.games || [];
  const seen = new Set(games.map(g => g.id));

  for (let year = FIRST; year <= LAST; year++) {
    // Regular season is seasontype 2; weeks 1-18 since 2021.
    for (let week = 1; week <= 18; week++) {
      const board = await getJson(
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${year}&seasontype=2&week=${week}`);
      if (!board) continue;

      const pending = [];
      for (const ev of board.events || []) {
        if (seen.has(ev.id)) continue;
        const comp = (ev.competitions || [])[0];
        if (!comp || !(comp.status && comp.status.type && comp.status.type.completed)) continue;
        const cs = comp.competitors || [];
        const home = cs.find(c => c.homeAway === 'home');
        const away = cs.find(c => c.homeAway === 'away');
        if (!home || !away) continue;
        const hs = readScore(home), as = readScore(away);
        if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
        pending.push({
          id: ev.id, year, week,
          home: home.team && home.team.abbreviation,
          away: away.team && away.team.abbreviation,
          margin: hs - as,
        });
      }

      // Odds, a few at a time.
      for (let i = 0; i < pending.length; i += 6) {
        const batch = pending.slice(i, i + 6);
        const odds = await Promise.all(batch.map(g => getJson(
          `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${g.id}/competitions/${g.id}/odds`)));
        batch.forEach((g, j) => {
          const items = (odds[j] && odds[j].items) || [];
          if (!items.length) return;
          // Prefer a provider that carries both a spread and both moneylines.
          const it = items.find(x => Number.isFinite(x.spread) &&
            Number.isFinite(x.homeTeamOdds && x.homeTeamOdds.moneyLine) &&
            Number.isFinite(x.awayTeamOdds && x.awayTeamOdds.moneyLine)) || items[0];
          if (!it || !Number.isFinite(it.spread)) return;
          const hml = it.homeTeamOdds && it.homeTeamOdds.moneyLine;
          const aml = it.awayTeamOdds && it.awayTeamOdds.moneyLine;
          games.push({
            ...g,
            provider: (it.provider && it.provider.name) || null,
            spread: it.spread,
            total: Number.isFinite(it.overUnder) ? it.overUnder : null,
            homeML: Number.isFinite(hml) ? hml : null,
            awayML: Number.isFinite(aml) ? aml : null,
          });
          seen.add(g.id);
        });
      }
      process.stdout.write(`\r  ${year} week ${week}: ${games.length} games collected   `);
    }
  }

  const withML = games.filter(g => g.homeML !== null && g.awayML !== null);
  fs.writeFileSync(OUT, JSON.stringify({ games, harvested: `${FIRST}-${LAST}` }));
  console.log(`\n\ndone: ${games.length} games with a closing spread, ${withML.length} with both moneylines`);
  const byYear = {};
  for (const g of games) byYear[g.year] = (byYear[g.year] || 0) + 1;
  console.log('  by season:', JSON.stringify(byYear));
})();
