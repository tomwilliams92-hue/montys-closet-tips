// player-notes.mjs
// The qualitative layer the numbers model can't see: injuries, withdrawals, returns
// from layoff, swing changes, personal circumstances. Update this each week from the
// news. Keyed by player name (accents/case-insensitive).
//   adjust = added to the model composite (negative downgrades; ~0.5 is a big move)
//   tag    = short flag shown on the card
//   note   = the sentence that appears in the write-up
//
// Always date the note so stale ones are easy to spot and clear.

export const PLAYER_NOTES = {
  'jake knapp': {
    adjust: -0.9, tag: 'Injury doubt',
    note: 'Returning from a thumb sprain that forced three straight withdrawals, including the PGA Championship (as of late June 2026). Elite when fit - 3rd in SG: Total this season - but until he completes a full tournament he is a back-with-caution, not a confident play.',
  },
};

// Editorial storylines: the "personal story" behind a pick. When present for a player this
// week, it leads the write-up (the value line is still appended automatically). Refresh these
// each week for the actual selections - this is the human, story-driven layer.
export const STORYLINES = {
  // 3M Open (TPC Twin Cities) - week of 20 Jul 2026. Replaces the Open Championship set,
  // which is done and settled - never leave a finished event's copy live on the board.
  'doug ghim': "The best golf of Ghim's career is happening right now: four straight finishes of T31 or better, including a stretch at the John Deere Classic where he became the first player on the PGA Tour since 2014 to hit every fairway and every green in regulation in a single round. Four starts already at TPC Twin Cities, and a long, generous track suits a ball-striker this straight.",
  'lee hodges': "The last man to win at TPC Twin Cities - he ran away with the 2023 title by seven shots - and he arrives in form, two shots from a playoff at last week's John Deere Classic. A proven course winner at a price the market hasn't caught up to.",
  'keith mitchell': "One of the tour's more underrated ball-strikers: third for proximity and ninth for driving distance in a stacked field at the Travelers two starts ago, and trending up across his last four. A long, generous course built for exactly this game.",
  'max homa': "A six-time PGA Tour winner finding form again - runner-up three tournaments ago at TPC Deere Run - with course pedigree here too: T3 at the 2020 3M Open. The market already knows this story, so it's a conditions play rather than a priced value bet.",
  'keita nakajima': "Japan's rising star is playing well above his OWGR ranking right now, gaining 1.75 strokes a round across his last three starts. No course history to lean on yet, which is why this stays a single point.",
};

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();
export function noteFor(name) { return PLAYER_NOTES[norm(name)] || null; }
export function storyFor(name) { return STORYLINES[norm(name)] || null; }
