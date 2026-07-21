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
import { loadLedger, saveLedger, appendWeek, appendPersonalBets, settle, summary, SHADOW_LEDGER, LEGACY_SHADOW_LEDGER } from './ledger.mjs';
import { getRealWinnerOdds } from './odds-api.mjs';
import { runDeepDive } from './deepdive.mjs';

// Replace the algorithmic selections with the AI deep-dive's value-led picks + storylines.
function applyDeepDive(board, dd, makeBet) {
  const pct2 = (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
  const prep = (c, pts, story) => {
    c.points = Math.max(1, Math.min(3, pts || 1));
    c.pickType = c.pickType || 'model'; // deep-dive re-selections are still model-led provenance
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
// Hand-picked card for ONE specific event. It is applied ONLY when the build is for
// MANUAL_CARD_EVENT (guard in buildManualCard), so a leftover card can never bleed onto a later
// week - on any other event it is simply ignored and The Green Book auto-selects. To hand-pick a
// week: set BOTH the event id below AND the picks. Empty array = always auto-select.
// `eachWay: true` = e/w to win (half win, half place at 1/5); `places` overrides the 8-place
// default. `judgment: true` = story-led pick with no model edge chip (data-thin players get the
// honest "limited data" treatment automatically). Every pick carries `type:` — its PROVENANCE,
// persisted to the ledger so review.mjs can answer "who actually picks the winners": 'model'
// (model edge at a real price led) · 'conditions' (course/weather-fit led) · 'judgment'
// (eye-test / data-thin) · 'toms-call' (Tom's override).
// TOM vs THE GREEN BOOK (21 Jul, Tom's call): this week the board is SPLIT. Tom's hand-picked
// card below is the real money and the ONLY thing in the public P&L; the model's restructured
// three-tier card publishes alongside it as a clearly-labelled PAPER section (board.greenBookCard)
// and settles in shadow-ledger.json — a live head-to-head test of "the model's picks or mine".
// Prices/places from Tom's ACTUAL bet365 slip (placed 21 Jul 19:07, ref GY7192426735W):
// Each Way Extra, 1/5 odds, 10 PLACES, decimal prices — 36.00=35/1, 51.00=50/1, 81.00=80/1,
// 46.00=45/1. £55 total staked, £1,900 max return. Kevin Yu was cut off in the screenshot but
// the slip total pins him at 81.00 (80/1): the other four return £1,410 of the £1,900.
// Jesper Svensson confirmed by Tom (NOT Adam — both are in this field). points = TOTAL stake at
// £5/pt: £5 e/w = points 2; Homa's £7.50 e/w = points 3.
const MANUAL_CARD_EVENT = 'R2026525'; // 3M Open, TPC Twin Cities
const MANUAL_CARD = [
  { name: 'Jesper Svensson',           market: 'win', eachWay: true, points: 2, price: '80/1', places: 10, type: 'toms-call' },
  { name: 'Johnny Keefer',             market: 'win', eachWay: true, points: 2, price: '45/1', places: 10, type: 'toms-call' },
  { name: 'Kevin Yu',                  market: 'win', eachWay: true, points: 2, price: '80/1', places: 10, type: 'toms-call' },
  { name: 'Rasmus Neergaard-Petersen', market: 'win', eachWay: true, points: 2, price: '50/1', places: 10, type: 'toms-call' },
  { name: 'Max Homa',                  market: 'win', eachWay: true, points: 3, price: '35/1', places: 10, type: 'toms-call' }, // £7.50 e/w — biggest stake on the card
];
const BEST_BET_NAME = 'Max Homa';                // headline by stake — Tom's 1.5pt e/w
// Split-board week: the model's card is NOT merged into the P&L card — it publishes as the paper
// Green Book section instead (board.greenBookCard). Flip back to true to merge banker/double tiers
// into a future manual-card week.
const INCLUDE_AUTO_BANKERS = false;
const REMOVE = [];                               // never feature these (also pulled from flutters/watchlist)
// The no-Scheffler house rule (Tom, 12 Jul) is BYPASSED for the 3M Open at Tom's instruction
// (21 Jul: "he's a class above this field") — his builder carries a Scheffler Top-20 leg and
// Scheffler may appear on the watchlist again. Default position for future weeks stays
// avoid-Scheffler unless Tom says otherwise; re-add him to REMOVE when the bypass ends.

// EXTRA CARD - hand-added bets on a NON-PGA-Tour event the pipeline can't price or settle
// (different tour, no strokes-gained feed, no auto-settlement). DISPLAY-ONLY: shown on the
// board for the record but NOT tracked in the points P&L. Set to null once the event is done.
// BMW International Open is finished — off-pipeline cards are display-only and must be nulled
// once the event is over so they stop showing. Repopulate only for a live off-tour event.
const EXTRA_CARD = null;

// NOTE (restructure, 21 Jul): the model now publishes its OWN doubles from banker legs (tier 3),
// so the earlier hand-proposed coupons are superseded. Tom's coupons from his book are still
// welcome any week as PERSONAL_CARD entries (gated to the event id) — but ONLY with his real
// quoted oddsDecimal/stake/toReturn, never an invented combined price.

// PERSONAL CARD - Tom's own "exotic" Open bets that the outright card can't hold: bet builders
// (multi-leg accumulators), a 72-hole matchup, and a miss-cut single. These now FEED THE P&L as
// pending bets (settled off the final leaderboard like everything else). Each leg carries a
// `cond` so the ledger can grade it: makeCut | missCut | top30 | top20 | top10 | top5 | win |
// matchup (needs `opponent`). `stake`/`toReturn` are in £; `points` = stake in points (£5/pt).
// Gated on PERSONAL_CARD_EVENT so it can't bleed onto a later week. Set to null to hide.
// Tom's 3M Open bet builder (21 Jul, his real slip): 6/1 with a "25% extra winnings" boost —
// the boost applies to WINNINGS only, not the stake (Tom confirmed). His book shows £10
// returning £72.50; the ledger just needs return/stake, so oddsDecimal = 7.25 reproduces the
// slip exactly. Never second-guess his book's boost arithmetic — record the slip's numbers.
const PERSONAL_CARD_EVENT = 'R2026525'; // 3M Open, TPC Twin Cities
const PERSONAL_CARD = {
  note: "Tom's bet builder — one ticket, four legs, 6/1 boosted with 25% extra winnings (boost on the winnings, not the stake): Scheffler to keep doing the boring thing (top 20), Jackson Suber to make the cut, and Max Homa and Johnny Keefer — both also carried each-way above — to go top 40. £10 on, returning £72.50 with the boost. Settles leg-by-leg off the final leaderboard; every leg must land.",
  betBuilders: [
    {
      oddsDecimal: 7.25, stake: 10, points: 2, toReturn: 72.50,
      legs: [
        { player: 'Scottie Scheffler', market: 'Top 20 Finish (Inc Ties)', cond: 'top20' },
        { player: 'Jackson Suber',     market: 'To Make The Cut',          cond: 'makeCut' },
        { player: 'Max Homa',          market: 'Top 40 Finish (Inc Ties)', cond: 'top40' },
        { player: 'Johnny Keefer',     market: 'Top 40 Finish (Inc Ties)', cond: 'top40' },
      ],
    },
  ],
  singles: [],
};

// Weekly editorial - the recap is auto-built from the ledger; week-ahead + spotlight are hand-written.
// Hand-written editorial for ONE event (gated on EDITORIAL_EVENT so it can't leak onto a later
// week's board). `story` = Monty's Update narrative; `courseIntro` = the short course write-up.
// The P&L recap is auto-built from the ledger regardless. Refresh both weekly.
const EDITORIAL_EVENT = MANUAL_CARD_EVENT; // editorial applies only to this event
const EDITORIAL = {
  story: "Something different this week: a head-to-head. After a bruising Open (0-for-9 on the outrights, bank down to 81.25pts), the board is split in two — Tom's hand-picked card carries the real money and the public P&L, while The Green Book's newly restructured card publishes alongside it on paper. Same event, same field, two philosophies: Tom goes hunting each-way prices, the model grinds high-probability markets. The results will referee. Tom's card is five each-way plays, placed for real at bet365 on Each Way Extra terms — 10 places at 1/5 odds, where the place half does the heavy lifting: Max Homa leads the staking at 35/1 (£7.50 e/w) with rookie Johnny Keefer at 45/1, Rasmus Neergaard-Petersen at 50/1, and Kevin Yu and Jesper Svensson both at 80/1 behind him (£5 e/w apiece). On top sits a boosted four-leg builder: Scheffler top 20, Jackson Suber to make the cut, and Homa and Keefer both top 40 — £10 returning £72.50 after a 25% winnings boost. The Green Book's paper card, picked by the restructured model with no human edits, is top-30 grinders: Sudarshan Yellamaraju, Maverick McNealy and Hideki Matsuyama as banker singles plus two small doubles from banker legs — at the model's own fair prices, clearly flagged, backed with nothing but pride. A season replay showed the model's losses all came from To Win each-way bets at its own estimated prices, so a hard rule now sits in the build: no To Win bet ever publishes without a real, sourced price. Defending champion Kurt Kitayama is a pure fade for the outright win — market's second favourite on name and course history alone, but trending down three starts. Thirteen points of real money staked; the model's seven on paper. May the better card win.",
  courseIntro: "TPC Twin Cities plays long — 7,431 yards, one of the longest par 71s on tour — but generously: wide Palmer/Lehman landing areas mean driving accuracy matters less here than at most tour stops, even with water touching 14 holes. Big, receptive Bentgrass greens (the field has gained 70%+ GIR here historically) turn the week into a putting contest rather than a survival test — every champion in the event's history has finished 15-under or better. The forecast is hot and dry throughout (mid-80s building to a scorching 100°F on Sunday) with no rain and gusts up to 35mph by Saturday, so expect the course to firm up and run out as the week goes on — a mild tilt toward ball-strikers who control flight and bounce over pure length merchants.",
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
    // GUARDRAIL (card restructure 2026-07-21): NO To Win pick — each-way or straight — may ever
    // publish on a model-estimated price. Real sourced price or it doesn't go on the card.
    if (e.market === 'win' && !price) { console.error(`[build] manual card: ${e.name} To Win needs a real price - skipped (guardrail)`); continue; }
    const id = model.playerIdByName(e.name);
    if (!id) { console.error(`[build] manual card: ${e.name} not in field - skipped`); continue; }
    const c = model.makeBet(id, e.market);
    if (!c) { console.error(`[build] manual card: makeBet failed for ${e.name}`); continue; }
    c.tracked = true; c.points = e.points || 1;
    c.eachWay = !!e.eachWay; // win-market candidates default to each-way; honour the card explicitly
    // A player the model can't rate (dataThin - e.g. a DP World Tour player with no PGA
    // strokes-gained) has no meaningful edge, so a computed "edge %" would be nonsense. Treat it
    // as a judgment pick: no edge chip, honest "limited data" copy. Tom backs these on his own read.
    const judgment = !!e.judgment || !!c.dataThin;
    if (price) { // override the model estimate with Tom's real market price
      c.priceSourced = true; // real quote from Tom's book — satisfies the To Win guardrail
      c.marketOdds = { prob: 1 / price.decimal, decimal: price.decimal, fractional: price.fractional };
      c.marketProb = 1 / price.decimal;
      c.edgePct = Math.round((c.modelProb / c.marketProb - 1) * 100);
      if (e.eachWay) {
        // Each-way = a place-led bet, so the win-market "edge" line is the wrong frame (a longshot
        // always looks "overpriced" to win). Drop it; the each-way angle below carries the case.
        c.rationale = c.rationale.replace(/\s*the value:.*?edge\s*\./i, '');
      } else if (!judgment) { // straight win/place pick: re-stamp the value line to the real price
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
      c.rationale += c.dataThin
        ? ` Each-way angle: a longshot flyer at ${places} places (1/5 odds) — the place half is the play, taken on Tom's read rather than the model, which has limited data on him.`
        : ` Each-way angle: the model has him about ${c.ewPlaceProb}% to finish inside the top ${places}, so at ${places} places (1/5 odds) the place half of the bet is where the value sits.`;
    }
    if (judgment) { c.judgment = true; c.edgePct = null; if (e.story) c.rationale = e.story; }
    c.pickType = e.type || (judgment ? 'judgment' : 'model'); // provenance -> ledger -> review.mjs
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

  // An in-progress event (e.g. an opposite-field co-sanctioned week like the ISCO) stays in
  // `upcoming` until it finishes, so "next event" = first upcoming that has not started yet.
  const event = forceId
    ? (upcoming.find((t) => t.id === forceId) || completed.find((t) => t.id === forceId) || { id: forceId, tournamentName: forceId })
    : upcoming.find((t) => !t.startDate || Number(t.startDate) > Date.now()) || upcoming[0];
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

  // Leaderboards for the same recent events: who actually played and got CUT. Feeds the model's
  // missed-cut form penalty (the per-event SG feed omits MCs entirely - survivorship bias).
  const recentLbs = await Promise.all(recentSrc.map((e) => getLeaderboard(e.id).catch(() => null)));
  const recentEvents = recentSrc.map((e, i) => ({ id: e.id, name: e.tournamentName, map: recent[i].map, finishes: recentLbs[i]?.positions || null }));

  // last week's event drives the let-down factor - pull its final leaderboard for finishes
  const prev = completed[completed.length - 1];
  // The schedule feed's champion field lags on the Sunday night after an event (it still showed
  // the previous winner hours after the Genesis Scottish Open finished, when the leaderboard
  // already had Tom Kim at 1) - correct the known-stale value so the board and the let-down
  // fade name the right man.
  if (prev?.id === 'R2026541') prev.champion = 'Tom Kim';
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
  notes.push(`Selections are made by The Green Book — the model that ranks every player by VALUE (its probability vs the best price, the edge). Win/Top-5/Top-10/Top-20/Top-30/Make-Cut probabilities come from a Monte Carlo simulation built on course-fit strokes-gained, recency-weighted recent form (last 8 events), trend, season class, world ranking, course history at this event, and course-conditional driving-distance and scrambling. ${oddsNote}`);
  notes.push('The card runs a three-tier structure: BANKERS — make-cut / top-20 / top-30 singles in the model\'s calibrated probability range — are the core; a lean EACH-WAY side is only ever published at real, sourced prices in the 20/1-50/1 band (never a model estimate); and 1-2 small DOUBLES are built from banker legs on different players. Weekly exposure is hard-capped at ~10pts.');
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

  // ---- AI deep-dive re-selection: RETIRED by the card restructure (2026-07-21). The three-tier
  // card (bankers / real-priced each-way / multiples) is deterministic model output; an AI pass
  // re-picking win-market bets at model-estimated prices was part of the old failure mode.
  // runDeepDive stays importable for one-off analysis; flip USE_DEEPDIVE_CARD to re-enable.
  const USE_DEEPDIVE_CARD = false;
  if (USE_DEEPDIVE_CARD) {
    try {
      const dd = await runDeepDive({ event: board.event, courseProfile: board.courseProfile, previousEvent, players: model.deepDivePayload });
      if (dd && dd.trackedBets && dd.trackedBets.length) { applyDeepDive(board, dd, model.makeBet); console.error('[build] applied AI deep-dive picks'); }
    } catch (e) { console.error('[build] deep-dive skipped, keeping algorithmic picks:', e.message); }
  }

  // GUARDRAIL (belt & braces): the published card must NEVER contain a To Win bet at a
  // model-estimated price — the documented −72.5% ROI failure mode (this week's original auto-card
  // put up five To Win e/w at 40–66/1 with zero players priced by the feed). Auto e/w picks
  // already require a live-feed price in model.mjs; this catches anything else that slips through.
  {
    const before = board.trackedBets.length;
    board.trackedBets = board.trackedBets.filter((c) => c.market !== 'win' || c.bookie || c.priceSourced);
    if (board.trackedBets.length !== before) console.error(`[build] GUARDRAIL: dropped ${before - board.trackedBets.length} To Win pick(s) at unverified prices — bankers-only auto card.`);
    board.bankroll.stakedThisWeekPoints = board.trackedBets.reduce((a, c) => a + c.points, 0);
    if (board.bestBet && board.bestBet.market === 'win' && !(board.bestBet.bookie || board.bestBet.priceSourced)) board.bestBet = board.trackedBets[0] || null;
  }

  // SHADOW snapshots for the model-vs-man A/B — taken BEFORE the manual card overrides anything:
  //   shadowBets       = the NEW three-tier auto card (what the restructured Green Book publishes)
  //   legacyShadowBets = the OLD selector's card (value picks + e/w at model prices), paper-traded
  //                      in parallel so old-style vs new-style becomes a measurable comparison.
  const shadowBets = (board.trackedBets || []).map((c) => ({ ...c }));
  const legacyShadowBets = (model.legacyTrackedBets || []).map((c) => ({ ...c }));

  // hand-curated card for the week (Tom's research): replaces the auto-selection when set
  buildManualCard(board, model);
  // Card restructure: on a manual-card week Tom's real-priced e/w picks are tier 2, but the model's
  // banker singles + doubles (tiers 1 & 3) still publish alongside them so the card keeps its
  // calibrated core. Gated on INCLUDE_AUTO_BANKERS (validated by the 2026-07-21 season replay —
  // see THE-GREEN-BOOK-backtest.md). A banker/multi duplicating a manual pick's exact market is out.
  if (INCLUDE_AUTO_BANKERS && MANUAL_CARD.length && board.event.id === MANUAL_CARD_EVENT) {
    const have = new Set(board.trackedBets.map((c) => `${c.playerId}:${c.market}`));
    const extra = (model.trackedBets || []).filter((c) => (c.tier === 'banker' || c.tier === 'multi') && !have.has(`${c.playerId}:${c.market}`));
    if (extra.length) {
      board.trackedBets = [...board.trackedBets, ...extra];
      // Merged-week exposure cap ~11pts (manual e/w + model bankers/doubles): shed the model's
      // lowest-conviction banker singles first — Tom's own picks are never trimmed.
      const total = () => board.trackedBets.reduce((a, c) => a + c.points, 0);
      while (total() > 11) {
        const shed = [...board.trackedBets].reverse().find((c) => c.tier === 'banker') || [...board.trackedBets].reverse().find((c) => c.tier === 'multi');
        if (!shed) break;
        board.trackedBets.splice(board.trackedBets.indexOf(shed), 1);
      }
      board.bankroll.stakedThisWeekPoints = total();
      console.error(`[build] merged model banker/multi picks into the manual-card week (total ${total()}pts)`);
    }
  }
  // TOM vs THE GREEN BOOK: on a split week (manual card owns the P&L, bankers not merged) the
  // model's own card publishes as a clearly-labelled PAPER section. It settles in
  // shadow-ledger.json — never the public P&L — so the two cards can be compared on results.
  board.greenBookCard = (!INCLUDE_AUTO_BANKERS && MANUAL_CARD.length && board.event.id === MANUAL_CARD_EVENT && shadowBets.length)
    ? shadowBets.map((c) => ({ ...c, paper: true, tracked: false }))
    : null;
  // watchlist must never feature a player we're actually backing (the manual card is applied AFTER
  // the model builds the watchlist), so filter against the final card and trim to ~6 to-watch names.
  {
    const backedIds = new Set((board.trackedBets || []).map((c) => c.playerId));
    for (const c of board.greenBookCard || []) for (const id of (c.legs ? c.legs.map((l) => l.playerId) : [c.playerId])) backedIds.add(id);
    board.watchlist = (board.watchlist || []).filter((w) => !backedIds.has(w.playerId) && !REMOVE.includes(w.name)).slice(0, 6);
  }
  board.bankroll.poundsPerPoint = POUNDS_PER_POINT; // show actual £ stakes (in-house plan)
  board.extraCard = EXTRA_CARD; // hand-added off-pipeline bets (e.g. DP World Tour) - display only
  board.personalCard = (PERSONAL_CARD && (!PERSONAL_CARD_EVENT || board.event.id === PERSONAL_CARD_EVENT)) ? PERSONAL_CARD : null;
  // Resolve each personal-bet leg to a field playerId so the ledger can settle it off the final
  // leaderboard. A name that isn't in the field is logged and left unresolved (that leg simply
  // can't be graded, so the bet stays pending) — worth watching in the build output.
  if (board.personalCard) {
    const resolve = (nm) => { const id = model.playerIdByName(nm); if (!id) console.error(`[build] personal bet: "${nm}" not found in field - won't settle automatically`); return id || null; };
    for (const b of board.personalCard.betBuilders || []) for (const l of b.legs) l.playerId = resolve(l.player);
    for (const s of board.personalCard.singles || []) { s.playerId = resolve(s.player); if (s.opponent) s.opponentId = resolve(s.opponent); }
  }

  // ---- P&L ledger: settle finished events, then record this week's tracked bets ----
  const ledger = loadLedger();
  const completedIds = new Set(completed.map((t) => t.id));
  await settle(ledger, completedIds, getLeaderboard);
  appendWeek(ledger, board);
  appendPersonalBets(ledger, board); // Tom's bet builders / matchup / miss-cut single -> pending in the P&L
  saveLedger(ledger);
  board.pnl = summary(ledger);

  // ---- SHADOW ledger: the Green Book's own card, paper-traded (never real money) ----
  // Settled off the same leaderboards; prices are the model's own estimates until a real odds
  // feed lands, so read the P&L as directional. Idempotent per event (appendWeek replaces pending).
  try {
    const shadow = loadLedger(SHADOW_LEDGER);
    shadow.note = shadow.note || 'PAPER record: what The Green Book auto-card would have done each week. Not real bets; prices are model estimates until a real odds feed is wired.';
    await settle(shadow, completedIds, getLeaderboard);
    if (shadowBets.length) appendWeek(shadow, { ...board, trackedBets: shadowBets });
    saveLedger(shadow, SHADOW_LEDGER);
    const sp = summary(shadow);
    board.shadow = {
      pnl: { startBankPts: sp.startBankPts, bankNowPts: sp.bankNowPts, profitPts: sp.profitPts, settledCount: sp.settledCount, won: sp.won, roiPct: sp.roiPct, pendingCount: sp.pendingCount, pendingStakePts: sp.pendingStakePts },
      card: shadowBets.map((c) => ({ name: c.name, marketLabel: c.marketLabel, points: c.points, priceFractional: c.priceFractional, eachWay: !!c.eachWay })),
    };
    console.error('[build] SHADOW CARD (paper):', shadowBets.map((c) => `${c.points}pt ${c.name} ${c.marketLabel} ${c.priceFractional}${c.eachWay ? ' e/w' : ''}`).join(' | ') || 'none');
  } catch (e) { console.error('[build] shadow ledger failed (non-fatal):', e.message); board.shadow = null; }

  // ---- LEGACY shadow ledger: the OLD selector run in parallel (paper), for the restructure A/B ----
  try {
    const legacy = loadLedger(LEGACY_SHADOW_LEDGER);
    legacy.note = legacy.note || 'PAPER record: the OLD-STYLE (pre-restructure 2026-07-21) selector — value picks + each-way at model-estimated prices — run in parallel against the new three-tier card so the restructure is judged on data. Not real bets.';
    await settle(legacy, completedIds, getLeaderboard);
    if (legacyShadowBets.length) appendWeek(legacy, { ...board, trackedBets: legacyShadowBets });
    saveLedger(legacy, LEGACY_SHADOW_LEDGER);
    const lp = summary(legacy);
    board.shadowLegacy = { pnl: { startBankPts: lp.startBankPts, bankNowPts: lp.bankNowPts, profitPts: lp.profitPts, settledCount: lp.settledCount, won: lp.won, roiPct: lp.roiPct, pendingCount: lp.pendingCount, pendingStakePts: lp.pendingStakePts } };
    console.error('[build] LEGACY SHADOW CARD (paper, old-style):', legacyShadowBets.map((c) => `${c.points}pt ${c.name} ${c.marketLabel} ${c.priceFractional}${c.eachWay ? ' e/w' : ''}`).join(' | ') || 'none');
  } catch (e) { console.error('[build] legacy shadow ledger failed (non-fatal):', e.message); board.shadowLegacy = null; }

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
  console.error('[build] CARD:', board.trackedBets.map((c) => `${c.points}pt ${c.name} ${c.marketLabel} ${c.priceFractional}${c.eachWay ? ' e/w' : ''} [${c.pickType}]`).join(' | '));
  console.error('[build] BEST BET:', board.bestBet ? `${board.bestBet.name} ${board.bestBet.marketLabel} ${board.bestBet.priceFractional}` : 'none');
  console.error('[build] P&L:', `bank ${board.pnl.bankNowPts}pts | settled ${board.pnl.settledCount} | pending ${board.pnl.pendingCount} (${board.pnl.pendingStakePts}pts)`);
}

main().catch((e) => { console.error('[build] FAILED:', e.message); process.exit(1); });
