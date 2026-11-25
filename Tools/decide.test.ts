/**
 * decide: the join, the honesty of its output, the upgrade estimate, and time math.
 * Runs end to end against a fake seat-map plug-in, offline. All flights are made up.
 *
 * Regressions this suite pins:
 *   - two BLOCKED seats were printed exactly like open ones and read as the best
 *     seats on the flight          -> "a seat's state is never hidden"
 *   - a cap on seat-map fetches silently read as "the rest have no good seats"
 *                                  -> "itineraries past top_n say they were not fetched"
 */

import { describe, expect, test } from "bun:test";
import { decide, durationOf, fromGoogleItinerary, renderDecision, renderSeatLine, toItinerary, type DecisionRow, type SourceFailure } from "./decide.ts";
import type { Config, Itinerary } from "./painfulness.ts";
import type { AvailItinerary, AvailSegment, BrowserDriver, SeatMapProvider, SeatMapRequest } from "./seatmap-api.ts";
import type { LegSeatReality, SitableSeat } from "./seats.ts";
import { CFG } from "./test-helpers.ts";
import { addDays, AIRPORT_ZONES, airportZone, minutesBetween, zonedEpoch } from "./time.ts";
import { upgradeEstimate } from "./upgrade.ts";

const TZ = { ORD: "America/Chicago", DEN: "America/Denver", SFO: "America/Los_Angeles", EWR: "America/New_York" };

const cfg: Config = {
  ...CFG,
  defaults: { airline: "UA", prefer_mainline: true },
  traveler: { programs: [{ airline: "UA", status: "top" }] },
  seating: { preference_order: ["exit_row_aisle", "exit_row_window", "extra_legroom_aisle", "extra_legroom_window"] },
  seat_data: { UA: { "739": { exit_rows: [20], extra_legroom_rows: [7, 8, 20], bulkhead_rows: [7] } } },
  airport_tz: TZ,
  upgrade_estimate: {
    premium_buckets: { UA: ["F", "J"] },
    weights: { open_premium_seats: 3, premium_bucket_sum: 1 },
    hub_factor: { DEN: 0.5, default: 1 },
    tier_factor: { top: 1, default: 0.5 },
    labels: { high: 20, medium: 8 },
  },
  sources: { ...CFG.sources, pricing: { cabins: [] }, seatmap: { enabled: true, module: "unused", top_n: 1 } },
};

function seg(flightNumber: string, origin: string, destination: string, dep: string, arr: string, buckets: [string, number][] = []): AvailSegment {
  return {
    airline: "UA", flightNumber, origin, destination,
    departDate: "2027-03-10", departTime: dep, arriveDate: "2027-03-10", arriveTime: arr,
    aircraft: "739", buckets: buckets.map(([cls, count]) => ({ cls, count })),
  };
}

const NONSTOP: AvailItinerary = { segments: [seg("1001", "ORD", "SFO", "08:00", "10:30", [["J", 4], ["Y", 9]])] };
const ONESTOP: AvailItinerary = {
  segments: [seg("2002", "ORD", "DEN", "07:30", "09:00", [["J", 2]]), seg("3003", "DEN", "SFO", "10:30", "12:15", [["F", 1]])],
};

const browser: BrowserDriver = { open: async () => 1, read: async () => "", click: async () => {}, requests: () => 0 };

function fakeProvider(seen: SeatMapRequest[] = []): SeatMapProvider {
  return {
    apiVersion: 1,
    name: "fake",
    availability: async () => ({ itineraries: [ONESTOP, NONSTOP], complete: true }),
    seatMap: async (req) => {
      seen.push(req);
      const X: Record<string, number> = { A: 1, B: 2, C: 3, D: 6, E: 7, F: 8 };
      const seats = [...("ABCDEF" as string)].flatMap((l) =>
        [7, 20, 30].map((row) => ({ id: `${row}${l}`, state: req.cabin === "F" ? "available" : row === 20 && l === "C" ? "blocked" : row === 7 && l === "D" ? "available" : "occupied", x: X[l]! })),
      );
      return { request: req, aircraftName: "Boeing 737-900", aircraftCode: "739", seats: seats as never };
    },
  };
}

describe("decide, end to end against a fake plug-in", () => {
  test("ranks, fetches seats for the top itinerary only, and says the rest were not fetched", async () => {
    const seen: SeatMapRequest[] = [];
    const res = await decide(cfg, browser, fakeProvider(seen), "ORD", "SFO", "2027-03-10", { airlines: ["UA"], seatmaps: true });
    expect(res.flightsFrom).toBe("fake availability");
    expect(res.rows).toHaveLength(2);
    const withSeats = res.rows.filter((r) => r.seatReality.length > 0);
    expect(withSeats).toHaveLength(1);
    expect(seen.every((r) => ["Y", "F"].includes(r.cabin))).toBe(true);
    expect(res.failures.map((f) => f.error).join(" ")).toContain("not fetched, not because they are full");
  });

  test("the upgrade estimate uses the scarcest premium leg and the fare buckets", () => {
    // ONESTOP: J2 + F1 = 3 bucket seats, 18 open F seats on the map, DEN hub 0.5, status top 1.0
    const u = upgradeEstimate(cfg, ONESTOP, 18)!;
    expect(u.score).toBe(Math.round((3 * 18 + 3) * 0.5));
    expect(u.label).toBe("high");
    expect(u.connectionAirports).toEqual(["DEN"]);
    const noMap = upgradeEstimate(cfg, ONESTOP, undefined)!;
    expect(noMap.openPremiumSeats).toBeUndefined();
    expect(noMap.score).toBe(Math.round(3 * 0.5)); // nothing invented for the missing map
    const plain: Config = { ...cfg, traveler: { programs: [{ airline: "UA", status: "member" }] } };
    expect(upgradeEstimate(plain, NONSTOP, 0)!.score).toBe(Math.round(4 * 0.5));
    expect(upgradeEstimate({ ...cfg, upgrade_estimate: undefined }, NONSTOP, 0)).toBeUndefined();
  });

  test("the fetch cap is never exceeded: itineraries are taken in rank order until it is, and the cut is named (live 2026-11-24)", async () => {
    for (const cap of [4, 5, 6, 7, 8, 16]) {
      const seen: SeatMapRequest[] = [];
      const c: Config = { ...cfg, sources: { ...cfg.sources, seatmap: { enabled: true, module: "x", top_n: 5, max_fetches: cap } } };
      const r = await decide(c, browser, fakeProvider(seen), "ORD", "SFO", "2027-03-10", { airlines: ["UA"], seatmaps: true });
      expect(seen.length).toBeLessThanOrEqual(cap);
      expect(seen.length).toBeGreaterThan(0);
      const cut = r.failures.find((f) => f.error.includes("not fetched"));
      if (cut) expect(cut.error).toMatch(/max_fetches|top_n/);
    }
  });

  test("when even the best itinerary needs more fetches than the cap, nothing is fetched", async () => {
    const seen: SeatMapRequest[] = [];
    const tight: Config = { ...cfg, sources: { ...cfg.sources, seatmap: { enabled: true, module: "x", top_n: 5, max_fetches: 1 } } };
    const err = await decide(tight, browser, fakeProvider(seen), "ORD", "SFO", "2027-03-10", { airlines: ["UA"], seatmaps: true }).catch((e) => e);
    expect(String(err?.message)).toContain("max_fetches");
    expect(seen).toHaveLength(0);
  });

  test("a seat-map failure for one leg shows on that leg, named", async () => {
    const p = fakeProvider();
    p.seatMap = async () => {
      throw new Error("source said: try again later");
    };
    const res = await decide(cfg, browser, p, "ORD", "SFO", "2027-03-10", { airlines: ["UA"], seatmaps: true });
    const line = renderDecision(res).split("\n").find((l) => l.includes("UNAVAILABLE"));
    expect(line).toContain("source said: try again later");
  });

  test("bad availability from a provider is refused before ranking", async () => {
    const p = fakeProvider();
    p.availability = async () => ({ itineraries: [{ segments: [{ ...NONSTOP.segments[0]!, departTime: "8:00 AM" }] }], complete: true });
    await expect(decide(cfg, browser, p, "ORD", "SFO", "2027-03-10", { airlines: ["UA"], seatmaps: false })).rejects.toThrow(/HH:MM/);
  });
});

// ───────────── honesty of the rendered table ─────────────

function seat(id: string, o: Partial<SitableSeat> & { tier: number; state: SitableSeat["state"] }): SitableSeat {
  return {
    id, position: o.position ?? "aisle", exitRow: o.exitRow ?? false, extraLegroom: o.extraLegroom ?? false,
    bulkhead: o.bulkhead ?? false, state: o.state, bookable: o.state === "available", openMiddleAdjacent: false, tier: o.tier,
  };
}

function leg(sitable: SitableSeat[]): LegSeatReality {
  return {
    leg: "UA 2002 ORD-DEN", aircraft: "Boeing 737-900", cabin: "Y",
    open: sitable.filter((s) => s.state === "available").length, occupied: 100,
    blocked: sitable.filter((s) => s.state === "blocked").length, sitable, exitRowsKnown: true, extraLegroomRowsKnown: true,
  };
}

function row(seatReality: LegSeatReality[]): DecisionRow {
  return {
    flights: "UA 2002", route: "ORD-DEN", depart: "2027-03-10 07:30", arrive: "2027-03-10 09:00", aircraft: "739",
    painScore: 90, rejected: [], priceByCabin: { economy: 199, first: undefined }, fareNotes: [], seatReality,
    upgrade: undefined, durationMinutes: 150, notes: [],
  };
}

describe("a seat's state is never hidden", () => {
  test("a flight whose only good seats are blocked reports NO ACCEPTABLE SEAT and marks them", () => {
    const out = renderDecision({
      rows: [
        row([
          leg([
            seat("4D", { tier: 2, state: "blocked", extraLegroom: true, bulkhead: true }),
            seat("4E", { tier: -1, state: "blocked", extraLegroom: true, bulkhead: true, position: "middle" }),
            seat("13F", { tier: -1, state: "available", position: "window" }),
            seat("10B", { tier: -1, state: "available", exitRow: true, position: "middle" }),
          ]),
        ]),
      ],
    });
    expect(out).toContain("NO ACCEPTABLE SEAT");
    expect(out).toContain("1 ladder seat blocked");
    expect(out).toContain("ladder: 0 open (+1 blocked)");
    expect(out).toMatch(/4D\^b\(blo\)/);
  });

  test("a blocked ladder seat alone never clears the check; an open one does, with no marker", () => {
    expect(renderSeatLine(leg([seat("20D", { tier: 0, state: "blocked", exitRow: true })]))).toContain("NO ACCEPTABLE SEAT");
    const open = renderSeatLine(leg([seat("20D", { tier: 0, state: "available", exitRow: true })]));
    expect(open).not.toContain("NO ACCEPTABLE SEAT");
    expect(open).toContain("best: 20D*");
    expect(open).not.toContain("(blo)");
  });

  test("a failed leg says UNAVAILABLE with the reason, never a seat count", () => {
    const line = renderSeatLine({ ...leg([]), error: "logged out of the source" });
    expect(line).toContain("UNAVAILABLE — logged out of the source");
    expect(line).not.toContain("open /");
  });

  test("a missing price prints n/a, never a number", () => {
    expect(renderDecision({ rows: [row([])] })).toContain("first: n/a");
  });
});

// ───────────── time and shape conversion ─────────────

describe("time", () => {
  test("durations across zones use real offsets, swept over every hour of a DST-change week", () => {
    for (let day = 7; day <= 14; day++) {
      const date = `2027-03-${String(day).padStart(2, "0")}`;
      for (let h = 6; h <= 20; h++) {
        const dep = `${String(h).padStart(2, "0")}:00`;
        const a: AvailItinerary = { segments: [{ ...NONSTOP.segments[0]!, departDate: date, arriveDate: date, departTime: dep, arriveTime: `${String(h + 2).padStart(2, "0")}:00` }] };
        // ORD -> SFO local clocks 2h apart on the face; Chicago is 2h ahead of LA all year.
        expect(durationOf(cfg, a)).toBe(4 * 60);
      }
    }
  });

  test("zonedEpoch is exact for a known instant and rejects 12h input", () => {
    expect(new Date(zonedEpoch("2027-07-01", "12:00", "America/New_York")).toISOString()).toBe("2027-07-01T16:00:00.000Z");
    expect(() => zonedEpoch("2027-07-01", "12:00 PM", "America/New_York")).toThrow(/HH:MM/);
    expect(minutesBetween(0, 90 * 60_000)).toBe(90);
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  test("an airport with no zone anywhere is reported, and its trip length is left unmeasured", () => {
    const failures: SourceFailure[] = [];
    // QQX is not a real IATA code, so neither the built-in table nor the config knows it.
    const viaUnknown: AvailItinerary = { segments: ONESTOP.segments.map((s, i) => (i === 0 ? { ...s, destination: "QQX" } : { ...s, origin: "QQX" })) };
    const it = toItinerary(cfg, viaUnknown, failures, "fake");
    expect(it.measuredConnections).toBeUndefined();
    expect(failures[0]!.error).toContain("no time zone known for QQX");
    expect(durationOf(cfg, viaUnknown)).toBe(405); // ends are known: total time needs only those
    const fromUnknown: AvailItinerary = { segments: [{ ...NONSTOP.segments[0]!, origin: "QQX" }] };
    expect(durationOf(cfg, fromUnknown)).toBeUndefined();
  });

  test("the built-in table covers every airport the config does not, and the config wins", () => {
    for (const [code, tz] of Object.entries({ DEN: "America/Denver", SLC: "America/Denver", PHX: "America/Phoenix", ANC: "America/Anchorage", HNL: "Pacific/Honolulu", KTM: "Asia/Kathmandu", AKL: "Pacific/Auckland" })) {
      expect(airportZone({ ...cfg, airport_tz: {} }, code)).toBe(tz);
    }
    expect(airportZone({ ...cfg, airport_tz: { DEN: "America/Chicago" } }, "DEN")).toBe("America/Chicago");
    expect(airportZone({ ...cfg, airport_tz: {} }, "den")).toBe("America/Denver");
    expect(durationOf({ ...cfg, airport_tz: {} }, ONESTOP)).toBeGreaterThan(0);
  });

  test("the built-in table: every zone loads, and every UTC offset in use is covered", () => {
    const codes = Object.keys(AIRPORT_ZONES);
    expect(codes.length).toBeGreaterThan(7000);
    expect(codes.every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
    const offsets = new Set<string>();
    for (const z of new Set(Object.values(AIRPORT_ZONES))) {
      for (const d of [new Date("2027-01-15T12:00Z"), new Date("2027-07-15T12:00Z")]) {
        offsets.add(new Intl.DateTimeFormat("en-US", { timeZone: z, timeZoneName: "longOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")!.value);
      }
    }
    // Every offset with a scheduled airport, from -11 (Pago Pago) to +14 (Kiritimati), including the odd ones.
    for (const o of ["GMT-11:00", "GMT-09:30", "GMT-03:30", "GMT+05:30", "GMT+05:45", "GMT+08:45", "GMT+12:45", "GMT+13:45", "GMT+14:00"]) expect(offsets).toContain(o);
    expect(offsets.size).toBeGreaterThanOrEqual(39);
  });

  test("provider itineraries become ranking itineraries with measured connections and day offsets", () => {
    const red: AvailItinerary = { segments: [{ ...NONSTOP.segments[0]!, departTime: "23:30", arriveDate: "2027-03-11", arriveTime: "05:10" }] };
    const it = toItinerary(cfg, red, [], "fake");
    expect(it.segments[0]!.arriveDayOffset).toBe(1);
    const one = toItinerary(cfg, ONESTOP, [], "fake");
    expect(one.measuredConnections).toEqual([{ airport: "DEN", minutes: 90 }]);
  });

  test("Google Flights rows keep '?' flight numbers so no seat map is fetched for them", () => {
    const gf: Itinerary = {
      segments: [{ marketingAirline: "UA", flightNumber: "?", origin: "ORD", destination: "SFO", departLocal: "08:00", arriveLocal: "10:30", arriveDayOffset: 0, aircraft: "not expanded" }],
      totalDurationMinutes: 270,
      sourceLabel: "gf",
    };
    const a = fromGoogleItinerary(gf, "2027-03-10");
    expect(a.segments[0]!.flightNumber).toBe("?");
    expect(a.segments[0]!.buckets).toEqual([]);
  });
});

describe("Google Flights per-cabin price rows", () => {
  test("price, times and stops come from the row's own label", async () => {
    const { parseCabinPriceRows } = await import("./cabin-prices.ts");
    const html =
      '<li aria-label="From 644 US dollars. Leaves O&#39;Hare International Airport at 7:25 AM on Wednesday, March 10 and arrives at Denver International Airport at 4:29 PM on Wednesday, March 10. Layover (1 of 1) is a 1 hr 43 min layover at Omaha. Select flight"></li>' +
      '<li aria-label="From 1,024 US dollars. Leaves O&#39;Hare International Airport at 6:00 AM and arrives at Denver International Airport at 3:15 PM. Nonstop flight. Select flight"></li>' +
      '<li aria-label="From 1,024 US dollars. Leaves O&#39;Hare International Airport at 6:00 AM and arrives at Denver International Airport at 3:15 PM. Nonstop flight. Select flight"></li>';
    const rows = parseCabinPriceRows(html);
    expect(rows.map((r) => [r.price, r.departTime, r.arriveTime, r.stops])).toEqual([
      [644, "07:25", "16:29", 1],
      [1024, "06:00", "15:15", 0],
    ]);
    expect(parseCabinPriceRows("<html><body>Sorry</body></html>")).toEqual([]);
  });

  test("a list Google still collapsed is reported, never read as 'no price' (live 2026-11-24)", async () => {
    const { fetchCabinPrices } = await import("./cabin-prices.ts");
    const row =
      '<li aria-label="From 644 US dollars. Leaves O&#39;Hare International Airport at 7:25 AM and arrives at Denver International Airport at 9:05 AM. Nonstop flight. Select flight"></li>';
    let clicks = 0;
    const b: BrowserDriver = {
      open: async () => 1,
      read: async () => `<button aria-label="View more flights"></button>${row}`,
      click: async () => void clicks++,
      requests: () => 1,
    };
    const said: string[] = [];
    expect(await fetchCabinPrices(b, "ORD", "DEN", "2027-03-10", "first", "UA", (w) => said.push(w))).toHaveLength(1);
    expect(said[0]).toContain("collapsed the first list");
    expect(clicks).toBe(0); // its button ignores scripted clicks; no pretending
    const quiet: string[] = [];
    await fetchCabinPrices({ ...b, read: async () => row }, "ORD", "DEN", "2027-03-10", "first", "UA", (w) => quiet.push(w));
    expect(quiet).toEqual([]);
  });

  test("the price link is the structured all-flights search for that cabin", async () => {
    const { cabinPriceUrl } = await import("./cabin-prices.ts");
    const u = new URL(cabinPriceUrl("ORD", "DEN", "2027-03-10", "first", "United"));
    expect(u.searchParams.has("q")).toBe(false);
    expect(u.searchParams.get("tfu")).toBe("EgYIABABGAA");
    expect(cabinPriceUrl("ORD", "DEN", "2027-03-10", "first", "UA")).not.toBe(cabinPriceUrl("ORD", "DEN", "2027-03-10", "economy", "UA"));
  });

  test("Phoenix ignores daylight saving: its gap to Los Angeles flips across March", () => {
    const gap = (d: string) => minutesBetween(zonedEpoch(d, "09:00", "America/Phoenix"), zonedEpoch(d, "09:00", "America/Los_Angeles"));
    expect(gap("2027-01-15")).toBe(60);
    expect(gap("2027-07-15")).toBe(0);
  });
});
