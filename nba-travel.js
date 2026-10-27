'use strict';
/**
 * The NBA stale-line rule across the TRAVEL axis, harvested from ESPN only.
 *
 * CHECKED: travel-test.js (the identical sweep for NFL, on frozen-rows.json),
 * calibrate-sport.js (the harvest-and-cache pattern reused here, and the source
 * of the recorded NBA headline), price-move.js, frozen-test.js, nba-rest.js.
 * None of them sweeps travel for basketball: calibrate-sport.js measured the
 * rule at the OPEN only (62.1% at 2+ points, n=435, 5.03 SD, all seven months
 * positive) and nothing measured what a partly-absorbed NBA number is worth.
 *
 * WHY IT MATTERS NOW. Danny asked for a recommendation on NBA without a second
 * book. The measured rule needs no second book -- it compares a number against
 * ITSELF over time, and ESPN's free feed carries DraftKings' open and current.
 * What it does need is to know what the number is worth partway through the
 * move, because a live bet is never at the open. For football that curve is
 * measured. For basketball it was a guess, and an interpolation presented as a
 * measurement is the thing this repo keeps getting caught by.
 *
 * Nothing here touches the paid feed. ESPN's scoreboard for scores, its core
 * odds endpoint for the opening and closing numbers, cached to disk so a re-run
 * costs nothing.
 *
 * Run: node nba-travel.js [startYYYYMMDD] [endYYYYMMDD]
 */
const fs = require('fs');

const START = process.argv[2] || '20251022';
const END = process.argv[3] || '20260412';
const CACHE = './cal-nba-travel-cache.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
let fetched = 0, served = 0;

const get = async (url) => {
  if (cache[url] !== undefined) { served++; return cache[url]; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) { const v = await r.json(); cache[url] = v; fetched++; return v; }
      if (r.status === 404) break;             // genuinely absent, not a blip
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
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
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

(async () => {
  console.log('harvesting NBA ' + START + ' to ' + END + '  (' + dates.length + ' dates)');
  const rows = [];
  let n = 0;
  for (const day of dates) {
    n++;
    const sb = await get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=' + day);
    const events = (sb && sb.events) || [];
    for (const ev of events) {
      const c = (ev.competitions || [])[0];
      if (!c || !c.status || !c.status.type || !c.status.type.completed) continue;
      const h = (c.competitors || []).find((x) => x.homeAway === 'home');
      const a = (c.competitors || []).find((x) => x.homeAway === 'away');
      if (!h || !a) continue;
      const hs = Number(h.score), as = Number(a.score);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;

      const od = await get('https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/' +
        ev.id + '/competitions/' + ev.id + '/odds');
      const items = (od && od.items) || [];
      // skip the in-play feeds: one of them carried a live number nothing else had
      const it = items.find((x) => !/live/i.test((x.provider && x.provider.name) || '')) || items[0];
      if (!it) continue;
      const hto = it.homeTeamOdds || {};
      const g = (ph) => num(hto[ph] && hto[ph].pointSpread && hto[ph].pointSpread.american);
      const open = g('open'), close = g('current');
      if (open === null || close === null) continue;
      rows.push({ id: ev.id, date: day, margin: hs - as, open, close,
                  month: day.slice(0, 6) });
    }
    if (n % 20 === 0) { save(); console.log('  ' + n + '/' + dates.length +
      '  rows ' + rows.length + '  (fetched ' + fetched + ', cached ' + served + ')'); }
  }
  save();
  fs.writeFileSync('./nba-travel-rows.json', JSON.stringify(rows));
  console.log('\n' + rows.length + ' games with an opening AND closing number');
  console.log('fetched ' + fetched + ' urls, ' + served + ' from cache\n');

  // ---- the sweep, identical in shape to travel-test.js --------------------
  // home covers at L when margin + L > 0. move = close - open, negative = the
  // market moved toward HOME. A PUSH IS A REFUND for live betting, which is what
  // the NBA tab is for -- unlike the Pick 6, where it loses. Scored both ways.
  function run(t, minMove, pushLoses) {
    const bets = [];
    for (const r of rows) {
      const move = r.close - r.open;
      if (!Number.isFinite(move) || Math.abs(move) < minMove || Math.abs(move) < 1e-9) continue;
      const line = r.open + t * move;
      const backHome = move < 0;
      const cover = backHome ? (r.margin + line) : -(r.margin + line);
      if (Math.abs(cover) < 1e-9) { if (pushLoses) bets.push({ won: false, m: r.month }); continue; }
      bets.push({ won: cover > 0, m: r.month });
    }
    const nb = bets.length;
    if (!nb) return null;
    const w = bets.filter((b) => b.won).length;
    const byMonth = {};
    for (const b of bets) {
      byMonth[b.m] = byMonth[b.m] || { n: 0, w: 0 };
      byMonth[b.m].n++; if (b.won) byMonth[b.m].w++;
    }
    return { n: nb, p: w / nb, sd: (w / nb - 0.5) / Math.sqrt(0.25 / nb), byMonth };
  }

  const pc = (x) => (x * 100).toFixed(1) + '%';
  const TRAVELS = [0, 0.25, 0.5, 0.75, 1];
  for (const pushLoses of [false, true]) {
    console.log('PUSH ' + (pushLoses ? 'LOSES (the Pick 6 rule)' : 'REFUNDS (live betting, the NBA tab)'));
    console.log('  move        n        0%     25%     50%     75%    100%');
    console.log('  ' + '-'.repeat(54));
    for (const [label, mm] of [['any', 0.5], ['>=1pt', 1], ['>=2pt', 2], ['>=3pt', 3]]) {
      const cells = TRAVELS.map((t) => run(t, mm, pushLoses));
      console.log('  ' + label.padEnd(8) + String(cells[0] ? cells[0].n : 0).padStart(5) + '  ' +
        cells.map((c) => (c ? pc(c.p) : '  --  ').padStart(8)).join(''));
      console.log('  ' + ' '.repeat(8) + '     ' + '  ' +
        cells.map((c) => (c ? ((c.sd >= 0 ? '+' : '') + c.sd.toFixed(2)) : ' -- ').padStart(8)).join('') +
        '   SD');
    }
    console.log('');
  }

  // gate 2: every month the same direction, at the bar this project uses
  console.log('GATE 2 -- months agreeing, move>=2, push refunds');
  for (const t of TRAVELS) {
    const r = run(t, 2, false);
    if (!r) continue;
    const ms = Object.keys(r.byMonth).sort();
    const rates = ms.map((m) => r.byMonth[m].w / r.byMonth[m].n);
    const above = rates.filter((x) => x > 0.5).length;
    console.log('  ' + ((t * 100) + '%').padStart(5) + '  ' + above + ' of ' + ms.length +
      ' months above 50%   ' + ms.map((m, i) =>
        m.slice(4) + ':' + (rates[i] * 100).toFixed(0)).join(' '));
  }
  console.log('');
})().catch((e) => { save(); console.error(e.message); process.exit(1); });
