'use strict';
/**
 * Reduce nflverse play-by-play to a per-team, per-week EPA summary.
 *
 * CHECKED: efftest.js (rejected yards-per-play, which is a crude proxy for this
 * and not the same input -- YPP ignores down, distance and field position, is
 * contaminated by game script, and throws away turnovers and red-zone
 * conversion; EPA contains all of it). regression-sweep.js and frozen-test.js
 * (the harness this feeds).
 *
 * 93 MB per season uncompressed, 372 columns, of which seven matter. Everything
 * is reduced to sums and counts here so the model can be re-fitted in seconds
 * without touching the raw files again.
 *
 * Run: node epa-build.js [firstYear] [lastYear]
 */
const fs = require('fs');
const zlib = require('zlib');

const FIRST = Number(process.argv[2] || 2022);
const LAST = Number(process.argv[3] || 2025);
const OUT = './epa-weekly.json';

/** Split one CSV line, respecting quotes, returning only the wanted indices. */
function pick(line, wanted, max) {
  const out = {};
  let i = 0, field = 0, cur = '', q = false;
  for (; i < line.length && field <= max; i++) {
    const ch = line[i];
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) {
      if (wanted.has(field)) out[field] = cur;
      field++; cur = '';
      continue;
    }
    cur += ch;
  }
  if (wanted.has(field)) out[field] = cur;
  return out;
}

async function season(year) {
  const gz = `./pbp${year}.csv.gz`;
  if (!fs.existsSync(gz)) {
    process.stderr.write(`fetching ${year}...\n`);
    const r = await fetch(
      `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${year}.csv.gz`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) { process.stderr.write(`  ${year}: HTTP ${r.status}\n`); return []; }
    fs.writeFileSync(gz, Buffer.from(await r.arrayBuffer()));
  }
  const txt = zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8');
  const nl = txt.indexOf('\n');
  const cols = txt.slice(0, nl).split(',');
  const ix = (n) => cols.indexOf(n);
  const C = {
    week: ix('week'), type: ix('season_type'), pos: ix('posteam'), def: ix('defteam'),
    epa: ix('epa'), play: ix('play_type'), game: ix('game_id'),
  };
  const wanted = new Set(Object.values(C));
  const max = Math.max(...wanted);

  // team|week -> offensive and defensive EPA, summed, with play counts
  const rows = new Map();
  let start = nl + 1, seen = 0;
  while (start < txt.length) {
    let end = txt.indexOf('\n', start);
    if (end < 0) end = txt.length;
    const line = txt.slice(start, end);
    start = end + 1;
    if (!line) continue;
    const f = pick(line, wanted, max);
    if (f[C.type] !== 'REG') continue;
    // Only plays that actually have an EPA: run, pass, and the special-teams
    // plays nflverse scores. Kneels, spikes, timeouts and penalties without a
    // play carry no EPA and would drag the per-play average toward zero.
    const pt = f[C.play];
    if (pt !== 'run' && pt !== 'pass') continue;
    const epa = Number(f[C.epa]);
    if (!Number.isFinite(epa)) continue;
    const off = f[C.pos], def = f[C.def], wk = Number(f[C.week]);
    if (!off || !def || !Number.isFinite(wk)) continue;
    seen++;
    const bump = (team, kind) => {
      const k = team + '|' + wk;
      if (!rows.has(k)) rows.set(k, { team, week: wk, offEpa: 0, offPlays: 0, defEpa: 0, defPlays: 0 });
      const o = rows.get(k);
      if (kind === 'off') { o.offEpa += epa; o.offPlays++; } else { o.defEpa += epa; o.defPlays++; }
    };
    bump(off, 'off');
    bump(def, 'def');
  }
  process.stderr.write(`  ${year}: ${seen} plays -> ${rows.size} team-weeks\n`);
  return [...rows.values()].map(r => ({ season: year, ...r }));
}

(async () => {
  let all = [];
  for (let y = FIRST; y <= LAST; y++) all = all.concat(await season(y));
  fs.writeFileSync(OUT, JSON.stringify(all));
  const bySeason = {};
  for (const r of all) bySeason[r.season] = (bySeason[r.season] || 0) + 1;
  console.log('wrote ' + OUT + ' — ' + all.length + ' team-weeks ' + JSON.stringify(bySeason));
  const t = all[0];
  console.log('sample:', JSON.stringify(t));
  console.log('  offensive EPA per play for that team-week:',
    (t.offEpa / t.offPlays).toFixed(4), 'over', t.offPlays, 'plays');
})();
