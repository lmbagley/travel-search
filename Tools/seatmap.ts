/**
 * seatmap.ts — load a seat-map plug-in and check everything it returns.
 *
 * The plug-in is untrusted input: a source that changed its page, or a provider built
 * against a different contract, must fail loudly here rather than produce a confident
 * ranking of seats that do not exist.
 */

import { existsSync } from "node:fs";
import { configPath, expandHome } from "./config.ts";
import { str, type Config } from "./painfulness.ts";
import { resolveSecret } from "./secrets.ts";
import {
  SEATMAP_API_VERSION,
  SEAT_STATES,
  type AvailabilityResult,
  type BrowserDriver,
  type ProviderSeat,
  type SeatMap,
  type SeatMapProvider,
  type SeatMapRequest,
  type SeatPosition,
} from "./seatmap-api.ts";

export class SeatMapUnavailable extends Error {}

export interface SeatMapSettings {
  enabled: boolean;
  module?: string;
  options: Record<string, unknown>;
  cabins: string[]; // cabin letters `decide` fetches: coach for seats, premium for upgrade odds
  topN: number; // how many best itineraries get seat maps in `decide`
  maxFetches: number; // hard cap on seat-map fetches per run
  economyCabin: string; // cabin letter the monitor and `seats` default to
  premiumCabin: string; // cabin letter whose open seats feed the upgrade estimate
}

export function seatMapSettings(cfg: Config): SeatMapSettings {
  const sm = (cfg.sources?.seatmap ?? {}) as Record<string, unknown>;
  const list = (v: unknown, d: string[]) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : d);
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return {
    enabled: sm.enabled === true,
    module: str(sm, "module"),
    options: (sm.options && typeof sm.options === "object" ? sm.options : {}) as Record<string, unknown>,
    cabins: list(sm.cabins, ["Y", "F"]),
    topN: n(sm.top_n, 4),
    maxFetches: n(sm.max_fetches, 16),
    economyCabin: str(sm, "economy_cabin") ?? "Y",
    premiumCabin: str(sm, "premium_cabin") ?? "F",
  };
}

/** Import the configured provider module and check it implements this contract version. */
export async function loadSeatMapProvider(cfg: Config, browser: BrowserDriver): Promise<SeatMapProvider> {
  const s = seatMapSettings(cfg);
  if (!s.enabled) {
    throw new SeatMapUnavailable(
      `no seat-map source: sources.seatmap.enabled is not true in ${configPath()}. ` +
        `Exit rows and seat occupancy stay UNKNOWN until you add one (README "Seat-map plug-ins").`,
    );
  }
  if (!s.module) throw new SeatMapUnavailable(`sources.seatmap.module is not set in ${configPath()} — point it at a provider .ts file`);
  const path = expandHome(s.module);
  if (!existsSync(path)) throw new SeatMapUnavailable(`seat-map provider module not found at ${path} (sources.seatmap.module)`);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(path)) as Record<string, unknown>;
  } catch (e) {
    throw new SeatMapUnavailable(`seat-map provider ${path} failed to load: ${(e as Error).message}`);
  }
  const factory = mod.createProvider ?? mod.default;
  if (typeof factory !== "function") {
    throw new SeatMapUnavailable(`seat-map provider ${path} does not export createProvider(ctx)`);
  }
  const provider = (await factory({
    browser,
    options: s.options,
    resolveSecret: async (ref: string) => (await resolveSecret(ref)).value,
  })) as Partial<SeatMapProvider> | undefined;
  return assertProvider(provider, path);
}

/** Exported for tests: the shape check every loaded provider passes through. */
export function assertProvider(p: Partial<SeatMapProvider> | undefined, where: string): SeatMapProvider {
  if (!p || typeof p !== "object") throw new SeatMapUnavailable(`seat-map provider ${where}: createProvider returned nothing`);
  if (p.apiVersion !== SEATMAP_API_VERSION) {
    throw new SeatMapUnavailable(
      `seat-map provider ${where} is built for seat-map API version ${String(p.apiVersion)}, ` +
        `this travel-search speaks version ${SEATMAP_API_VERSION} — update one of them`,
    );
  }
  if (typeof p.name !== "string" || !p.name.trim()) throw new SeatMapUnavailable(`seat-map provider ${where} has no name`);
  if (typeof p.seatMap !== "function") throw new SeatMapUnavailable(`seat-map provider ${where} is missing seatMap()`);
  for (const k of ["availability", "check"] as const) {
    if (p[k] !== undefined && typeof p[k] !== "function") {
      throw new SeatMapUnavailable(`seat-map provider ${where}: ${k} must be a function when present`);
    }
  }
  return p as SeatMapProvider;
}

// ───────────────────────────── seat maps ─────────────────────────────

/** A seat with its row and letter split out and its position settled. */
export interface CheckedSeat extends ProviderSeat {
  row: number;
  letter: string;
  position: SeatPosition;
}

export interface CheckedSeatMap extends Omit<SeatMap, "seats"> {
  seats: CheckedSeat[];
  source: string;
}

const SEAT_ID = /^(\d{1,3})([A-Z])$/;

/** Check a provider's seat map and derive any missing seat positions. Throws on anything
 *  that cannot be trusted; never drops a bad seat quietly. */
export function checkSeatMap(raw: unknown, req: SeatMapRequest, source: string): CheckedSeatMap {
  const where = `${source} seat map for ${req.airline} ${req.flightNumber} ${req.origin}-${req.destination} ${req.date} cabin ${req.cabin}`;
  if (!raw || typeof raw !== "object") throw new Error(`${where}: provider returned no object`);
  const m = raw as Partial<SeatMap>;
  if (typeof m.aircraftCode !== "string" || !m.aircraftCode.trim()) throw new Error(`${where}: aircraftCode missing`);
  if (!Array.isArray(m.seats)) throw new Error(`${where}: seats is not a list`);
  if (m.seats.length === 0) throw new Error(`${where}: zero seats returned — the source rendered nothing usable, so nothing is ranked`);

  const seen = new Set<string>();
  const seats: CheckedSeat[] = [];
  for (const s of m.seats as ProviderSeat[]) {
    const printed = typeof s?.id === "string" ? s.id.trim().toUpperCase() : "";
    const mm = printed.match(SEAT_ID);
    if (!mm) throw new Error(`${where}: bad seat id ${JSON.stringify(s?.id)}`);
    const id = `${Number(mm[1])}${mm[2]}`; // "08A" and "8A" are one seat; airlines print "8A"
    if (seen.has(id)) throw new Error(`${where}: seat ${id} appears twice`);
    seen.add(id);
    if (!SEAT_STATES.includes(s.state)) {
      throw new Error(`${where}: seat ${id} has state ${JSON.stringify(s.state)}; allowed: ${SEAT_STATES.join(", ")}`);
    }
    if (s.position !== undefined && !["window", "aisle", "middle"].includes(s.position)) {
      throw new Error(`${where}: seat ${id} has position ${JSON.stringify(s.position)}`);
    }
    if (s.position === undefined && (typeof s.x !== "number" || !Number.isFinite(s.x))) {
      throw new Error(`${where}: seat ${id} has neither a position nor an x coordinate to derive one from`);
    }
    seats.push({ ...s, id, row: Number(mm[1]), letter: mm[2]!, position: s.position ?? "middle" });
  }
  derivePositions(seats, m.seats as ProviderSeat[]);
  return {
    request: req,
    aircraftName: typeof m.aircraftName === "string" && m.aircraftName ? m.aircraftName : m.aircraftCode,
    aircraftCode: m.aircraftCode.trim(),
    seats,
    source,
  };
}

/**
 * Fill in position for seats the provider left blank, from drawing geometry, by COLUMN:
 * each seat letter sits at its median x across the cabin, the outermost columns are
 * windows and the two columns beside the widest gap are aisles. Working row by row would
 * call the last seat of a short row (one missing for an exit or galley) a window. Measuring
 * the drawing, not assuming a layout, handles 3-3, 2-2 and 2-3 alike. (A twin-aisle cabin
 * needs the provider to send positions; one gap is all this derives.)
 */
export function derivePositions(seats: CheckedSeat[], raw: ProviderSeat[]): void {
  const norm = (id: string) => {
    const m = id.trim().toUpperCase().match(SEAT_ID);
    return m ? `${Number(m[1])}${m[2]}` : id;
  };
  const given = new Set(raw.filter((s) => s.position !== undefined).map((s) => norm(s.id)));
  const todo = seats.filter((s) => !given.has(s.id));
  if (!todo.length) return;
  const xs = new Map<string, number[]>();
  for (const s of todo) xs.set(s.letter, [...(xs.get(s.letter) ?? []), s.x!]);
  const median = (v: number[]) => {
    const o = [...v].sort((p, q) => p - q);
    return o.length % 2 ? o[(o.length - 1) / 2]! : (o[o.length / 2 - 1]! + o[o.length / 2]!) / 2;
  };
  const cols = [...xs.entries()].map(([letter, v]) => ({ letter, x: median(v) })).sort((p, q) => p.x - q.x);
  let gapIdx = -1;
  let gapSize = -1;
  for (let i = 0; i + 1 < cols.length; i++) {
    const gap = cols[i + 1]!.x - cols[i]!.x;
    if (gap > gapSize) {
      gapSize = gap;
      gapIdx = i;
    }
  }
  const pos = new Map<string, SeatPosition>();
  cols.forEach((c, i) => {
    pos.set(c.letter, i === 0 || i === cols.length - 1 ? "window" : i === gapIdx || i === gapIdx + 1 ? "aisle" : "middle");
  });
  for (const s of todo) s.position = pos.get(s.letter)!;
}

// ───────────────────────────── availability ─────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Check provider availability before `decide` trusts a single fare bucket of it. */
export function checkAvailability(raw: unknown, source: string): AvailabilityResult {
  const where = `${source} availability`;
  if (!raw || typeof raw !== "object") throw new Error(`${where}: provider returned no object`);
  const r = raw as Partial<AvailabilityResult>;
  if (!Array.isArray(r.itineraries)) throw new Error(`${where}: itineraries is not a list`);
  if (typeof r.complete !== "boolean") throw new Error(`${where}: complete must be true or false`);
  if (!r.complete && !r.note) throw new Error(`${where}: incomplete result with no note saying why`);
  r.itineraries.forEach((it, i) => {
    if (!it || !Array.isArray(it.segments) || it.segments.length === 0) throw new Error(`${where}: itinerary ${i} has no segments`);
    it.segments.forEach((s, j) => {
      const at = `${where}: itinerary ${i} segment ${j}`;
      for (const k of ["airline", "flightNumber", "origin", "destination", "aircraft"] as const) {
        if (typeof s[k] !== "string" || !s[k]) throw new Error(`${at}: ${k} missing`);
      }
      for (const k of ["departDate", "arriveDate"] as const) if (!ISO.test(s[k] ?? "")) throw new Error(`${at}: ${k} must be YYYY-MM-DD, got ${JSON.stringify(s[k])}`);
      for (const k of ["departTime", "arriveTime"] as const) if (!HHMM.test(s[k] ?? "")) throw new Error(`${at}: ${k} must be HH:MM (24h), got ${JSON.stringify(s[k])}`);
      if (!Array.isArray(s.buckets)) throw new Error(`${at}: buckets is not a list`);
      for (const b of s.buckets) {
        if (typeof b?.cls !== "string" || !/^[A-Z]$/.test(b.cls)) throw new Error(`${at}: bad fare class ${JSON.stringify(b?.cls)}`);
        if (!Number.isInteger(b.count) || b.count < 0 || b.count > 9) throw new Error(`${at}: class ${b.cls} count ${JSON.stringify(b.count)} is not 0-9`);
      }
    });
  });
  return r as AvailabilityResult;
}
