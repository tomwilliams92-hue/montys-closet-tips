// dryrun.mjs
// Consult The Green Book WITHOUT writing anything - no ledger, no data.js, no board.
// Runs the exact same data pulls + model as build.mjs and prints the model's full read,
// so picks can be researched before committing a card. Used by the green-book-picks skill.
//
//   node dryrun.mjs                     -> next event that hasn't started yet
//   node dryrun.mjs R2026100            -> force a specific tournament id
//   node dryrun.mjs R2026100 rahm kim   -> ...plus per-market detail for matching names
//
// READ-ONLY by design: the only file it may touch is odds-sample.json (the armed
// bookmaker-odds capture inside pga-api.mjs, which we WANT to fire when a feed goes live).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSchedule, getField, getStat, getEventSG, getLeaderboard, getCourseHistory, getCourseTypeHistory, getBookmakerOdds } from './pga-api.mjs';
import { profileFor, COURSE_TYPE_EVENTS } from './course-profiles.mjs';
import { buildModel } from './model.mjs';
import { getRealWinnerOdds } from './odds-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env - fine */ }

const SG = { total: '02675', ott: '02567', app: '02568', arg: '02569', putt: '02564' };
const MAJOR_RE = /(Masters Tournament|PGA Championship|U\.?S\.? Open|The Open Championship|THE PLAYERS)/i;
const isMajor = (name) => MAJOR_RE.test(name || '') && !/Scottish|Canadian|Mexico|Australian/i.test(name || '');

const forceId = (process.argv[2] || '').match(/^[A-Z]\d+/) ? process.argv[2] : null;
const nameFilters = process.argv.slice(forceId ? 3 : 2).map((s) => s.toLowerCase());

const year = new Date().getFullYear();
let { upcoming, completed } = await getSchedule(year);
if (!upcoming.length) ({ upcoming, completed } = await getSchedule(year + 1));

const event = forceId
  ? (upcoming.find((t) => t.id === forceId) || completed.find((t) => t.id === forceId) || { id: forceId, tournamentName: forceId })
  : upcoming.find((t) => !t.startDate || Number(t.startDate) > Date.now()) || upcoming[0];
console.log(`EVENT: ${event.tournamentName} (${event.id}) @ ${event.courseName || '?'} | start ${event.startDate ? new Date(Number(event.startDate)).toISOString().slice(0, 10) : '?'}`);
const profile = profileFor(event.id);
console.log(`PROFILE: ${profile.archetype} | type ${profile.courseType || 'none'} | weights ott ${profile.weights.ott} app ${profile.weights.app} arg ${profile.weights.arg} putt ${profile.weights.putt}`);
if (!profile.course) console.log('WARNING: no course profile on file for this event - add one to course-profiles.mjs before picking (falls back to a neutral read).');

const recentSrc = completed.slice(-8).reverse();
const [field, sgTotal, sgOTT, sgAPP, sgARG, sgPUTT, dDist, dAcc, dScr, ...recent] = await Promise.all([
  getField(event.id),
  getStat(SG.total, year), getStat(SG.ott, year), getStat(SG.app, year),
  getStat(SG.arg, year), getStat(SG.putt, year),
  getStat('101', year), getStat('102', year), getStat('130', year),
  ...recentSrc.map((e) => getEventSG(e.id, year)),
]);
const recentEvents = recentSrc.map((e, i) => ({ id: e.id, name: e.tournamentName, map: recent[i].map }));
console.log(`FIELD: ${field.players.length} players | form window: ${recentSrc.map((e) => e.tournamentName).join(' -> ')}`);

const prev = completed[completed.length - 1];
const prevLb = prev ? await getLeaderboard(prev.id).catch(() => null) : null;
const previousEvent = prev ? { name: prev.tournamentName, isMajor: isMajor(prev.tournamentName), champion: prev.champion || null, finishPositions: prevLb?.positions || null } : null;
if (previousEvent) console.log(`LAST WEEK: ${previousEvent.name}${previousEvent.isMajor ? ' (MAJOR)' : ''} | schedule says champion: ${previousEvent.champion} - VERIFY against the leaderboard (the feed lags on Sunday nights and mis-credits the winner)`);

const realOdds = await getRealWinnerOdds(event.tournamentName).catch(() => null);
console.log(`REAL WIN ODDS (the-odds-api): ${realOdds ? realOdds.size + ' players' : 'NONE - model win prices below are ESTIMATES, never bet or publish them'}`);
const realPlaceOdds = await getBookmakerOdds(event.id, event.tournamentName, field.players).catch(() => null);
console.log(`REAL PLACE ODDS (pgatour oddsTable): ${realPlaceOdds ? realPlaceOdds.size + ' players - check odds-sample.json, verify parseOddsString' : 'none published'}`);

const courseHistory = await getCourseHistory(event.id, 4).catch(() => null);
const typeCodes = profile.courseType ? COURSE_TYPE_EVENTS[profile.courseType] : null;
const courseTypeHistory = typeCodes ? await getCourseTypeHistory(event.id, typeCodes, 4).catch(() => null) : null;
console.log(`COURSE HISTORY: ${courseHistory?.size || 0} players | ${profile.courseType || 'type'} suitability: ${courseTypeHistory?.size || 0} players`);

const model = buildModel({
  field, profile,
  sg: { total: sgTotal.map, ott: sgOTT.map, app: sgAPP.map, arg: sgARG.map, putt: sgPUTT.map },
  driving: { distance: dDist.map, accuracy: dAcc.map },
  scrambling: dScr.map,
  recentEvents, previousEvent,
  weekNumber: completed.length + 1,
  eventSlug: event.tournamentName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  affiliate: '',
  realOdds, courseHistory, courseTypeHistory,
});

const pc = (v) => (v * 100).toFixed(1) + '%';
console.log(`\n=== MODEL BOARD (top of the field${realOdds ? ', real win prices' : ', MODEL-ESTIMATE prices - value only vs a real quote'}) ===`);
for (const r of model.placesTable) {
  const ct = r.courseType ? `${profile.courseType || 'type'}: ${r.courseType.starts}st best T${r.courseType.bestFinish} avg ${r.courseType.avgFinish}` : '';
  const chh = r.courseHistory ? `here: ${r.courseHistory.starts}st best T${r.courseHistory.bestFinish} avg ${r.courseHistory.avgFinish}` : '';
  console.log(`#${String(r.modelRank).padStart(2)} ${r.name.padEnd(22)} OWGR${String(r.owgr).padStart(4)}${r.dataThin ? ' DATA-THIN' : ''} | win ${pc(r.win.prob)} @${r.m_win.fractional} | t5 ${pc(r.top5.prob)} t10 ${pc(r.top10.prob)} t20 ${pc(r.top20.prob)} | ${[chh, ct].filter(Boolean).join(' | ')}${r.letdownFlag ? ' | LETDOWN: ' + r.letdownFlag : ''}`);
}

console.log('\n=== WHAT THE GREEN BOOK WOULD PICK (auto card - sanity check, not the card) ===');
for (const c of model.trackedBets) console.log(`  ${c.points}pt ${c.name} ${c.marketLabel} @ ${c.priceFractional}${c.marquee ? ' e/w' : ''} | model ${pc(c.modelProb)} edge +${c.edgePct}%${c.ewPlaceProb ? ' | top-8 ' + c.ewPlaceProb + '%' : ''}`);
console.log('\n=== EACH-WAY VALUE (next-best e/w ideas, 17/1-51/1 band) ===');
for (const c of model.eachWayValue) console.log(`  ${c.name} @ ${c.priceFractional} | win ${pc(c.modelProb)} | top-8 ${c.ewPlaceProb}%`);
console.log('\n=== WATCHLIST POOL ===');
for (const w of model.watchlist) console.log(`  ${w.name} (${w.winOdds})${w.tag ? ' [' + w.tag + ']' : ''} - ${w.why}`);

if (nameFilters.length) {
  console.log('\n=== REQUESTED PLAYERS (full market picture; missing name = DATA-THIN, model cannot rate) ===');
  for (const p of model.deepDivePayload) {
    if (!nameFilters.some((f) => p.name.toLowerCase().includes(f))) continue;
    const m = p.markets;
    const top8 = m.top5.modelProb + 0.6 * (m.top10.modelProb - m.top5.modelProb);
    console.log(`${p.name} OWGR${p.owgr}: win ${pc(m.win.modelProb)}@${m.win.price} | t5 ${pc(m.top5.modelProb)} t10 ${pc(m.top10.modelProb)} t20 ${pc(m.top20.modelProb)} | top-8 ~${pc(top8)} | SG ott ${p.sg?.ott ?? '?'} app ${p.sg?.app ?? '?'} arg ${p.sg?.arg ?? '?'} putt ${p.sg?.putt ?? '?'} | form ${p.recentSG} SG/rd over ${p.recentEvents} (${p.trend})${p.courseHistory ? ` | here: ${p.courseHistory.starts}st best T${p.courseHistory.bestFinish}` : ''}${p.courseType ? ` | type: ${p.courseType.starts}st best T${p.courseType.bestFinish} avg ${p.courseType.avgFinish}` : ''}${p.injury ? ' | NOTE: ' + p.injury : ''}`);
  }
}
console.log(`\nDATA-THIN: ${model.dataThinCount} players in this field have little/no PGA Tour strokes-gained (DP World Tour/LIV) - model probabilities for them are meaningless; judgment picks only.`);
