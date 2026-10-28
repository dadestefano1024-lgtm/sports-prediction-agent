'use strict';
/**
 * Harvest NHL games with the puckline PRICES and both moneylines, for grading
 * runLineEdge -- the sport it was actually written for.
 *
 * CHECKED: nba-travel.js (same harvest-and-cache shape, same endpoints, and its
 * cache is why this one is needed -- that cache is basketball and
 * coverProbFromWinProb has no margin table for it), calibrate-sport.js,
 * runline-test.js (the grader, which asked NBA and got null 3,983 times).
 *
 * runLineEdge needs FOUR numbers from the same book plus the result: both
 * moneylines, the puckline and the price on each side of it. ESPN's core odds
 * feed carries all of them and nothing here has ever read the prices.
 *
 * Nothing touches the paid feed. Cached to disk so a re-run is free.
 *
 * Run: node nhl-harvest.js [startYYYYMMDD] [endYYYYMMDD]
 */
const fs = require('fs');

const START = process.argv[2] || '20241004';
const END = process.argv[3] || '20250417';
const CACHE = './cal-nhl-price-cache.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
let fetched = 0, served = 0;

const get = async (url) => {
  if (cache[url] !== undefined) { served++; return cache[url]; }
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) { const v = await r.json(); cache[url] = v; fetched++; return v; }
      if (r.status === 404) break;
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 400 * (a + 1)));
  }
  cache[url] = null;
  return null;
};
const save = () => fs.writeFileSync(CACHE, JSON.stringify(cache));
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^(even|ev|pk|pick)$/i.test(s)) return 0;
  const n = Number(s.replace('+', ''));
  return Number.isFinite(n) ? n : null;
};

const dates = [];
{
  const d = new Date(START.slice(0, 4) + '-' + START.slice(4, 6) + '-' + START.slice(6, 8) + 'T12:00:00Z');
  const end = new Date(END.slice(0, 4) + '-' + END.slice(4, 6) + '-' + END.slice(6, 8) + 'T12:00:00Z');
  while (d <= end) { dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    d.setUTCDate(d.getUTCDate() + 1); }
}

(async () => {
  console.log('harvesting NHL ' + START + ' to ' + END + '  (' + dates.length + ' dates)');
  const out = [];
  let n = 0;
  for (const day of dates) {
    n++;
    const sb = await get('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=' + day);
    for (const ev of ((sb && sb.events) || [])) {
      const c = (ev.competitions || [])[0];
      if (!c || !c.status?.type?.completed) continue;
      const h = (c.competitors || []).find((x) => x.homeAway === 'home');
      const a = (c.competitors || []).find((x) => x.homeAway === 'away');
      if (!h || !a) continue;
      const hs = Number(h.score), as = Number(a.score);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;

      const od = await get('https://sports.core.api.espn.com/v2/sports/hockey/leagues/nhl/events/' +
        ev.id + '/competitions/' + ev.id + '/odds');
      const items = (od && od.items) || [];
      const it = items.find((x) => !/live/i.test((x.provider && x.provider.name) || '')) || items[0];
      if (!it) continue;
      const hto = it.homeTeamOdds || {}, ato = it.awayTeamOdds || {};
      const g = (o, f) => num(o && o.current && o.current[f] && o.current[f].american);
      const rec = {
        id: ev.id, date: day, month: day.slice(0, 6),
        margin: hs - as,
        spread: g(hto, 'pointSpread'),
        sHome: g(hto, 'spread'), sAway: g(ato, 'spread'),
        mlHome: g(hto, 'moneyLine'), mlAway: g(ato, 'moneyLine'),
        book: (it.provider && it.provider.name) || '?',
      };
      if (![rec.spread, rec.sHome, rec.sAway, rec.mlHome, rec.mlAway].every(Number.isFinite)) continue;
      out.push(rec);
    }
    if (n % 25 === 0) { save(); console.log('  ' + n + '/' + dates.length + '  rows ' + out.length +
      '  (fetched ' + fetched + ', cached ' + served + ')'); }
  }
  save();
  fs.writeFileSync('./nhl-price-rows.json', JSON.stringify(out));
  console.log('\n' + out.length + ' NHL games with puckline PRICES, both moneylines and a result');
  const books = {};
  for (const r of out) books[r.book] = (books[r.book] || 0) + 1;
  console.log('providers: ' + Object.entries(books).map(([b, c]) => b + ' ' + c).join(', '));
  const spreads = {};
  for (const r of out) spreads[r.spread] = (spreads[r.spread] || 0) + 1;
  console.log('pucklines seen: ' + JSON.stringify(spreads));
  console.log('fetched ' + fetched + ' urls, ' + served + ' from cache');
})().catch((e) => { save(); console.error(e.message); process.exit(1); });
