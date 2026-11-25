/**
 * Seat ladder and seat-map checks. Every flight, seat and row here is made up.
 *
 * Regressions this suite pins, and where:
 *   - "blocked seat shown as a top pick"                    -> "blocked seats are listed but never bookable"
 *                                                             and decide.test.ts "a seat's state is never hidden"
 *   - "status assumed to unlock blocked seats"              -> "no status makes a blocked seat bookable"
 *   - "unknown exit rows promoted a seat"                  -> "missing row data never promotes a seat"
 *   - "four ticketed seats decode to their rungs"          -> "every rung decodes" (a sweep, not four hand-picked seats)
 */

import { describe, expect, test } from "bun:test";
import { checkSeatMap, derivePositions, type CheckedSeat } from "./seatmap.ts";
import type { SeatMapRequest } from "./seatmap-api.ts";
import { ladderTier, legSeatReality, noAcceptableSeat, rankSitable, seatToken, tierForSeatId } from "./seats.ts";
import { CFG } from "./test-helpers.ts";
import type { Config } from "./painfulness.ts";

const REQ: SeatMapRequest = { airline: "UA", flightNumber: "1234", origin: "ORD", destination: "DEN", date: "2027-03-10", cabin: "Y" };

// A 3-3 cabin drawn with an aisle gap between C and D.
const X: Record<string, number> = { A: 100, B: 160, C: 220, D: 400, E: 460, F: 520 };

const cfg: Config = {
  ...CFG,
  seating: {
    preference_order: ["exit_row_aisle", "exit_row_window", "extra_legroom_aisle", "extra_legroom_window"],
    want_open_middle: true,
    extra_legroom_bulkhead_preferred: true,
  },
  seat_data: { UA: { "739": { exit_rows: [20, 21], extra_legroom_rows: [7, 8, 20, 21], bulkhead_rows: [7] } } },
};

/** Seats you name get those states; every other seat in the same rows is drawn occupied,
 *  so geometry (and so window/aisle/middle) is a full 3-3 row, as on a real map. */
function map(states: Record<string, string>, c: Config = cfg, code = "739") {
  const all: Record<string, string> = {};
  for (const id of Object.keys(states)) for (const l of "ABCDEF") all[`${id.slice(0, -1)}${l}`] = "occupied";
  Object.assign(all, states);
  const seats = Object.entries(all).map(([id, state]) => ({ id, state, x: X[id.slice(-1)]! }));
  return checkSeatMap({ request: REQ, aircraftName: "Boeing 737-900", aircraftCode: code, seats }, REQ, "test");
}

describe("seat-map checks", () => {
  test("positions are derived from drawing geometry when the source omits them", () => {
    const m = map({ "12A": "available", "12B": "available", "12C": "available", "12D": "available", "12E": "available", "12F": "available" });
    const pos = Object.fromEntries(m.seats.map((s) => [s.id, s.position]));
    expect(pos).toEqual({ "12A": "window", "12B": "middle", "12C": "aisle", "12D": "aisle", "12E": "middle", "12F": "window" });
  });

  test("a 2-2 row and a lone seat both classify", () => {
    const seats = [
      { id: "3A", state: "available", x: 10 },
      { id: "3B", state: "available", x: 60 },
      { id: "3C", state: "available", x: 200 },
      { id: "3D", state: "available", x: 250 },
      { id: "4A", state: "available", x: 10 },
    ] as const;
    const m = checkSeatMap({ request: REQ, aircraftName: "x", aircraftCode: "x", seats: [...seats] }, REQ, "t");
    expect(m.seats.map((s) => s.position)).toEqual(["window", "aisle", "aisle", "window", "window"]);
  });

  test("a position the source gave is kept, not re-derived", () => {
    const m = checkSeatMap(
      { request: REQ, aircraftName: "x", aircraftCode: "x", seats: [{ id: "5A", state: "available", position: "aisle" }] },
      REQ,
      "t",
    );
    expect(m.seats[0]!.position).toBe("aisle");
  });

  test("zero seats is rejected, never ranked", () => {
    expect(() => checkSeatMap({ request: REQ, aircraftName: "x", aircraftCode: "739", seats: [] }, REQ, "src")).toThrow(/zero seats/);
  });

  test("an unknown seat state is rejected with the seat named", () => {
    expect(() => map({ "12A": "reserved-for-crew" })).toThrow(/seat 12A has state "reserved-for-crew"/);
  });

  test("a seat with neither position nor x is rejected", () => {
    expect(() =>
      checkSeatMap({ request: REQ, aircraftName: "x", aircraftCode: "x", seats: [{ id: "5A", state: "available" }] }, REQ, "t"),
    ).toThrow(/neither a position nor an x/);
  });

  test("bad and duplicate seat ids are rejected", () => {
    expect(() => map({ "A12": "available" })).toThrow(/bad seat id/);
    expect(() =>
      checkSeatMap(
        { request: REQ, aircraftName: "x", aircraftCode: "x", seats: [{ id: "5A", state: "available", x: 1 }, { id: "5a", state: "occupied", x: 1 }] },
        REQ,
        "t",
      ),
    ).toThrow(/appears twice/);
  });

  test("missing aircraft code is rejected", () => {
    expect(() => checkSeatMap({ request: REQ, aircraftName: "x", seats: [{ id: "5A", state: "available", x: 1 }] }, REQ, "t")).toThrow(/aircraftCode/);
  });

  test("a short row keeps its columns: a missing F seat does not make E a window (live A321, 2026-11-24)", () => {
    const seats = [
      ...["9", "11"].flatMap((r) => "ABCDEF".split("").map((l) => ({ id: `${r}${l}`, state: "occupied", x: X[l]! }))),
      ...("ABCDE".split("").map((l) => ({ id: `10${l}`, state: "available", x: X[l]! }))),
    ];
    const m = checkSeatMap({ request: REQ, aircraftName: "x", aircraftCode: "321", seats }, REQ, "t");
    const pos = Object.fromEntries(m.seats.map((s) => [s.id, s.position]));
    expect([pos["10A"], pos["10B"], pos["10C"], pos["10D"], pos["10E"]]).toEqual(["window", "middle", "aisle", "aisle", "middle"]);
    for (const l of "ABCDEF") expect(new Set(m.seats.filter((s) => s.letter === l).map((s) => s.position)).size).toBe(1);
  });

  test("zero-padded seat ids are read as the airline prints them, and count as the same seat", () => {
    const m = checkSeatMap({ request: REQ, aircraftName: "x", aircraftCode: "321", seats: [{ id: "08C", state: "available", x: 1 }, { id: "8D", state: "available", x: 9 }] }, REQ, "t");
    expect(m.seats.map((s) => s.id)).toEqual(["8C", "8D"]);
    expect(() => checkSeatMap({ request: REQ, aircraftName: "x", aircraftCode: "321", seats: [{ id: "08C", state: "available", x: 1 }, { id: "8C", state: "available", x: 1 }] }, REQ, "t")).toThrow(/8C appears twice/);
  });

  test("derivePositions leaves given positions alone", () => {
    const seats: CheckedSeat[] = [{ id: "1A", row: 1, letter: "A", state: "available", position: "middle" }];
    derivePositions(seats, [{ id: "1A", state: "available", position: "middle" }]);
    expect(seats[0]!.position).toBe("middle");
  });
});

describe("the ladder", () => {
  const states = { "20A": "available", "20B": "available", "20C": "blocked", "20D": "occupied", "21C": "available", "21B": "occupied" };

  test("blocked seats are listed but never bookable", () => {
    const r = legSeatReality(cfg, map(states));
    const blocked = r.sitable.find((s) => s.id === "20C")!;
    expect(blocked.bookable).toBe(false);
    expect(r.sitable.map((s) => s.id)).not.toContain("20D"); // occupied: counted, not listed
    for (const s of r.sitable) expect(s.bookable).toBe(s.state === "available");
    expect([r.open, r.occupied, r.blocked]).toEqual([3, 8, 1]);
  });

  test("no status makes a blocked seat bookable", () => {
    for (const status of [undefined, "1K", "Global Services", "top-tier"]) {
      const c: Config = { ...cfg, traveler: { programs: [{ airline: "UA", status }] } };
      expect(legSeatReality(c, map(states)).sitable.find((s) => s.id === "20C")!.bookable).toBe(false);
    }
  });

  test("your own seat's rung is found whatever its state", () => {
    const m = map(states);
    expect(tierForSeatId(cfg, m, "20D")).toBe(0); // exit row aisle, shown occupied because you hold it
    expect(tierForSeatId(cfg, m, " 20d ")).toBe(0);
    expect(tierForSeatId(cfg, m, "99Z")).toBe(-1);
  });

  test("exit rows come from seat_data; missing data reads UNKNOWN", () => {
    const r = legSeatReality(cfg, map(states));
    expect(r.exitRowsKnown).toBe(true);
    expect(r.sitable.find((s) => s.id === "20C")!.exitRow).toBe(true);
    const none = legSeatReality(cfg, map(states, cfg, "320")); // no seat_data for this aircraft
    expect(none.exitRowsKnown).toBe(false);
    expect(none.extraLegroomRowsKnown).toBe(false);
    expect(none.sitable.find((s) => s.id === "20C")!.exitRow).toBe("unknown");
  });

  test("missing row data never promotes a seat", () => {
    const none = legSeatReality(cfg, map(states, cfg, "320"));
    expect(none.sitable.every((s) => s.tier === -1)).toBe(true);
    expect(noAcceptableSeat(none.sitable)).toBe(true);
    expect(noAcceptableSeat(legSeatReality(cfg, map(states)).sitable)).toBe(false);
  });

  test("a blocked seat on a good rung does not count as acceptable", () => {
    const r = legSeatReality(cfg, map({ "20C": "blocked", "20B": "available", "20D": "occupied" }));
    expect(r.sitable.some((s) => s.tier >= 0)).toBe(true);
    expect(noAcceptableSeat(r.sitable)).toBe(true);
  });

  test("extra-legroom aisle outranks window; bulkhead first inside the rung", () => {
    const r = legSeatReality(cfg, map({ "8C": "available", "7C": "available", "7A": "available", "9B": "available" }));
    expect(r.sitable.map((s) => s.id)).toEqual(["7C", "8C", "7A", "9B"]);
    expect(r.sitable[0]!.tier).toBe(2);
    expect(r.sitable[2]!.tier).toBe(3);
    expect(r.sitable[3]!.tier).toBe(-1); // middle in a plain row
  });

  test("an available seat sorts before a blocked one on the same rung", () => {
    const r = legSeatReality(cfg, map({ "20C": "blocked", "21D": "available" }));
    expect(r.sitable.map((s) => s.id)).toEqual(["21D", "20C"]);
  });

  test("older mce_* rung names still match", () => {
    const old: Config = { ...cfg, seating: { preference_order: ["mce_aisle", "mce_window"], mce_bulkhead_preferred: true } };
    const r = legSeatReality(old, map({ "8C": "available", "7C": "available", "8A": "available" }));
    expect(r.sitable.map((s) => [s.id, s.tier])).toEqual([["7C", 0], ["8C", 0], ["8A", 1]]);
  });

  test("every rung decodes: a sweep over row type and seat position", () => {
    const order = ["exit_row_aisle", "exit_row_window", "extra_legroom_aisle", "extra_legroom_window", "aisle", "window"];
    const expected: Record<string, Record<string, number>> = {
      exit: { aisle: 0, window: 1, middle: -1 },
      legroom: { aisle: 2, window: 3, middle: -1 },
      plain: { aisle: 4, window: 5, middle: -1 },
      unknown: { aisle: 4, window: 5, middle: -1 },
    };
    for (const [kind, byPos] of Object.entries(expected)) {
      for (const [position, tier] of Object.entries(byPos)) {
        const exitRow = kind === "exit" ? true : kind === "unknown" ? "unknown" : false;
        const extraLegroom = kind === "exit" || kind === "legroom" ? true : kind === "unknown" ? "unknown" : false;
        const s = { id: "1A", position: position as "aisle", exitRow, extraLegroom, bulkhead: false, state: "available" as const, bookable: true, openMiddleAdjacent: false };
        expect([kind, position, ladderTier(order, s as never)]).toEqual([kind, position, tier]);
      }
    }
  });

  test("an open middle beside you is measured within your block", () => {
    const r = legSeatReality(cfg, map(states));
    expect(r.sitable.find((s) => s.id === "20C")!.openMiddleAdjacent).toBe(true); // 20B open
    expect(r.sitable.find((s) => s.id === "21C")!.openMiddleAdjacent).toBe(false); // 21B taken
  });

  test("seat tokens carry the state of a blocked seat", () => {
    const r = legSeatReality(cfg, map({ "7C": "blocked" }));
    expect(seatToken(r.sitable[0]!)).toBe("7C^b(blo)");
    expect(rankSitable(cfg, [])).toEqual([]);
  });
});
