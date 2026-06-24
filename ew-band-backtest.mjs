// ew-band-backtest.mjs
// Where is the each-way SWEET SPOT? For every completed event this season we rebuild
// the model point-in-time, then place a notional 1pt EACH-WAY bet (1pt win + 1pt place)
// on every credible player at the model's win price, settle against the real finish, and
// bucket the result by PRICE BAND. We run it under BOTH 5-place and 8-place (Bet365-style)
// terms so you can see how the sweet spot shifts when you get more places.
//
// IMPORTANT: prices are the model's own estimate (notional), so this shows where the
// model's pricing finds each-way value, not proven profit vs the bookies (that needs
// historical market odds / DataGolf). Still, it's the cleanest read on which price band
// each-way bets actually land in.
//
//   node ew-band-backtest.mjs [N]    N = recent events to test (default = whole season)

import { getSchedule, getField, getStat, getEventSG, getLeaderboard } from './pga-api.mjs';
import { profileFor } from './course-profiles.mjs';
import { buildModel } from './model.mjs';

const SG = { total: '02675', ott: '02567', app: '02568', arg: '02569', putt: '02564' };
const DRIVE = { distance: '101', accuracy: '102' };
const MAJOR_RE = /(Masters Tournament|PGA Championship|U\.?S\.? Open|The Open Championship|THE PLAYERS)/i;
const isMajor = (n) => MAJOR_RE.test(n || '') && !/Scottish|Canadian|Mexico|Australian/i.test(n || '');
const seasonThrough = (statId, year, throughId) => getStat(statId, year, { tournamentId: throughId, queryType: 'THROUGH_EVENT' });

// price bands by decimal odds (lo inclusive, hi exclusive)
const BANDS = [
  ['<8/1', 1, 9], ['8/1-14/1', 9, 15], ['14/1-20/1', 15, 21], ['20/1-30/1', 21, 31],
  ['30/1-50/1', 31, 51], ['50/1-80/1', 51, 81], ['80/1-150/1', 81, 151], ['150/1+', 151, 1e9],
];
const bandOf = (dec) => BANDS.find(([, lo, hi]) => dec >= lo && dec < hi)?.[0] || '?';

// parse model fractional win price -> decimal
const fracToDec = (f) => { const [n, d] = f.split('/').map(Number); return d ? n / d + 1 : Number(f) + 1; };

// each-way settle: 1pt win + 1pt place. Returns profit (stake was 2pt).
function ewProfit(winDec, pos, places, placeFrac = 1 / 5) {
  let ret = 0;
  if (pos === 1) ret += 1 * winDec;                       // win part at full odds
  if (Number.isFinite(pos) && pos <= places) ret += 1 * (1 + (winDec - 1) * placeFrac); // place part
  return ret - 2;
}

async function main() {
  const year = new Date().getFullYear();
  let { completed } = await getSchedule(year);
  if (completed.length < 8) ({ completed } = await getSchedule(year - 1));
  const N = parseInt(process.argv[2] || String(completed.length), 10);
  const start = Math.max(6, completed.length - N);
  console.error(`[ew-backtest] season ${year}, events ${start + 1}-${completed.length}`);

  // accumulate per band for 5 and 8 places. Only "credible" each-way candidates:
  // model win price <= 200/1 and a real top-20 chance (filters 250/1 no-hopers).
  const acc = { 5: {}, 8: {} };
  for (const [name] of BANDS) { acc[5][name] = { n: 0, stake: 0, ret: 0, wins: 0, places: 0 }; acc[8][name] = { n: 0, stake: 0, ret: 0, wins: 0, places: 0 }; }

  for (let i = start; i < completed.length; i++) {
    const E = completed[i], prev = completed[i - 1];
    const recentSrc = completed.slice(Math.max(0, i - 5), i).reverse();
    try {
      const [field, sgT, sgO, sgA, sgAr, sgP, dD, dA, prevLb, resultLb, ...recent] = await Promise.all([
        getField(E.id),
        seasonThrough(SG.total, year, prev.id), seasonThrough(SG.ott, year, prev.id), seasonThrough(SG.app, year, prev.id),
        seasonThrough(SG.arg, year, prev.id), seasonThrough(SG.putt, year, prev.id),
        seasonThrough(DRIVE.distance, year, prev.id), seasonThrough(DRIVE.accuracy, year, prev.id),
        getLeaderboard(prev.id), getLeaderboard(E.id),
        ...recentSrc.map((e) => getEventSG(e.id, year)),
      ]);
      if (!field?.players?.length || !resultLb?.positions?.size) { console.error(`  skip ${E.tournamentName}`); continue; }
      const recentEvents = recentSrc.map((e, j) => ({ id: e.id, name: e.tournamentName, map: recent[j].map }));
      const previousEvent = { name: prev.tournamentName, isMajor: isMajor(prev.tournamentName), champion: prev.champion || null, finishPositions: prevLb?.positions || null };
      const model = buildModel({
        field, profile: profileFor(E.id),
        sg: { total: sgT.map, ott: sgO.map, app: sgA.map, arg: sgAr.map, putt: sgP.map },
        driving: { distance: dD.map, accuracy: dA.map },
        recentEvents, previousEvent, weekNumber: i + 1,
      });
      for (const r of model.deepDivePayload) {
        const win = r.markets.win; if (!win) continue;
        const dec = fracToDec(win.price);
        if (dec > 201) continue;                       // skip no-hopers
        if ((r.markets.top20?.modelProb || 0) < 0.05) continue; // must have a real place chance
        const fr = resultLb.positions.get(String(r.id));
        const pos = fr && !fr.cut ? fr.pos : null;
        const band = bandOf(dec);
        for (const places of [5, 8]) {
          const p = ewProfit(dec, pos, places);
          const a = acc[places][band];
          a.n++; a.stake += 2; a.ret += p + 2;
          if (pos === 1) a.wins++;
          if (Number.isFinite(pos) && pos <= places) a.places++;
        }
      }
      console.error(`  ${E.tournamentName.slice(0, 36).padEnd(36)} done`);
    } catch (e) { console.error(`  ERROR ${E.tournamentName}: ${e.message}`); }
  }

  for (const places of [5, 8]) {
    console.log(`\n================ EACH-WAY BY PRICE BAND  (1pt e/w, 1/5 odds, ${places} places) ================`);
    console.log('band         bets   win%   place%   ROI');
    let tot = { n: 0, stake: 0, ret: 0 };
    for (const [name] of BANDS) {
      const a = acc[places][name]; if (!a.n) continue;
      const roi = ((a.ret - a.stake) / a.stake) * 100;
      tot.n += a.n; tot.stake += a.stake; tot.ret += a.ret;
      console.log(
        name.padEnd(12),
        String(a.n).padStart(4),
        (a.wins / a.n * 100).toFixed(1).padStart(6) + '%',
        (a.places / a.n * 100).toFixed(1).padStart(6) + '%',
        ((roi >= 0 ? '+' : '') + roi.toFixed(1) + '%').padStart(9),
      );
    }
    const troi = ((tot.ret - tot.stake) / tot.stake) * 100;
    console.log('-'.repeat(46));
    console.log('ALL'.padEnd(12), String(tot.n).padStart(4), ' '.repeat(14), ((troi >= 0 ? '+' : '') + troi.toFixed(1) + '%').padStart(9));
  }
  console.log('\nNOTE: prices are the model\'s own estimate, so ROI is notional (model value, not proven market profit).');
}

main().catch((e) => { console.error('[ew-backtest] FAILED:', e.message); process.exit(1); });
