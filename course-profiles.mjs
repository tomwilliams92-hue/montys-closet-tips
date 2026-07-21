// course-profiles.mjs
// What kind of course is it, and which skills does it reward?
// `weights` re-weight the strokes-gained components for the picks model and MUST sum to 1:
//   ott  = off the tee (distance + driving)   app = approach play
//   arg  = around the green (short game)       putt = putting
// A bomber's track lifts `ott`; a short, fiddly course lifts `app`/`putt`; links lifts `ott`/`arg`.
// `archetype` is the one-line "what wins here", `tags` are the bullet read for the board.

export const DEFAULT_PROFILE = {
  archetype: 'Balanced ball-striking',
  summary: 'No strong course bias on file - the model falls back to all-round strokes-gained.',
  tags: ['Balanced test', 'All-round game rewarded'],
  weights: { ott: 0.25, app: 0.30, arg: 0.20, putt: 0.25 },
};

// Keyed by PGA Tour tournament id (e.g. Travelers 2026 = R2026034).
export const COURSE_PROFILES = {
  // 3M Open - TPC Twin Cities, Blaine MN
  R2026525: {
    course: 'TPC Twin Cities',
    par: 71,
    yards: 7431,
    grass: 'Bentgrass tee-to-green (cool-season)',
    archetype: 'Bomber-friendly birdie-fest',
    summary:
      'A long, generous Palmer/Lehman design with wide landing areas but water in play on 14 holes. Large, receptive Bentgrass greens (avg. ~6,500 sq ft, 70%+ tour-wide GIR) mean approach play sets up chances rather than defends par, so the week turns into a putting contest - every champion in tournament history has finished 15-under or better.',
    tags: [
      'One of the longest par 71s on tour at 7,431 yards - length is an edge, not a requirement',
      'Wide, generous fairways - driving accuracy matters less than at a tight course',
      'Water on 14 holes - the real hazard is attacking pins near it, not narrow tee shots',
      'Big, receptive greens and high GIR% - approach sets up birdies more than it defends',
      'Historically a birdie-fest - 15-under has won every playing - hot putter decides it',
    ],
    weights: { ott: 0.28, app: 0.32, arg: 0.15, putt: 0.25 },
  },

  // Travelers Championship - TPC River Highlands, Cromwell CT
  R2026034: {
    course: 'TPC River Highlands',
    par: 70,
    yards: 6841,
    grass: 'Bentgrass greens, bentgrass/Poa fairways (cool-season)',
    archetype: 'Precision irons & hot putter',
    summary:
      'One of the shortest, most scoreable tracks on tour. A par 70 with small greens where birdies are made with sharp approach play and putting, not raw power. Straight, accurate iron players beat the bombers here.',
    narrative:
      'At 6,841 yards TPC River Highlands is one of the shortest stops on the PGA Tour, and length is close to irrelevant - the driver often stays in the bag as players position off the tee and attack with wedges and short irons. The defence is the green complexes: they are small, quick and tightly bunkered, so it is a relentless second-shot and putting test where winning scores routinely reach 15-under or lower. The stretch from 15 to 17 (a drivable par 4 and the island-ish 17th) creates birdie-and-bogey swings, rewarding bold, in-form scorers with hot putters over methodical plodders. Course history matters here too - the same names keep contending - so we lean on approach play, putting and short game, and discount raw distance.',
    tags: [
      'Short par 70 - among the shortest on tour',
      'Small greens reward pinpoint approach play',
      'Birdie-fest: putting and short game decide it',
      'Distance off the tee is a minor edge - accuracy over power',
      'Pure bentgrass greens - true-rolling, rewards confident putters',
    ],
    weights: { ott: 0.15, app: 0.35, arg: 0.20, putt: 0.30 },
  },

  // John Deere Classic - TPC Deere Run, Silvis IL
  R2026030: {
    course: 'TPC Deere Run',
    par: 71,
    yards: 7268,
    grass: 'Bentgrass greens (cool-season)',
    archetype: 'Birdie-machine, elite irons & putting',
    summary:
      'A low-scoring birdie-fest. The winner almost always goes deep under par, so relentless approach play and a hot putter matter far more than length.',
    tags: [
      'Famously low scoring - winner goes deep red',
      'Approach play and putting are everything',
      'Length is not a requirement',
      'Suits accurate, in-form scorers',
    ],
    weights: { ott: 0.15, app: 0.35, arg: 0.15, putt: 0.35 },
  },

  // Genesis Scottish Open - The Renaissance Club, North Berwick (links, co-sanctioned)
  R2026541: {
    courseType: 'links',
    course: 'The Renaissance Club',
    par: 70,
    yards: 7282,
    grass: 'Fescue links greens and fairways',
    archetype: 'Wind-proof ball-striker',
    summary:
      'A links test in the wind the week before The Open. Control off the tee and flighted iron play win out; a strong all-round ball-striker who handles the breeze is favoured over a pure bomber.',
    tags: [
      'Coastal links - wind is the defence',
      'Driving control and accuracy at a premium',
      'Flighted, precise iron play rewarded',
      'Strong field: DP World Tour players in the mix (thinner PGA Tour data)',
    ],
    weights: { ott: 0.30, app: 0.30, arg: 0.20, putt: 0.20 },
  },

  // The Open Championship - Royal Birkdale, Southport (major, not a PGA Tour stats event)
  R2026100: {
    courseType: 'links',
    course: 'Royal Birkdale',
    par: 70,
    yards: 7156,
    grass: 'Fescue links greens and fairways',
    archetype: 'Complete links player',
    summary:
      'Classic Open links. Driving control, penetrating iron play and a sharp short game in the wind separate the field. Putting matters least of the four here - ball-striking and scrambling win Opens.',
    tags: [
      'Major championship links in the wind',
      'Premium on driving control and iron flight',
      'Scrambling and bunker play are decisive',
      'Global field - many players have little/no PGA Tour data (picks flagged)',
    ],
    weights: { ott: 0.30, app: 0.30, arg: 0.25, putt: 0.15 },
  },
};

// Course archetype -> the PGA Tour event codes (the {code} in R{year}{code}) of comparable events.
// Used to build each player's record on THIS TYPE of course (e.g. links suitability) from past
// stagings, so the model can credit proven wind/links horses the season-long SG average misses.
export const COURSE_TYPE_EVENTS = {
  links: ['100', '541'], // The Open Championship, Genesis Scottish Open
};

export function profileFor(tournamentId) {
  return COURSE_PROFILES[tournamentId] || DEFAULT_PROFILE;
}
