'use strict';
/**
 * Why does the History tab show totals at 13-9?
 *
 * CHECKED: totals-gap.js and stale-totals-pool.js (both measure the totals
 * STALE-LINE rule on historical data, not the app's own shipped record),
 * regrade_audit.js (checks the grading, not the selection). Nothing takes the
 * app's own graded totals and asks the one question that decides this: what
 * would the dumbest possible rule have scored on exactly those games?
 *
 * The three things that can make a record like this look like skill:
 *   1. n. 22 bets is about one standard error of 10 percentage points.
 *   2. The BASELINE. If the picks lean one way and that way ran hot, the record
 *      is the league's scoring, not the model's. "Always take the over" scored
 *      50.6% across the measured seasons -- on 22 games it can be anything.
 *   3. DOUBLE COUNTING in the tab. byConfidence says Medium went 13-9-1 and
 *      byMarket says totals went 13-9. If those are the same bets, the tab is
 *      showing one result twice and it reads as two independent findings.
 *
 * Run: node totals-why.js
 */
const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('../hist.json', 'utf8')).recent || [];

const graded = (r) => r.result === 'win' || r.result === 'loss' || r.result === 'push';
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const pts = (r) => {
  const h = num(r.actual_home), a = num(r.actual_away);
  return (Number.isFinite(h) && Number.isFinite(a)) ? h + a : null;
};
const dirOf = (r) => /\bover\b/i.test(r.pick || '') ? 'over'
  : /\bunder\b/i.test(r.pick || '') ? 'under' : null;

const tot = rows.filter((r) => r.market === 'total' && graded(r));
const rec = tot.filter((r) => (r.source || 'recommendation') === 'recommendation');

const tally = (list) => {
  const w = list.filter((r) => r.result === 'win').length;
  const l = list.filter((r) => r.result === 'loss').length;
  const p = list.filter((r) => r.result === 'push').length;
  return { n: list.length, w, l, p,
    rate: (w + l) ? w / (w + l) : null,
    sd: (w + l) ? ((w / (w + l)) - 0.5) / Math.sqrt(0.25 / (w + l)) : null };
};
const pc = (x) => (x === null ? '--' : (x * 100).toFixed(1) + '%');

const t = tally(rec);
console.log('');
console.log('THE NUMBER ON THE TAB');
console.log('  app totals (NFL tab):  ' + t.w + '-' + t.l + (t.p ? '-' + t.p : '') +
  '   ' + pc(t.rate) + '   ' + (t.sd >= 0 ? '+' : '') + t.sd.toFixed(2) + ' SD   n=' + (t.w + t.l));
console.log('  one standard error on ' + (t.w + t.l) + ' bets is ' +
  (Math.sqrt(0.25 / (t.w + t.l)) * 100).toFixed(1) + ' points, so the band around that');
console.log('  figure runs from about ' + ((t.rate - Math.sqrt(0.25 / (t.w + t.l))) * 100).toFixed(0) +
  '% to ' + ((t.rate + Math.sqrt(0.25 / (t.w + t.l))) * 100).toFixed(0) + '%.');

// ---- 1. which way do the picks lean? ---------------------------------------
const overs = rec.filter((r) => dirOf(r) === 'over');
const unders = rec.filter((r) => dirOf(r) === 'under');
console.log('');
console.log('WHICH WAY DO THEY LEAN');
console.log('  overs taken:  ' + overs.length + '   ' + (() => { const x = tally(overs); return x.w + '-' + x.l + '  ' + pc(x.rate); })());
console.log('  unders taken: ' + unders.length + '   ' + (() => { const x = tally(unders); return x.w + '-' + x.l + '  ' + pc(x.rate); })());
const unknown = rec.filter((r) => !dirOf(r));
if (unknown.length) console.log('  direction unreadable from the pick text: ' + unknown.length);

// ---- 2. THE BASELINE: what would a blind rule have done on these games? ----
const withPts = rec.filter((r) => pts(r) !== null && num(r.line) !== null);
console.log('');
console.log('THE BASELINE -- the same games, scored by a rule with no model in it');
console.log('  (' + withPts.length + ' of ' + rec.length + ' rows carry both a line and a final score)');
if (withPts.length) {
  const blind = (dir) => {
    let w = 0, l = 0, p = 0;
    for (const r of withPts) {
      const total = pts(r), line = num(r.line);
      if (Math.abs(total - line) < 1e-9) { p++; continue; }
      const over = total > line;
      ((dir === 'over') === over) ? w++ : l++;
    }
    return { w, l, p, rate: (w + l) ? w / (w + l) : null };
  };
  const o = blind('over'), u = blind('under');
  console.log('  always the OVER:   ' + o.w + '-' + o.l + (o.p ? '-' + o.p : '') + '   ' + pc(o.rate));
  console.log('  always the UNDER:  ' + u.w + '-' + u.l + (u.p ? '-' + u.p : '') + '   ' + pc(u.rate));
  const best = Math.max(o.rate || 0, u.rate || 0);
  const appOn = tally(withPts);
  console.log('  the app on those same games: ' + appOn.w + '-' + appOn.l + '   ' + pc(appOn.rate));
  console.log('');
  console.log('  >> the better blind rule scored ' + pc(best) + ' on these games.');
  console.log('  >> the app scored ' + pc(appOn.rate) + '.');
  console.log('  >> picking skill is the DIFFERENCE, which is ' +
    (appOn.rate !== null ? ((appOn.rate - best) * 100).toFixed(1) + ' points' : '--') + '.');
}

// ---- 3. is the tab showing the same bets twice? ----------------------------
console.log('');
console.log('IS THE TAB COUNTING THESE TWICE');
const byConf = {};
for (const r of rec) {
  const c = r.confidence || 'none';
  byConf[c] = byConf[c] || [];
  byConf[c].push(r);
}
for (const [c, list] of Object.entries(byConf)) {
  const x = tally(list);
  console.log('  totals at confidence "' + c + '": ' + x.w + '-' + x.l + (x.p ? '-' + x.p : '') +
    '   n=' + x.n);
}
const allRec = rows.filter((r) => (r.source || 'recommendation') === 'recommendation' && graded(r));
const med = allRec.filter((r) => r.confidence === 'Medium');
const medTotals = med.filter((r) => r.market === 'total');
console.log('  all Medium-confidence rows: ' + med.length +
  ', of which totals: ' + medTotals.length);
if (med.length && medTotals.length === med.length) {
  console.log('  >> EVERY Medium-confidence bet is a total. The tab\'s "Medium does well"');
  console.log('     and "totals do well" are the SAME ' + med.length + ' bets printed twice.');
}

// ---- 4. how concentrated in time? ------------------------------------------
const weeks = {};
for (const r of rec) {
  const k = (r.game_time || r.created_at || '').slice(0, 10);
  weeks[k] = (weeks[k] || 0) + 1;
}
const days = Object.keys(weeks).sort();
console.log('');
console.log('OVER WHAT PERIOD');
console.log('  ' + days.length + ' distinct dates, ' + (days[0] || '?') + ' to ' +
  (days[days.length - 1] || '?'));
console.log('  busiest day carried ' + Math.max(...Object.values(weeks)) + ' of the ' +
  rec.length + ' bets');
console.log('');
