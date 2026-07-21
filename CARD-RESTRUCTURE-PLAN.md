# Monty's Closet Tips — Card Restructure Plan (agreed with Tom, 2026-07-21)

Tom's feedback: The Green Book/skill isn't (1) picking well, (2) mixing bet types. He likes
each-way bets and has seen better returns on multiples (make-the-cut, top 10/20/30 coupons).

## What the data actually says (don't re-litigate)
- Model probabilities are WELL-CALIBRATED in the 10–45% range (94-bet backtest). The bleeding
  is the MARKET, not the model: 16/1–50/1 win-market e/w = −72.5% ROI; Top-10 bets = +97.5%.
- Bank 81.25pts (−18.75 from start), 34 settled, 7 pending (3M Open, all-model card).
- **This week's auto-card published five To Win e/w at 40–66/1 on MODEL-ESTIMATED prices**
  (odds feed had 0 players priced) — the exact known failure mode.

## The rebuild — three-tier card
1. **New markets from the existing Monte Carlo (no new data needed):**
   - P(make cut) = top-65-and-ties at the 36-hole mark of the sim.
   - P(top 30).
   Both sit in the model's calibrated sweet spot.
2. **Card architecture:**
   - **Bankers (core, ~5pts/wk):** 3–4 singles in make-cut / top-20 / top-30.
   - **Each-way (~3pts/wk):** 1–2 picks MAX, hard-limited to 20/1–50/1 band (per learnings),
     ONLY with a sourced real price — never a model estimate.
   - **Multiples (~2pts/wk):** 1–2 small doubles/trebles from banker legs, DIFFERENT players
     (near-independent → combo prob ≈ product of legs). Rule: every leg must individually
     clear its price or the combo is refused (multis compound margin).
   - Exposure caps so one week can't repeat The Open's −15pts.
3. **Immediate guardrail (do first):** auto-run must NEVER publish To Win e/w on model prices.
   If odds unverified → bankers-only auto-card.

## Build order
1. Guardrail in build.mjs (today — before next Monday's run).
2. Cut/top-30 probabilities out of the Monte Carlo (model.mjs/build.mjs).
3. Extend backtest.mjs to cut/top-30 + multi structure → validate over the 21-event season
   replay BEFORE staking. (Backtest stays OUT of the public ledger — hard rule.)
4. ledger.mjs leg-level settlement for multis; board rendering for multis.
5. Update `green-book-picks` skill (three-tier workflow, manual price sourcing for cut/top-30 —
   pgatour feed only covers win/top-5/10/20) + `montys-tips-writeup` for new card shape.
6. Shadow ledger runs old-style vs new-style in parallel.

## Housekeeping / open items
- Uncommitted working-tree changes (build.mjs +77 lines, course-profiles, player-notes,
  ledger, shadow-ledger) — launchd Monday 07:05 auto-pushes the working tree; review/commit.
- Wednesday midweek-check may finally capture pgatour odds sample on the 3M Open (standard
  full-field event) → verify parseOddsString → wire realPlaceOdds → flip flag.
- DataGolf (~$30/mo) later: non-PGA SG (Hatton problem) + historical odds.
- Provenance read: model +17.3% ROI vs judgment −100% (small sample) — lean model.
- Monetisation blocked on Tom: Telegram channel + BotFather bot token.
