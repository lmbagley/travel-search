/**
 * Ranking-core tests.
 *
 * Discipline: no fixed-value vanity. Time-dependent behaviour is swept across the input
 * space and asserted as invariants. The cases pinned to literal values are concrete
 * regressions: each one is a shape of input that once produced a wrong answer.
 */

import { describe, expect, test } from "bun:test";
import {
  applyHardRules,
  assertComplete,
  connectionsOf,
  inWindow,
  isMainlineOnly,
  legroomFare,
  rank,
  renderTable,
  scoreItinerary,
  seatableFare,
  toMinutes,
  type Config,
  type Itinerary,
} from "./painfulness.ts";
import { CFG, oneStop, seg } from "./test-helpers.ts";
import { to24h } from "./google-flights.ts";

const hhmm = (x: number) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;

describe("time parsing is total or throws — never silently wrong", () => {
  test("every valid HH:MM in a day maps to a strictly increasing minute count", () => {
    let prev = -1;
    for (let t = 0; t < 1440; t++) {
      const v = toMinutes(hhmm(t));
      expect(v).toBe(prev + 1);
      prev = v;
    }
    expect(prev).toBe(1439);
  });

  test("malformed and out-of-range times throw rather than coerce", () => {
    for (const bad of ["", "7:5", "25:00", "12:60", "noon", "07-25", "7:25 AM"]) {
      expect(() => toMinutes(bad)).toThrow();
    }
  });

  test("12h→24h conversion is consistent across the whole clock", () => {
    for (let h = 1; h <= 12; h++) {
      for (const ap of ["AM", "PM"] as const) {
        const expectedHour = (h % 12) + (ap === "PM" ? 12 : 0);
        expect(toMinutes(to24h(`${h}:30 ${ap}`))).toBe(expectedHour * 60 + 30);
      }
    }
    expect(to24h("12:00 AM")).toBe("00:00");
    expect(to24h("12:00 PM")).toBe("12:00");
  });

  test("inWindow handles wrap-around windows for every minute of the day", () => {
    const s = toMinutes("23:00");
    const e = toMinutes("05:00");
    for (let t = 0; t < 1440; t++) expect(inWindow(t, s, e)).toBe(t >= s || t <= e);
  });
});

describe("hard rules — swept across the clock, not one convenient value", () => {
  test("a departure is rejected iff it is before the floor or inside the redeye window", () => {
    const floor = toMinutes(CFG.painfulness.hard.depart_not_before!);
    for (let t = 0; t < 1440; t += 5) {
      const r = applyHardRules(oneStop(hhmm(t), "13:00", "14:30", "16:00"), CFG);
      const isRedeye = inWindow(t, toMinutes("23:00"), toMinutes("05:00"));
      if (isRedeye) expect(r).toContain("redeye");
      else if (t < floor) expect(r).toContain("departs-too-early");
      if (t >= floor && !isRedeye) expect(r).not.toContain("departs-too-early");
    }
  });

  test("connection floor is per-airport, and DFW is strictly stricter than the default", () => {
    const dfwFloor = CFG.painfulness.hard.min_connection_minutes_by_airport!.DFW;
    const generic = CFG.painfulness.hard.min_connection_minutes!;
    expect(dfwFloor).toBeGreaterThan(generic);
    for (const [via, floor] of [
      ["DFW", dfwFloor],
      ["PHX", CFG.painfulness.hard.min_connection_minutes_by_airport!.PHX],
      ["STL", generic], // unlisted airport falls back to the default
    ] as const) {
      for (let mins = 20; mins <= 200; mins += 5) {
        const arrive = 11 * 60;
        const it = oneStop("08:00", hhmm(arrive), hhmm(arrive + mins), "17:00", via);
        expect(applyHardRules(it, CFG).includes("connection-below-floor")).toBe(mins < floor);
      }
    }
  });

  test("an arrival on a later calendar day is always rejected, at any arrival clock time", () => {
    for (let t = 0; t < 1440; t += 15) {
      const r = applyHardRules(oneStop("14:00", "18:00", "19:30", hhmm(t), "DFW", { arriveDayOffset: 1 }), CFG);
      expect(r.includes("overnight-arrival") || r.includes("redeye")).toBe(true);
    }
  });
});

describe("scoring — relationships, not hand-typed totals", () => {
  test("arrival inside the preferred window always scores at least as well as outside it", () => {
    const inside = oneStop("08:00", "12:00", "13:45", "16:00");
    for (const late of ["19:30", "20:15", "21:00", "21:59"]) {
      expect(scoreItinerary(inside, CFG).breakdown.arrival_window).toBeGreaterThan(
        scoreItinerary(oneStop("08:00", "12:00", "13:45", late), CFG).breakdown.arrival_window,
      );
    }
  });

  test("arrival-window score decays monotonically as arrival moves away from the window", () => {
    let prev = Infinity;
    for (let t = toMinutes("19:00"); t <= toMinutes("22:00"); t += 10) {
      const s = scoreItinerary(oneStop("08:00", "12:00", "13:45", hhmm(t)), CFG).breakdown.arrival_window;
      expect(s).toBeLessThanOrEqual(prev + 1e-9);
      prev = s;
    }
  });

  test("mainline metal always outscores the identical itinerary flown by a regional", () => {
    for (const dep of ["07:00", "09:15", "11:00", "14:30"]) {
      const main = oneStop(dep, "12:00", "13:45", "16:00");
      const regional = oneStop(dep, "12:00", "13:45", "16:00", "DFW", { operatedBy: "SkyWest Airlines as American Eagle" });
      expect(scoreItinerary(main, CFG).score).toBeGreaterThan(scoreItinerary(regional, CFG).score);
      expect(isMainlineOnly(main)).toBe(true);
      expect(isMainlineOnly(regional)).toBe(false);
    }
  });

  test("a barely-legal connection never outranks a comfortable one, all else equal", () => {
    const tight = oneStop("08:00", "12:00", "13:02", "16:00", "PHX");
    const comfy = oneStop("08:00", "12:00", "13:45", "16:00", "PHX");
    expect(scoreItinerary(comfy, CFG).score).toBeGreaterThan(scoreItinerary(tight, CFG).score);
  });

  test("total duration breaks ties: with all else equal, shorter always ranks higher", () => {
    // Swept: every pair of durations from 4h to 16h in 20-minute steps.
    for (let a = 240; a <= 960; a += 20) {
      for (let b = a + 20; b <= 960; b += 60) {
        const short = { ...oneStop("08:00", "11:00", "12:30", "16:00"), totalDurationMinutes: a };
        const long = { ...oneStop("08:00", "11:00", "12:30", "16:00"), totalDurationMinutes: b };
        const [first, second] = rank([long, short], CFG);
        expect(first.itinerary).toBe(short);
        expect(first.breakdown.total_duration).toBe(10);
        expect(second.breakdown.total_duration).toBeLessThan(10);
        expect(second.breakdown.total_duration).toBeGreaterThan(0);
      }
    }
  });

  /**
   * Regression: the duration term compared
   * each trip to the LONGEST offered, so every trip scored full marks and the AS68/AS123
   * one-stop via SEA (15h25, dep 07:00) outranked the JL57 nonstop (11h10, dep 11:50) on
   * a 20-minute departure-window miss.
   */
  test("an 11h10 nonstop outranks a 15h25 one-stop that only wins on departure time", () => {
    const nonstop: Itinerary = {
      segments: [seg({ marketingAirline: "JL", flightNumber: "57", origin: "SEA", destination: "NRT", departLocal: "11:50", arriveLocal: "16:00", arriveDayOffset: 1 })],
      totalDurationMinutes: 670,
      sourceLabel: "seats.aero jal",
    };
    const oneStopSea: Itinerary = {
      segments: [
        seg({ marketingAirline: "AS", flightNumber: "68", origin: "SEA", destination: "SEA", departLocal: "07:00", arriveLocal: "09:10" }),
        seg({ marketingAirline: "AS", flightNumber: "123", origin: "SEA", destination: "NRT", departLocal: "11:55", arriveLocal: "15:25", arriveDayOffset: 1 }),
      ],
      totalDurationMinutes: 925,
      sourceLabel: "seats.aero alaska",
    };
    const longHaul: Config = JSON.parse(JSON.stringify(CFG));
    longHaul.painfulness.hard.reject_overnight_arrival = false;
    expect(rank([oneStopSea, nonstop], longHaul)[0].itinerary).toBe(nonstop);
  });

  test("rank never places a rejected itinerary above an eligible one", () => {
    const pool = [
      oneStop("23:30", "05:00", "06:30", "08:59", "DFW", { arriveDayOffset: 1 }),
      oneStop("07:25", "13:07", "14:50", "16:29", "DFW"),
      oneStop("05:33", "09:00", "10:01", "13:29", "PHX"),
      oneStop("15:46", "19:00", "20:00", "23:44", "PHX"),
    ];
    const ranked = rank(pool, CFG);
    const firstRejected = ranked.findIndex((v) => v.rejected.length > 0);
    const lastEligible = ranked.map((v) => v.rejected.length === 0).lastIndexOf(true);
    expect(firstRejected).toBeGreaterThan(lastEligible);
  });
});

describe("regressions — concrete cases that once went wrong", () => {
  /**
   * Google Flights once published "5 results returned" while rendering
   * 4. The hidden 5th was STL 06:00 → SEA 09:38 with a 35-minute PHX connection — the
   * option that most violated the model was the one the page concealed.
   */
  test("the concealed 35-minute PHX connection rejects on the connection floor", () => {
    const concealed = oneStop("06:00", "07:20", "07:55", "09:38", "PHX", {
      operatedBy: "SkyWest Airlines as American Eagle",
      duration: 338,
    });
    const reasons = applyHardRules(concealed, CFG);
    expect(reasons).toContain("connection-below-floor");
    expect(reasons).toContain("departs-too-early");
  });

  /** Least painful beats fastest. The 5h58m PHX option lands 23:44. */
  test("shortest total duration does not win when it arrives at 23:44", () => {
    const viaDfw = oneStop("07:25", "13:07", "14:50", "16:29", "DFW", { duration: 424 });
    const viaPhxFast = oneStop("15:46", "18:46", "19:46", "23:44", "PHX", { duration: 358 });
    const ranked = rank([viaPhxFast, viaDfw], CFG);
    expect(ranked[0].itinerary.totalDurationMinutes).toBe(424);
    expect(ranked[1].rejected).toContain("arrives-too-late");
  });
});

describe("earlier-in-window arrival gradient", () => {
  /**
   * Two options: SEA 06:00 → PHL (62m) → BDL 16:54, and the rule-clean
   * SEA 07:00 → PHL (2h) → BDL 18:52. A traveler who values getting in ~2h earlier will
   * accept the early start and the tight-but-valid connection. A flat window scores both
   * arrivals the same; earlier_gradient exists so the model can express that preference.
   */
  const GCFG: Config = JSON.parse(JSON.stringify(CFG));
  GCFG.painfulness.hard.depart_not_before = "06:00";
  GCFG.painfulness.hard.min_connection_minutes_by_airport!.PHL = 60;
  (GCFG.painfulness.scored.arrival_window as Record<string, unknown>).earlier_gradient = 0.7;

  const earlier: Itinerary = {
    segments: [
      seg({ flightNumber: "4161", origin: "SEA", destination: "PHL", departLocal: "06:00", arriveLocal: "14:33" }),
      seg({
        flightNumber: "6083",
        origin: "PHL",
        destination: "BDL",
        departLocal: "15:35",
        arriveLocal: "16:54",
        aircraft: "Canadair RJ 700",
        operatedBy: "PSA Airlines as American Eagle",
      }),
    ],
    totalDurationMinutes: 474,
    sourceLabel: "GF SEA→BDL",
  };
  const ruleClean: Itinerary = {
    segments: [
      seg({ flightNumber: "4722", origin: "SEA", destination: "PHL", departLocal: "07:00", arriveLocal: "15:30" }),
      seg({
        flightNumber: "6467",
        origin: "PHL",
        destination: "BDL",
        departLocal: "17:30",
        arriveLocal: "18:52",
        aircraft: "Canadair RJ 900",
        operatedBy: "PSA Airlines as American Eagle",
      }),
    ],
    totalDurationMinutes: 532,
    sourceLabel: "GF SEA→BDL",
  };

  test("the earlier itinerary is eligible and outranks the rule-clean one", () => {
    expect(applyHardRules(earlier, GCFG)).toEqual([]);
    const shortest = Math.min(earlier.totalDurationMinutes, ruleClean.totalDurationMinutes);
    expect(scoreItinerary(earlier, GCFG, shortest).score).toBeGreaterThan(scoreItinerary(ruleClean, GCFG, shortest).score);
    // and through rank(), which computes the fleet minimum itself
    expect(rank([ruleClean, earlier], GCFG)[0].itinerary).toBe(earlier);
  });

  test("gradient absent reproduces the flat window — two in-window arrivals tie", () => {
    const early = scoreItinerary(oneStop("08:00", "12:00", "13:00", "14:00"), CFG).breakdown.arrival_window;
    const late = scoreItinerary(oneStop("08:00", "12:00", "13:00", "18:00"), CFG).breakdown.arrival_window;
    expect(early).toBe(late);
  });

  test("with the gradient on, arrival score strictly decreases across the window and past it", () => {
    let prev = Infinity;
    for (let t = toMinutes("13:00"); t <= toMinutes("21:50"); t += 10) {
      const s = scoreItinerary(oneStop("08:00", "11:00", "12:00", hhmm(t)), GCFG).breakdown.arrival_window;
      expect(s).toBeLessThan(prev);
      expect(s).toBeGreaterThanOrEqual(0);
      prev = s;
    }
  });

  test("a just-outside arrival never outscores a just-inside one", () => {
    const inside = scoreItinerary(oneStop("08:00", "11:00", "12:00", "18:59"), GCFG).breakdown.arrival_window;
    for (const late of ["19:01", "19:30", "20:15", "21:59"]) {
      expect(scoreItinerary(oneStop("08:00", "11:00", "12:00", late), GCFG).breakdown.arrival_window).toBeLessThan(inside);
    }
  });

  test("an absurd gradient clamps to 1 instead of going negative", () => {
    const XCFG: Config = JSON.parse(JSON.stringify(GCFG));
    (XCFG.painfulness.scored.arrival_window as Record<string, unknown>).earlier_gradient = 5;
    expect(scoreItinerary(oneStop("08:00", "11:00", "12:00", "18:59"), XCFG).breakdown.arrival_window).toBeGreaterThanOrEqual(0);
  });
});

describe("fare-brand gate — a pick you cannot sit in is a wrong answer", () => {
  /** Regression: headline $319 was Basic Economy; Main Cabin $369 was the cheapest seatable fare. */
  const withBasic: Itinerary = {
    ...oneStop("09:50", "11:36", "13:15", "14:54", "DFW"),
    priceFrom: 319,
    fares: [
      { brand: "Basic Economy", price: 319, freeSeatSelection: false, extraLegroomIncluded: false },
      { brand: "Main Cabin", price: 369, freeSeatSelection: true, extraLegroomIncluded: false },
      { brand: "Main Plus", price: 439, freeSeatSelection: true, extraLegroomIncluded: true },
    ],
  };

  test("seatableFare skips Basic Economy and returns the cheapest choosable brand", () => {
    expect(seatableFare(withBasic)?.brand).toBe("Main Cabin");
    expect(seatableFare(withBasic)!.price).toBeGreaterThan(withBasic.priceFrom!);
  });

  test("legroomFare returns the cheapest brand that includes extra legroom", () => {
    expect(legroomFare(withBasic)?.brand).toBe("Main Plus");
  });

  test("an absent fare ladder reports unknown rather than assuming the headline is fine", () => {
    const noFares = oneStop("09:50", "11:36", "13:15", "14:54", "DFW");
    expect(seatableFare(noFares)).toBeNull();
    expect(legroomFare(noFares)).toBeNull();
  });

  test("ladder order does not matter — cheapest seatable wins regardless", () => {
    expect(seatableFare({ ...withBasic, fares: [...withBasic.fares!].reverse() })?.price).toBe(369);
  });
});

describe("completeness assertion", () => {
  test("parsed below published is never complete; at-or-above always is", () => {
    for (let claimed = 0; claimed <= 12; claimed++) {
      for (let parsed = 0; parsed <= 12; parsed++) {
        expect(assertComplete(parsed, claimed).complete).toBe(parsed >= claimed);
      }
    }
  });

  test("a missing published count is NOT complete", () => {
    expect(assertComplete(50, null).complete).toBe(false);
    expect(assertComplete(50, undefined).complete).toBe(false);
    expect(assertComplete(50, null).reason).toContain("cannot be asserted");
  });

  test("a 4-parsed-of-5-published truncation fails the gate", () => {
    const g = assertComplete(4, 5);
    expect(g.complete).toBe(false);
    expect(g.reason).toContain("View more flights");
  });
});

describe("anti-fabrication", () => {
  test("no exported symbol in any module can produce a seat or exit-row number", async () => {
    // Positive control first: the probe must be able to see a symbol it is looking for.
    const control = Object.keys({ exitRowNumber: 1 }).join(" ").toLowerCase();
    expect(control).toContain("exitrow");
    const mods = await Promise.all(
      ["./painfulness.ts", "./google-flights.ts", "./seats-aero.ts", "./config.ts", "./secrets.ts"].map((m) => import(m)),
    );
    const surface = mods.flatMap((m) => Object.keys(m)).join(" ").toLowerCase();
    expect(surface.length).toBeGreaterThan(100);
    for (const banned of ["exitrow", "seatnumber", "seatrow", "rownumber"]) expect(surface).not.toContain(banned);
  });

  test("connectionsOf derives layovers from real segment times", () => {
    const c = connectionsOf(oneStop("07:25", "13:07", "14:50", "16:29", "DFW"));
    expect(c).toEqual([{ airport: "DFW", minutes: 103 }]);
  });
});

describe("rendering", () => {
  test("the loyalty column label comes from config and defaults to Prog", () => {
    const v = rank([oneStop("07:25", "13:07", "14:50", "16:29")], CFG);
    expect(renderTable(v, CFG).split("\n")[0]).toContain("Prog Score");
    const mm: Config = { ...CFG, output: { loyalty_label: "MM" } };
    expect(renderTable(v, mm).split("\n")[0]).toContain("Price  MM  Score");
  });
});
