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
  'ludvig aberg': "Sweden's smooth-swinging heir apparent has looked a major champion in waiting since turning pro, a runner-up at the 2024 Masters in his very first start there. His game is built on towering, pure iron play, one of the most valuable skills in golf, and he arrives in good order off a T17 at the U.S. Open.",
  'jacob bridgeman': "One of the most improved young Americans on tour, Bridgeman has quietly become a relentless scorer with a red-hot putter (+0.76 strokes a round). On a birdie-fest where someone always goes deep, a player holing everything is dangerous at a three-figure-friendly price.",
  'matt fitzpatrick': "Golf's great perfectionist, the 2022 U.S. Open champion who logs every shot he hits and sharpens his approach play to a razor's edge. A precise, wind-hardened ball-striker with a genuine links pedigree — and the form links player in the field, third at the Scottish Open last week in his home country's major.",
  'wyndham clark': "The hottest ball-striker in the field bar none, gaining nearly three strokes a round across his last five starts — and a U.S. Open champion whose links game has quietly matured (best finish T4, averaging around 28th across nine comparable links starts). Firm, fast ground rewards exactly his blend of power and flight control.",
  'chris gotterup': "Golf's great closer — four wins this season already, the latest a final-round 62 from five back at the John Deere two weeks ago, and he backed it up with T11 defending his Scottish Open title last week. The links case is real: a links win on the record and a T3 in his only Open start. The one wrinkle is driving accuracy on firm, running ground with penal rough — which is why he's the small stake, not the anchor.",
  'si woo kim': "The quiet fit for a burnt Birkdale: Si Woo Kim ranks among the tour's very best for driving accuracy and approach play — the two skills firm, running fairways pay — and he has done it at an Open before, runner-up at Royal Liverpool in 2023. T9 at the Scottish Open last week says the links game has travelled again this summer.",
  'akshay bhatia': "The aggressive young left-hander is one of the tour's most natural scorers, and when the irons are sharp he goes very low. A short, attackable course plays straight into his birdie-making hands.",
  'xander schauffele': "Mr Consistency. The 2024 PGA and Open champion is the hardest man in golf to leave off a leaderboard, he turns up, contends and stacks top-10s. On a course that rewards all-round excellence, he is about as solid a top-10 play as exists.",
  'scottie scheffler': "The world number one and the best ball-striker on the planet, whose floor is most players' ceiling. He contended again at the U.S. Open (T4), and on a demanding ball-striker's test in the wind the only question is whether the putter behaves.",
};

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();
export function noteFor(name) { return PLAYER_NOTES[norm(name)] || null; }
export function storyFor(name) { return STORYLINES[norm(name)] || null; }
