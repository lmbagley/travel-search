/**
 * seats.ts — rank the seats on a checked seat map against your preference ladder.
 *
 * Exit rows, extra-legroom rows and bulkhead rows come from `seat_data` in your config,
 * per airline and aircraft code, filled from a source you can cite. Nothing here guesses
 * a row: missing data makes the leg say "UNKNOWN" and no seat climbs the ladder on it.
 *
 * A "blocked" seat is listed (it can open up before departure, which is what the seat
 * monitor watches for) but is never bookable, for anyone. Elite status does not change
 * that: an airline desk could not assign a seat that the map showed as blocked.
 */

import type { Config } from "./painfulness.ts";
import type { CheckedSeat, CheckedSeatMap } from "./seatmap.ts";
import type { SeatPosition, SeatState } from "./seatmap-api.ts";

export interface SitableSeat {
  id: string;
  position: SeatPosition;
  exitRow: boolean | "unknown";
  extraLegroom: boolean | "unknown";
  bulkhead: boolean;
  state: SeatState;
  /** true only when state is "available". */
  bookable: boolean;
  openMiddleAdjacent: boolean;
  /** Rung of the preference ladder this seat meets; -1 = none ("would pick another flight"). */
  tier: number;
}

export interface LegSeatReality {
  leg: string; // "UA 1234 ORD-DEN"
  aircraft: string;
  cabin: string;
  open: number;
  occupied: number;
  blocked: number;
  sitable: SitableSeat[];
  exitRowsKnown: boolean;
  extraLegroomRowsKnown: boolean;
  error?: string; // the fetch or check failed: named, never silent
}

export interface RowData {
  exitRows: number[];
  extraLegroomRows: number[];
  bulkheadRows: number[];
  exitRowsKnown: boolean;
  extraLegroomRowsKnown: boolean;
}

interface SeatingPrefs {
  order: string[];
  wantOpenMiddle: boolean;
  bulkheadPreferred: boolean;
}

function prefs(cfg: Config): SeatingPrefs {
  const s = cfg.seating ?? {};
  return {
    order: Array.isArray(s.preference_order) ? (s.preference_order as string[]) : [],
    wantOpenMiddle: s.want_open_middle === true,
    // `mce_bulkhead_preferred` is the older name, still read.
    bulkheadPreferred: s.extra_legroom_bulkhead_preferred === true || s.mce_bulkhead_preferred === true,
  };
}

function nums(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
}

/** Row data for one airline + aircraft code from `seat_data`. */
export function rowDataFor(cfg: Config, airline: string, aircraftCode: string): RowData {
  const all = cfg.seat_data ?? {};
  const d = all[airline]?.[aircraftCode] ?? {};
  const exitRows = nums(d.exit_rows);
  const extraLegroomRows = nums(d.extra_legroom_rows);
  return {
    exitRows,
    extraLegroomRows,
    bulkheadRows: nums(d.bulkhead_rows),
    exitRowsKnown: exitRows.length > 0,
    extraLegroomRowsKnown: extraLegroomRows.length > 0,
  };
}

/**
 * The ladder rung a seat meets, from `seating.preference_order`, or -1. Rung names:
 * `exit_row_aisle|window`, `extra_legroom_aisle|window` (older name `mce_*`), and plain
 * `aisle` / `window`. Unknown row data never promotes a seat.
 */
export function ladderTier(order: string[], s: Omit<SitableSeat, "tier">): number {
  for (let i = 0; i < order.length; i++) {
    const p = order[i]!;
    const pos = p.endsWith("_aisle") || p === "aisle" ? "aisle" : p.endsWith("_window") || p === "window" ? "window" : undefined;
    if (pos && s.position !== pos) continue;
    if (p.startsWith("exit_row")) {
      if (s.exitRow === true) return i;
    } else if (p.startsWith("extra_legroom") || p.startsWith("mce")) {
      // Exit rows almost always carry extra legroom too, so an exit seat meets this rung.
      if (s.extraLegroom === true || s.exitRow === true) return i;
    } else if (pos && (p === "aisle" || p === "window")) {
      return i;
    }
  }
  return -1;
}

function toSitable(cfg: Config, rows: RowData, s: CheckedSeat, openMiddleAdjacent: boolean): SitableSeat {
  const base = {
    id: s.id,
    position: s.position,
    exitRow: rows.exitRowsKnown ? rows.exitRows.includes(s.row) : ("unknown" as const),
    extraLegroom: rows.extraLegroomRowsKnown ? rows.extraLegroomRows.includes(s.row) : ("unknown" as const),
    bulkhead: rows.bulkheadRows.includes(s.row),
    state: s.state,
    bookable: s.state === "available",
    openMiddleAdjacent,
  };
  return { ...base, tier: ladderTier(prefs(cfg).order, base) };
}

function middleNeighbourOpen(seat: CheckedSeat, byId: Map<string, CheckedSeat>): boolean {
  const near = [-1, 1].map((d) => byId.get(`${seat.row}${String.fromCharCode(seat.letter.charCodeAt(0) + d)}`));
  return near.some((n) => n !== undefined && n.position === "middle" && n.state === "available");
}

/** Every available or blocked seat on the map, laddered. Occupied seats are counted, not listed. */
export function legSeatReality(cfg: Config, map: CheckedSeatMap): LegSeatReality {
  const req = map.request;
  const rows = rowDataFor(cfg, req.airline, map.aircraftCode);
  const want = prefs(cfg).wantOpenMiddle;
  const byId = new Map(map.seats.map((s) => [s.id, s]));
  const sitable = map.seats
    .filter((s) => s.state === "available" || s.state === "blocked")
    .map((s) => toSitable(cfg, rows, s, want ? middleNeighbourOpen(s, byId) : false));
  return {
    leg: `${req.airline} ${req.flightNumber} ${req.origin}-${req.destination}`,
    aircraft: map.aircraftName,
    cabin: req.cabin,
    open: map.seats.filter((s) => s.state === "available").length,
    occupied: map.seats.filter((s) => s.state === "occupied").length,
    blocked: map.seats.filter((s) => s.state === "blocked").length,
    sitable: rankSitable(cfg, sitable),
    exitRowsKnown: rows.exitRowsKnown,
    extraLegroomRowsKnown: rows.extraLegroomRowsKnown,
  };
}

/** Ladder rung of one seat id whatever its state. Your own ticketed seat shows as occupied,
 *  so it is looked up directly. -1 when it is off the ladder or not on this map. */
export function tierForSeatId(cfg: Config, map: CheckedSeatMap, seatId: string): number {
  const want = seatId.trim().toUpperCase();
  const s = map.seats.find((x) => x.id === want);
  if (!s) return -1;
  return toSitable(cfg, rowDataFor(cfg, map.request.airline, map.aircraftCode), s, false).tier;
}

/** Ladder rung first; bulkhead first inside a rung when you prefer it; then an open middle beside you. */
export function rankSitable(cfg: Config, seats: SitableSeat[]): SitableSeat[] {
  const bulk = prefs(cfg).bulkheadPreferred;
  const key = (s: SitableSeat) => (s.tier === -1 ? 999 : s.tier);
  return [...seats].sort(
    (a, b) =>
      key(a) - key(b) ||
      Number(b.bookable) - Number(a.bookable) ||
      (bulk ? Number(b.bulkhead) - Number(a.bulkhead) : 0) ||
      Number(b.openMiddleAdjacent) - Number(a.openMiddleAdjacent),
  );
}

/** True when no BOOKABLE seat is on any rung. A blocked seat on a good rung does not count. */
export function noAcceptableSeat(seats: SitableSeat[]): boolean {
  return !seats.some((s) => s.tier >= 0 && s.bookable);
}

/** Short seat token for tables: `12C*` exit, `^` extra legroom, `b` bulkhead, `+` open middle,
 *  `(blo)` blocked and NOT bookable, `~` off the ladder. */
export function seatToken(s: SitableSeat): string {
  return (
    `${s.id}${s.exitRow === true ? "*" : s.extraLegroom === true ? "^" : ""}${s.bulkhead ? "b" : ""}` +
    `${s.openMiddleAdjacent ? "+" : ""}${s.bookable ? "" : `(${s.state.slice(0, 3)})`}${s.tier < 0 ? "~" : ""}`
  );
}

export const SEAT_LEGEND =
  "legend: * exit row  ^ extra legroom  b bulkhead  + adjacent middle open  (blo) blocked — NOT bookable  ~ off your ladder\n" +
  "        (exit, extra-legroom and bulkhead rows come from seat_data in your config, never guessed)";
