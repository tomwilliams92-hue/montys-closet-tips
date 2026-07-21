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

export function loadLedger(file = LEDGER) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return { startBankPts: 100, createdAt: new Date().toISOString(), bets: [] };
}
export function saveLedger(l, file = LEDGER) { fs.writeFileSync(file, JSON.stringify(l, null, 2)); }

// The SHADOW ledger: what The Green Book's own card would have done, paper-traded. Every build
// records the model's auto-selection here BEFORE any manual/personal card overrides it, so over a
// season "trust the model or trust Tom" becomes a measurable comparison instead of a feeling.
// Never mixed with the real ledger; never shown as real bets. Prices are the model's own market
// estimates until a real odds feed lands, so treat the P&L as directional.
export const SHADOW_LEDGER = path.join(__dirname, 'shadow-ledger.json');
// Old-style selector (pre-restructure 2026-07-21) paper-traded in parallel with the new three-tier
// card, so "did the restructure actually help" is answered by data rather than memory.
export const LEGACY_SHADOW_LEDGER = path.join(__dirname, 'shadow-ledger-legacy.json');

// Record this week's tracked bets as pending. The event hasn't started, so its pending bets
// are fully REPLACED on every rebuild - that keeps a week idempotent even if the card or a
// market changes between runs (no stale duplicates). Settled bets are never touched.
export function appendWeek(ledger, board) {
  ledger.bets = ledger.bets.filter((b) => !(b.eventId === board.event.id && b.status === 'pending'));
  let multiIdx = 0;
  for (const c of board.trackedBets) {
    // Auto-card multiples (restructure tier 3): carry legs and settle via the exotic grader —
    // every leg's cond must hit off the final leaderboard, exactly like the personal bet builders.
    if (c.legs) {
      ledger.bets.push({
        id: `${board.event.id}:multi:${multiIdx++}`,
        weekNumber: board.bankroll.weekNumber, eventId: board.event.id, eventName: board.event.name,
        placedAt: board.generatedAt, player: c.name, market: 'accumulator', marketLabel: c.marketLabel,
        legs: c.legs, eachWay: false, stakePts: c.points, priceDecimal: c.priceDecimal, priceFractional: c.priceFractional,
        pickType: c.pickType || 'model', exotic: true, priceEstimated: !!c.priceEstimated,
        modelProb: c.modelProb, status: 'pending', finishPos: null, returnPts: null, profitPts: null,
      });
      continue;
    }
    const id = `${board.event.id}:${c.playerId}:${c.market}`;
    ledger.bets.push({
      id, weekNumber: board.bankroll.weekNumber, eventId: board.event.id, eventName: board.event.name,
      placedAt: board.generatedAt, playerId: c.playerId, player: c.name,
      market: c.market, marketLabel: c.marketLabel, eachWay: c.eachWay, eachWayPlaces: c.eachWayPlaces || (c.eachWay ? 5 : null),
      stakePts: c.points, priceDecimal: c.priceDecimal, priceFractional: c.priceFractional,
      pickType: c.pickType || (c.judgment ? 'judgment' : 'model'), // provenance: model | conditions | judgment | toms-call
      priceEstimated: !!c.priceEstimated,
      modelProb: c.modelProb, status: 'pending', finishPos: null, returnPts: null, profitPts: null,
    });
  }
}

function gradeBet(bet, pos, cut) {
  // returns total return in POINTS for the stake; profit = return - stake
  const placed = (n) => Number.isFinite(pos) && pos <= n && !cut;
  if (bet.eachWay) {
    const side = bet.stakePts / 2; // half win, half place at 1/5 odds
    const places = bet.eachWayPlaces || 5;
    let ret = 0;
    if (Number.isFinite(pos) && pos === 1 && !cut) ret += side * bet.priceDecimal;   // win part
    if (placed(places)) ret += side * (1 + (bet.priceDecimal - 1) / 5);              // place part
    return ret;
  }
  if (bet.market === 'makeCut') return !cut && Number.isFinite(pos) ? bet.stakePts * bet.priceDecimal : 0;
  const need = { win: 1, top5: 5, top10: 10, top20: 20, top30: 30 }[bet.market];
  return placed(need) ? bet.stakePts * bet.priceDecimal : 0;
}

// Record Tom's "exotic" personal bets (bet builders, matchup, miss-cut single) as pending. These
// don't fit the standard win/top-N grading, so each carries `legs` with a per-leg `cond`. Replaces
// only prior pending EXOTIC bets for the event (the outright card is handled by appendWeek), so a
// rebuild stays idempotent. build.mjs resolves each leg's playerId before calling this.
export function appendPersonalBets(ledger, board) {
  const pc = board.personalCard;
  if (!pc) return;
  ledger.bets = ledger.bets.filter((b) => !(b.eventId === board.event.id && b.status === 'pending' && b.exotic));
  const push = (kind, subject, marketLabel, legs, points, dec, i) => {
    ledger.bets.push({
      id: `${board.event.id}:personal:${kind}:${i}`,
      weekNumber: board.bankroll.weekNumber, eventId: board.event.id, eventName: board.event.name,
      placedAt: board.generatedAt, player: subject, market: kind, marketLabel,
      legs, eachWay: false, stakePts: points, priceDecimal: dec, priceFractional: dec.toFixed(2),
      pickType: 'toms-call', exotic: true, status: 'pending', finishPos: null, returnPts: null, profitPts: null,
    });
  };
  (pc.betBuilders || []).forEach((b, i) =>
    push('accumulator', b.legs.map((l) => l.player).join(' + '), `Bet Builder (${b.legs.length}-leg)`, b.legs, b.points, b.oddsDecimal, i));
  (pc.singles || []).forEach((s, i) =>
    push(s.cond === 'matchup' ? 'matchup' : 'single', s.player, s.market, [{ playerId: s.playerId, player: s.player, cond: s.cond, opponentId: s.opponentId, opponent: s.opponent, market: s.market }], s.points, s.oddsDecimal, i));
}

// Evaluate one leg against final positions. Returns true (hit), false (missed), 'push' (void), or
// null (can't grade — player not on the leaderboard yet).
function legResult(leg, positions) {
  const fr = positions.get(String(leg.playerId));
  if (!fr) return null;
  const pos = fr.pos, cut = fr.cut, made = !cut && Number.isFinite(pos);
  const within = (n) => made && pos <= n;
  switch (leg.cond) {
    case 'makeCut': return !cut;
    case 'missCut': return !!cut;
    case 'win': return within(1);
    case 'top5': return within(5);
    case 'top10': return within(10);
    case 'top20': return within(20);
    case 'top30': return within(30);
    case 'top40': return within(40);
    case 'matchup': {
      const opp = positions.get(String(leg.opponentId));
      if (!opp) return null;
      const pMiss = !!cut, oMiss = !!opp.cut;
      if (pMiss && oMiss) return 'push';           // both missed the cut -> void
      if (pMiss !== oMiss) return oMiss;           // making the cut beats missing it
      if (pos === opp.pos) return 'push';          // tied finish -> void (dead heat)
      return pos < opp.pos;                        // lower finishing position wins
    }
    default: return null;
  }
}

// Grade an exotic accumulator/matchup/single. All legs must hit to win. Returns
// { returnPts, status, finishText } or null if it can't be graded yet.
function gradeExotic(bet, positions) {
  const results = bet.legs.map((l) => legResult(l, positions));
  if (results.some((r) => r === null)) return null; // a leg's player isn't scored yet
  const anyLost = results.some((r) => r === false);
  const anyPush = results.some((r) => r === 'push');
  const legText = bet.legs.map((l) => {
    const fr = positions.get(String(l.playerId));
    return `${l.player} ${fr ? (fr.cut ? 'MC' : fr.posText) : '?'}`;
  }).join(', ');
  if (anyLost) return { returnPts: 0, status: 'lost', finishText: legText };
  if (anyPush) return { returnPts: bet.stakePts, status: 'void', finishText: legText }; // stake returned
  return { returnPts: bet.stakePts * bet.priceDecimal, status: 'won', finishText: legText };
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
      if (b.exotic) {
        const g = gradeExotic(b, positions);
        if (!g) continue; // leave pending until every leg is scored
        b.finishPos = g.finishText;
        b.returnPts = r2(g.returnPts);
        b.profitPts = r2(g.returnPts - b.stakePts);
        b.status = g.status; // won | lost | void
        continue;
      }
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
  // Max drawdown: the largest peak-to-trough fall in the running bank across settled bets
  // (chronological = push order). It's the "worst losing run" — the honesty/bank-sizing number.
  let bank = startBank, peak = startBank, maxDD = 0, ddPeak = startBank, ddTrough = startBank;
  for (const b of settled) {
    bank += b.profitPts;
    if (bank > peak) peak = bank;
    const dd = peak - bank;
    if (dd > maxDD) { maxDD = dd; ddPeak = peak; ddTrough = bank; }
  }
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
    maxDrawdownPts: r2(maxDD), ddPeakPts: r2(ddPeak), ddTroughPts: r2(ddTrough),
    pendingCount: pending.length, pendingStakePts: r2(pending.reduce((a, b) => a + b.stakePts, 0)),
    totalBets: ledger.bets.length,
    byMarket: Object.values(byMarket).map((m) => ({ ...m, staked: r2(m.staked), profit: r2(m.profit), roiPct: m.staked ? Math.round((m.profit / m.staked) * 1000) / 10 : 0 })),
    openBets: pending.slice().reverse(),
    allBets: ledger.bets.slice().reverse(),
  };
}
