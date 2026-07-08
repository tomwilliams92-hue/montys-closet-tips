// build.mjs
// Orchestrates one weekly board: pick the event, pull the data from pgatour.com,
// run the model, and write data.js (which index.html reads).
//
//   node build.mjs                -> this week's next event
//   node build.mjs R2026034       -> force a specific tournament id

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSchedule, getField, getStat, getEventSG, getLeaderboard, getCourseHistory, getCourseTypeHistory, getBookmakerOdds } from './pga-api.mjs';
import { profileFor, COURSE_TYPE_EVENTS } from './course-profiles.mjs';
import { buildModel } from './model.mjs';
import { loadLedger, saveLedger, appendWeek, settle, summary } from './ledger.mjs';
import { getRealWinnerOdds } from './odds-api.mjs';
import { runDeepDive } from './deepdive.mjs';

// Replace the algorithmic selections with the AI deep-dive's value-led picks + storylines.
function applyDeepDive(board, dd, makeBet) {
  const pct2 = (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
  const prep = (c, pts, story) => {
    c.points = Math.max(1, Math.min(3, pts || 1));
    c.priceDecimal = c.marketOdds.decimal;
    c.priceFractional = c.marketOdds.fractional;
    if (story) {
      // Append the model's exact value line so the edge in the write-up always matches the chip
      const phrase = c.market === 'win' ? 'to win' : `to finish ${(c.marketLabel || c.market).toLowerCase()}`;
      const vl = `The value: the model rates him ${pct2(c.modelProb)} ${phrase} vs the market's ${pct2(c.marketProb)} implied — a +${c.edgePct}% edge.`;
      c.rationale = `${story} ${vl}`;
    }
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
const SCRAMBLE = '130'; // Scrambling % — short-game/up-and-down skill, matters most on tough-to-hit courses/links
const AFFILIATE = ''; // e.g. 'affil=YOURCODE' - appended to the oddschecker "Back it" links

const fracToDec = (f) => { const [n, d] = String(f).split('/').map(Number); return d ? n / d + 1 : Number(f) + 1; };
const FRAC_LADDER = [[1,5],[2,9],[1,4],[2,7],[3,10],[1,3],[4,11],[2,5],[4,9],[1,2],[8,15],[4,7],[8,13],[4,6],[8,11],[4,5],[5,6],[10,11],[1,1],[11,10],[6,5],[5,4],[11,8],[6,4],[13,8],[7,4],[15,8],[2,1],[9,4],[5,2],[11,4],[3,1],[10,3],[7,2],[4,1],[9,2],[5,1],[11,2],[6,1],[13,2],[7,1],[15,2],[8,1],[9,1],[10,1],[11,1],[12,1],[14,1],[16,1],[18,1],[20,1],[22,1],[25,1],[28,1],[33,1],[40,1],[50,1],[66,1],[80,1],[100,1]];
const decToFrac = (dec) => { const t = dec - 1; let best = FRAC_LADDER[0], e = Infinity; for (const [n, d] of FRAC_LADDER) { const err = Math.abs(n / d - t); if (err < e) { e = err; best = [n, d]; } } return `${best[0]}/${best[1]}`; };
// a price may be given fractional ('21/1') or decimal (2.75) -> {decimal, fractional}
const parsePrice = (p) => {
  if (p == null) return null;
  if (typeof p === 'string' && p.includes('/')) { const dec = fracToDec(p); return { decimal: dec, fractional: p }; }
  const dec = Number(p); return Number.isFinite(dec) && dec > 1 ? { decimal: dec, fractional: decToFrac(dec) } : null;
};

// MANUAL CARD - when non-empty, this HAND-PICKS the tracked bets (Tom's research overrides the
// auto-selector for the week). Each pick keeps the model's value/course-history/rationale, but
// the market, stake and REAL price come from here. `price` may be fractional ('21/1') or decimal
// (2.75). Refresh weekly. Each-way win picks require a real price (the model price is a long-shot
// artifact for course-history specialists).
const POUNDS_PER_POINT = 5;                   // in-house suggested stake plan: £5 per point
// John Deere Classic 2026 (TPC Deere Run) - Tom's hand-picked card with real book prices.
// `eachWay: true` = 1pt e/w to win (half win, half place); `places` overrides the 8-place default.
// `judgment: true` = market/eye-test pick the model can't price (data-thin); uses `story` and
// shows no model edge. Travelers form folded in by hand (SG feed not yet finalised on the day).
// Hand-picked card for ONE specific event. It is applied ONLY when the build is for
// MANUAL_CARD_EVENT (guard in buildManualCard), so a leftover card can never bleed onto a later
// week - on any other event it is simply ignored and The Green Book auto-selects. To hand-pick a
// week: set BOTH the event id below AND the picks. Empty array = always auto-select.
const MANUAL_CARD_EVENT = 'R2026541'; // Genesis Scottish Open - the event this card is written for
const MANUAL_CARD = [
  { name: 'Scottie Scheffler', market: 'top5',  points: 3, price: 2.20 },                          // Bet365 top-5
  { name: 'Nicolai Højgaard',  market: 'top20', points: 2, price: 2.60 },                          // Bet365 top-20
  { name: 'Matt Fitzpatrick',  market: 'win', eachWay: true, points: 2, price: '17/1', places: 8 },  // e/w, 8 places — BEST BET
  { name: 'Tyrrell Hatton',    market: 'win', eachWay: true, points: 2, price: '26/1', places: 10, judgment: true,
    story: "Judgement pick — The Green Book can't rate him (no PGA Tour strokes-gained; he plays mostly DP World Tour/LIV), but the case is strong: a multiple Alfred Dunhill Links winner, elite in the wind, and gained +2.4 strokes a round at his last U.S. Open. At 26/1 with ten places each-way (1/5), the place half is where the value sits." },
  { name: 'Marco Penge',       market: 'win', eachWay: true, points: 2, price: '41/1', places: 12, judgment: true,
    story: "Each-way flyer (£5 e/w). An in-form DP World Tour player (OWGR 48) with a runner-up in his links record; the PGA-based model rates him low, so this is a punt on his European form at 41/1 with twelve places (1/5) — all about the place terms." },
  { name: 'Grant Forrest',     market: 'win', eachWay: true, points: 1, price: '141/1', places: 12, judgment: true,
    story: "Home each-way flyer (£2.50 e/w). A Scot the model can't rate (no PGA Tour strokes-gained), but with a solid links cut-rate and a home crowd behind him; 141/1 with twelve places (1/5) is a lottery ticket bought on the place terms, not a value bet." },
];
const BEST_BET_NAME = 'Matt Fitzpatrick';       // headline pick — each-way to win, 2pt total
const REMOVE = [];                              // never feature these (also pulled from flutters)

// EXTRA CARD - hand-added bets on a NON-PGA-Tour event the pipeline can't price or settle
// (different tour, no strokes-gained feed, no auto-settlement). DISPLAY-ONLY: shown on the
// board for the record but NOT tracked in the points P&L. Set to null once the event is done.
// BMW International Open is finished — off-pipeline cards are display-only and must be nulled
// once the event is over so they stop showing. Repopulate only for a live off-tour event.
const EXTRA_CARD = null;

// Weekly editorial - the recap is auto-built from the ledger; week-ahead + spotlight are hand-written.
// Hand-written editorial for ONE event (gated on EDITORIAL_EVENT so it can't leak onto a later
// week's board). `story` = Monty's Update narrative; `courseIntro` = the short course write-up.
// The P&L recap is auto-built from the ledger regardless. Refresh both weekly.
const EDITORIAL_EVENT = MANUAL_CARD_EVENT; // editorial applies only to this event
const EDITORIAL = {
  story: "We're up overall — a positive start is banked, and that's the headline. Last week's John Deere stung a little: down 3.8 points on the week. The one that got away was Chris Gotterup — a player we flagged and genuinely fancied — but we sided with Ben Griffin instead, and Gotterup went and won it. Wrong horse, right race. The consolation was Jackson Suber, our 56/1 each-way flyer, who rewarded us with a strong top-10 finish — exactly the kind of big-priced place that makes the each-way game pay its way. One small dip, still in front overall, and now onto a proper links test.",
  courseIntro: "The Renaissance Club is links golf the week before The Open — and the wind is the defence. This is a ball-striker's test: control off the tee and flighted, penetrating iron play beat raw power, so accurate, wind-hardened players climb the board while the bombers get exposed. Jumping out to us: Scottie Scheffler (the most complete ball-striker in the game), Tommy Fleetwood and Matt Fitzpatrick (proven links horses with the record to back it up), and Tyrrell Hatton — a genuine wind specialist the data can't fully see, but the eye certainly can.",
  spotlight: null,
};

function buildManualCard(board, model) {
  if (!MANUAL_CARD.length) return;
  if (MANUAL_CARD_EVENT && board.event.id !== MANUAL_CARD_EVENT) {
    console.error(`[build] manual card is for ${MANUAL_CARD_EVENT}, but this build is ${board.event.id} (${board.event.name}) - IGNORING the stale card; The Green Book auto-selects.`);
    return;
  }
  const out = [];
  for (const e of MANUAL_CARD) {
    const price = parsePrice(e.price);
    if (e.eachWay && e.market === 'win' && !price) { console.error(`[build] manual card: ${e.name} each-way needs a real price - skipped`); continue; }
    const id = model.playerIdByName(e.name);
    if (!id) { console.error(`[build] manual card: ${e.name} not in field - skipped`); continue; }
    const c = model.makeBet(id, e.market);
    if (!c) { console.error(`[build] manual card: makeBet failed for ${e.name}`); continue; }
    c.tracked = true; c.points = e.points || 1;
    c.eachWay = !!e.eachWay; // win-market candidates default to each-way; honour the card explicitly
    if (price) { // override the model estimate with Tom's real market price
      c.marketOdds = { prob: 1 / price.decimal, decimal: price.decimal, fractional: price.fractional };
      c.marketProb = 1 / price.decimal;
      c.edgePct = Math.round((c.modelProb / c.marketProb - 1) * 100);
      if (!e.judgment) { // re-stamp the value line to match the real price (skipped for judgement picks)
        const pct3 = (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
        const phrase3 = c.market === 'win' ? 'to win' : `to finish ${(c.marketLabel || c.market).toLowerCase()}`;
        const newVl = `the value: the model makes him ${pct3(c.modelProb)} ${phrase3} where the best price implies about ${pct3(c.marketProb)} - a +${c.edgePct}% edge`;
        c.rationale = c.rationale.replace(/the value:.*?edge\s*\./i, newVl + '.');
        if (!c.rationale.toLowerCase().includes('the value:')) c.rationale += ` ${newVl.charAt(0).toUpperCase() + newVl.slice(1)}.`;
      }
    }
    if (e.eachWay) {
      const places = e.places || 8;
      c.marquee = 'Each-way to win'; c.eachWayPlaces = places;
      // place chance = P(top N): use the top-10 market for 10 places, else the model's top-8 interpolation
      const placeProb = places >= 10 ? (model.makeBet(id, 'top10')?.modelProb ?? c.placeProbTop8 ?? 0) : (c.placeProbTop8 || 0);
      c.ewPlaceProb = Math.round(placeProb * 100);
      c.rationale += ` Each-way angle: the model has him about ${c.ewPlaceProb}% to finish inside the top ${places}, so at ${places} places (1/5 odds) the place half of the bet is where the value sits.`;
    }
    if (e.judgment) { c.judgment = true; c.edgePct = null; if (e.story) c.rationale = e.story; }
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

// Build the weekly update block: auto-recap of the most recent settled event + hand-written look-ahead.
function buildEditorial(board, ledger) {
  const applies = EDITORIAL_EVENT ? board.event.id === EDITORIAL_EVENT : true;
  board.editorial = {
    story: applies ? EDITORIAL.story : null,
    courseIntro: applies ? EDITORIAL.courseIntro : null,
    spotlight: applies ? EDITORIAL.spotlight : null,
    recap: null,
  };
  const settled = ledger.bets.filter((b) => b.status === 'won' || b.status === 'lost');
  if (!settled.length) return;
  const lastId = settled[settled.length - 1].eventId; // most recently settled event
  const ev = settled.filter((b) => b.eventId === lastId);
  const rr = (n) => Math.round(n * 100) / 100;
  const staked = ev.reduce((a, b) => a + b.stakePts, 0);
  const profit = rr(ev.reduce((a, b) => a + b.profitPts, 0));
  const winners = ev.filter((b) => b.profitPts > 0).sort((a, b) => b.profitPts - a.profitPts)
    .map((b) => ({ player: b.player, marketLabel: b.marketLabel, finishPos: b.finishPos, price: b.priceFractional, profitPts: rr(b.profitPts) }));
  board.editorial.recap = {
    eventName: ev[0].eventName, settledCount: ev.length, wonCount: winners.length,
    stakedPts: rr(staked), profitPts: profit, roiPct: staked ? Math.round((profit / staked) * 1000) / 10 : 0,
    bankNowPts: board.pnl.bankNowPts, winners,
  };
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
  const recentSrc = completed.slice(-8).reverse(); // most recent first (last 8 events; recency-weighted in the model)
  const [field, sgTotal, sgOTT, sgAPP, sgARG, sgPUTT, dDist, dAcc, dScr, ...recent] = await Promise.all([
    getField(event.id),
    getStat(SG.total, year), getStat(SG.ott, year), getStat(SG.app, year),
    getStat(SG.arg, year), getStat(SG.putt, year),
    getStat(DRIVE.distance, year), getStat(DRIVE.accuracy, year), getStat(SCRAMBLE, year),
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

  // The Green Book real place-odds (pgatour oddsTable: real WINNER + TOP-5/10/20). CAPTURE MODE:
  // fetched and logged for verification but NOT yet fed to the model — the raw odds-string format is
  // unverified (no event was priced at build time). Flip to true ONLY after spot-checking a live sample.
  const USE_REAL_PLACE_ODDS = false;
  const realPlaceOdds = await getBookmakerOdds(event.id, event.tournamentName, field.players).catch(() => null);
  if (realPlaceOdds) {
    const sample = [...realPlaceOdds.entries()].slice(0, 3).map(([n, v]) => `${n} ${JSON.stringify(v)}`);
    console.error(`[build] real place-odds AVAILABLE for ${realPlaceOdds.size} players — VERIFY format then enable. Sample: ${sample.join(' | ')}`);
  } else {
    console.error('[build] real place-odds: none published for this event yet (using model estimates).');
  }
  void USE_REAL_PLACE_ODDS; // wired for activation once verified; model override intentionally deferred

  // course history: how the field has fared at THIS event over the last few years (free)
  const courseHistory = await getCourseHistory(event.id, 4).catch(() => null);
  if (courseHistory) console.error(`[build] course history: ${courseHistory.size} players with prior starts here`);

  // course-TYPE suitability (e.g. links/wind record across comparable events) when the course has an
  // archetype defined - this is the "can they do it in these conditions" signal the SG average misses
  const typeCodes = profile.courseType ? COURSE_TYPE_EVENTS[profile.courseType] : null;
  const courseTypeHistory = typeCodes ? await getCourseTypeHistory(event.id, typeCodes, 4).catch(() => null) : null;
  if (courseTypeHistory) console.error(`[build] ${profile.courseType} suitability: ${courseTypeHistory.size} players with a record at comparable ${profile.courseType} events`);

  const model = buildModel({
    field,
    profile,
    sg: { total: sgTotal.map, ott: sgOTT.map, app: sgAPP.map, arg: sgARG.map, putt: sgPUTT.map },
    driving: { distance: dDist.map, accuracy: dAcc.map },
    scrambling: dScr.map,
    recentEvents,
    previousEvent,
    weekNumber: completed.length + 1,
    eventSlug: slugify(event.tournamentName),
    affiliate: AFFILIATE,
    realOdds,
    courseHistory,
    courseTypeHistory,
  });

  const notes = [];
  if (model.dataThinCount) notes.push(`${model.dataThinCount} players in the field have little/no PGA Tour strokes-gained data - they are excluded from value bets and flagged.`);
  if (previousEvent?.isMajor) notes.push(`Last week was the ${previousEvent.name} (a major), so players who contended - especially winner ${previousEvent.champion} - are docked for the post-major let-down. Affected players carry a let-down flag.`);
  const oddsNote = realOdds
    ? 'Win-market prices are the best available across UK bookmakers (live); place-market prices (top 5/10/20) are model estimates.'
    : 'Prices are model estimates until a live odds feed is connected.';
  notes.push(`Selections are made by The Green Book — the model that ranks every player by VALUE (its probability vs the best price, the edge). Win/Top-5/Top-10/Top-20 probabilities come from a Monte Carlo simulation built on course-fit strokes-gained, recency-weighted recent form (last 8 events), trend, season class, world ranking, course history at this event, and course-conditional driving-distance and scrambling. ${oddsNote}`);
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
  // watchlist must never feature a player we're actually backing (the manual card is applied AFTER
  // the model builds the watchlist), so filter against the final card and trim to ~6 to-watch names.
  {
    const backedIds = new Set((board.trackedBets || []).map((c) => c.playerId));
    board.watchlist = (board.watchlist || []).filter((w) => !backedIds.has(w.playerId)).slice(0, 6);
  }
  board.bankroll.poundsPerPoint = POUNDS_PER_POINT; // show actual £ stakes (in-house plan)
  board.extraCard = EXTRA_CARD; // hand-added off-pipeline bets (e.g. DP World Tour) - display only

  // ---- P&L ledger: settle finished events, then record this week's tracked bets ----
  const ledger = loadLedger();
  const completedIds = new Set(completed.map((t) => t.id));
  await settle(ledger, completedIds, getLeaderboard);
  appendWeek(ledger, board);
  saveLedger(ledger);
  board.pnl = summary(ledger);
  buildEditorial(board, ledger);

  fs.writeFileSync(path.join(__dirname, 'data.js'), 'window.BOARD = ' + JSON.stringify(board) + ';\n');
  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(board, null, 2));
  console.error('[build] wrote data.js');

  // cache-bust: stamp the build version onto the data.js <script> tag so a refreshed page always
  // pulls the latest picks. GitHub Pages caches data.js for 10 min by default, which otherwise
  // leaves returning visitors on last week's board.
  try {
    const idxPath = path.join(__dirname, 'index.html');
    const ver = Date.now();
    const idx = fs.readFileSync(idxPath, 'utf8');
    const stamped = idx.replace(/src="data\.js(?:\?v=\d+)?"/, `src="data.js?v=${ver}"`);
    if (stamped !== idx) { fs.writeFileSync(idxPath, stamped); console.error('[build] stamped data.js cache version', ver); }
    else console.error('[build] WARNING: could not find data.js <script> tag to stamp');
  } catch (e) { console.error('[build] index.html stamp failed:', e.message); }
  console.error('[build] TRACKED:', model.trackedBets.map((c) => `${c.name} ${c.marketLabel} ${c.priceFractional} (+${c.edgePct}%)`).join(' | '));
  console.error('[build] BEST BET:', model.bestBet ? `${model.bestBet.name} ${model.bestBet.marketLabel} ${model.bestBet.priceFractional}` : 'none');
  console.error('[build] P&L:', `bank ${board.pnl.bankNowPts}pts | settled ${board.pnl.settledCount} | pending ${board.pnl.pendingCount} (${board.pnl.pendingStakePts}pts)`);
}

main().catch((e) => { console.error('[build] FAILED:', e.message); process.exit(1); });
