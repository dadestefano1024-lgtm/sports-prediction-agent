// If the public moves a number, is the other side the bet?
//
// The theory, and it is a reasonable one: the opener is the book's honest
// estimate, the money that moves it afterwards is mostly public, the public
// loses, so the side the line moved AWAY from should be the value — taken at
// the new, moved number.
//
// Total opens 46, gets bet up to 49, take the under at 49.
//
// This is a DIFFERENT bet from the stale-line rule already tested here, and it
// is important not to confuse them. That one backs the side the market moved
// TOWARD, at the OLD number, and it works: 55.4% at a point, 60.0% at two, with
// a holdout season behind it. It wins because a frozen number is behind the
// market. This one bets at the CURRENT number and needs the market itself to
// be wrong — a much stronger claim.
//
// Both markets, both seasons, split by how far the number moved, with a season
// split and a control.
//
// ANSWER: no, on both markets, and the two markets fail for different reasons.
//
//   SPREADS — fading goes 51.1% at a point and 48.2% at two, and the seasons
//   disagree (52.5% / 49.7%). The control explains it: the CLOSING spread is
//   more accurate than the opener, 9.685 mean error against 9.780. Spread
//   movement carries information, so fading it bets against information rather
//   than against the public.
//
//   TOTALS — fading looks like 56.3% at a two-point move, and that number is an
//   artifact. Totals get bet DOWN more often than up (227 against 174), so the
//   rule ends up taking the over on 61% of its bets, and overs won 53.4% of
//   this sample. Priced against that same over/under mix on base rate alone,
//   the movement itself adds +5.5 points at best, +1.49 SD, on 183 bets, with
//   the seasons disagreeing and the threshold chosen after seeing the results.
//
// The premise is half right and it is worth keeping the right half. On TOTALS
// the close genuinely is no better than the opener — 10.023 against 10.062,
// a tie. Total movement really is close to noise. But noise is not backwards.
// Fading noise is a coin flip minus the vig; for this to pay, the close would
// have to be WORSE than the opener by roughly 2.4 points of win rate, and it is
// worse by 0.04.
//
// Which leaves the distinction that actually matters. Total opens 46 and moves
// to 49. Taking the over at 46 — the old number, the side the move went toward
// — is 60.0% at a two-point move. Taking the under at 49 — the current number,
// against the move — is 53%, nothing. Same game, same movement, opposite bet.
// The edge is in holding a number the market has left behind, not in reading
// the direction of the move.
//
// Run: node fade-the-move.js

const fs = require('fs');

const spreads = JSON.parse(fs.readFileSync('./nfl-open-close.json', 'utf8')).rows;
const totals = JSON.parse(fs.readFileSync('./nfl-totals.json', 'utf8')).rows;

const report = (label, bets) => {
  const n = bets.length;
  if (n < 25) { console.log(`    ${label.padEnd(26)} too few (${n})`); return null; }
  const w = bets.filter(b => b.won).length;
  const rate = w / n;
  const z = (rate - 0.5) / Math.sqrt(0.25 / n);
  console.log(`    ${label.padEnd(26)} ${String(w).padStart(4)}-${String(n - w).padStart(4)}  ` +
    `${(rate * 100).toFixed(1)}%  ${String(n).padStart(4)} bets  ` +
    `${z >= 0 ? '+' : ''}${z.toFixed(2)} SD${rate > 0.524 ? '   beats the vig' : ''}`);
  return { rate, n, z };
};

// ---------------------------------------------------------------------------
// SPREADS
// ---------------------------------------------------------------------------
console.log(`SPREADS — ${spreads.length} games with an opening and a closing number\n`);

const spreadBets = (rows, minMove, fade) => {
  const out = [];
  for (const r of rows) {
    const move = r.close - r.open;              // negative = moved toward home
    if (Math.abs(move) < minMove) continue;
    // fade: back the side the number moved AWAY from. follow: the other way.
    const backHome = fade ? move > 0 : move < 0;
    // Settled at the CURRENT (closing) number, which is the whole point.
    const cover = backHome ? (r.margin + r.close) : -(r.margin + r.close);
    if (Math.abs(cover) < 1e-9) continue;       // push
    out.push({ won: cover > 0, season: r.year, move: Math.abs(move) });
  }
  return out;
};

console.log('  FADING the move, at the closing number ("the public moved it, take the other side"):');
for (const t of [0.5, 1, 1.5, 2, 3]) report(`move >= ${t}`, spreadBets(spreads, t, true));

console.log('\n  FOLLOWING the move, at the closing number, for contrast:');
for (const t of [1, 2, 3]) report(`move >= ${t}`, spreadBets(spreads, t, false));

console.log('\n  fading, by season (a real effect should show in both):');
for (const y of [2024, 2025]) {
  report(`${y}, move >= 1`, spreadBets(spreads.filter(r => r.year === y), 1, true));
}

// ---------------------------------------------------------------------------
// TOTALS — the case actually described
// ---------------------------------------------------------------------------
console.log(`\n\nTOTALS — ${totals.length} games\n`);

const totalBets = (rows, minMove, fade) => {
  const out = [];
  for (const r of rows) {
    const move = r.closeTotal - r.openTotal;    // positive = bet up
    if (Math.abs(move) < minMove) continue;
    // fade: the number was bet UP, so take the under. Settled at the close.
    const backOver = fade ? move < 0 : move > 0;
    const diff = r.points - r.closeTotal;
    if (Math.abs(diff) < 1e-9) continue;
    out.push({ won: backOver ? diff > 0 : diff < 0, season: r.year, move: Math.abs(move) });
  }
  return out;
};

console.log('  FADING the move, at the closing total ("opened 46, bet to 49, take the under at 49"):');
for (const t of [0.5, 1, 1.5, 2, 3]) report(`move >= ${t}`, totalBets(totals, t, true));

console.log('\n  FOLLOWING the move, at the closing total:');
for (const t of [1, 2, 3]) report(`move >= ${t}`, totalBets(totals, t, false));

console.log('\n  fading, by season:');
for (const y of [2024, 2025]) {
  report(`${y}, move >= 1`, totalBets(totals.filter(r => r.year === y), 1, true));
}

// ---------------------------------------------------------------------------
// The control that decides how to read all of it.
// ---------------------------------------------------------------------------
console.log('\n\nWHICH NUMBER WAS CLOSER TO THE RESULT — the opener or the close?');
console.log('  (the theory needs the OPENER to be better; that is what it rests on)\n');

let openBetterS = 0, closeBetterS = 0, tieS = 0;
for (const r of spreads) {
  const eOpen = Math.abs(r.margin + r.open);
  const eClose = Math.abs(r.margin + r.close);
  if (Math.abs(eOpen - eClose) < 1e-9) tieS++;
  else if (eOpen < eClose) openBetterS++;
  else closeBetterS++;
}
const maeS = (k) => spreads.reduce((s, r) => s + Math.abs(r.margin + r[k]), 0) / spreads.length;
console.log(`  spreads: opener closer on ${openBetterS}, close closer on ${closeBetterS}, level ${tieS}`);
console.log(`           mean error — opener ${maeS('open').toFixed(3)}, close ${maeS('close').toFixed(3)}`);

let openBetterT = 0, closeBetterT = 0, tieT = 0;
for (const r of totals) {
  const eOpen = Math.abs(r.points - r.openTotal);
  const eClose = Math.abs(r.points - r.closeTotal);
  if (Math.abs(eOpen - eClose) < 1e-9) tieT++;
  else if (eOpen < eClose) openBetterT++;
  else closeBetterT++;
}
const maeT = (k) => totals.reduce((s, r) => s + Math.abs(r.points - r[k]), 0) / totals.length;
console.log(`  totals:  opener closer on ${openBetterT}, close closer on ${closeBetterT}, level ${tieT}`);
console.log(`           mean error — opener ${maeT('openTotal').toFixed(3)}, close ${maeT('closeTotal').toFixed(3)}`);
