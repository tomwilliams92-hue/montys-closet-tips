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
const MANUAL_CARD = [
  { name: 'Jackson Koivun',          market: 'top20', points: 4, price: 2.10, judgment: true,
    story: "Pure judgement pick - and the headline one. The model can't rate him (he has no tracked PGA Tour strokes-gained yet), so the eye test does the talking. He went T11 here at TPC Deere Run and T23 at the U.S. Open at brutal Oakmont, gaining +1.39 strokes a round in a major - one of the best young players in the game arriving on a low-scoring birdie course that suits. It's a punt on a player early in his pro career, but the class is obvious and the market makes him about 48% for a top 20. We're happy to take the 2.10." },
  { name: 'Ben Griffin',             market: 'top10', points: 3, price: 2.70 },  // 46% model vs 37% implied = +24%
  { name: 'Ben Griffin',             market: 'win',   points: 2, price: '16/1' }, // straight win (top-10 covers the place)
  { name: 'Jackson Suber', market: 'win', eachWay: true, points: 2, price: '56/1', places: 10 }, // £5 e/w (1pt/side, 2pt total), 10 places - value is the place side
  { name: 'Tom Kim', market: 'win', eachWay: true, points: 2, price: '31/1', places: 10 }, // £5 e/w (1pt/side, 2pt total), 10 places
  { name: 'Denny McCarthy', market: 'win', eachWay: true, points: 1, price: '36/1', places: 8 }, // £2.50 e/w (0.5pt/side, 1pt total), 8 places
  { name: 'Eric Cole', market: 'win', eachWay: true, points: 1, price: '29/1', places: 8 }, // £2.50 e/w (0.5pt/side, 1pt total), 8 places
  { name: 'Sudarshan Yellamaraju',   market: 'top20', points: 1, price: 3.00 },  // £5 top-20 single (3.0 decimal = 2/1)
];
const BEST_BET_NAME = 'Jackson Koivun';        // headline pick (null = highest-edge place bet)
const REMOVE = ['Ludvig Åberg'];              // never feature these (also pulled from flutters)

// EXTRA CARD - hand-added bets on a NON-PGA-Tour event the pipeline can't price or settle
// (different tour, no strokes-gained feed, no auto-settlement). DISPLAY-ONLY: shown on the
// board for the record but NOT tracked in the points P&L. Set to null once the event is done.
const EXTRA_CARD = {
  eventName: 'BMW International Open',
  tour: 'DP World Tour',
  note: 'Off-pipeline: a DP World Tour event, so these two are shown for the record but are not priced by the model or settled in the points P&L.',
  bets: [
    { name: 'Rasmus Neergaard-Petersen', market: 'Each-way to win', places: 8,  priceFractional: '23/1', stakeText: '£2.50 e/w (£5 total)' },
    { name: 'Oliver Lindell',            market: 'Each-way to win', places: 10, priceFractional: '29/1', stakeText: '£5 e/w (£10 total)' },
  ],
};

// Weekly editorial - the recap is auto-built from the ledger; week-ahead + spotlight are hand-written.
const EDITORIAL = {
  weekAhead: "The John Deere Classic is a deliberately reduced field - a number of the bigger names are sitting it out, resting or warming up for the Genesis Scottish Open and The Open Championship. That is the opportunity: with the marquee names away, the door opens for in-form, well-suited players like Ben Griffin and Jackson Koivun to shine on a low-scoring birdie course where pinpoint approach play and a hot putter win out.",
  spotlight: {
    name: 'Jackson Koivun',
    text: "Our headline focus - this week and beyond. Koivun has only just turned professional, so the bookmakers have barely any form to price him on, and that is exactly where the value sits. He went T11 here at TPC Deere Run and T23 at the U.S. Open at brutal Oakmont, gaining +1.39 strokes a round in a major. As his results land on the professional stage his prices will only shorten, so we want to be early. He is our Best Bet for a top 20 this week, and one we will be tracking every week from here.",
  },
};

function buildManualCard(board, model) {
  if (!MANUAL_CARD.length) return;
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
        c.rationale = c.rationale.replace(/the value:[^.]+\./i, newVl + '.');
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
  board.editorial = { weekAhead: EDITORIAL.weekAhead, spotlight: EDITORIAL.spotlight, recap: null };
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
  const recentSrc = completed.slice(-6).reverse(); // most recent first (last 6 events)
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
