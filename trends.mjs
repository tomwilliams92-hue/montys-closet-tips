// trends.mjs — the automated strokes-gained trends report ("the Knapp report").
//
//   node trends.mjs             -> report for the next upcoming event's field
//   node trends.mjs R2026XXX    -> report for a specific event's field
//
// READ-ONLY: no board, ledger or data.js writes. Writes TRENDS.md (gitignored/local) and
// prints the same report to stdout.
//
// WHY THIS EXISTS (28 Jul 2026, the Jake Knapp case): the model's form input is SG:TOTAL per
// recent event only, so a big move in ONE component — e.g. Knapp gaining +0.79 OTT and +1.83
// approach per round at the 3M Open on his injury comeback — gets blended into a single number
// and diluted by season-long averages. Tom spotted it by eye; the pipeline had no way to. This
// report compares each player's RECENT per-component strokes-gained (last 3 measured starts,
// recency-weighted like the model) against his SEASON baseline and surfaces the movers, so the
// weekly selection (green-book-picks skill §1) starts from the trends, not just the composite.
// It also cross-references player-notes.mjs: a player carrying a negative note adjust while his
// numbers surge is flagged as a possible STALE NOTE — exactly what suppressed Knapp's rating.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSchedule, getField, getStat } from './pga-api.mjs';
import { noteFor } from './player-notes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SGC = { ott: '02567', app: '02568', arg: '02569', putt: '02564', total: '02675' };
const COMP_LABEL = { ott: 'off the tee', app: 'approach', arg: 'around the green', putt: 'putting', total: 'total' };
const RECENT_STARTS = 3;      // how many recent measured starts define "current form"
const RECENCY_DECAY = 0.85;   // same decay the model uses
const SURGE = 0.4;            // SG/rd delta vs season baseline worth flagging
const WINDOW_EVENTS = 10;     // how many completed events back to scan

const argId = process.argv[2] || null;
const year = new Date().getFullYear();

// schedule dates: startDate = epoch millis, sortDate = a plain sequence NUMBER (20, 30, ...) —
// never wrap either in new Date() for comparisons.
const sched = await getSchedule(year);
const upcoming = (sched.upcoming || []).sort((a, b) => (a.sortDate ?? a.startDate) - (b.sortDate ?? b.startDate));
const target = argId
  ? [...(sched.upcoming || []), ...(sched.completed || [])].find((e) => e.id === argId)
  : upcoming[0];
if (!target) { console.error(`[trends] event ${argId || '(next)'} not found in the ${year} schedule`); process.exit(1); }

const field = await getField(target.id);
const fieldIds = new Set((field.players || []).filter((p) => !p.amateur).map((p) => String(p.id)));
const nameById = new Map((field.players || []).map((p) => [String(p.id), `${p.firstName} ${p.lastName}`.trim()]));

// Recent completed events, most recent first, capped at WINDOW_EVENTS.
const completed = (sched.completed || [])
  .sort((a, b) => (b.sortDate ?? b.startDate) - (a.sortDate ?? a.startDate))
  .slice(0, WINDOW_EVENTS);

// Per-event component stats (5 pulls per event, batched); majors/off-tour weeks with no SG
// coverage come back empty and are skipped.
const events = [];
for (const ev of completed) {
  const pulls = await Promise.all(Object.values(SGC).map((id) =>
    getStat(id, year, { tournamentId: ev.id, queryType: 'EVENT_ONLY' }).catch(() => null)));
  const byComp = {};
  Object.keys(SGC).forEach((k, i) => { byComp[k] = pulls[i]?.map || new Map(); });
  if (byComp.total.size) events.push({ id: ev.id, name: ev.tournamentName, byComp });
}

// Season baselines (full-year averages — the same aggregates the model rates from).
const season = {};
for (const [k, id] of Object.entries(SGC)) season[k] = (await getStat(id, year).catch(() => null))?.map || new Map();

const val = (m, pid) => { const v = m?.get(pid)?.values?.Avg; return Number.isFinite(v) ? v : null; };

const rows = [];
for (const pid of fieldIds) {
  const recent = {}; let starts = 0;
  for (const k of Object.keys(SGC)) {
    let wSum = 0, wTot = 0, n = 0;
    for (const ev of events) {
      if (n >= RECENT_STARTS) break;
      const v = val(ev.byComp[k], pid);
      if (v == null) continue;
      const wt = Math.pow(RECENCY_DECAY, n);
      wSum += v * wt; wTot += wt; n++;
    }
    recent[k] = wTot ? wSum / wTot : null;
    if (k === 'total') starts = n;
  }
  if (!starts) continue; // no measured recent starts — nothing to trend
  const base = {}; const delta = {};
  for (const k of Object.keys(SGC)) {
    base[k] = val(season[k], pid);
    delta[k] = recent[k] != null && base[k] != null ? recent[k] - base[k] : null;
  }
  const name = nameById.get(pid) || pid;
  rows.push({ pid, name, starts, recent, base, delta, note: noteFor(name) });
}

const f = (v, w = 6) => (v == null ? '—'.padStart(w) : (v >= 0 ? '+' : '') + v.toFixed(2)).padStart(w);
const lines = [];
const out = (s = '') => { lines.push(s); };

out(`# SG TRENDS — ${target.tournamentName || target.name} (${target.id})`);
out(`_Auto-generated by trends.mjs. Recent = last ${RECENT_STARTS} measured starts (${RECENCY_DECAY} decay) vs ${year} season baseline; SG per round. Window: ${events.map((e) => e.name).join(' · ')}._`);
out();

// 1. Ball-striking surges — the Knapp shape: OTT + approach moving together.
const bs = rows.filter((r) => r.delta.ott != null && r.delta.app != null)
  .map((r) => ({ ...r, bsDelta: r.delta.ott + r.delta.app }))
  .filter((r) => r.bsDelta >= SURGE).sort((a, b) => b.bsDelta - a.bsDelta).slice(0, 12);
out(`## Ball-striking surges (OTT + approach ≥ +${SURGE} vs baseline)`);
out('```');
for (const r of bs) out(`${r.name.padEnd(26)} ott ${f(r.delta.ott)}  app ${f(r.delta.app)}  (recent total ${f(r.recent.total)}/rd over ${r.starts})${r.note ? `  [note: ${r.note.tag}]` : ''}`);
if (!bs.length) out('none this week');
out('```');
out();

// 2. Single-component movers (any component, both directions).
out(`## Component movers (|Δ| ≥ +${SURGE} SG/rd vs baseline, ≥2 recent starts)`);
out('```');
let any = false;
for (const k of ['ott', 'app', 'arg', 'putt']) {
  const movers = rows.filter((r) => r.starts >= 2 && r.delta[k] != null && Math.abs(r.delta[k]) >= SURGE)
    .sort((a, b) => b.delta[k] - a.delta[k]);
  for (const r of movers.slice(0, 8)) { out(`${COMP_LABEL[k].padEnd(17)} ${r.name.padEnd(26)} ${f(r.delta[k])} (recent ${f(r.recent[k])} vs season ${f(r.base[k])})`); any = true; }
}
if (!any) out('none this week');
out('```');
out();

// 3. Stale-note warnings — the exact failure mode that hid Knapp.
const stale = rows.filter((r) => r.note && r.note.adjust < 0 && r.delta.total != null && r.delta.total >= SURGE);
out('## ⚠ Possible stale notes (negative note adjust but numbers surging — re-verify the news)');
out('```');
for (const r of stale) out(`${r.name.padEnd(26)} adjust ${r.note.adjust}  recent total ${f(r.recent.total)}/rd (Δ ${f(r.delta.total)})  [${r.note.tag}]`);
if (!stale.length) out('none — all negative notes look consistent with the numbers');
out('```');
out();

// 4. Total-form leaders for the field (context table).
const form = rows.filter((r) => r.recent.total != null).sort((a, b) => b.recent.total - a.recent.total).slice(0, 15);
out('## Form leaders in this field (recent SG:Total per round)');
out('```');
for (const r of form) out(`${r.name.padEnd(26)} ${f(r.recent.total)}/rd over ${r.starts} (season ${f(r.base.total)}, Δ ${f(r.delta.total)})`);
out('```');

const report = lines.join('\n') + '\n';
fs.writeFileSync(path.join(__dirname, 'TRENDS.md'), report);
console.log(report);
console.error(`[trends] wrote TRENDS.md — ${rows.length} field players trended over ${events.length} measured events`);
