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
  'ludvig aberg': "Sweden's smooth-swinging heir apparent has looked a major champion in waiting since turning pro, a runner-up at the 2024 Masters in his very first start there. His game is built on towering, pure iron play, the single most valuable skill on a tight, second-shot course like River Highlands, and he arrives in good order off a T17 at the U.S. Open.",
  'jacob bridgeman': "One of the most improved young Americans on tour, Bridgeman has quietly become a relentless scorer with a red-hot putter (+0.76 strokes a round). On a birdie-fest where someone always goes deep, a player holing everything is dangerous at a three-figure-friendly price.",
  'matt fitzpatrick': "Golf's great perfectionist, the 2022 U.S. Open champion who logs every shot he hits and sharpens his approach play to a razor's edge. That precision iron game is tailor-made for River Highlands' small greens, and he was already in the mix (22nd) at Shinnecock last week.",
  'akshay bhatia': "The aggressive young left-hander is one of the tour's most natural scorers, and when the irons are sharp he goes very low. A short, attackable course plays straight into his birdie-making hands.",
  'xander schauffele': "Mr Consistency. The 2024 PGA and Open champion is the hardest man in golf to leave off a leaderboard, he turns up, contends and stacks top-10s. On a course that rewards all-round excellence, he is about as solid a top-10 play as exists.",
  'scottie scheffler': "The world number one and the best ball-striker on the planet, whose floor is most players' ceiling. He contended again at the U.S. Open (T4), and on a scoreable course the only question is whether the putter behaves, which is exactly why each-way is the smart way in at this price.",
};

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();
export function noteFor(name) { return PLAYER_NOTES[norm(name)] || null; }
export function storyFor(name) { return STORYLINES[norm(name)] || null; }
