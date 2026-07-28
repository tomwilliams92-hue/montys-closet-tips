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
  // Rocket Classic (Detroit Golf Club) - week of 27 Jul 2026. Replaces the 3M Open set,
  // which is done and settled - never leave a finished event's copy live on the board.
  'wyndham clark': "This year's U.S. Open champion is playing the best golf on tour right now — gaining 2.42 strokes a round across his last three starts — and he arrives at a course that fits like a glove: T8 in two prior Detroit starts, with the sharp wedge play and hot putter this birdie-fest demands. The market has him fifth-favourite; our numbers make him the man to beat in the final Rocket Classic at Detroit Golf Club.",
  'akshay bhatia': "A three-time tour winner, including this season's Arnold Palmer Invitational, and a proven Detroit performer — runner-up here in 2024. He's warming up at the right time (nearly two strokes a round gained over his last two starts) and the putter, his best club, is the one that separates the field at Detroit Golf Club.",
  'xander schauffele': "The two-time major champion hasn't hit top gear this season, but his floor is what we're backing: relentless cut-making class and a tee-to-green game that keeps him near the frame even in ordinary weeks. On the tour's most forgiving course, the model makes him more likely than not to be inside the top 30.",
};

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();
export function noteFor(name) { return PLAYER_NOTES[norm(name)] || null; }
export function storyFor(name) { return STORYLINES[norm(name)] || null; }
