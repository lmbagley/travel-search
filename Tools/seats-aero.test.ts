/**
 * seats.aero client tests. Fixtures are trimmed real API responses (public award-cache
 * data). In the search fixture, every record's JMileageCost was overwritten with
 * "1" and JAirlines with "ZZ", so any code that reads record headers instead of trips
 * fails loudly.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHardRules, connectionsOf, rank } from "./painfulness.ts";
import {
  attachSegments,
  awardTripToItinerary,
  buildSearchParams,
  localWallClock,
  renderAwardTable,
  searchAwards,
  sortByCost,
  tripsFromRecords,
  type AwardTrip,
} from "./seats-aero.ts";
import { redact, resolveSecret } from "./secrets.ts";
import { CFG } from "./test-helpers.ts";

const fx = (n: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", n), "utf8"));
const SEARCH = fx("seats-aero-search.json");
const TRIPS = fx("seats-aero-trips.json");
const NOW = Date.parse("2026-12-01T00:00:00Z");
const KEY = "pro_TESTKEY_0123456789abcdef";
const noSleep = async () => {};

type Call = { path: string; params: Record<string, string>; headers: Record<string, string> };

/** A fake fetch that records every call and answers from a handler. */
function fakeFetch(handler: (c: Call) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    const c: Call = {
      path: u.pathname.replace("/partnerapi", ""),
      params: Object.fromEntries(u.searchParams),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(c);
    const r = handler(c);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("pagination — cursor from the FIRST response, skip = rows already retrieved", () => {
  test("three pages send cursor unchanged and skip = cumulative row count", async () => {
    const pages = [
      { data: [{ ID: "a" }, { ID: "b" }, { ID: "c" }], hasMore: true, cursor: 111 },
      { data: [{ ID: "d" }, { ID: "e" }], hasMore: true, cursor: 999 }, // a later cursor must be ignored
      { data: [{ ID: "f" }], hasMore: false, cursor: 999 },
    ];
    let i = 0;
    const { f, calls } = fakeFetch(() => ({ body: pages[i++] }));
    const res = await searchAwards(
      { origin: "sfo", destination: "nrt", startDate: "2027-02-01", endDate: "2027-02-03", maxPages: 10 },
      { apiKey: KEY, fetchImpl: f, sleepMs: noSleep, now: () => NOW },
    );
    expect(calls.length).toBe(3);
    expect(calls[0].params.cursor).toBeUndefined();
    expect(calls[0].params.skip).toBeUndefined();
    expect(calls[1].params).toMatchObject({ cursor: "111", skip: "3" });
    expect(calls[2].params).toMatchObject({ cursor: "111", skip: "5" });
    expect(res.records).toBe(6);
    expect(res.complete).toBe(true);
  });

  test("the page bound is decided up front; hitting it with more waiting is INCOMPLETE", async () => {
    for (let bound = 1; bound <= 4; bound++) {
      const { f, calls } = fakeFetch(() => ({ body: { data: [{ ID: "x" }], hasMore: true, cursor: 5 } }));
      const res = await searchAwards(
        { origin: "SFO", destination: "NRT", startDate: "2027-02-01", endDate: "2027-02-01", maxPages: bound },
        { apiKey: KEY, fetchImpl: f, sleepMs: noSleep },
      );
      expect(calls.length).toBe(bound);
      expect(res.complete).toBe(false);
      expect(res.incompleteReason).toContain(`${bound}-page bound`);
    }
  });

  test("hasMore without a cursor is an error, not a silent stop", async () => {
    const { f } = fakeFetch(() => ({ body: { data: [{ ID: "x" }], hasMore: true } }));
    await expect(
      searchAwards(
        { origin: "SFO", destination: "NRT", startDate: "2027-02-01", endDate: "2027-02-01", maxPages: 3 },
        { apiKey: KEY, fetchImpl: f, sleepMs: noSleep },
      ),
    ).rejects.toThrow(/no cursor/);
  });

  test("every search asks for trip-level rows and sends the key in the documented header", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { data: [], hasMore: false } }));
    await searchAwards(
      { origin: "SFO", destination: "NRT", startDate: "2027-02-01", endDate: "2027-02-01" },
      { apiKey: KEY, fetchImpl: f, sleepMs: noSleep },
    );
    expect(calls[0].params.include_trips).toBe("true");
    expect(calls[0].headers["Partner-Authorization"]).toBe(KEY);
  });

  test("bad dates are refused before any call", async () => {
    const { f, calls } = fakeFetch(() => ({ body: {} }));
    for (const [s, e] of [
      ["2027-2-1", "2027-02-01"],
      ["2027-02-05", "2027-02-01"],
    ]) {
      await expect(
        searchAwards({ origin: "SFO", destination: "NRT", startDate: s, endDate: e }, { apiKey: KEY, fetchImpl: f }),
      ).rejects.toThrow();
    }
    expect(calls.length).toBe(0);
  });

  test("query params: cabins/sources/carriers join with commas; take is clamped to 10..1000", () => {
    const p = buildSearchParams({
      origin: "sfo,lax",
      destination: "nrt",
      startDate: "2027-02-01",
      endDate: "2027-02-02",
      cabins: ["business", "first"],
      sources: ["aeroplan", "united"],
      carriers: ["nh", "jl"],
      directOnly: true,
      take: 5,
    });
    expect(p).toMatchObject({
      origin_airport: "SFO,LAX",
      cabins: "business,first",
      sources: "aeroplan,united",
      carriers: "NH,JL",
      only_direct_flights: "true",
      take: "10",
    });
    expect(buildSearchParams({ origin: "a", destination: "b", startDate: "x", endDate: "y", take: 5000 }).take).toBe("1000");
  });
});

describe("trip rows come from AvailabilityTrips, never record headers", () => {
  const trips = tripsFromRecords(SEARCH.data, NOW);

  test("every trip in the fixture becomes exactly one row", () => {
    const expected = SEARCH.data.reduce((n: number, r: any) => n + r.AvailabilityTrips.length, 0);
    expect(trips.length).toBe(expected);
  });

  test("the poisoned header values (JMileageCost '1', JAirlines 'ZZ') never appear in a row", () => {
    expect(trips.every((t) => t.miles > 1000)).toBe(true);
    expect(trips.some((t) => t.carriers.includes("ZZ"))).toBe(false);
  });

  test("taxes are converted from cents: 560 → 5.60, 125400 → 1254.00", () => {
    for (const rec of SEARCH.data) {
      for (const raw of rec.AvailabilityTrips) {
        const row = trips.find((t) => t.tripId === raw.ID)!;
        expect(row.taxes).toBeCloseTo(raw.TotalTaxes / 100, 10);
      }
    }
    expect(trips.find((t) => t.flightNumbers.join() === "AS68,AS123")!.taxes).toBe(5.6);
  });

  test("times stay airport-local wall clock — the Z suffix is not UTC", () => {
    const jl = trips.find((t) => t.flightNumbers.join() === "JL57")!;
    expect(jl.departLocal).toBe("2027-02-01T11:50");
    expect(jl.arriveLocal).toBe("2027-02-02T16:00");
    // Sweep every hour: the conversion is a pure string slice, whatever the machine's TZ.
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, "0");
      expect(localWallClock(`2027-03-14T${hh}:30:00Z`)).toBe(`2027-03-14T${hh}:30`);
    }
    expect(() => localWallClock("garbage")).toThrow();
  });

  test("data age is measured from each trip's UpdatedAt", () => {
    for (const t of trips) {
      expect(t.ageHours).toBeCloseTo((NOW - Date.parse(t.updatedAt)) / 3_600_000, 6);
      expect(t.ageHours).toBeGreaterThanOrEqual(0);
    }
  });

  test("a cabin filter drops trips in other cabins", () => {
    expect(tripsFromRecords(SEARCH.data, NOW, ["first"]).length).toBe(0);
    expect(tripsFromRecords(SEARCH.data, NOW, ["business"]).length).toBe(trips.length);
  });

  test("cached search carries no segments — leg detail is never invented", () => {
    expect(trips.every((t) => t.segments.length === 0)).toBe(true);
  });

  test("sortByCost orders by miles, then taxes", () => {
    const s = sortByCost(trips);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].miles > s[i - 1].miles || (s[i].miles === s[i - 1].miles && s[i].taxes >= s[i - 1].taxes)).toBe(true);
    }
  });

  test("the table flags stale rows and renders every trip", () => {
    const out = renderAwardTable(trips, 1);
    expect(out.split("\n").length).toBe(trips.length + 2);
    expect(out).toContain("STALE");
    expect(out).toContain("$5.60");
  });
});

describe("leg detail from GET /trips/{availabilityId}", () => {
  test("attachSegments joins by trip ID, fetches each record once, and keeps the booking link", async () => {
    const trips = tripsFromRecords(SEARCH.data, NOW);
    const target = trips.find((t) => t.flightNumbers.join() === "AS68,AS123")!;
    const { f, calls } = fakeFetch((c) =>
      c.path === `/trips/${target.availabilityId}` ? { body: TRIPS } : { body: { data: [] } },
    );
    const r = await attachSegments(trips, { apiKey: KEY, fetchImpl: f, sleepMs: noSleep }, 100);
    const distinct = new Set(trips.map((t) => t.availabilityId)).size;
    expect(calls.length).toBe(distinct);
    expect(r.calls).toBe(distinct);
    expect(target.segments.map((s) => s.flightNumber)).toEqual(["AS68", "AS123"]);
    expect(target.bookingLink).toContain("alaskaair.com");
    expect(r.detailed).toBe(1);
  });

  test("the call budget is respected", async () => {
    const trips = tripsFromRecords(SEARCH.data, NOW);
    for (const budget of [0, 1, 2]) {
      const { f, calls } = fakeFetch(() => ({ body: { data: [] } }));
      await attachSegments(trips, { apiKey: KEY, fetchImpl: f, sleepMs: noSleep }, budget);
      expect(calls.length).toBe(budget);
    }
  });
});

describe("awards through the painfulness model", () => {
  const withSegs = (): AwardTrip => {
    const t = tripsFromRecords(SEARCH.data, NOW).find((x) => x.flightNumbers.join() === "AS68,AS123")!;
    const full = TRIPS.data.find((x: any) => x.ID === t.tripId);
    t.segments = full.AvailabilitySegments.map((s: any) => ({
      flightNumber: s.FlightNumber,
      origin: s.OriginAirport,
      destination: s.DestinationAirport,
      departLocal: localWallClock(s.DepartsAt),
      arriveLocal: localWallClock(s.ArrivesAt),
      aircraft: s.AircraftName,
      fareClass: s.FareClass,
    }));
    return t;
  };

  test("connection minutes come from same-airport wall clocks; duration comes from the API", () => {
    const t = withSegs();
    const it = awardTripToItinerary(t)!;
    const conns = connectionsOf(it);
    expect(conns.length).toBe(1);
    expect(conns[0].airport).toBe(t.segments[0].destination);
    const arr = t.segments[0].arriveLocal;
    const dep = t.segments[1].departLocal;
    const expected = (Date.parse(dep + ":00Z") - Date.parse(arr + ":00Z")) / 60000;
    expect(conns[0].minutes).toBe(expected);
    expect(it.totalDurationMinutes).toBe(t.durationMinutes);
    expect(it.segments[0].marketingAirline).toBe("AS");
    expect(it.segments[0].flightNumber).toBe("68");
  });

  test("a next-day arrival carries a day offset, so the overnight rule can see it", () => {
    const it = awardTripToItinerary(withSegs())!;
    expect(it.segments[it.segments.length - 1].arriveDayOffset).toBeGreaterThanOrEqual(1);
    expect(applyHardRules(it, CFG)).toContain("overnight-arrival");
  });

  test("a connecting trip with no leg detail is NOT rankable — never a fake nonstop", () => {
    const bare = tripsFromRecords(SEARCH.data, NOW).filter((t) => t.stops > 0);
    expect(bare.length).toBeGreaterThan(0);
    for (const t of bare) expect(awardTripToItinerary(t)).toBeNull();
  });

  test("a nonstop needs no leg detail and ranks", () => {
    const nonstops = tripsFromRecords(SEARCH.data, NOW).filter((t) => t.stops === 0);
    expect(nonstops.length).toBeGreaterThan(0);
    const its = nonstops.map(awardTripToItinerary);
    expect(its.every((x) => x !== null)).toBe(true);
    expect(rank(its as any, CFG).length).toBe(nonstops.length);
  });

  test("two-character designators with a digit split correctly (B6123 → B6 / 123)", () => {
    const t = withSegs();
    t.segments = t.segments.map((s, i) => ({ ...s, flightNumber: i === 0 ? "B6123" : "9W1" }));
    const it = awardTripToItinerary(t)!;
    expect(it.segments[0].marketingAirline).toBe("B6");
    expect(it.segments[0].flightNumber).toBe("123");
    expect(it.segments[1].marketingAirline).toBe("9W");
  });
});

describe("the API key never leaks", () => {
  test("an error body that echoes the key is redacted, and 401 gets a named hint", async () => {
    const { f } = fakeFetch(() => ({ status: 401, body: `{"error":"user_subscription_expired","key":"${KEY}"}` }));
    try {
      await searchAwards(
        { origin: "SFO", destination: "NRT", startDate: "2027-02-01", endDate: "2027-02-01" },
        { apiKey: KEY, fetchImpl: f },
      );
      throw new Error("should have thrown");
    } catch (e) {
      const msg = String((e as Error).message) + String((e as Error).stack);
      expect(msg).not.toContain(KEY);
      expect(msg).toContain("<REDACTED>");
      expect(msg).toContain("subscription");
    }
  });

  test("a network error that mentions the key is redacted too", async () => {
    const f = (async () => {
      throw new Error(`connect failed for header ${KEY}`);
    }) as unknown as typeof fetch;
    await expect(
      searchAwards(
        { origin: "SFO", destination: "NRT", startDate: "2027-02-01", endDate: "2027-02-01" },
        { apiKey: KEY, fetchImpl: f },
      ),
    ).rejects.toThrow(/<REDACTED>/);
  });

  test("redact: positive control and short-secret guard", () => {
    expect(redact(`a ${KEY} b ${KEY}`, KEY)).toBe("a <REDACTED> b <REDACTED>");
    expect(redact("abc", "ab")).toBe("abc");
  });
});

describe("secret references", () => {
  const dir = mkdtempSync(join(tmpdir(), "travel-search-test-"));

  test("env: reads the variable; a missing one is a named error", async () => {
    process.env.TS_TEST_KEY = "  value-from-env  ";
    expect((await resolveSecret("env:TS_TEST_KEY")).value).toBe("value-from-env");
    delete process.env.TS_TEST_KEY;
    await expect(resolveSecret("env:TS_TEST_KEY")).rejects.toThrow(/TS_TEST_KEY is not set/);
  });

  test("a file path is read and trimmed; loose permissions produce a warning", async () => {
    const p = join(dir, "key");
    writeFileSync(p, "file-key\n");
    chmodSync(p, 0o600);
    const tight = await resolveSecret(p);
    expect(tight.value).toBe("file-key");
    expect(tight.warning).toBeUndefined();
    chmodSync(p, 0o644);
    expect((await resolveSecret(p)).warning).toContain("chmod 600");
  });

  test("a missing or empty file is an error, never an empty key", async () => {
    await expect(resolveSecret(join(dir, "nope"))).rejects.toThrow(/no key file/);
    const e = join(dir, "empty");
    writeFileSync(e, "\n");
    await expect(resolveSecret(e)).rejects.toThrow(/empty/);
  });
});
