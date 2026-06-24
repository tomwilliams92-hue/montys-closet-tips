// build.mjs
// Orchestrates one weekly board: pick the event, pull the data from pgatour.com,
// run the model, and write data.js (which index.html reads).
//
//   node build.mjs                -> this week's next event
//   node build.mjs R2026034       -> force a specific tournament id

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSchedule, getField, getStat, getEventSG, getLeaderboard, getCourseHistory } from './pga-api.mjs';
import { profileFor } from './course-profiles.mjs';
import { buildModel } from './model.mjs';
import { loadLedger, saveLedger, appendWeek, settle, summary } from './ledger.mjs';
import { getRealWinnerOdds } from './odds-api.mjs';
import { runDeepDive } from './deepdive.mjs';

// Replace the algorithmic selections with the AI deep-dive's value-led picks + storylines.
function applyDeepDive(board, dd, makeBet) {
  const prep = (c, pts, story) => {
    c.points = Math.max(1, Math.min(3, pts || 1));
    c.priceDecimal = c.marketOdds.decimal;
    c.priceFractional = c.marketOdds.fractional;
    if (story) c.rationale = story;
    return c;
  };
  const tracked = [];
  for (const b of dd.trackedBets || []) {
    const c = makeBet(b.playerId, b.market); if (!c) continue;
    c.tracked = true; if (b.eachWayToWin) c.marquee = 'Each-way to win';
    tracked.push(prep(c, b.stakePoints, b.story));
  }
  if (!tracked.length) return; // nothing usable - keep algorithmic board
  board.trackedBets = tracked;
  board.bankroll.stakedThisWeekPoints = tracked.reduce((a, c) => a + c.points, 0);
  if (dd.bestBet) {
    const bb = makeBet(dd.bestBet.playerId, dd.bestBet.market);
    if (bb) board.bestBet = tracked.find((t) => t.playerId === bb.playerId && t.market === bb.market) || prep(bb, 2);
  }
  const fl = [];
  for (const f of dd.flutters || []) { const c = makeBet(f.playerId, f.market); if (!c) continue; c.tracked = false; c.kind = f.kind || 'Flutter'; fl.push(prep(c, 1, f.story)); }
  if (fl.length) board.flutters = fl;
  const wl = [];
  for (const w of dd.watchlist || []) {
    const c = makeBet(w.playerId, 'win'); if (!c) continue;
    wl.push({ playerId: c.playerId, name: c.name, headshot: c.headshot, country: c.country, owgr: c.owgr, trend: c.trend, recentSG: c.recentSG, recentEvents: c.recentEvents, winOdds: c.marketOdds.fractional, why: w.why, tag: c.playerNoteTag || null });
  }
  if (wl.length) board.watchlist = wl;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// load .env (keys) for manual runs too - the launchd job also sources it
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env - fine */ }
const SG = { total: '02675', ott: '02567', app: '02568', arg: '02569', putt: '02564' };
const DRIVE = { distance: '101', accuracy: '102' };
const AFFILIATE = ''; // e.g. 'affil=YOURCODE' - appended to the oddschecker "Back it" links

const fracToDec = (f) => { const [n, d] = String(f).split('/').map(Number); return d ? n / d + 1 : Number(f) + 1; };

// MANUAL CARD - when non-empty, this HAND-PICKS the tracked bets (Tom's research overrides the
// auto-selector for the week). Each pick keeps the model's value/course-history/rationale, but
// the market + stake (and, for each-way picks, the real price) come from here. Refresh weekly.
//   { name, market: win|top5|top10|top20, points, eachWay?, priceFractional? }
// priceFractional is needed only for each-way picks whose model price is a long-shot artifact.
const MANUAL_CARD = [
  { name: 'Akshay Bhatia',    market: 'top10', points: 2 },
  { name: 'Matt Fitzpatrick', market: 'top10', points: 2 },
  { name: 'Collin Morikawa',  market: 'top10', points: 1 },
  { name: 'Eric Cole',        market: 'top20', points: 1 },
  { name: 'Tommy Fleetwood',  market: 'win', eachWay: true, points: 2 },                                     // model price (~22/1) is realistic
  { name: 'Justin Thomas',    market: 'win', eachWay: true, points: 2, needsPrice: true, priceFractional: null }, // PENDING Tom's price
  { name: 'Brian Harman',     market: 'win', eachWay: true, points: 2, needsPrice: true, priceFractional: null }, // PENDING Tom's price
];
const BEST_BET_NAME = 'Akshay Bhatia';        // headline pick (null = highest-edge place bet)
const REMOVE = ['Ludvig Åberg'];              // never feature these (also pulled from flutters)

function buildManualCard(board, model) {
  if (!MANUAL_CARD.length) return;
  const out = [];
  for (const e of MANUAL_CARD) {
    if (e.needsPrice && !e.priceFractional) { console.error(`[build] manual card: ${e.name} each-way price PENDING - skipped until set`); continue; }
    const id = model.playerIdByName(e.name);
    if (!id) { console.error(`[build] manual card: ${e.name} not in field - skipped`); continue; }
    const c = model.makeBet(id, e.market);
    if (!c) { console.error(`[build] manual card: makeBet failed for ${e.name}`); continue; }
    c.tracked = true; c.points = e.points || 1;
    if (e.priceFractional) { // override the model price with the real market price
      const dec = fracToDec(e.priceFractional);
      c.marketOdds = { prob: 1 / dec, decimal: dec, fractional: e.priceFractional };
      c.marketProb = 1 / dec;
      c.edgePct = Math.round((c.modelProb / (1 / dec) - 1) * 100);
    }
    if (e.eachWay) {
      c.marquee = 'Each-way to win'; c.eachWay = true; c.eachWayPlaces = 8;
      c.ewPlaceProb = Math.round((c.placeProbTop8 || 0) * 100);
      c.rationale += ` Each-way angle: the model has him about ${c.ewPlaceProb}% to finish inside the top 8, so at 8 places (1/5 odds) the place half of the bet is where the value sits.`;
    }
    c.priceDecimal = c.marketOdds.decimal; c.priceFractional = c.marketOdds.fractional;
    out.push(c);
  }
  if (!out.length) return;
  board.trackedBets = out;
  board.bankroll.stakedThisWeekPoints = out.reduce((a, c) => a + c.points, 0);
  const bb = BEST_BET_NAME ? out.find((c) => c.name === BEST_BET_NAME) : null;
  board.bestBet = bb || out.filter((c) => !c.marquee).sort((a, b) => b.edgePct - a.edgePct)[0] || out[0];
  if (REMOVE.length) board.flutters = (board.flutters || []).filter((f) => !REMOVE.includes(f.name));
}
const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const logoUrl = (a) => (a && a.imagePath ? `https://res.cloudinary.com/pgatour-prod/image/upload/q_auto,f_auto/${a.imagePath}` : null);

// The four men's majors (+ the Players, a near-major) trigger the strongest let-down.
const MAJOR_RE = /(Masters Tournament|PGA Championship|U\.?S\.? Open|The Open Championship|THE PLAYERS)/i;
const isMajor = (name) => MAJOR_RE.test(name || '') && !/Scottish|Canadian|Mexico|Australian/i.test(name || '');

function fmtRange(startMs) {
  const start = new Date(startMs);
  const end = new Date(startMs + 3 * 86400000); // Thu -> Sun
  const mon = (d) => d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const day = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', timeZone: 'UTC' });
  const yr = start.toLocaleDateString('en-GB', { year: 'numeric', timeZone: 'UTC' });
  return mon(start) === mon(end)
    ? `${mon(start)} ${day(start)}-${day(end)}, ${yr}`
    : `${mon(start)} ${day(start)} - ${mon(end)} ${day(end)}, ${yr}`;
}

async function main() {
  const forceId = process.argv[2];
  const year = new Date().getFullYear();
  console.error(`[build] season ${year}`);

  let { upcoming, completed } = await getSchedule(year);
  if (!upcoming.length) ({ upcoming, completed } = await getSchedule(year + 1));

  const event = forceId
    ? (upcoming.find((t) => t.id === forceId) || completed.find((t) => t.id === forceId) || { id: forceId, tournamentName: forceId })
    : upcoming[0];
  if (!event) throw new Error('No upcoming event found.');
  console.error(`[build] event: ${event.tournamentName} (${event.id})`);

  const profile = profileFor(event.id);

  // pull everything in parallel
  const recentSrc = completed.slice(-5).reverse(); // most recent first
  const [field, sgTotal, sgOTT, sgAPP, sgARG, sgPUTT, dDist, dAcc, ...recent] = await Promise.all([
    getField(event.id),
    getStat(SG.total, year), getStat(SG.ott, year), getStat(SG.app, year),
    getStat(SG.arg, year), getStat(SG.putt, year),
    getStat(DRIVE.distance, year), getStat(DRIVE.accuracy, year),
    ...recentSrc.map((e) => getEventSG(e.id, year)),
  ]);
  console.error(`[build] field: ${field.players.length} players | SG:Total rows: ${sgTotal.map.size}`);

  const recentEvents = recentSrc.map((e, i) => ({ id: e.id, name: e.tournamentName, map: recent[i].map }));

  // last week's event drives the let-down factor - pull its final leaderboard for finishes
  const prev = completed[completed.length - 1];
  const prevLb = prev ? await getLeaderboard(prev.id).catch(() => null) : null;
  const previousEvent = prev ? {
    name: prev.tournamentName,
    isMajor: isMajor(prev.tournamentName),
    champion: prev.champion || null,
    finishPositions: prevLb?.positions || null,
  } : null;
  if (previousEvent) console.error(`[build] last week: ${previousEvent.name}${previousEvent.isMajor ? ' (MAJOR)' : ''} won by ${previousEvent.champion} | finishes: ${prevLb?.positions.size || 0}`);

  // real best-price winner odds across UK books (the-odds-api) - null without a key
  const realOdds = await getRealWinnerOdds(event.tournamentName).catch(() => null);

  // course history: how the field has fared at THIS event over the last few years (free)
  const courseHistory = await getCourseHistory(event.id, 4).catch(() => null);
  if (courseHistory) console.error(`[build] course history: ${courseHistory.size} players with prior starts here`);

  const model = buildModel({
    field,
    profile,
    sg: { total: sgTotal.map, ott: sgOTT.map, app: sgAPP.map, arg: sgARG.map, putt: sgPUTT.map },
    driving: { distance: dDist.map, accuracy: dAcc.map },
    recentEvents,
    previousEvent,
    weekNumber: completed.length + 1,
    eventSlug: slugify(event.tournamentName),
    affiliate: AFFILIATE,
    realOdds,
    courseHistory,
  });

  const notes = [];
  if (model.dataThinCount) notes.push(`${model.dataThinCount} players in the field have little/no PGA Tour strokes-gained data - they are excluded from value bets and flagged.`);
  if (previousEvent?.isMajor) notes.push(`Last week was the ${previousEvent.name} (a major), so players who contended - especially winner ${previousEvent.champion} - are docked for the post-major let-down. Affected players carry a let-down flag.`);
  const oddsNote = realOdds
    ? 'Win-market prices are the best available across UK bookmakers (live); place-market prices (top 5/10/20) are model estimates.'
    : 'Prices are model estimates until a live odds feed is connected.';
  notes.push(`Recommendations are ranked by VALUE - the model's probability vs the best price (the edge). Win/Top-5/Top-10/Top-20 probabilities come from a Monte Carlo simulation built on course-fit strokes-gained, recent form/trend, season class and course history at this event. ${oddsNote}`);
  if (model.courseHistoryCount) notes.push(`Course history: finishes at this event over the last 4 stagings feed the model for ${model.courseHistoryCount} of the field (debutants are treated neutrally, not penalised).`);
  if (profile.grass) notes.push(`Greens/grass: ${profile.grass}. Surface type informs the course read; per-player grass-specific putting splits would need a paid feed, so it is not yet a separate player input.`);
  notes.push('Each-way to-win bets are 1pt e/w at 8 places (Bet365 terms), priced in the 20/1-50/1 backtested sweet spot. Tracked bets feed the P&L (points/units); untracked "flutters" do not. Bets settle the following week off the final leaderboard.');

  const board = {
    generatedAt: new Date().toISOString(),
    event: {
      id: event.id,
      name: event.tournamentName,
      course: profile.course || event.courseName || null,
      city: event.city || null,
      state: event.state || null,
      dateRange: event.startDate ? fmtRange(Number(event.startDate)) : null,
      fieldSize: field.players.length,
      logo: logoUrl(event.tournamentLogoAsset),
    },
    courseProfile: {
      archetype: profile.archetype,
      summary: profile.summary,
      narrative: profile.narrative || profile.summary,
      tags: profile.tags,
      weights: profile.weights,
      par: profile.par || null,
      yards: profile.yards || null,
      grass: profile.grass || null,
    },
    recentEventsUsed: recentEvents.map((e) => e.name),
    previousEvent: previousEvent ? { name: previousEvent.name, isMajor: previousEvent.isMajor, champion: previousEvent.champion } : null,
    trackedBets: model.trackedBets,
    flutters: model.flutters,
    bestBet: model.bestBet,
    watchlist: model.watchlist,
    eachWayValue: model.eachWayValue,
    top5Sel: model.top5Sel,
    top10Sel: model.top10Sel,
    top20Sel: model.top20Sel,
    placesTable: model.placesTable,
    worldRankings: model.worldRankings,
    fieldRanking: model.fieldRanking,
    bankroll: model.bankroll,
    ewTerms: model.ewTerms,
    notes,
  };

  // ---- AI deep-dive: re-select picks by value + write storylines (falls back if no key) ----
  try {
    const dd = await runDeepDive({ event: board.event, courseProfile: board.courseProfile, previousEvent, players: model.deepDivePayload });
    if (dd && dd.trackedBets && dd.trackedBets.length) { applyDeepDive(board, dd, model.makeBet); console.error('[build] applied AI deep-dive picks'); }
  } catch (e) { console.error('[build] deep-dive skipped, keeping algorithmic picks:', e.message); }

  // hand-curated card for the week (Tom's research): replaces the auto-selection when set
  buildManualCard(board, model);

  // ---- P&L ledger: settle finished events, then record this week's tracked bets ----
  const ledger = loadLedger();
  const completedIds = new Set(completed.map((t) => t.id));
  await settle(ledger, completedIds, getLeaderboard);
  appendWeek(ledger, board);
  saveLedger(ledger);
  board.pnl = summary(ledger);

  fs.writeFileSync(path.join(__dirname, 'data.js'), 'window.BOARD = ' + JSON.stringify(board) + ';\n');
  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(board, null, 2));
  console.error('[build] wrote data.js');
  console.error('[build] TRACKED:', model.trackedBets.map((c) => `${c.name} ${c.marketLabel} ${c.priceFractional} (+${c.edgePct}%)`).join(' | '));
  console.error('[build] BEST BET:', model.bestBet ? `${model.bestBet.name} ${model.bestBet.marketLabel} ${model.bestBet.priceFractional}` : 'none');
  console.error('[build] P&L:', `bank ${board.pnl.bankNowPts}pts | settled ${board.pnl.settledCount} | pending ${board.pnl.pendingCount} (${board.pnl.pendingStakePts}pts)`);
}

main().catch((e) => { console.error('[build] FAILED:', e.message); process.exit(1); });
