/**
 * decide.ts — one table: least-painful ranking, price per cabin, the seats you could
 * actually sit in, and a rough upgrade estimate.
 *
 * Where the flights come from:
 *   - a seat-map plug-in that offers availability (fare-class counts per flight), or
 *   - Google Flights, when it does not. That path has no fare-class counts, so the
 *     upgrade estimate there rests on open premium seats alone, and it says so.
 * Every source that failed or was cut short is listed under "source failures". A row
 * with no seat line was not fetched; it is never "full".
 */

import { collectGoogleFlights } from "./google-flights.ts";
import { rank, type Config, type Itinerary } from "./painfulness.ts";
import { fetchCabinPrices } from "./cabin-prices.ts";
import { checkAvailability, checkSeatMap, seatMapSettings } from "./seatmap.ts";
import type { AvailItinerary, BrowserDriver, SeatMapProvider } from "./seatmap-api.ts";
import { legSeatReality, noAcceptableSeat, seatToken, SEAT_LEGEND, type LegSeatReality } from "./seats.ts";
import { addDays, airportZone, minutesBetween, zonedEpoch } from "./time.ts";
import { upgradeEstimate, type UpgradeEstimate } from "./upgrade.ts";

export interface SourceFailure {
  source: string;
  error: string;
}

export interface DecisionRow {
  flights: string; // "UA 1234 → UA 567"
  route: string; // "ORD-DEN-SFO"
  depart: string; // "2027-02-01 07:10"
  arrive: string;
  aircraft: string;
  painScore: number | undefined;
  rejected: string[];
  priceByCabin: Record<string, number | undefined>;
  fareNotes: string[];
  seatReality: LegSeatReality[];
  upgrade: UpgradeEstimate | undefined;
  durationMinutes: number | undefined;
  notes: string[];
}

export interface DecideResult {
  origin: string;
  destination: string;
  date: string;
  flightsFrom: string; // which source supplied the flights
  rows: DecisionRow[];
  failures: SourceFailure[];
  requests: number;
  fetchedAt: string;
}

export interface DecideOptions {
  airlines: string[]; // carrier codes
  airlineName?: string; // Google Flights filter name
  seatmaps: boolean;
  topN?: number;
}

interface Candidate {
  avail: AvailItinerary;
  itin: Itinerary;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const keyOf = (a: AvailItinerary) => a.segments.map((s) => `${s.airline}${s.flightNumber}`).join("/");
const timeKey = (a: AvailItinerary) => `${a.segments[0]!.departTime}|${a.segments[a.segments.length - 1]!.arriveTime}`;

export function pricingCabins(cfg: Config): string[] {
  const c = (cfg.sources?.pricing as Record<string, unknown> | undefined)?.cabins;
  // An explicit empty list means "price nothing"; no list at all means economy only.
  return Array.isArray(c) ? (c as string[]) : ["economy"];
}

export async function decide(
  cfg: Config,
  browser: BrowserDriver,
  provider: SeatMapProvider | undefined,
  origin: string,
  destination: string,
  date: string,
  opts: DecideOptions,
): Promise<DecideResult> {
  const failures: SourceFailure[] = [];
  const priceIndex = new Map<string, Record<string, number>>();
  const fareNotes = new Map<string, string[]>();
  const setPrice = (k: string, cabin: string, p: number) => {
    const rec = priceIndex.get(k) ?? {};
    if (rec[cabin] === undefined || p < rec[cabin]!) rec[cabin] = p;
    priceIndex.set(k, rec);
  };

  // 1) The flights.
  let candidates: Candidate[];
  let flightsFrom: string;
  let gfEconomyDone = false;
  if (provider?.availability) {
    flightsFrom = `${provider.name} availability`;
    const res = checkAvailability(
      await provider.availability({ origin, destination, date, airlines: opts.airlines }),
      provider.name,
    );
    if (!res.complete) failures.push({ source: `${provider.name}:availability`, error: `INCOMPLETE: ${res.note}` });
    if (!res.itineraries.length) throw new Error(`${provider.name} availability returned zero itineraries for ${origin}-${destination} ${date}`);
    candidates = res.itineraries.map((a) => ({ avail: a, itin: toItinerary(cfg, a, failures, provider.name) }));
  } else {
    flightsFrom = "Google Flights";
    if (provider) failures.push({ source: `${provider.name}:availability`, error: "this seat-map source has no availability; flights come from Google Flights, with no fare-class counts" });
    const gf = await collectGoogleFlights(origin, destination, date, opts.airlineName, cfg);
    if (!gf.complete) failures.push({ source: "google-flights", error: `INCOMPLETE: ${gf.incompleteReason ?? "?"} (parsed ${gf.parsedCount}/${gf.claimedResultCount ?? "?"})` });
    candidates = gf.itineraries.map((it) => ({ avail: fromGoogleItinerary(it, date), itin: it }));
    for (const c of candidates) gfPrices(c.itin, c.avail);
    gfEconomyDone = true;
    if (opts.seatmaps && provider) {
      failures.push({ source: "google-flights", error: "Google Flights does not print flight numbers, so no seat maps could be fetched; use 'travel.ts seats' for a specific flight" });
    }
  }

  function gfPrices(it: Itinerary, a: AvailItinerary) {
    const k = timeKey(a);
    if (it.priceFrom !== undefined) setPrice(k, "economy", it.priceFrom);
    const basic = it.fares?.[0];
    if (basic && !basic.freeSeatSelection) {
      const seatable = it.fares!.find((f) => f.freeSeatSelection);
      fareNotes.set(k, [`headline $${basic.price} ${basic.brand} = NO seat selection${seatable ? `; seatable from ${seatable.brand} $${seatable.price}` : ""}`]);
    }
  }

  // 2) Least-painful ranking, in process.
  const verdicts = rank(candidates.map((c) => c.itin), cfg);
  const verdictFor = new Map(verdicts.map((v) => [v.itinerary, v]));

  // 3) Prices per cabin.
  const cabins = pricingCabins(cfg);
  if (!gfEconomyDone && cabins.includes("economy")) {
    try {
      const gf = await collectGoogleFlights(origin, destination, date, opts.airlineName, cfg);
      if (!gf.complete) failures.push({ source: "google-flights:economy", error: `INCOMPLETE: ${gf.incompleteReason ?? "?"}` });
      for (const it of gf.itineraries) {
        // Summary rows still carry the true first departure and final arrival, which is the join key.
        gfPrices(it, fromGoogleItinerary(it, date));
      }
    } catch (e) {
      failures.push({ source: "google-flights:economy", error: errText(e) });
    }
  }
  for (const cabin of cabins.filter((c) => c !== "economy")) {
    try {
      for (const p of await fetchCabinPrices(browser, origin, destination, date, cabin, opts.airlineName, (why) =>
        failures.push({ source: `google-flights:${cabin}`, error: why }),
      )) {
        setPrice(`${p.departTime}|${p.arriveTime}`, cabin, p.price);
      }
    } catch (e) {
      failures.push({ source: `google-flights:${cabin}`, error: errText(e) });
    }
  }

  // 4) Seat maps for the best eligible itineraries, one fetch per leg and cabin.
  const legReality = new Map<string, LegSeatReality>();
  const sm = seatMapSettings(cfg);
  if (opts.seatmaps && provider) {
    const eligible = candidates
      .map((c) => ({ c, v: verdictFor.get(c.itin) }))
      .filter((x) => x.v && x.v.rejected.length === 0)
      .sort((a, b) => b.v!.score - a.v!.score);
    // Take itineraries in rank order while their legs fit under max_fetches. Hitting the
    // cap after availability was already read must not throw that work away, and must
    // never fetch past the cap; the cut is named below, so the run still exits incomplete.
    const topN = opts.topN ?? sm.topN;
    type Leg = { airline: string; flightNumber: string; origin: string; destination: string; date: string };
    const legs = new Map<string, Leg>();
    const chosen: typeof eligible = [];
    let capped = false;
    for (const x of eligible.slice(0, topN)) {
      const mine = new Map<string, Leg>();
      for (const s of x.c.avail.segments) {
        if (s.flightNumber !== "?" && !legs.has(legKey(s))) {
          mine.set(legKey(s), { airline: s.airline, flightNumber: s.flightNumber, origin: s.origin, destination: s.destination, date: s.departDate });
        }
      }
      if ((legs.size + mine.size) * sm.cabins.length > sm.maxFetches) {
        capped = true;
        break;
      }
      for (const [k, v] of mine) legs.set(k, v);
      chosen.push(x);
    }
    if (eligible.length && !chosen.length) {
      throw new Error(`the best itinerary alone needs more than sources.seatmap.max_fetches (${sm.maxFetches}) seat-map fetches across ${sm.cabins.length} cabin(s); raise the cap on purpose`);
    }
    if (eligible.length > chosen.length) {
      const why = capped ? `max_fetches ${sm.maxFetches} with ${sm.cabins.length} cabin(s) per leg` : `top_n ${topN}`;
      failures.push({
        source: `${provider.name}:seatmaps`,
        error: `seats fetched for the top ${chosen.length} of ${eligible.length} eligible itineraries (${why}); the rest show NO seat line because they were not fetched, not because they are full`,
      });
    }
    for (const [k, leg] of legs) {
      for (const cabin of sm.cabins) {
        const req = { ...leg, cabin };
        try {
          legReality.set(`${k}|${cabin}`, legSeatReality(cfg, checkSeatMap(await provider.seatMap(req), req, provider.name)));
        } catch (e) {
          legReality.set(`${k}|${cabin}`, {
            leg: `${leg.airline} ${leg.flightNumber} ${leg.origin}-${leg.destination}`,
            aircraft: "?",
            cabin,
            open: 0,
            occupied: 0,
            blocked: 0,
            sitable: [],
            exitRowsKnown: false,
            extraLegroomRowsKnown: false,
            error: errText(e),
          });
        }
      }
    }
  } else if (opts.seatmaps) {
    failures.push({ source: "seatmaps", error: "no seat-map source configured; seats are UNKNOWN (sources.seatmap)" });
  }

  // 5) Join.
  const rows: DecisionRow[] = candidates.map(({ avail, itin }) => {
    const v = verdictFor.get(itin);
    const first = avail.segments[0]!;
    const last = avail.segments[avail.segments.length - 1]!;
    const k = timeKey(avail);
    const prices = priceIndex.get(k) ?? {};
    const priceByCabin: Record<string, number | undefined> = {};
    for (const c of cabins) priceByCabin[c] = prices[c];
    const seatReality: LegSeatReality[] = [];
    for (const s of avail.segments) {
      for (const cabin of sm.cabins) {
        const r = legReality.get(`${legKey(s)}|${cabin}`);
        if (r) seatReality.push(r);
      }
    }
    const premium = seatReality.filter((r) => r.cabin === sm.premiumCabin && !r.error);
    // An upgrade needs a seat on every leg, so the scarcest leg decides.
    const openPremium = premium.length ? Math.min(...premium.map((r) => r.open)) : undefined;
    return {
      flights: avail.segments.map((s) => `${s.airline} ${s.flightNumber}`).join(" → "),
      route: [first.origin, ...avail.segments.map((s) => s.destination)].join("-"),
      depart: `${first.departDate} ${first.departTime}`,
      arrive: `${last.arriveDate} ${last.arriveTime}`,
      aircraft: avail.segments.map((s) => s.aircraft).join("/"),
      painScore: v?.score,
      rejected: v?.rejected ?? ["unscored"],
      priceByCabin,
      fareNotes: fareNotes.get(k) ?? [],
      seatReality,
      upgrade: upgradeEstimate(cfg, avail, openPremium),
      durationMinutes: durationOf(cfg, avail),
      notes: v?.notes ?? [],
    };
  });
  rows.sort((a, b) => a.rejected.length - b.rejected.length || (b.painScore ?? -1) - (a.painScore ?? -1));
  return { origin, destination, date, flightsFrom, rows, failures, requests: browser.requests(), fetchedAt: new Date().toISOString() };
}

function legKey(s: { airline: string; flightNumber: string; origin: string; destination: string }): string {
  return `${s.airline}|${s.flightNumber}|${s.origin}|${s.destination}`;
}

export function durationOf(cfg: Config, a: AvailItinerary): number | undefined {
  const first = a.segments[0]!;
  const last = a.segments[a.segments.length - 1]!;
  const z1 = airportZone(cfg, first.origin);
  const z2 = airportZone(cfg, last.destination);
  if (!z1 || !z2) return undefined;
  return minutesBetween(zonedEpoch(first.departDate, first.departTime, z1), zonedEpoch(last.arriveDate, last.arriveTime, z2));
}

/** Provider availability → the ranking engine's itinerary shape. */
export function toItinerary(cfg: Config, a: AvailItinerary, failures: SourceFailure[], source: string): Itinerary {
  const day0 = a.segments[0]!.departDate;
  const dayOffset = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${day0}T00:00:00Z`)) / 86_400_000);
  const measured: { airport: string; minutes: number }[] = [];
  const missingZones = new Set<string>();
  for (let i = 0; i + 1 < a.segments.length; i++) {
    const x = a.segments[i]!;
    const y = a.segments[i + 1]!;
    const tz = airportZone(cfg, x.destination);
    if (!tz) {
      missingZones.add(x.destination);
      continue;
    }
    measured.push({ airport: x.destination, minutes: minutesBetween(zonedEpoch(x.arriveDate, x.arriveTime, tz), zonedEpoch(y.departDate, y.departTime, tz)) });
  }
  const duration = durationOf(cfg, a);
  if (duration === undefined) {
    missingZones.add(a.segments[0]!.origin);
    missingZones.add(a.segments[a.segments.length - 1]!.destination);
  }
  const unknown = [...missingZones].filter((z) => !airportZone(cfg, z));
  if (unknown.length) {
    const msg = `no time zone known for ${unknown.join(", ")} (add it under airport_tz) — trip length and connections for ${keyOf(a)} are not measured`;
    if (!failures.some((f) => f.error === msg)) failures.push({ source: `${source}:time`, error: msg });
  }
  return {
    segments: a.segments.map((s) => ({
      marketingAirline: s.airline,
      flightNumber: s.flightNumber,
      origin: s.origin,
      destination: s.destination,
      departLocal: s.departTime,
      arriveLocal: s.arriveTime,
      departDayOffset: dayOffset(s.departDate),
      arriveDayOffset: dayOffset(s.arriveDate),
      aircraft: s.aircraft,
    })),
    measuredConnections: measured.length === a.segments.length - 1 ? measured : undefined,
    totalDurationMinutes: duration ?? 0,
    sourceLabel: `${source} ${keyOf(a)}`,
  };
}

/** A Google Flights itinerary → the plug-in shape. Google prints no flight numbers, so they stay "?"
 *  and no seat map is fetched for them; a summary row is one pseudo-segment, first departure to final arrival. */
export function fromGoogleItinerary(it: Itinerary, date: string): AvailItinerary {
  return {
    segments: it.segments.map((s) => ({
      airline: s.marketingAirline,
      flightNumber: s.flightNumber || "?",
      origin: s.origin,
      destination: s.destination,
      departDate: addDays(date, s.departDayOffset ?? 0),
      departTime: s.departLocal,
      arriveDate: addDays(date, s.arriveDayOffset ?? 0),
      arriveTime: s.arriveLocal,
      aircraft: s.aircraft,
      buckets: [],
    })),
  };
}

// ───────────────────────────── rendering ─────────────────────────────

export function renderDecision(res: Pick<DecideResult, "rows">): string {
  const lines: string[] = [];
  for (const r of res.rows) {
    const verdict = r.rejected.length ? `REJECTED: ${r.rejected.join(",")}` : `pain ${r.painScore}`;
    const dur = r.durationMinutes !== undefined ? `${Math.floor(r.durationMinutes / 60)}h${String(r.durationMinutes % 60).padStart(2, "0")}` : "?";
    const prices = Object.entries(r.priceByCabin)
      .map(([c, p]) => `${c}: ${p !== undefined ? "$" + p : "n/a"}`)
      .join("  ");
    lines.push(`\n${r.flights}  (${r.route})  ${r.depart} → ${r.arrive}  ${dur}  [${r.aircraft}]  ${verdict}`);
    const up = r.upgrade
      ? `   upgrade: ${r.upgrade.label.toUpperCase()} (${r.upgrade.score}) [premium open=${r.upgrade.openPremiumSeats ?? "?"} buckets=${r.upgrade.premiumBucketSum}]`
      : "";
    lines.push(`  price  ${prices}${up}`);
    for (const n of r.fareNotes) lines.push(`  fare   ${n}`);
    for (const sr of r.seatReality) lines.push(renderSeatLine(sr));
    if (r.notes.length) lines.push(`  notes  ${r.notes.join("; ")}`);
  }
  lines.push("\n  " + SEAT_LEGEND.replace("\n", "\n  "));
  return lines.join("\n");
}

/** One leg's seat line. A seat's state always rides with it: a blocked seat printed like an
 *  open one would be a silent recommendation of a seat nobody can book. */
export function renderSeatLine(sr: LegSeatReality, economyCabin = "Y"): string {
  if (sr.error) return `  seats  ${sr.leg} ${sr.cabin}: UNAVAILABLE — ${sr.error.slice(0, 160)}`;
  const top = sr.sitable.slice(0, 5).map(seatToken).join(" ");
  const ladderOpen = sr.sitable.filter((s) => s.tier >= 0 && s.bookable).length;
  const ladderBlocked = sr.sitable.filter((s) => s.tier >= 0 && !s.bookable).length;
  const none = sr.cabin === economyCabin && noAcceptableSeat(sr.sitable);
  return (
    `  seats  ${sr.leg} ${sr.cabin} (${sr.aircraft}): ${sr.open} open / ${sr.occupied} occ / ${sr.blocked} blk` +
    ` | ladder: ${ladderOpen} open${ladderBlocked ? ` (+${ladderBlocked} blocked)` : ""}` +
    `${sr.exitRowsKnown ? "" : " | exit rows UNKNOWN"}${sr.extraLegroomRowsKnown ? "" : " | extra-legroom rows UNKNOWN"}` +
    ` | best: ${top || "none sit-able"}` +
    (none ? `  ⚠ NO ACCEPTABLE SEAT — nothing on your ladder is open${ladderBlocked ? ` (${ladderBlocked} ladder seat${ladderBlocked > 1 ? "s" : ""} blocked)` : ""}` : "")
  );
}
