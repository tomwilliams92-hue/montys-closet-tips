// midweek-check.mjs
// Wednesday sanity check between publishing the card (Sun/Mon) and tee-off (Thu):
//   1. WITHDRAWALS - is every player we have a pending bet on still in the field? A WD would
//      otherwise be discovered only when the bet silently drops out at settle time.
//   2. REAL ODDS PROBE - has the pgatour oddsTable started pricing the event? (The feed only
//      prices standard events in their live mid-week window; the armed capture in pga-api.mjs
//      writes odds-sample.json the first time it fires, unlocking real place-market betting.)
//
// Run manually (`node midweek-check.mjs`) or via the com.pga.board.midweek launchd job (Wed 18:00).
// Read-only apart from the odds capture. Posts a macOS notification if anything needs attention.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getField, getBookmakerOdds } from './pga-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, 'ledger.json'), 'utf8'));
const pending = ledger.bets.filter((b) => b.status === 'pending');
const stamp = new Date().toISOString();

if (!pending.length) {
  console.log(`[midweek ${stamp}] no pending bets - nothing to check.`);
  process.exit(0);
}
const eventId = pending[pending.length - 1].eventId; // latest card
const eventName = pending[pending.length - 1].eventName;
const picks = pending.filter((b) => b.eventId === eventId);
console.log(`[midweek ${stamp}] ${eventName} (${eventId}) - checking ${picks.length} pending picks`);

const notify = (msg) => {
  try {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "Monty's Closet - midweek check"`], () => {});
  } catch { /* notification is best-effort */ }
};

const problems = [];

// 1. withdrawals
try {
  const field = await getField(eventId);
  const inField = new Set(field.players.map((p) => String(p.id)));
  for (const b of picks) {
    if (inField.has(String(b.playerId))) console.log(`  OK   ${b.player} (${b.marketLabel} ${b.priceFractional}) still in the field`);
    else { console.log(`  WD?  ${b.player} is NOT in the current field - check for a withdrawal NOW`); problems.push(`${b.player} may have withdrawn`); }
  }
} catch (e) {
  console.log(`  field check FAILED: ${e.message}`);
  problems.push('field check failed - run manually');
}

// 2. real odds probe (the capture inside getBookmakerOdds writes odds-sample.json when it fires)
try {
  const field = await getField(eventId);
  const odds = await getBookmakerOdds(eventId, eventName, field.players);
  if (odds) {
    console.log(`  ODDS pgatour oddsTable IS PRICING this event (${odds.size} players). odds-sample.json captured - verify parseOddsString, then real place odds can be enabled (build.mjs USE_REAL_PLACE_ODDS).`);
    problems.push('Real odds feed live - verify odds-sample.json');
  } else {
    console.log('  ODDS oddsTable still empty for this event.');
  }
} catch (e) { console.log(`  odds probe failed: ${e.message}`); }

if (problems.length) notify(problems.join(' | '));
console.log(`[midweek ${stamp}] done - ${problems.length ? problems.length + ' item(s) need attention' : 'all clear'}.`);
