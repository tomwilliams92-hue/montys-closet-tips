// review.mjs — The Green Book LEARNING LOOP.
// Reads ledger.json, analyses every SETTLED bet, and writes THE-GREEN-BOOK-learnings.md.
//
// READ-ONLY on picks: this never changes the model. It surfaces what the results are teaching —
// calibration (is a stated probability actually hitting?), ROI by market / price band / pick type —
// so Tom can act on it, and so the model can eventually be calibrated once the sample is big enough.
//
// Golf is high-variance: treat everything here as DIRECTIONAL until the sample is large
// (rule of thumb: >~40 settled bets per segment before a number means much).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLedger, summary } from './ledger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'THE-GREEN-BOOK-learnings.md');
const STANDING_MARKER = '<!-- STANDING LESSONS — hand-maintained below this line; review.mjs never overwrites it -->';
const r1 = (n) => Math.round(n * 10) / 10;
const sign = (n) => (n >= 0 ? '+' : '') + n;
const roi = (profit, staked) => (staked ? sign(Math.round((profit / staked) * 1000) / 10) + '%' : '–');

const ledger = loadLedger();
const settled = ledger.bets.filter((b) => b.status === 'won' || b.status === 'lost');
const s = summary(ledger);
const N = settled.length;
const small = N < 40; // sample-size honesty gate

// --- ROI by market ---
const byMarket = s.byMarket
  .slice()
  .sort((a, b) => b.profit - a.profit)
  .map((m) => `| ${m.market} | ${m.bets} | ${r1(m.staked)} | ${sign(r1(m.profit))} | ${roi(m.profit, m.staked)} |`);

// --- Calibration (straight bets only: an each-way "win" bet can profit on a place, so its
// win-probability doesn't map cleanly to the profit outcome). Predicted = mean modelProb; Actual
// = strike rate. A big negative gap = the model is OVER-confident in that market. ---
const straight = settled.filter((b) => !b.eachWay);
const cal = {};
for (const b of straight) {
  const k = b.marketLabel || b.market;
  (cal[k] ||= { n: 0, pred: 0, hit: 0 });
  cal[k].n++; cal[k].pred += b.modelProb; cal[k].hit += b.status === 'won' ? 1 : 0;
}
const calRows = Object.entries(cal).map(([k, v]) => {
  const pred = Math.round((v.pred / v.n) * 100), act = Math.round((v.hit / v.n) * 100), gap = act - pred;
  return `| ${k} | ${v.n} | ${pred}% | ${act}% | ${sign(gap)}pts |`;
});

// --- ROI by price band ---
const bands = [
  ['Odds-on → 3/1', (d) => d <= 4],
  ['7/2 → 15/1', (d) => d > 4 && d <= 16],
  ['16/1 → 50/1 (e/w zone)', (d) => d > 16 && d <= 51],
  ['Bigger than 50/1', (d) => d > 51],
];
const bandRows = bands.map(([lab, fn]) => {
  const g = settled.filter((b) => fn(b.priceDecimal));
  const st = g.reduce((a, b) => a + b.stakePts, 0), pr = g.reduce((a, b) => a + b.profitPts, 0);
  return `| ${lab} | ${g.length} | ${r1(st)} | ${sign(r1(pr))} | ${roi(pr, st)} |`;
});

// --- Pick type: model value bets vs longshot/judgement flyers (proxy: priced > 25/1) ---
const seg = (name, arr) => {
  const st = arr.reduce((a, b) => a + b.stakePts, 0), pr = arr.reduce((a, b) => a + b.profitPts, 0);
  return `| ${name} | ${arr.length} | ${r1(st)} | ${sign(r1(pr))} | ${roi(pr, st)} |`;
};
const flyers = settled.filter((b) => b.priceDecimal > 26);
const core = settled.filter((b) => b.priceDecimal <= 26);
const ewBets = settled.filter((b) => b.eachWay);
const typeRows = [seg('Core (≤25/1)', core), seg('Flyers (>25/1)', flyers), seg('Each-way bets', ewBets)];

// --- ROI by PROVENANCE: who actually picks the winners? Every bet is tagged at selection time
// ('model' = model edge at a real price led; 'conditions' = course/weather-fit led; 'judgment' =
// eye-test/data-thin; 'toms-call' = Tom's override of the process). This is the segmentation that
// eventually settles whether the model, the overlays or Tom's gut is paying — sample-size rules apply.
const PROV_LABEL = { model: 'The Green Book (model)', conditions: 'Conditions/course-fit', judgment: 'Judgement (eye-test)', 'toms-call': "Tom's call" };
const byProv = {};
for (const b of settled) { const k = b.pickType || 'untagged'; (byProv[k] ||= []).push(b); }
const provRows = ['model', 'conditions', 'judgment', 'toms-call', 'untagged']
  .filter((k) => byProv[k]?.length)
  .map((k) => seg(PROV_LABEL[k] || 'Untagged (pre-provenance)', byProv[k]));

// --- Auto observations (conservative; flagged as directional on small samples) ---
const obs = [];
for (const [k, v] of Object.entries(cal)) {
  if (v.n >= 3) {
    const gap = Math.round((v.hit / v.n) * 100) - Math.round((v.pred / v.n) * 100);
    if (gap <= -15) obs.push(`⚠️ **${k}** looks OVER-confident: model averaged ${Math.round(v.pred / v.n * 100)}% but only ${Math.round(v.hit / v.n * 100)}% landed (${v.n} bets). Candidate for a downward calibration factor once the sample grows.`);
    if (gap >= 15) obs.push(`**${k}** is landing ABOVE its model probability so far (${v.n} bets) — under-confident, or just variance.`);
  }
}
{
  const fst = flyers.reduce((a, b) => a + b.stakePts, 0), fpr = flyers.reduce((a, b) => a + b.profitPts, 0);
  if (flyers.length >= 3) obs.push(`Flyers (>25/1): ${flyers.length} bets, ${roi(fpr, fst)} ROI — ${fpr >= 0 ? 'paying their way so far.' : 'net negative so far; watch the stake sizing.'}`);
}
if (!obs.length) obs.push('No segment has enough settled bets yet to say anything beyond noise. Keep logging.');

const fmt = (rows, header) => `| ${header} |\n|${'---|'.repeat(header.split('|').length)}\n${rows.join('\n')}`;

const auto = `# The Green Book — Learnings

_Auto-generated by \`review.mjs\` on ${new Date().toISOString().slice(0, 10)} from ${N} settled bets. Everything above the standing-lessons line is regenerated each run._

**Sample size: ${N} settled bets.** ${small ? '🚧 Too small to tune the model on — read the numbers below as DIRECTIONAL only, never as a reason to change picks yet.' : 'Large enough to start trusting per-segment signals.'}

## Headline
Bank **${s.bankNowPts}pts** · Net **${sign(s.profitPts)}pts** · ROI **${s.roiPct}%** · Strike **${s.strikeRatePct}%** · Max drawdown **${s.maxDrawdownPts}pts** (${s.ddPeakPts}→${s.ddTroughPts}).

## ROI by market
| Market | Bets | Staked | P/L | ROI |
|---|---|---|---|---|
${byMarket.join('\n')}

## Calibration — is the model's probability real? (straight bets only)
_Predicted = the model's average stated probability. Actual = how often it actually hit. A big negative gap = over-confident._
| Market | Bets | Predicted | Actual | Gap |
|---|---|---|---|---|
${calRows.join('\n') || '| (no straight bets settled yet) | | | | |'}

## ROI by price band
| Band | Bets | Staked | P/L | ROI |
|---|---|---|---|---|
${bandRows.join('\n')}

## ROI by pick type
| Type | Bets | Staked | P/L | ROI |
|---|---|---|---|---|
${typeRows.join('\n')}

## ROI by provenance — who picks the winners?
_Tagged at selection time. The long-run question this table answers: does the model, the conditions overlay, the eye-test or Tom's gut make the money?_
| Provenance | Bets | Staked | P/L | ROI |
|---|---|---|---|---|
${provRows.join('\n') || '| (no tagged bets settled yet) | | | | |'}

## What the results are saying (auto)
${obs.map((o) => '- ' + o).join('\n')}

${STANDING_MARKER}

## Standing lessons (hand-maintained)
_These persist across runs. Add durable lessons here; review.mjs never overwrites this section._

- **The model is well-calibrated in its normal range; only the odds-on tail runs hot.** The 94-bet season backtest (THE-GREEN-BOOK-backtest.md) shows small gaps across every market — To Win 3%→2%, Top-20 39%→42%, Top-10 25%→29%, Top-5 15%→22%. The absurd numbers only appear for ODDS-ON FAVOURITES at the extreme (e.g. Scheffler shown ~90% for top-5 when reality is ~40-45%) — a tail miscalibration, not a systematic one. So: still never publish an extreme-favourite edge (frame by conviction), but trust the model's probabilities in its usual value range (~10-45%).
- **Non-PGA players are floored, not rated.** DP World Tour/LIV players (e.g. Hatton) get 250/1 from the model because it can't see their strokes-gained — a data gap, not a verdict. Treat these as eye-test/place-terms judgement picks until a DataGolf feed is added.
- **Each-way sweet spot is 20/1–50/1.** Below ~16/1 the place return is too thin; above ~50/1 it's a lottery ticket. Backtest-derived — revisit once there are more settled e/w bets.
`;

// Preserve the hand-maintained standing-lessons section across runs.
let finalDoc = auto;
if (fs.existsSync(OUT)) {
  const prev = fs.readFileSync(OUT, 'utf8');
  const idx = prev.indexOf(STANDING_MARKER);
  if (idx !== -1) finalDoc = auto.slice(0, auto.indexOf(STANDING_MARKER)) + prev.slice(idx);
}
fs.writeFileSync(OUT, finalDoc);
console.log(`[review] analysed ${N} settled bets → wrote ${path.basename(OUT)}`);
console.log(`[review] ROI ${s.roiPct}% | strike ${s.strikeRatePct}% | drawdown ${s.maxDrawdownPts}pts`);
if (calRows.length) console.log('[review] calibration:\n  ' + calRows.join('\n  '));
console.log('[review] observations:\n  - ' + obs.join('\n  - '));
