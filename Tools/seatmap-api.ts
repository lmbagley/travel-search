/**
 * seatmap-api.ts — the seat-map plug-in contract, version 1.
 *
 * travel-search ships no seat-map reader. A seat-map source is a separate module you
 * point at with `sources.seatmap.module` in your config. That module exports
 *
 *     export const createProvider: CreateProvider = (ctx) => ({ ... });
 *
 * and travel-search checks everything it hands back (see seatmap.ts) before ranking
 * a single seat. This file is types plus one constant, with no imports, so a provider
 * repo can copy it verbatim. Bump SEATMAP_API_VERSION on any breaking change; the
 * loader refuses a provider built for a different version.
 */

export const SEATMAP_API_VERSION = 1;

/** The only states a provider may report. Anything else is rejected, never guessed. */
export type SeatState = "available" | "occupied" | "blocked";
export const SEAT_STATES: readonly SeatState[] = ["available", "occupied", "blocked"];

export type SeatPosition = "window" | "aisle" | "middle";

export interface SeatMapRequest {
  airline: string; // marketing carrier code, e.g. "UA"
  flightNumber: string; // digits as printed, e.g. "1234"
  origin: string; // IATA
  destination: string; // IATA
  date: string; // local departure date, YYYY-MM-DD
  cabin: string; // cabin letter the source understands, e.g. "Y" or "F"
}

export interface ProviderSeat {
  id: string; // "12A" — row digits then seat letter
  state: SeatState;
  /** Optional when the source knows it. Otherwise give `x` and it is derived. */
  position?: SeatPosition;
  /** Horizontal drawing coordinate. Within a row, outermost seats are windows and the
   *  seats beside the widest gap are aisles. Needed only when `position` is absent. */
  x?: number;
}

export interface SeatMap {
  request: SeatMapRequest;
  aircraftName: string; // as printed, e.g. "Boeing 737-900"
  /** Equipment code as the source prints it. Keys `seat_data` in the config. */
  aircraftCode: string;
  seats: ProviderSeat[]; // only seats in the requested cabin
}

export interface AvailabilityRequest {
  origin: string;
  destination: string;
  date: string; // YYYY-MM-DD
  airlines: string[]; // carrier codes to include
}

export interface BucketCount {
  cls: string; // fare class letter, e.g. "J"
  count: number; // seats the source says are sellable in that class (0-9)
}

export interface AvailSegment {
  airline: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departDate: string; // YYYY-MM-DD, local
  departTime: string; // HH:MM 24h, local
  arriveDate: string; // YYYY-MM-DD, local
  arriveTime: string; // HH:MM 24h, local
  aircraft: string; // equipment code
  buckets: BucketCount[];
}

export interface AvailItinerary {
  segments: AvailSegment[];
}

export interface AvailabilityResult {
  itineraries: AvailItinerary[];
  /** false when the source could not cover the whole day; `note` must say why. */
  complete: boolean;
  note?: string;
}

/** The real-browser driver travel-search already uses for Google Flights. One
 *  instance is shared by every source in a run, so requests stay paced and serial. */
export interface BrowserDriver {
  /** Open a URL in a new tab after waiting out the pacing. Returns the tab id. */
  open(url: string, pacing?: { pacingMs: number; jitterMs: number }): Promise<number>;
  /** Re-read a tab until `settled(html)` is true; throws when the deadline passes. */
  read(tabId: number, settled: (html: string) => boolean, deadlineMs?: number): Promise<string>;
  /** Click a CSS selector in a tab. Throws on failure. */
  click(tabId: number, selector: string): Promise<void>;
  /** Browser requests made so far in this process. */
  requests(): number;
}

export interface ProviderContext {
  browser: BrowserDriver;
  /** `sources.seatmap.options` from the config, passed through untouched. */
  options: Record<string, unknown>;
  /** Resolve an `env:NAME`, `op://...` or file-path reference to its value. */
  resolveSecret(ref: string): Promise<string>;
}

export interface ProviderCheck {
  ok: boolean;
  /** "logged-out" is reported separately from "broken" so the fix is obvious. */
  status: "ok" | "logged-out" | "error";
  detail: string;
}

export interface SeatMapProvider {
  apiVersion: number; // must equal SEATMAP_API_VERSION
  name: string; // short id shown by `doctor`, e.g. "my-source"
  seatMap(req: SeatMapRequest): Promise<SeatMap>;
  /** Optional. Fare-class availability for a day; `decide` uses it when present. */
  availability?(req: AvailabilityRequest): Promise<AvailabilityResult>;
  /** Optional. Cheap readiness probe used by `doctor`. */
  check?(): Promise<ProviderCheck>;
}

export type CreateProvider = (ctx: ProviderContext) => SeatMapProvider | Promise<SeatMapProvider>;
