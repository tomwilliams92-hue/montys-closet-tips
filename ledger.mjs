// ledger.mjs
// The P&L track record, kept in POINTS / UNITS (stake-agnostic - users pick their own £).
// Tracked bets are logged as "pending" when published, then settled the following week off
// the final leaderboard. ledger.json is committed to git, so the record is publicly verifiable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(__dirname, 'ledger.json');
const r2 = (n) => Math.round(n * 100) / 100;

export function loadLedger() {
  if (fs.existsSync(LEDGER)) return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  return { startBankPts: 100, createdAt: new Date().toISOString(), bets: [] };
}
export function saveLedger(l) { fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }

// Record this week's tracked bets as pending (id keyed so re-running a week updates, not dupes).
export function appendWeek(ledger, board) {
  for (const c of board.trackedBets) {
    const id = `${board.event.id}:${c.playerId}:${c.market}`;
    if (ledger.bets.some((b) => b.id === id)) continue;
    ledger.bets.push({
      id, weekNumber: board.bankroll.weekNumber, eventId: board.event.id, eventName: board.event.name,
      placedAt: board.generatedAt, playerId: c.playerId, player: c.name,
      market: c.market, marketLabel: c.marketLabel, eachWay: c.eachWay,
      stakePts: c.points, priceDecimal: c.priceDecimal, priceFractional: c.priceFractional,
      modelProb: c.modelProb, status: 'pending', finishPos: null, returnPts: null, profitPts: null,
    });
  }
}

function gradeBet(bet, pos, cut) {
  // returns total return in POINTS for the stake; profit = return - stake
  const placed = (n) => Number.isFinite(pos) && pos <= n && !cut;
  if (bet.eachWay) {
    const side = bet.stakePts / 2; // half win, half place (top-5 at 1/5 odds)
    let ret = 0;
    if (Number.isFinite(pos) && pos === 1 && !cut) ret += side * bet.priceDecimal;   // win part
    if (placed(5)) ret += side * (1 + (bet.priceDecimal - 1) / 5);                    // place part
    return ret;
  }
  const need = { win: 1, top5: 5, top10: 10, top20: 20 }[bet.market];
  return placed(need) ? bet.stakePts * bet.priceDecimal : 0;
}

// Settle pending bets whose event has finished. getPositions(eventId) -> {positions: Map}.
export async function settle(ledger, completedEventIds, getPositions) {
  const pending = ledger.bets.filter((b) => b.status === 'pending' && completedEventIds.has(b.eventId));
  const byEvent = {};
  for (const b of pending) (byEvent[b.eventId] ||= []).push(b);
  for (const [eventId, bets] of Object.entries(byEvent)) {
    let positions;
    try { positions = (await getPositions(eventId)).positions; } catch { continue; }
    for (const b of bets) {
      const fr = positions.get(String(b.playerId));
      const pos = fr?.pos ?? null, cut = fr?.cut ?? true;
      const ret = gradeBet(b, pos, cut);
      b.finishPos = fr?.posText || (cut ? 'MC' : 'n/a');
      b.returnPts = r2(ret);
      b.profitPts = r2(ret - b.stakePts);
      b.status = b.profitPts > 0 ? 'won' : 'lost';
    }
  }
}

export function summary(ledger) {
  const startBank = ledger.startBankPts ?? 100;
  const settled = ledger.bets.filter((b) => b.status === 'won' || b.status === 'lost');
  const pending = ledger.bets.filter((b) => b.status === 'pending');
  const staked = settled.reduce((a, b) => a + b.stakePts, 0);
  const profit = settled.reduce((a, b) => a + b.profitPts, 0);
  const returned = settled.reduce((a, b) => a + (b.returnPts || 0), 0);
  const won = settled.filter((b) => b.profitPts > 0).length;
  const byMarket = {};
  for (const b of settled) {
    const k = b.marketLabel || b.market;
    (byMarket[k] ||= { market: k, bets: 0, staked: 0, profit: 0, won: 0 });
    byMarket[k].bets++; byMarket[k].staked += b.stakePts; byMarket[k].profit += b.profitPts; if (b.profitPts > 0) byMarket[k].won++;
  }
  return {
    startBankPts: startBank,
    settledCount: settled.length, won, lost: settled.length - won,
    stakedPts: r2(staked), returnedPts: r2(returned), profitPts: r2(profit),
    bankNowPts: r2(startBank + profit),
    roiPct: staked > 0 ? Math.round((profit / staked) * 1000) / 10 : 0,
    strikeRatePct: settled.length ? Math.round((won / settled.length) * 100) : 0,
    pendingCount: pending.length, pendingStakePts: r2(pending.reduce((a, b) => a + b.stakePts, 0)),
    totalBets: ledger.bets.length,
    byMarket: Object.values(byMarket).map((m) => ({ ...m, staked: r2(m.staked), profit: r2(m.profit), roiPct: m.staked ? Math.round((m.profit / m.staked) * 1000) / 10 : 0 })),
    openBets: pending.slice().reverse(),
    allBets: ledger.bets.slice().reverse(),
  };
}
