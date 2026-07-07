// model.mjs
// Value-driven picks. We build TWO probability estimates per player per market:
//   - MODEL  = course fit + recent form + trend + quality + post-major let-down
//   - MARKET = an anchor based only on world ranking + season quality (what the
//              market mostly prices on). When live Bet365 odds are wired in, they
//              replace this anchor directly.
// EDGE = modelProb / marketProb - 1. Positive edge = value. Recommendations are
// ranked by value, not by who is simply most likely to win. Markets: Win / Top-5 /
// Top-10 / Top-20, so each-way and place value both surface.

import { noteFor, storyFor } from './player-notes.mjs';

// oddschecker market slugs for the "Back it" deep links
const OC_MARKET = { win: 'winner', top5: 'top-5-finish', top10: 'top-10-finish', top20: 'top-20-finish' };

// ---- stats helpers --------------------------------------------------------
function stats(values) {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length || 1;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return { mean, sd };
}
const z = (x, m, s) => (Number.isFinite(x) ? (x - m) / s : null);
const pct = (p) => (p * 100).toFixed(p < 0.1 ? 1 : 0) + '%';
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();

// ---- odds formatting (covers odds-on for place markets) -------------------
const STD_FRACTIONS = [
  [1, 6], [1, 5], [1, 4], [2, 7], [1, 3], [2, 5], [4, 9], [1, 2], [8, 15], [4, 7], [8, 13], [4, 6],
  [8, 11], [4, 5], [5, 6], [10, 11], [1, 1], [11, 10], [5, 4], [11, 8], [6, 4], [7, 4], [15, 8],
  [2, 1], [9, 4], [5, 2], [11, 4], [3, 1], [7, 2], [4, 1], [9, 2], [5, 1], [11, 2], [6, 1],
  [13, 2], [7, 1], [15, 2], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [18, 1],
  [20, 1], [22, 1], [25, 1], [28, 1], [33, 1], [40, 1], [50, 1], [66, 1], [80, 1], [100, 1],
  [125, 1], [150, 1], [200, 1], [250, 1],
];
function toFractional(decimal) {
  const target = decimal - 1;
  let best = STD_FRACTIONS[0], bestErr = Infinity;
  for (const [n, d] of STD_FRACTIONS) { const e = Math.abs(n / d - target); if (e < bestErr) { bestErr = e; best = [n, d]; } }
  return `${best[0]}/${best[1]}`;
}
function oddsFrom(prob) {
  const p = Math.max(1 / 251, Math.min(0.97, prob));
  const decimal = 1 / p;
  return { prob, decimal, fractional: toFractional(decimal) };
}

// ---- player helpers -------------------------------------------------------
const headshot = (id) => `https://pga-tour-res.cloudinary.com/image/upload/c_fill,g_face:center,h_240,w_240,q_auto,f_auto/headshots_${id}.png`;
const SG_LABELS = { ott: 'off the tee', app: 'approach', arg: 'around the green', putt: 'putting' };
const MARKETS = ['win', 'top5', 'top10', 'top20'];
const MK_LABEL = { win: 'To Win', top5: 'Top 5', top10: 'Top 10', top20: 'Top 20' };
const FLOOR = { win: 0.02, top5: 0.10, top10: 0.20, top20: 0.33 }; // min model prob to bet a market
const EDGE_MIN = 0.08; // 8% edge to count as value

function strengthText(sg, profile) {
  const comps = ['ott', 'app', 'arg', 'putt'].map((k) => ({ k, val: sg[k] ?? -99 })).filter((c) => c.val > -90).sort((a, b) => b.val - a.val);
  const courseTop = Object.entries(profile.weights).sort((a, b) => b[1] - a[1])[0][0];
  if (comps[0] && comps[0].k === courseTop && comps[0].val > 0.1) return `fits ${profile.course || 'the course'} - strongest on ${SG_LABELS[courseTop]}, what wins here`;
  if (comps[0] && comps[0].val > 0.2) return `gaining on ${SG_LABELS[comps[0].k]} (+${comps[0].val.toFixed(2)}/rd)`;
  return null;
}
function formText(p) {
  if (!p.recentEvents) return null;
  const starts = `${p.recentEvents} start${p.recentEvents === 1 ? '' : 's'}`;
  if (p.trend === 'up') return `trending up (${p.recentSG.toFixed(2)} SG/rd over last ${starts})`;
  if (p.trend === 'down') return `form cooling (${p.recentSG.toFixed(2)} SG/rd over ${starts})`;
  return `steady (${p.recentSG.toFixed(2)} SG/rd over last ${starts})`;
}
const ordFinish = (n) => (n === 1 ? 'a win' : `T${n}`);
function courseHistText(ch) {
  if (!ch || !ch.starts) return null;
  const s = `${ch.starts} prior start${ch.starts === 1 ? '' : 's'} here`;
  if (!ch.madeCuts) return `course history: ${s}, no made cuts (struggles at this track)`;
  const avg = Math.round(ch.avgFinish);
  const quality = ch.bestFinish <= 5 ? 'strong record' : ch.bestFinish <= 15 ? 'solid record' : 'mixed record';
  return `course history: ${quality} here - best ${ordFinish(ch.bestFinish)} in ${s} (avg finish ~${avg})`;
}
function courseTypeText(ct, typeName) {
  if (!ct || !ct.starts || !typeName) return null;
  const s = `${ct.starts} start${ct.starts === 1 ? '' : 's'} at comparable ${typeName} events`;
  if (!ct.madeCuts) return `${typeName} suitability: ${s} with no made cuts - struggles in these conditions`;
  const q = ct.bestFinish <= 5 ? 'strong' : ct.bestFinish <= 15 ? 'solid' : 'mixed';
  return `${typeName} suitability: ${q} - best ${ordFinish(ct.bestFinish)}, avg ~${Math.round(ct.avgFinish)} across ${s}`;
}

// ---- post-event let-down --------------------------------------------------
// Evidence (June 2026): a broad "major hangover" for everyone who contends is NOT supported
// by data - it's anecdotal. What IS real: backing up a win the next week is rare (~16
// back-to-back PGA Tour wins in 8 seasons). So we ONLY fade last week's winner; players who
// merely contended are not penalised - we just show their finish.
const LETDOWN = { majorWinner: 0.30, regularWinner: 0.15 };
function applyLetdown(rows, prev) {
  if (!prev || !prev.name) return;
  const champ = prev.champion ? norm(prev.champion) : null;
  const pos = prev.finishPositions; // Map(playerId -> {pos,posText,cut})
  for (const r of rows) {
    const fr = pos?.get(r.playerId);
    r.playedLastWeek = pos ? !!fr : null;          // null if we have no leaderboard
    r.lastWeekFinish = fr ? (fr.cut ? 'MC' : fr.posText) : null;
    if (champ && norm(r.name) === champ) {
      r.composite -= prev.isMajor ? LETDOWN.majorWinner : LETDOWN.regularWinner;
      r.letdownPenalty = true;
      r.letdownFlag = `Won the ${prev.name} last week - backing up a win the next week is rare (only ~16 in 8 seasons), so modestly faded`;
    }
  }
}

// ---- Monte Carlo: run the field, return finish-position probabilities ------
const T_SIM = 1.65, N_SIM = 16000, SEED = 0x9e3779b9;
// Seeded RNG so the same data always yields the same picks (deterministic, reproducible).
// Both sims share the seed = common random numbers, which also stabilises the edge estimates.
function mulberry32(a) { return function () { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function runSim(comps) {
  const n = comps.length;
  const rng = mulberry32(SEED);
  const gumbel = () => -Math.log(-Math.log(rng()));
  const c1 = new Array(n).fill(0), c5 = new Array(n).fill(0), c10 = new Array(n).fill(0), c20 = new Array(n).fill(0);
  const perf = new Array(n), idx = new Array(n);
  for (let s = 0; s < N_SIM; s++) {
    for (let i = 0; i < n; i++) { perf[i] = T_SIM * comps[i] + gumbel(); idx[i] = i; }
    idx.sort((a, b) => perf[b] - perf[a]);
    for (let r = 0; r < n; r++) { const p = idx[r]; if (r < 1) c1[p]++; if (r < 5) c5[p]++; if (r < 10) c10[p]++; if (r < 20) c20[p]++; }
  }
  return comps.map((_, i) => ({ win: c1[i] / N_SIM, top5: c5[i] / N_SIM, top10: c10[i] / N_SIM, top20: c20[i] / N_SIM }));
}

// ---- the model ------------------------------------------------------------
export function buildModel({ field, profile, sg, driving, scrambling = null, recentEvents, previousEvent, weekNumber, bankrollPoints = 100, eventSlug = '', affiliate = '', realOdds = null, courseHistory = null, courseTypeHistory = null }) {
  const players = field.players.filter((p) => !p.amateur);
  const sgVal = (which, id) => sg[which]?.get(String(id))?.values?.Avg;

  const rows = players.map((p) => {
    const id = String(p.id);
    const comp = { total: sgVal('total', id), ott: sgVal('ott', id), app: sgVal('app', id), arg: sgVal('arg', id), putt: sgVal('putt', id) };
    // recency-weighted recent form: recentEvents is most-recent-first, so weight = DECAY^index.
    // Last week counts full, six-to-eight weeks ago count progressively less. Only events the
    // player actually played contribute (gaps are skipped, not zero-filled).
    const RECENCY_DECAY = 0.85;
    const recentRaw = recentEvents.map((e) => e.map.get(id)?.values?.Avg);
    let wSum = 0, wTot = 0, played = 0;
    for (let i = 0; i < recentRaw.length; i++) {
      const v = recentRaw[i];
      if (!Number.isFinite(v)) continue;
      const wt = Math.pow(RECENCY_DECAY, i);
      wSum += v * wt; wTot += wt; played++;
    }
    const recentSG = wTot ? wSum / wTot : null;
    return {
      playerId: id, name: `${p.firstName} ${p.lastName}`.trim(), country: p.country, countryFlag: p.countryFlag,
      owgr: p.owgr || 999, headshot: headshot(id), sg: comp,
      drivingDistance: driving.distance?.get(id)?.values?.Avg, drivingAccuracy: driving.accuracy?.get(id)?.values?.['%'],
      scrambling: scrambling?.get(id)?.values?.['%'],
      recentSG, recentEvents: played, dataThin: !Number.isFinite(comp.total),
      courseHist: courseHistory?.get(id) || null, // {starts, madeCuts, avgFinish, bestFinish}
      courseTypeHist: courseTypeHistory?.get(id) || null, // links/type record: {starts, madeCuts, avgFinish, bestFinish}
    };
  });

  const dist = {};
  for (const k of ['total', 'ott', 'app', 'arg', 'putt']) dist[k] = stats(rows.map((r) => r.sg[k]));
  const recentDist = stats(rows.map((r) => r.recentSG));
  const distDist = stats(rows.map((r) => r.drivingDistance)); // driving distance spread across the field
  const scrDist = stats(rows.map((r) => r.scrambling));       // scrambling % spread across the field
  const owgrScore = (o) => -Math.log(Math.max(1, o));
  const owgrDist = stats(rows.map((r) => owgrScore(r.owgr)));

  for (const r of rows) {
    let fit = 0;
    for (const k of ['ott', 'app', 'arg', 'putt']) fit += profile.weights[k] * (z(r.sg[k], dist[k].mean, dist[k].sd) ?? -0.8);
    r.fitScore = fit;
    r.recentZ = z(r.recentSG, recentDist.mean, recentDist.sd) ?? -0.5;
    r.seasonZ = z(r.sg.total, dist.total.mean, dist.total.sd) ?? -0.8;
    r.owgrZ = z(owgrScore(r.owgr), owgrDist.mean, owgrDist.sd) ?? -0.5;
    r.trendRaw = Number.isFinite(r.recentSG) && Number.isFinite(r.sg.total) ? r.recentSG - r.sg.total : 0;
    r.trend = r.trendRaw > 0.25 ? 'up' : r.trendRaw < -0.25 ? 'down' : 'flat';
    // course history: lower average finish here = better. No history -> neutral (z=0), not penalised.
    r.histScore = r.courseHist && r.courseHist.starts ? -r.courseHist.avgFinish : null;
    // course-TYPE suitability (e.g. links record): lower avg finish at comparable events = better.
    r.typeScore = r.courseTypeHist && r.courseTypeHist.starts ? -r.courseTypeHist.avgFinish : null;
  }
  const fitDist = stats(rows.map((r) => r.fitScore));
  const trendDist = stats(rows.map((r) => r.trendRaw));
  const histDist = stats(rows.map((r) => r.histScore));
  const typeDist = stats(rows.map((r) => r.typeScore)); // course-type (e.g. links) suitability spread
  // A real market efficiently prices class, season quality and recent form. Where it is
  // slower is course-fit nuance and the post-major let-down. So the market anchor shares
  // the model's "base" and most of its course-fit, and our edge is only the residual.
  const DAMP = 0.55; // market captures ~55% of the course-fit signal
  for (const r of rows) {
    const fitZ = z(r.fitScore, fitDist.mean, fitDist.sd) ?? 0;
    const trendZ = z(r.trendRaw, trendDist.mean, trendDist.sd) ?? 0;
    const histZ = z(r.histScore, histDist.mean, histDist.sd) ?? 0; // 0 for debutants (neutral)
    r.histZ = histZ;
    // course-type (links/wind) suitability: 0 when the course has no archetype or the player has no
    // record at comparable events (neutral, not penalised). This is the signal the season-long SG
    // average is blind to - a proven links horse gets credit the raw numbers never showed.
    const typeZ = z(r.typeScore, typeDist.mean, typeDist.sd) ?? 0;
    r.typeZ = typeZ;
    // course history AND course-type suitability sit in the shared base: the market prices "horses for
    // courses" too, so they shape who contends (better place/EW probabilities) and shorten a proven
    // horse's price in BOTH the model and the market anchor - not manufacturing a fake edge.
    const base = 0.20 * r.recentZ + 0.11 * trendZ + 0.11 * r.seasonZ + 0.11 * r.owgrZ + 0.10 * histZ + 0.12 * typeZ;
    const fitContribution = 0.42 * fitZ;
    // Course-conditional driving-distance & scrambling nudges. The SG splits already capture most
    // of this, so these are deliberately small (0.05) and scaled by how much THIS course rewards
    // that skill: raw distance counts more where off-the-tee is weighted heavily (bomber/links),
    // scrambling more where around-the-green is (tight, tough-to-hit tracks). Adds granularity the
    // season-long SG smooths over without letting it override strokes-gained.
    const distZ = z(r.drivingDistance, distDist.mean, distDist.sd) ?? 0;
    const scrZ = z(r.scrambling, scrDist.mean, scrDist.sd) ?? 0;
    r.distZ = distZ; r.scrZ = scrZ;
    const extra = 0.05 * distZ * (profile.weights.ott / 0.25) + 0.05 * scrZ * (profile.weights.arg / 0.20);
    r.composite = base + fitContribution + extra;       // full model: course-fit at 100% + skill nudges
    if (r.dataThin) r.composite -= 0.6;
    r.marketComposite = base + DAMP * (fitContribution + extra);  // market: course-fit + nudges dampened, no let-down
  }
  applyLetdown(rows, previousEvent); // docks the MODEL composite only -> our edge to fade them
  // qualitative news/injury layer (overrides the numbers where we know better)
  for (const r of rows) { const nt = noteFor(r.name); if (nt) { r.composite += nt.adjust; r.playerNote = nt; } }

  // Put the market anchor on the SAME mean/spread as the model so the two sims are
  // comparable - otherwise differing variance creates huge phantom edges. Edges then
  // reflect genuine re-ordering (model rating a player above/below the market), not scale.
  const cStat = stats(rows.map((r) => r.composite));
  const mStat = stats(rows.map((r) => r.marketComposite));
  const modelP = runSim(rows.map((r) => r.composite));
  const marketP = runSim(rows.map((r) => cStat.mean + (r.marketComposite - mStat.mean) * (cStat.sd / mStat.sd)));
  rows.forEach((r, i) => {
    r.winProb = modelP[i].win;
    for (const m of MARKETS) {
      r[m] = oddsFrom(modelP[i][m]);          // model odds
      r['m_' + m] = oddsFrom(marketP[i][m]);  // estimated market odds
      r['edge_' + m] = marketP[i][m] > 0 ? modelP[i][m] / marketP[i][m] - 1 : 0;
    }
    // real best-price WINNER odds (the-odds-api) override the win-market estimate when present
    if (realOdds) {
      const ro = realOdds.get(norm(r.name));
      if (ro) {
        const implied = 1 / ro.decimal;
        r.m_win = { prob: implied, decimal: ro.decimal, fractional: ro.fractional };
        r.edge_win = implied > 0 ? modelP[i].win / implied - 1 : 0;
        r.winBookie = ro.bookie;
      }
    }
    r.confidence = Math.max(1, Math.min(5, Math.round(1 + r.winProb * 16)));
  });

  const byWin = [...rows].sort((a, b) => b.winProb - a.winProb);
  byWin.forEach((r, i) => { r.modelRank = i + 1; });

  // ---- build value bet candidates (best market per player) ----
  function candidate(r, m) {
    const modelProb = r[m].prob, marketProb = r['m_' + m].prob, edge = r['edge_' + m];
    const label = MK_LABEL[m].toLowerCase();
    const bits = [];
    const st = strengthText(r.sg, profile);
    bits.push(st || `solid all-round numbers for ${profile.course || 'this test'}`);
    const ft = formText(r); if (ft) bits.push(ft);
    const cht = courseHistText(r.courseHist); if (cht) bits.push(cht);
    const ctt = courseTypeText(r.courseTypeHist, profile.courseType); if (ctt) bits.push(ctt);
    if (r.playedLastWeek === false) bits.push('did not play last week, so arrives fresh');
    else if (r.lastWeekFinish && !r.letdownFlag) bits.push(`finished ${r.lastWeekFinish} last week`);
    if (r.playerNote) bits.push(r.playerNote.note);
    else if (r.letdownFlag) bits.push(r.letdownFlag.toLowerCase());
    const phrase = m === 'win' ? 'to win' : 'to finish ' + label;
    const valueLine = `the value: the model makes him ${pct(modelProb)} ${phrase} where the best price implies about ${pct(marketProb)} - a +${Math.round(edge * 100)}% edge`;
    bits.push(valueLine);
    const dataRationale = bits.map((b) => b.charAt(0).toUpperCase() + b.slice(1)).join('. ') + '.';
    // an editorial storyline (player-notes) takes over the lead, with the value line kept
    const story = storyFor(r.name, m);
    const rationale = story ? `${story} ${valueLine.charAt(0).toUpperCase() + valueLine.slice(1)}.` : dataRationale;
    return {
      playerId: r.playerId, name: r.name, headshot: r.headshot, country: r.countryFlag || r.country, owgr: r.owgr,
      market: m, marketLabel: MK_LABEL[m], eachWay: m === 'win',
      modelProb, modelOdds: r[m], marketProb, marketOdds: r['m_' + m], edgePct: Math.round(edge * 100),
      valueScore: edge * Math.sqrt(modelProb), confidence: r.confidence, trend: r.trend,
      sg: r.sg, recentSG: r.recentSG, recentEvents: r.recentEvents, dataThin: r.dataThin,
      letdownFlag: r.letdownFlag || null, playerNote: r.playerNote ? r.playerNote.note : null, playerNoteTag: r.playerNote ? r.playerNote.tag : null,
      lastWeekFinish: r.lastWeekFinish || null, playedLastWeek: r.playedLastWeek ?? null,
      courseHistory: r.courseHist || null,
      courseType: r.courseTypeHist || null,
      placeProbTop8: m === 'win' ? r.top5.prob + 0.6 * (r.top10.prob - r.top5.prob) : null, // for manual each-way picks
      bookie: m === 'win' ? (r.winBookie || null) : null,
      ocLink: `https://www.oddschecker.com/golf/${eventSlug}/${OC_MARKET[m]}${affiliate ? '?' + affiliate : ''}`,
      rationale,
    };
  }
  const bestMarket = (r) => MARKETS.filter((m) => r[m].prob >= FLOOR[m] && r['edge_' + m] >= EDGE_MIN)
    .map((m) => ({ m, vs: r['edge_' + m] * Math.sqrt(r[m].prob) })).sort((a, b) => b.vs - a.vs)[0];

  const candidates = [];
  for (const r of rows) { const bm = bestMarket(r); if (bm && !r.dataThin) candidates.push(candidate(r, bm.m)); }
  candidates.sort((a, b) => b.valueScore - a.valueScore);

  // up to five best value bets - but only genuine conviction makes the card:
  // a real edge (>=15%) AND at least 2 recent starts of form (no thin samples).
  const valueBets = candidates.filter((c) => c.edgePct >= 15 && c.recentEvents >= 2).slice(0, 5);
  const valueIds = new Set(valueBets.map((c) => c.playerId));
  // ...plus EACH-WAY TO-WIN bets. Each-way only pays off at a price, so these are bigger-priced
  // contenders with a strong place chance - never the favourite (place fraction too short).
  const elig = (r) => !r.dataThin && !valueIds.has(r.playerId) && !r.playerNote && !r.letdownPenalty;
  // BACKTEST (ew-band-backtest.mjs, season-to-date): with 8 places the each-way sweet spot is
  // ~20/1-50/1 (clearly +EV, repeatable place rate). Below ~16/1 the place return is too thin;
  // above ~50/1 the headline ROI is variance-driven (rare big hits), not repeatable. So the
  // eligible band is 16/1-50/1, and we rank by full EACH-WAY EV at 8 PLACES (1/5 odds).
  const top8 = (r) => r.top5.prob + 0.6 * (r.top10.prob - r.top5.prob); // ~P(finish top 8) by interpolation
  const ewEV = (r) => 0.5 * (r.win.prob * r.m_win.decimal) + 0.5 * (top8(r) * (1 + (r.m_win.decimal - 1) / 5)) - 1;
  // Rank by each-way EV but NUDGE by course history: a long price earned by a poor record here
  // shouldn't read as "value", and a proven course horse should get the benefit. Small weight so
  // form still leads. (ewEV stays the headline number; this only orders the shortlist.)
  const ewScore = (r) => ewEV(r) + 0.06 * (r.histZ || 0);
  const inBand = rows.filter((r) => elig(r) && r.m_win.decimal >= 17 && r.m_win.decimal <= 51);
  const pool = inBand.length ? inBand : rows.filter((r) => elig(r) && r.m_win.decimal >= 13 && r.m_win.decimal <= 67);
  const ewRanked = pool.map((r) => ({ r, vs: ewEV(r), score: ewScore(r) })).sort((a, b) => b.score - a.score);
  const ewPicks = ewRanked.slice(0, 2).map(({ r }) => {
    const c = candidate(r, 'win');
    c.marquee = 'Each-way to win';
    c.eachWayPlaces = 8;
    c.ewPlaceProb = Math.round(top8(r) * 100);     // model's top-8 (place) chance - the honest each-way number
    c.ewEV = Math.round(ewEV(r) * 100);            // notional each-way EV at the model price (kept, not headlined)
    c.edgePct = Math.round(r.edge_win * 100);      // honest WIN-market edge (modest), not the EW EV
    // lead the write-up with the each-way angle: the place part is where the value sits
    c.rationale += ` Each-way angle: the model has him about ${c.ewPlaceProb}% to finish inside the top 8, so at 8 places (1/5 odds) the place half of the bet is where the value is.`;
    return c;
  });

  const trackedBets = [...valueBets];
  const valueStake = [3, 2, 2, 1, 1];
  valueBets.forEach((c, i) => { c.points = valueStake[i] || 1; });
  for (const c of ewPicks) { c.points = 2; trackedBets.push(c); } // 1pt each-way = 2pt total (1 win + 1 place), 8 places
  trackedBets.forEach((c) => {
    c.tracked = true; // stakes are in POINTS/units only - no monetary value (users set their own)
    c.priceDecimal = c.marketOdds.decimal; c.priceFractional = c.marketOdds.fractional;
  });
  const trackedIds = new Set(trackedBets.map((c) => c.playerId));
  const bestBet = valueBets[0] || null;

  // untracked flutters: a favourite punt + a longshot punt (NOT in the P&L)
  const flutters = [];
  const fav = byWin.find((r) => !trackedIds.has(r.playerId) && !r.letdownPenalty);
  if (fav) flutters.push({ ...candidate(fav, 'win'), kind: 'Favourite punt', tracked: false });
  const longshot = byWin.slice(0, 25).filter((r) => !trackedIds.has(r.playerId) && r.win.decimal >= 40 && !flutters.find((f) => f.playerId === r.playerId)).sort((a, b) => b.composite - a.composite)[0];
  if (longshot) flutters.push({ ...candidate(longshot, 'win'), kind: 'Longshot punt', tracked: false });
  flutters.forEach((f) => { f.points = 1; }); // a small fun stake, not tracked

  // watchlist: ones to watch we are NOT backing - injury/news flags first, then improvers
  const usedIds = new Set([...trackedIds, ...flutters.map((f) => f.playerId)]);
  const wlRow = (r, why, tag) => ({ playerId: r.playerId, name: r.name, headshot: r.headshot, country: r.countryFlag || r.country, owgr: r.owgr, trend: r.trend, recentSG: r.recentSG, recentEvents: r.recentEvents, winOdds: r.win.fractional, why, tag: tag || null });
  const flagged = rows.filter((r) => r.playerNote && !usedIds.has(r.playerId)).map((r) => wlRow(r, r.playerNote.note, r.playerNote.tag));
  flagged.forEach((w) => usedIds.add(w.playerId));
  const improvers = rows.filter((r) => !usedIds.has(r.playerId) && !r.dataThin)
    .map((r) => ({ r, score: r.recentZ - r.seasonZ + 0.3 * r.recentZ })).sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, 6 - flagged.length))
    .map(({ r }) => {
      let why;
      if (r.trend === 'up') why = `Form spiking (${r.recentSG.toFixed(2)} SG/rd lately) but no value at the current price - watch for a bigger number.`;
      else if (r.owgr <= 30) why = `Class act (OWGR #${r.owgr}); numbers not quite firing this week - one to monitor.`;
      else { const st = strengthText(r.sg, profile); why = st ? `${st.charAt(0).toUpperCase() + st.slice(1)} - building, not yet a bet.` : 'Underlying numbers improving - monitor.'; }
      return wlRow(r, why, r.trend === 'up' ? 'In form' : null);
    });
  const watchlist = [...flagged, ...improvers];

  // place-market value selections (ranked by edge) - surfaces e.g. value top-20 plays
  const selFor = (m, k) => rows.filter((r) => r[m].prob >= FLOOR[m]).map((r) => candidate(r, m)).sort((a, b) => b.edgePct - a.edgePct).slice(0, k);
  // "best each-way value" = untracked EACH-WAY TO-WIN ideas in the sweet spot. These are WIN-market
  // bets at a sensible price (>=~13/1; never short-priced favourites - the place return is too thin),
  // ranked by 8-place each-way EV and shown at win odds with the model's top-8 chance.
  const eachWayValue = rows
    .filter((r) => !r.dataThin && !trackedIds.has(r.playerId) && !r.letdownPenalty && r.m_win.decimal >= 17 && r.m_win.decimal <= 51)
    .map((r) => ({ r, score: ewScore(r), p8: top8(r) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ r, p8 }) => { const c = candidate(r, 'win'); c.eachWay = true; c.eachWayPlaces = 8; c.ewPlaceProb = Math.round(p8 * 100); return c; });

  const placesTable = byWin.slice(0, 18).map((r) => ({
    modelRank: r.modelRank, name: r.name, headshot: r.headshot, letdownFlag: r.letdownFlag || null,
    courseHistory: r.courseHist ? { starts: r.courseHist.starts, bestFinish: r.courseHist.bestFinish, avgFinish: Math.round(r.courseHist.avgFinish) } : null,
    courseType: r.courseTypeHist ? { starts: r.courseTypeHist.starts, bestFinish: r.courseTypeHist.bestFinish, avgFinish: Math.round(r.courseTypeHist.avgFinish) } : null,
    win: r.win, top5: r.top5, top10: r.top10, top20: r.top20,
    m_win: r.m_win, edge_win: Math.round(r.edge_win * 100), edge_top20: Math.round(r.edge_top20 * 100),
  }));
  const fieldRanking = byWin.slice(0, 15).map((r) => ({ modelRank: r.modelRank, name: r.name, headshot: r.headshot, win: r.win, winProb: r.winProb, trend: r.trend, recentSG: r.recentSG, recentEvents: r.recentEvents }));
  const worldRankings = rows.filter((r) => r.owgr < 999).sort((a, b) => a.owgr - b.owgr)
    .map((r) => ({ owgr: r.owgr, name: r.name, country: r.countryFlag || r.country, headshot: r.headshot, winOdds: r.win.fractional, value: trackedIds.has(r.playerId) }));

  const totalPts = trackedBets.reduce((a, c) => a + c.points, 0);

  // for the AI deep-dive: a materialiser for any (player, market) candidate, and a compact
  // payload of every player's value picture. Not serialised into the board.
  const rowById = new Map(rows.map((r) => [r.playerId, r]));
  const makeBet = (playerId, market) => { const r = rowById.get(String(playerId)); return r ? candidate(r, market) : null; };
  const playerIdByName = (name) => { const r = rows.find((x) => norm(x.name) === norm(name)); return r ? r.playerId : null; };
  const deepDivePayload = rows.filter((r) => !r.dataThin).map((r) => ({
    id: r.playerId, name: r.name, owgr: r.owgr, sg: r.sg,
    recentSG: r.recentSG != null ? Math.round(r.recentSG * 100) / 100 : null, recentEvents: r.recentEvents, trend: r.trend,
    lastWeekFinish: r.lastWeekFinish || null, injury: r.playerNote ? r.playerNote.note : null,
    courseHistory: r.courseHist ? { starts: r.courseHist.starts, madeCuts: r.courseHist.madeCuts, bestFinish: r.courseHist.bestFinish, avgFinish: Math.round(r.courseHist.avgFinish) } : null,
    courseType: r.courseTypeHist ? { starts: r.courseTypeHist.starts, madeCuts: r.courseTypeHist.madeCuts, bestFinish: r.courseTypeHist.bestFinish, avgFinish: Math.round(r.courseTypeHist.avgFinish) } : null,
    markets: Object.fromEntries(MARKETS.map((m) => [m, { modelProb: Math.round(r[m].prob * 1000) / 1000, marketProb: Math.round(r['m_' + m].prob * 1000) / 1000, edgePct: Math.round(r['edge_' + m] * 100), price: r['m_' + m].fractional }])),
  }));

  return {
    dataThinCount: rows.filter((r) => r.dataThin).length,
    courseHistoryCount: rows.filter((r) => r.courseHist && r.courseHist.starts).length,
    trackedBets, flutters, bestBet, watchlist, eachWayValue,
    top5Sel: selFor('top5', 6), top10Sel: selFor('top10', 6), top20Sel: selFor('top20', 8),
    placesTable, fieldRanking, worldRankings,
    ewTerms: '1pt each-way at 1/5 odds, 8 places (Bet365 terms on a full-field event). Backtest sweet spot is 20/1-50/1; below ~16/1 the place return is too thin to back each-way, above ~50/1 it is a lottery ticket. Always check each book\'s place terms before betting.',
    bankroll: { startPoints: bankrollPoints, stakedThisWeekPoints: totalPts, weekNumber },
    makeBet, playerIdByName, deepDivePayload,
  };
}
