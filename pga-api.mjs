// pga-api.mjs
// Thin client for the PGA Tour public GraphQL backend (orchestrator.pgatour.com).
// No login, no Chrome: the site authenticates with an AWS AppSync API key that is
// embedded in its JS bundle. We keep a few known-good keys as a fast path, and if
// they ever stop working we re-extract a fresh key from the live bundle automatically.
// That self-healing is the whole reason this is steadier than the Conwy Choppers login.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GQL_URL = 'https://orchestrator.pgatour.com/graphql';
const STATS_PAGE = 'https://www.pgatour.com/stats';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const KEY_CACHE = path.join(__dirname, '.apikey');

// Keys lifted from the bundle at build time. All 8 authenticate; we use the first
// that still works. If all fail we re-extract (see extractKeysFromBundle).
const SEED_KEYS = [
  'da2-coitqxzlkrdknf6y6laddb3w4e',
  'da2-fmi36ir4dvavljcurr2ofyiota',
  'da2-gsrx5bibzbb4njvhl7t37wqyl4',
  'da2-ikmqdnxdbjarxhmgocdn3c2ude',
  'da2-kquzxb3w4vhezhjosk5a74xx2u',
  'da2-krhfp4ml2bgp5cjsm5a7uezcva',
  'da2-teu6bwqcgzaobbu2aazt3i7lkq',
  'da2-w3m42v7r35cavjcei2kuiefigq',
];

function headers(key) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'x-pgat-platform': 'web',
    'User-Agent': UA,
  };
}

async function testKey(key) {
  try {
    const r = await fetch(GQL_URL, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({ query: '{__typename}' }),
    });
    const j = await r.json();
    return j?.data?.__typename === 'Query';
  } catch {
    return false;
  }
}

async function extractKeysFromBundle() {
  const html = await (await fetch(STATS_PAGE, { headers: { 'User-Agent': UA } })).text();
  const chunks = [...new Set([...html.matchAll(/\/_next\/static\/[^"']+\.js/g)].map((m) => m[0]))];
  const keys = new Set();
  for (const c of chunks) {
    try {
      const js = await (await fetch('https://www.pgatour.com' + c, { headers: { 'User-Agent': UA } })).text();
      for (const m of js.matchAll(/da2-[a-z0-9]{26}/g)) keys.add(m[0]);
    } catch { /* skip unreachable chunk */ }
  }
  return [...keys];
}

let CURRENT_KEY = null;

export async function getApiKey(force = false) {
  if (CURRENT_KEY && !force) return CURRENT_KEY;
  const candidates = [];
  try {
    if (fs.existsSync(KEY_CACHE)) candidates.push(fs.readFileSync(KEY_CACHE, 'utf8').trim());
  } catch { /* ignore */ }
  candidates.push(...SEED_KEYS);

  for (const k of candidates) {
    if (k && (await testKey(k))) {
      CURRENT_KEY = k;
      try { fs.writeFileSync(KEY_CACHE, k); } catch { /* ignore */ }
      return k;
    }
  }
  // Nothing cached/seeded works - pull a fresh key straight from the live bundle.
  console.error('[pga-api] seed keys rejected, re-extracting from bundle...');
  for (const k of await extractKeysFromBundle()) {
    if (await testKey(k)) {
      CURRENT_KEY = k;
      try { fs.writeFileSync(KEY_CACHE, k); } catch { /* ignore */ }
      console.error('[pga-api] new key acquired:', k);
      return k;
    }
  }
  throw new Error('Could not obtain a working pgatour.com API key.');
}

export async function gql(query, variables = {}) {
  const key = await getApiKey();
  const send = async (k) =>
    (await fetch(GQL_URL, { method: 'POST', headers: headers(k), body: JSON.stringify({ query, variables }) })).json();

  let j = await send(key);
  if (j.errors && /Unauthorized|Forbidden|403|401|ExpiredToken/i.test(JSON.stringify(j.errors))) {
    j = await send(await getApiKey(true)); // refresh once and retry
  }
  if (j.errors) throw new Error('GraphQL error: ' + JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

// ---- typed query wrappers -------------------------------------------------

const TOUR = 'R'; // PGA Tour

export async function getSchedule(year) {
  const q = `query S($t:String!,$y:String){schedule(tourCode:$t,year:$y){
    seasonYear
    upcoming{tournaments{id startDate sortDate tournamentName courseName city state tournamentLogoAsset{imagePath}}}
    completed{tournaments{id startDate sortDate tournamentName courseName champion}}
  }}`;
  const d = await gql(q, { t: TOUR, y: String(year) });
  const flat = (months) => (months || []).flatMap((m) => m.tournaments || []);
  return { upcoming: flat(d.schedule.upcoming), completed: flat(d.schedule.completed) };
}

export async function getField(tournamentId) {
  const q = `query F($id:ID!){field(id:$id){
    tournamentName lastUpdated
    players{id firstName lastName displayName country countryFlag owgr rankingPoints amateur}
  }}`;
  const d = await gql(q, { id: tournamentId });
  return d.field;
}

// statId values:
//  02675 SG:Total  02567 SG:OTT  02568 SG:Approach  02569 SG:AroundGreen  02564 SG:Putting
//  101 Driving Distance  102 Driving Accuracy %  103 GIR %  130 Scrambling  352 Birdie or Better %
export async function getStat(statId, year, eventQuery = null) {
  const q = `query SD($t:TourCode!,$s:String!,$y:Int,$eq:StatDetailEventQuery){
    statDetails(tourCode:$t,statId:$s,year:$y,eventQuery:$eq){
      statTitle statHeaders
      rows{... on StatDetailsPlayer{playerId playerName rank stats{statName statValue}}}
    }
  }`;
  const d = await gql(q, { t: TOUR, s: String(statId), y: year, eq: eventQuery });
  const sd = d.statDetails;
  const map = new Map(); // playerId -> { rank, values: {statName: number} }
  for (const r of sd.rows || []) {
    if (!r.playerId) continue;
    const values = {};
    for (const s of r.stats || []) values[s.statName] = parseFloat(String(s.statValue).replace(/[%,]/g, ''));
    map.set(String(r.playerId), { rank: r.rank, name: r.playerName, values });
  }
  return { title: sd.statTitle, headers: sd.statHeaders, map };
}

export async function getEventSG(tournamentId, year) {
  // SG:Total for a single completed event (recent form input).
  return getStat('02675', year, { tournamentId, queryType: 'EVENT_ONLY' });
}

// Course history: how each player has fared at THIS event in prior years. The PGA Tour id
// is R{YEAR}{eventCode} (e.g. Travelers = R2026034), so we swap the year to find past stagings
// and pull their final leaderboards. Returns Map(playerId -> {starts, madeCuts, avgFinish,
// bestFinish}) where a missed cut counts as a 65th-place finish so it drags the average down.
export async function getCourseHistory(currentEventId, yearsBack = 4) {
  const m = /^([A-Z])(\d{4})(\d+)$/.exec(currentEventId || '');
  if (!m) return new Map();
  const [, prefix, yr, code] = m;
  const year = parseInt(yr, 10);
  const ids = [];
  for (let k = 1; k <= yearsBack; k++) ids.push(`${prefix}${year - k}${code}`);
  const lbs = await Promise.all(ids.map((id) => getLeaderboard(id).catch(() => null)));
  const agg = new Map(); // playerId -> { starts, madeCuts, sumFinish, bestFinish }
  for (const lb of lbs) {
    if (!lb?.positions?.size) continue;
    for (const [pid, v] of lb.positions) {
      const a = agg.get(pid) || { starts: 0, madeCuts: 0, sumFinish: 0, bestFinish: null };
      a.starts++;
      const finishVal = v.cut || !Number.isFinite(v.pos) ? 65 : v.pos;
      a.sumFinish += finishVal;
      if (!v.cut && Number.isFinite(v.pos)) { a.madeCuts++; if (a.bestFinish == null || v.pos < a.bestFinish) a.bestFinish = v.pos; }
      agg.set(pid, a);
    }
  }
  const out = new Map();
  for (const [pid, a] of agg) out.set(pid, { starts: a.starts, madeCuts: a.madeCuts, avgFinish: a.sumFinish / a.starts, bestFinish: a.bestFinish });
  return out;
}

// Final finishing positions for a completed event - used to settle P&L bets.
// Returns Map(playerId -> { pos:Int|null, posText:String, cut:Boolean }).
export async function getLeaderboard(tournamentId) {
  const q = `query L($id:ID!){leaderboardV3(id:$id){tournamentStatus
    players{... on PlayerRowV3{player{id} scoringData{position}}}}}`;
  const d = await gql(q, { id: tournamentId });
  const lb = d.leaderboardV3;
  const map = new Map();
  for (const row of lb?.players || []) {
    if (!row.player?.id) continue;
    const txt = row.scoringData?.position || '';
    const num = /^T?(\d+)$/.exec(txt);
    const cut = /CUT|WD|DQ|MDF/i.test(txt);
    map.set(String(row.player.id), { pos: num ? parseInt(num[1], 10) : null, posText: txt, cut });
  }
  return { status: lb?.tournamentStatus, positions: map };
}
