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
// The Open Championship 2026 (Royal Birkdale) - Tom's hand-picked card with real book prices.
// `eachWay: true` = 1pt e/w to win (half win, half place); `places` overrides the 8-place default.
// `judgment: true` = story-led pick where the win-market edge is not the case for the bet
// (place-led or conditions/eye-test); uses `story` and shows no model edge chip.
// Hand-picked card for ONE specific event. It is applied ONLY when the build is for
// MANUAL_CARD_EVENT (guard in buildManualCard), so a leftover card can never bleed onto a later
// week - on any other event it is simply ignored and The Green Book auto-selects. To hand-pick a
// week: set BOTH the event id below AND the picks. Empty array = always auto-select.
// Prices from the latest published market lists on build night (12 Jul, pre-tournament) - the
// market will move after the Scottish Open result, so re-check each price before betting.
// NO SCHEFFLER this week by house rule after the Scottish Open missed cut - and at 4/1-5/1
// there is no each-way value in him anyway. All-e/w card, smaller stake after a losing week:
// judgment flyers went 0-for-3 at the Scottish, so the card is place-led: seven picks, all e/w, 10pt total.
// Si Woo Kim 70/1 sits above the backtested 50/1 e/w ceiling - flagged as the card's long shot,
// taken because BOTH halves are model-positive at the real price (not a pure lottery ticket).
// Every pick carries `type:` — its PROVENANCE, persisted to the ledger so review.mjs can answer
// "who actually picks the winners": 'model' (model edge at a real price led), 'conditions'
// (course/weather-fit led), 'judgment' (eye-test / data-thin), 'toms-call' (Tom's override).
const MANUAL_CARD_EVENT = 'R2026100'; // The Open Championship, Royal Birkdale
const MANUAL_CARD = [
  { name: 'Matt Fitzpatrick',  market: 'win', eachWay: true, points: 2, price: '15/1', places: 8, type: 'model' },  // e/w — BEST BET; 15/1 confirmed by Tom's own live bet 14 Jul (was 20/1, 12 Jul pre-Scottish-Open)
  { name: 'Tommy Fleetwood',   market: 'win', eachWay: true, points: 2, price: '16/1', places: 8, type: 'conditions', judgment: true,
    story: "The hometown pick, and a proper one — Fleetwood is Southport born and raised, and Royal Birkdale is the course he grew up on. The case isn't sentiment: he owns the best links record of anyone near the top of the market (average finish ~21st across nine comparable links starts) and arrives in form, gaining nearly two strokes a round over his last four. The Green Book has him about 54% to finish inside the top 8, so at 1/5 odds the place half of this bet is close to an even-money shot — the missing major is the only hole in the CV." },
  { name: 'Wyndham Clark',     market: 'win', eachWay: true, points: 2, price: '40/1', places: 8, type: 'model' },  // e/w — biggest model edge at a real price
  { name: 'Collin Morikawa',   market: 'win', eachWay: true, points: 1, price: '28/1', places: 8, type: 'conditions', judgment: true,
    story: "Conditions pick. Burnt, running links are exactly where Morikawa became Open champion in 2021 — the flighted-iron control that won on a baked Royal St George's is what this week's forecast (hot, dry, gusty east wind) demands, and he arrives off a third place with a closing 61. The win price is skinny by the model and there has been talk of a back niggle, so this is a 1-point, place-led play: The Green Book makes him ~27% to finish top 8 against the ~16% the place terms imply." },
  { name: 'Chris Gotterup',    market: 'win', eachWay: true, points: 1, price: '40/1', places: 8, type: 'model' },  // e/w — the model's own pick; links win + Open T3
  { name: 'Viktor Hovland',    market: 'win', eachWay: true, points: 1, price: '30/1', places: 8, type: 'toms-call', judgment: true,
    story: "Form pick — Tom's call, and a fair one. Hovland won the Travelers three starts ago — beating Scheffler in a playoff — and has gained 2.76 strokes a round over his recent starts. The doubt is the fit: his links average is ordinary (~34th, best T4) and firm ground has historically tested his short game, which is why it's a point and not three. The Green Book makes him ~23% to finish top 8 against the ~15% the place terms imply — the place half carries the bet." },
  { name: 'Si Woo Kim',        market: 'win', eachWay: true, points: 1, price: '70/1', places: 8, type: 'model' },  // e/w — the long shot; 70/1 (LVSB/CBS 12 Jul, +7500 at some books) is above the 50/1 sweet-spot ceiling, but model-backed both halves
];
const BEST_BET_NAME = 'Matt Fitzpatrick';       // headline pick — each-way to win, 2pt total
const REMOVE = ['Scottie Scheffler'];            // never feature these (also pulled from flutters/watchlist)
// Scheffler pulled from the watchlist for the Open: the recent-form calc missed his Scottish Open
// MC (getEventSG's EVENT_ONLY stat appears not to return a value for players who don't complete
// all 4 rounds, so a missed cut is silently skipped rather than penalised - a real model blind
// spot, not just stale copy). Revisit REMOVE once that recency gap is fixed properly.

// EXTRA CARD - hand-added bets on a NON-PGA-Tour event the pipeline can't price or settle
// (different tour, no strokes-gained feed, no auto-settlement). DISPLAY-ONLY: shown on the
// board for the record but NOT tracked in the points P&L. Set to null once the event is done.
// BMW International Open is finished — off-pipeline cards are display-only and must be nulled
// once the event is over so they stop showing. Repopulate only for a live off-tour event.
const EXTRA_CARD = null;

// PERSONAL CARD - Tom's own real-money action for the week, run entirely outside The Green Book
// (no model rationale, no edge chip, NOT tracked in the P&L). DISPLAY-ONLY, for transparency on
// a big event where he's backed a few extra things for interest. Gated on PERSONAL_CARD_EVENT so
// it can never bleed onto a later week. Set to null to hide.
const PERSONAL_CARD_EVENT = 'R2026100'; // The Open Championship, Royal Birkdale
const PERSONAL_CARD = {
  note: "Tom's own action for the season's last major — a bigger, more speculative slate than usual, run entirely outside The Green Book and not tracked in the P&L. Corey Conners is the thread running through both bet builders: a reliable cut-maker who doesn't often threaten to win but goes deep, backed here for a top-30 finish alongside Tommy Fleetwood, fancied for a strong finish on the course he grew up on in Southport. Bryson DeChambeau to miss the cut is the other conviction call — three missed cuts in a row and a course that doesn't suit his game. Also keeping an eye on Christiaan Bezuidenhout, in form and a good stylistic fit for firm links conditions, though no bet is down on him this week.",
  betBuilders: [
    {
      oddsDecimal: 3.75, stake: 10, toReturn: 37.50,
      legs: [
        { player: 'Chris Gotterup', market: 'To Make The Cut' },
        { player: 'Corey Conners', market: 'To Make The Cut' },
        { player: 'Matt Wallace', market: 'To Make The Cut' },
      ],
    },
    {
      oddsDecimal: 4.20, stake: 10, toReturn: 42.00,
      legs: [
        { player: 'Corey Conners', market: 'To Make The Cut' },
        { player: 'Tommy Fleetwood', market: 'Top 30 Finish (Inc Ties)' },
        { player: 'Chris Gotterup', market: 'Top 30 Finish (Inc Ties)' },
      ],
    },
  ],
  singles: [
    { player: 'Bryson DeChambeau', market: 'To Miss The Cut', oddsDecimal: 2.37, stake: 5, toReturn: 11.87 },
    { player: 'Corey Conners', market: '72-Hole Matchup vs Ryan Fox', oddsDecimal: 1.80, stake: 10, toReturn: 18.00 },
  ],
  portfolio: {
    label: 'Each-Way Portfolio', stake: 105, toReturn: 2628,
    note: 'Eight-strong each-way spread across the wider market — 1/5 odds a place.',
    legs: [
      { player: 'Viktor Hovland',   market: 'To Win Outright', places: 8,  oddsFractional: '34/1',  stakeEach: 7.50,  toReturn: 312.00 },
      { player: 'Matt Fitzpatrick', market: 'To Win Outright', places: 8,  oddsFractional: '15/1',  stakeEach: 12.50, toReturn: 235.00 },
      { player: 'Wyndham Clark',    market: 'To Win Outright', places: 8,  oddsFractional: '29/1',  stakeEach: 7.50,  toReturn: 267.00 },
      { player: 'Chris Gotterup',   market: 'To Win Outright', places: 8,  oddsFractional: '29/1',  stakeEach: 7.50,  toReturn: 267.00 },
      { player: 'Collin Morikawa',  market: 'To Win Outright', places: 8,  oddsFractional: '29/1',  stakeEach: 7.50,  toReturn: 267.00 },
      { player: 'Corey Conners',    market: 'Each Way Extra',  places: 12, oddsFractional: '71/1',  stakeEach: 5.00,  toReturn: 430.00 },
      { player: 'Akshay Bhatia',    market: 'To Win Outright', places: 8,  oddsFractional: '101/1', stakeEach: 2.50,  toReturn: 305.00 },
      { player: 'Jesper Svensson', market: 'Each Way Extra',   places: 12, oddsFractional: '181/1', stakeEach: 2.50,  toReturn: 545.00 },
    ],
  },
};

// Weekly editorial - the recap is auto-built from the ledger; week-ahead + spotlight are hand-written.
// Hand-written editorial for ONE event (gated on EDITORIAL_EVENT so it can't leak onto a later
// week's board). `story` = Monty's Update narrative; `courseIntro` = the short course write-up.
// The P&L recap is auto-built from the ledger regardless. Refresh both weekly.
const EDITORIAL_EVENT = MANUAL_CARD_EVENT; // editorial applies only to this event
const EDITORIAL = {
  story: "A losing week, and an honest one: down 7.6 points at the Scottish Open, and the bank dips under its starting line for the first time. The headline pick delivered again — Matt Fitzpatrick ran T3 and the each-way place paid — but everything around him leaked. Scheffler missed the cut with the model at 90% for a top-5; that one's on us for anchoring the card to an odds-on place price, and it won't happen again. Højgaard's top-20 died on the number (T26), and the judgment flyers went 0-for-3 — Hatton's T17 was respectable, Penge and Forrest never saw the weekend. The sting in the tail: Tom Kim, who we backed at the John Deere when he did nothing, went and won the Scottish Open the week we came off him. A week early is the same as wrong in this game. So this week's card is built place-led — seven picks, all each-way, nothing anchored to a short price — for the season's last major.",
  courseIntro: "Royal Birkdale, and the ground is the story: a dry summer has left the fairways burnt and running, and Open week is forecast hot and sunny — up to 27°C — with an east wind gusting towards 30mph. Firm, fast and windy is the fullest links examination there is: the ball won't stop where it lands, driver becomes optional, and the Claret Jug will go to whoever controls flight and bounce for 72 holes. Birkdale's flat-bottomed dune valleys make it the fairest course on the rota — no blind luck, just relentless shot-making — and it has a habit of crowning proper champions. Jumping out to us: Matt Fitzpatrick, the form links horse in the field, and Tommy Fleetwood — Southport's own son, on the course he grew up on.",
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
    c.pickType = e.type || (e.judgment ? 'judgment' : 'model'); // provenance -> ledger -> review.mjs
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

  const recentEvents = recentSrc.map((e, i) => ({ id: e.id, name: e.tournamentName, map: recent[i].map }));

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
    board.watchlist = (board.watchlist || []).filter((w) => !backedIds.has(w.playerId) && !REMOVE.includes(w.name)).slice(0, 6);
  }
  board.bankroll.poundsPerPoint = POUNDS_PER_POINT; // show actual £ stakes (in-house plan)
  board.extraCard = EXTRA_CARD; // hand-added off-pipeline bets (e.g. DP World Tour) - display only
  board.personalCard = (PERSONAL_CARD && (!PERSONAL_CARD_EVENT || board.event.id === PERSONAL_CARD_EVENT)) ? PERSONAL_CARD : null;

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
  console.error('[build] CARD:', board.trackedBets.map((c) => `${c.points}pt ${c.name} ${c.marketLabel} ${c.priceFractional}${c.eachWay ? ' e/w' : ''} [${c.pickType}]`).join(' | '));
  console.error('[build] BEST BET:', board.bestBet ? `${board.bestBet.name} ${board.bestBet.marketLabel} ${board.bestBet.priceFractional}` : 'none');
  console.error('[build] P&L:', `bank ${board.pnl.bankNowPts}pts | settled ${board.pnl.settledCount} | pending ${board.pnl.pendingCount} (${board.pnl.pendingStakePts}pts)`);
}

main().catch((e) => { console.error('[build] FAILED:', e.message); process.exit(1); });
