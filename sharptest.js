'use strict';

// Does line movement actually predict anything?
//
// The app shows "sharp action" callouts derived from open-to-current spread
// movement. Until the parser was fixed those were computed from noise. Now that
// the numbers are real, the question is whether the signal is.
//
// Two things are tested, and they are not the same question:
//
//   1. Does movement predict the winner AGAINST THE CLOSING LINE? If yes, the
//      closing line is beatable by watching movement, which would be
//      remarkable.
//   2. Does the closing line beat the OPENING line? If yes, moving with the
//      market is valuable only if you got in before it moved — which is CLV,
//      not a signal to act on now.
//
//   node sharptest.js

const axios = require('axios');
const fs = require('fs');

const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const pa = src.indexOf('function parseScore'), pb = src.indexOf('\n}\n', pa) + 2;
const parseScore = eval('(' + src.slice(pa, pb) + ')');

const CACHE = 'sharptest-cache.json';
const disk = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
let dirty = 0;
const flush = () => { if (dirty) { fs.writeFileSync(CACHE, JSON.stringify(disk)); dirty = 0; } };
async function cached(k, fn) {
  if (disk[k] !== undefined) return disk[k];
  try { disk[k] = await fn(); } catch (e) { disk[k] = null; }
  if (++dirty >= 40) flush();
  return disk[k];
}

const numOf = (v) => (v == null ? null : Number(String(v).replace('+', '')));

(async () => {
  const rows = [];
  for (let wk = 1; wk <= 18; wk++) {
    const sb = await cached(`sb:${wk}`, async () => (await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${wk}&dates=2025&limit=100`)).data);
    for (const ev of (sb && sb.events) || []) {
      const cm = ev.competitions[0];
      const H = cm.competitors.find(x => x.homeAway === 'home');
      const A = cm.competitors.find(x => x.homeAway === 'away');
      const fh = parseScore(H), fa = parseScore(A);
      if (fh === null || fa === null) continue;

      const o = await cached(`o:${ev.id}`, async () => {
        const r = await axios.get(
          `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${ev.id}/competitions/${ev.id}/odds`);
        const it = (r.data.items || [])[0];
        if (!it) return null;
        const hto = it.homeTeamOdds || {};
        const pick = (ph, f) => hto[ph] && hto[ph][f] ? hto[ph][f].american : null;
        return {
          open: pick('open', 'pointSpread'),
          close: pick('current', 'pointSpread'),
          openTotal: it.open?.total?.american ?? null,
          closeTotal: it.current?.total?.american ?? null,
        };
      });
      if (!o) continue;
      const open = numOf(o.open), close = numOf(o.close);
      if (open === null || close === null) continue;

      rows.push({ margin: fh - fa, open, close, move: close - open,
                  total: fh + fa,
                  openTotal: numOf(o.openTotal), closeTotal: numOf(o.closeTotal) });
    }
  }
  flush();

  console.log(`NFL 2025 — ${rows.length} games with both an opening and a closing spread`);
  const moved = rows.filter(r => Math.abs(r.move) >= 0.5);
  console.log(`games whose spread moved at least half a point: ${moved.length}`);
  console.log('');

  // 1. Does movement predict the cover, against the CLOSING line?
  //    Home covers the close when margin + close > 0. "Followed the move" means
  //    backing whichever side the line moved toward.
  const bucket = (min, max) => moved.filter(r => Math.abs(r.move) >= min && Math.abs(r.move) < max);
  const record = (set) => {
    let w = 0, l = 0, p = 0;
    for (const r of set) {
      const adj = r.margin + r.close;
      if (Math.abs(adj) < 1e-9) { p++; continue; }
      // move < 0 means the line moved toward the home side
      const backedHome = r.move < 0;
      const homeCovered = adj > 0;
      if (backedHome === homeCovered) w++; else l++;
    }
    const n = w + l;
    return { w, l, p, n, pct: n ? (100 * w / n) : null };
  };

  console.log('  1. FOLLOWING the move, graded against the CLOSING line');
  console.log('     (52.4% is break-even at -110)');
  for (const [label, lo, hi] of [['any move      ', 0.5, 99],
                                 ['0.5 to 1 pt   ', 0.5, 1],
                                 ['1 to 2 pts    ', 1, 2],
                                 ['2+ pts (strong)', 2, 99]]) {
    const r = record(bucket(lo, hi));
    console.log(`     ${label}  ${String(r.w).padStart(3)}-${String(r.l).padEnd(3)}  ` +
      `${r.pct === null ? 'n/a' : r.pct.toFixed(1) + '%'}  (n=${r.n})`);
  }

  // 2. Does the closing line beat the opening line at predicting the result?
  const mae = (f) => rows.reduce((s, r) => s + Math.abs(f(r) - r.margin), 0) / rows.length;
  console.log('');
  console.log('  2. Which number describes the game better');
  console.log('     opening line MAE :', mae(r => -r.open).toFixed(3));
  console.log('     closing line MAE :', mae(r => -r.close).toFixed(3));
  console.log('     -> the close is better by',
    (mae(r => -r.open) - mae(r => -r.close)).toFixed(3), 'points/game');

  // 3. And the practical version: how often did the line move toward the side
  //    that eventually covered the OPENING number?
  let beat = 0, lost = 0;
  for (const r of moved) {
    const adjOpen = r.margin + r.open;
    if (Math.abs(adjOpen) < 1e-9) continue;
    const backedHome = r.move < 0;
    const homeCoveredOpen = adjOpen > 0;
    if (backedHome === homeCoveredOpen) beat++; else lost++;
  }
  console.log('');
  console.log('  3. FOLLOWING the move, graded against the OPENING line');
  console.log(`     ${beat}-${lost}  ${(100 * beat / (beat + lost)).toFixed(1)}%  (n=${beat + lost})`);
  console.log('     this is the number that matters for getting in early');
})();
