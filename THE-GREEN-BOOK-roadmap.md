# The Green Book — model roadmap & notes

*The Green Book* is the model that makes the selections for Monty's Closet Tips. This doc records
what it considers, what changed on 2026-07-06, the key data findings, and the scoped next builds.

## What The Green Book weighs (composite rating → Monte Carlo → Win/Top-5/10/20 probs → value vs price)

| Signal | Weight | Notes |
|---|---|---|
| Course-fit strokes-gained | 42% | 4 SG splits (off-tee/approach/around-green/putting) re-weighted to the course |
| Recent form | 20% | **Now recency-weighted over the last 8 events** (0.85 decay: last week counts most) |
| Trend | 11% | recent SG vs season SG |
| Season class | 11% | season SG:Total |
| World ranking | 11% | OWGR stabiliser |
| Course history | 10% | finishes at THIS event over last 4 stagings |
| Driving distance + scrambling nudges | ~5% ea, course-scaled | **New** — distance matters more where OTT is weighted, scrambling where ARG is |

~84% of the rating is strokes-gained-derived.

## Changed 2026-07-06 (built + verified via `node build.mjs`)

1. **Live bug fix** — cleared the stale hand-picked `MANUAL_CARD` (it was bleeding John Deere picks +
   prices onto later events for any player in both fields). It must be reset to `[]` every week.
2. **Form window 6 → 8 events, recency-weighted** (0.85 decay, most-recent-first).
3. **Driving distance + scrambling** folded into the rating as small, course-conditional nudges
   (Scrambling stat 130 now fetched; distance/accuracy were fetched but previously unused).
4. **Named the model "The Green Book"** — surfaced in the board tagline + methodology note.
5. Cleared finished `EXTRA_CARD` (BMW International Open) and stale editorial copy.

## KEY FINDING — real odds are available for FREE (priority #1)

- the-odds-api free tier only covers the **4 majors, winner market only** — useless for regular events.
- **pgatour.com's own `oddsTable` GraphQL query exposes real bookmaker odds for `WINNER`,
  `TOP_RANKED_5`, `TOP_RANKED_10`, `TOP_RANKED_20`** — exactly the place markets we need, free, via the
  same API we already use. Confirmed the schema; input is `{tournamentId, tournamentName, markets:[{market,class}],
  players:[{playerId,playerName}]}` (batch players ≤~40 to avoid a payload limit).
- Caveat: odds populate **mid-week** once books price the event, and **co-sanctioned/DP World Tour events
  (e.g. Scottish Open) may not be priced** by the US feed. On a Monday build the feed can be empty
  (`provider:null`). At the time of writing NO upcoming event was priced, so the real `odds` STRING FORMAT
  is still unseen — the parser must be verified against one live sample before we trust it.

**Why this matters:** without real odds the win-market "edges" are model-vs-model and produce nonsense
(the 2026-07-06 auto-card had Schauffele & Si Woo Kim at 66/1 to win with "+60% edges"). Real place odds
make "value" honest and fix the miscalibration. Client is being built defensively (auto-activates when
odds appear, falls back to estimates when not).

## SCOPED — Weather / tee-time draw bias (biggest untapped edge, not yet built)

**The edge:** at exposed/links courses the morning vs afternoon wave often play in materially different
wind/rain. The "draw" (which half of the field you're in) can be worth shots — decisive at the Scottish
Open and The Open. Sharp golf money weights this heavily; The Green Book ignores it entirely today.

**What it needs:**
1. **Tee times / wave** — pgatour GraphQL has tee-time data (needs a `teeTimters`/`groups` query, TBC) OR
   scrape the tournament tee sheet. Gives each player an AM/PM Thu–Fri wave.
2. **Weather forecast by window** — a forecast API keyed to the course lat/long, per 3-hour block across
   Thu–Fri. Options: Open-Meteo (**free**, no key, hourly wind/precip) — recommended first; or a paid tier
   (Tomorrow.io / Meteomatics) for round-level golf models. Open-Meteo alone likely covers 80% of the edge.
3. **Model term** — a per-player wave-conditions adjustment: penalise the wave forecast to play in the worst
   wind, reward the sheltered wave. Small weight, only switched on for high-wind/exposed courses.

**Effort:** ~a day. Free-data path (Open-Meteo + pgatour tee times) is viable with no new cost. Biggest
risk is tee times not being available until Wed/Thu, i.e. after the Monday build — so this likely needs a
**mid-week re-build** (which also solves the mid-week odds population above). Recommend pairing the two.

## SCOPED — Comparable-course archetypes (needs a curated map, wants your golf sign-off)

Today we only use history at the *exact* event. Comparable-course history would credit a player's record
across *similar* courses. Requires tagging events by type and aggregating past leaderboards by type:
- **links / coastal** (The Open, Scottish Open, …)
- **short & scoreable / birdie-fest** (John Deere, Travelers, Wyndham, RSM, …)
- **bomber / long** (big-yardage tracks)
- **tight positional / second-shot** (Harbour Town, Colonial, …)
- **desert / bermuda-grain**, **poa greens**, etc.

The model plumbing is straightforward (same mechanism as course history, at a small weight). The accuracy
depends on the event→type map — best built with your input since you know the courses. **To be confirmed
before shipping.**
