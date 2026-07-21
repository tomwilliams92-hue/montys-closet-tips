// backtest.mjs
// Point-in-time backtest of the model's TRACKED picks over recent completed events.
// For each past event it reconstructs the inputs AS THEY WERE before that event
// (season strokes-gained THROUGH the prior event, recent form from the prior 5 events,
// last week's leaderboard for the let-down), runs the exact picks engine, then settles
// against the real final leaderboard.
//
// IMPORTANT: this proves model SKILL (do the picks finish well / is it calibrated?), not
// profit vs the market - prices here are the model's own estimate, so P&L is notional.
// Proving profit vs real bookmaker odds needs a historical-odds feed (DataGolf).
//
//   node backtest.mjs [N]      N = how many recent events to test (default 10)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSchedule, getField, getStat, getEventSG, getLeaderboard } from './pga-api.mjs';
import { profileFor } from './course-profiles.mjs';
import { buildModel } from './model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SG = { total: '02675', ott: '02567', app: '02568', arg: '02569', putt: '02564' };
const DRIVE = { distance: '101', accuracy: '102' };
const MAJOR_RE = /(Masters Tournament|PGA Championship|U\.?S\.? Open|The Open Championship|THE PLAYERS)/i;
const isMajor = (n) => MAJOR_RE.test(n || '') && !/Scottish|Canadian|Mexico|Australian/i.test(n || '');

// season-to-date stat THROUGH a given (prior) event = the state going into the next one
const seasonThrough = (statId, year, throughId) => getStat(statId, year, { tournamentId: throughId, queryType: 'THROUGH_EVENT' });

const LEG_NEED = { win: 1, top5: 5, top10: 10, top20: 20, top30: 30 };
function settle(bet, positions) {
  // Multi (restructure tier 3): every leg's cond must hit for the double/treble to pay.
  if (bet.legs) {
    let allHit = true, unknown = false;
    const txt = [];
    for (const l of bet.legs) {
      const fr = positions.get(String(l.playerId));
      if (!fr) { unknown = true; txt.push(`${l.player} ?`); continue; }
      const pos = fr.cut ? null : fr.pos;
      const hit = l.cond === 'makeCut' ? !fr.cut : Number.isFinite(pos) && pos <= LEG_NEED[l.cond];
      if (!hit) allHit = false;
      txt.push(`${l.player} ${fr.cut ? 'MC' : fr.posText}`);
    }
    const hit = allHit && !unknown;
    return { hit, profit: (hit ? bet.points * bet.priceDecimal : 0) - bet.points, finishPos: txt.join(', ') };
  }
  const fr = positions.get(String(bet.playerId));
  const pos = fr && !fr.cut ? fr.pos : null;
  const placed = (n) => Number.isFinite(pos) && pos <= n;
  let ret = 0, hit = false;
  if (bet.market === 'win') { // each-way: half win, half top-5 place at 1/5
    const side = bet.points / 2;
    if (pos === 1) ret += side * bet.priceDecimal;
    if (placed(5)) ret += side * (1 + (bet.priceDecimal - 1) / 5);
    hit = placed(5);
  } else if (bet.market === 'makeCut') {
    hit = !!fr && !fr.cut && Number.isFinite(fr.pos);
    ret = hit ? bet.points * bet.priceDecimal : 0;
  } else {
    hit = placed(LEG_NEED[bet.market]);
    ret = hit ? bet.points * bet.priceDecimal : 0;
  }
  return { hit, profit: ret - bet.points, finishPos: fr ? (fr.cut ? 'MC' : fr.posText) : 'n/a' };
}

async function main() {
  const N = parseInt(process.argv[2] || '10', 10);
  const year = new Date().getFullYear();
  let { completed } = await getSchedule(year);
  if (completed.length < 8) ({ completed } = await getSchedule(year - 1));
  const start = Math.max(6, completed.length - N);
  console.error(`[backtest] season ${year}, testing events ${start + 1}-${completed.length} of ${completed.length}`);

  const rowsOut = [];
  let staked = 0, profit = 0, hits = 0, bets = 0;
  const byMarket = {};

  for (let i = start; i < completed.length; i++) {
    const E = completed[i], prev = completed[i - 1];
    const recentSrc = completed.slice(Math.max(0, i - 5), i).reverse();
    try {
      const [field, sgT, sgO, sgA, sgAr, sgP, dD, dA, prevLb, resultLb, ...recent] = await Promise.all([
        getField(E.id),
        seasonThrough(SG.total, year, prev.id), seasonThrough(SG.ott, year, prev.id), seasonThrough(SG.app, year, prev.id),
        seasonThrough(SG.arg, year, prev.id), seasonThrough(SG.putt, year, prev.id),
        seasonThrough(DRIVE.distance, year, prev.id), seasonThrough(DRIVE.accuracy, year, prev.id),
        getLeaderboard(prev.id), getLeaderboard(E.id),
        ...recentSrc.map((e) => getEventSG(e.id, year)),
      ]);
      if (!field?.players?.length || !resultLb?.positions?.size) { console.error(`  skip ${E.tournamentName} (no field/result)`); continue; }
      const recentEvents = recentSrc.map((e, j) => ({ id: e.id, name: e.tournamentName, map: recent[j].map }));
      const previousEvent = { name: prev.tournamentName, isMajor: isMajor(prev.tournamentName), champion: prev.champion || null, finishPositions: prevLb?.positions || null };
      const model = buildModel({
        field, profile: profileFor(E.id),
        sg: { total: sgT.map, ott: sgO.map, app: sgA.map, arg: sgAr.map, putt: sgP.map },
        driving: { distance: dD.map, accuracy: dA.map },
        recentEvents, previousEvent, weekNumber: i + 1,
      });
      const picks = model.trackedBets;
      let evProfit = 0;
      for (const c of picks) {
        const r = settle(c, resultLb.positions);
        bets++; staked += c.points; profit += r.profit; evProfit += r.profit; if (r.hit) hits++;
        const mk = c.legs ? 'Double (banker legs)' : c.marketLabel; // group all doubles for a usable calibration sample
        (byMarket[mk] ||= { n: 0, hit: 0, profit: 0, pred: 0 });
        byMarket[mk].n++; if (r.hit) byMarket[mk].hit++; byMarket[mk].profit += r.profit; byMarket[mk].pred += (c.modelProb || 0);
        rowsOut.push({ event: E.tournamentName, player: c.name, market: c.marketLabel, price: c.priceFractional, finish: r.finishPos, hit: r.hit, profit: Math.round(r.profit * 10) / 10 });
      }
      console.error(`  ${E.tournamentName.slice(0, 34).padEnd(34)} picks ${picks.length}  net ${evProfit >= 0 ? '+' : ''}${evProfit.toFixed(1)}pt`);
    } catch (e) { console.error(`  ERROR ${E.tournamentName}: ${e.message}`); }
  }

  console.log('\n================ BACKTEST RESULT (model skill - notional prices) ================');
  console.log(`Events: ${start + 1}-${completed.length}  |  Bets: ${bets}  |  Strike (hit market): ${bets ? Math.round((hits / bets) * 100) : 0}%`);
  console.log(`Staked: ${staked} pts  |  Net: ${profit >= 0 ? '+' : ''}${profit.toFixed(1)} pts  |  ROI: ${staked ? (profit / staked * 100).toFixed(1) : 0}%`);
  console.log('\nCalibration by market (model predicted % vs actual hit %):');
  const calLines = [];
  for (const [m, s] of Object.entries(byMarket)) {
    const pred = Math.round((s.pred / s.n) * 100), act = Math.round((s.hit / s.n) * 100), gap = act - pred;
    console.log(`  ${m.padEnd(7)}  ${s.n} bets  model ${pred}%  actual ${act}%  gap ${gap >= 0 ? '+' : ''}${gap}pts  net ${s.profit >= 0 ? '+' : ''}${s.profit.toFixed(1)}pt`);
    calLines.push(`| ${m} | ${s.n} | ${pred}% | ${act}% | ${gap >= 0 ? '+' : ''}${gap}pts | ${s.profit >= 0 ? '+' : ''}${s.profit.toFixed(1)} |`);
  }
  console.log('\nNOTE: prices are the model\'s own estimate, so ROI is NOT proof of beating the market.');
  console.log('It shows whether the picks finish where the model expects. Profit-vs-market needs real historical odds (DataGolf).');

  // Persist a LABELLED backtest report (separate from the live ledger; NOT a public track record).
  const doc = `# The Green Book — Season Backtest (learning only)

_Generated by \`backtest.mjs\` on ${new Date().toISOString().slice(0, 10)}. Point-in-time replay of the model over completed 2026 events (season strokes-gained through the prior event, form from the prior 5), settled against real final leaderboards._

⚠️ **This is NOT a live track record and must never be presented as one.** These bets were not committed before the events — they are a retrospective simulation for CALIBRATION. Prices are the model's own estimates, so the P&L is **notional** (proves whether the model's probabilities are honest, not profit vs the market — that needs a historical-odds feed, DataGolf). Keep it out of the public ledger/board.

## Sample
Events tested: **${completed.length - start}** · Bets: **${bets}** · Overall strike (hit market): **${bets ? Math.round((hits / bets) * 100) : 0}%** · Net (notional): **${profit >= 0 ? '+' : ''}${profit.toFixed(1)}pts** · ROI (notional): **${staked ? (profit / staked * 100).toFixed(1) : 0}%**

## Calibration by market
_Model = the model's average stated probability. Actual = how often it hit. Big negative gap = over-confident._
| Market | Bets | Model | Actual | Gap | Net (notional) |
|---|---|---|---|---|---|
${calLines.join('\n')}

## Reading it
- Focus on the **gaps**, not the notional P&L. A persistent negative gap in a market = shrink that market's probabilities (a calibration factor for \`model.mjs\`).
- The win/each-way market's value lives in the price and the place half — notional prices understate it, so judge win bets on real odds, not this.
- Per-market samples are still modest (esp. Top-5); treat as the best evidence available, not gospel. Re-run as the season grows.
`;
  fs.writeFileSync(path.join(__dirname, 'THE-GREEN-BOOK-backtest.md'), doc);
  console.log('\n[backtest] wrote THE-GREEN-BOOK-backtest.md (labelled learning artifact — not for the public ledger)');
}

main().catch((e) => { console.error('[backtest] FAILED:', e.message); process.exit(1); });
