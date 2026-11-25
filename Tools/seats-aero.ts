/**
 * seats-aero.ts — award availability from the seats.aero Partner API (cached search).
 *
 * Docs: https://developers.seats.aero/reference/cached-search
 * Auth: header `Partner-Authorization: <key>` (a seats.aero Pro subscription key).
 *
 * Four traps this module exists to get right, each verified against the docs and a
 * live response:
 *
 *   1. PAGINATION. `cursor` is the value from the FIRST response of a search, and
 *      `skip` is the number of results already retrieved. Sending the cursor as `skip`
 *      silently returns the wrong pages.
 *   2. TAXES ARE IN CENTS. `TotalTaxes: 1290` is $12.90.
 *   3. TIMES ARE AIRPORT-LOCAL even though they carry a `Z` suffix. Parsing them with
 *      `new Date()` shifts every time by your machine's offset. They are kept as
 *      wall-clock strings here and never converted.
 *   4. RECORD HEADERS ARE AGGREGATES. Fields like `JMileageCost` / `JAirlines` summarise
 *      a day's search index; they are not a bookable itinerary. Every row this module
 *      returns comes from `AvailabilityTrips` (requires include_trips=true).
 *
 * Data is cached by seats.aero and can be hours to weeks old. Every row carries its age.
 */

import type { Itinerary, Segment } from "./painfulness.ts";
import { redact } from "./secrets.ts";

export const SEATS_AERO_BASE = "https://seats.aero/partnerapi";

export const CABINS = ["economy", "premium", "business", "first"] as const;
export type Cabin = (typeof CABINS)[number];

export interface AwardQuery {
  origin: string; // "SFO" or "SFO,LAX"
  destination: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  cabins?: Cabin[];
  sources?: string[]; // mileage programs, e.g. ["aeroplan", "united"]
  carriers?: string[]; // e.g. ["NH", "JL"]
  directOnly?: boolean;
  orderBy?: "lowest_mileage";
  take?: number; // 10..1000 per page
  maxPages?: number; // hard bound on API calls for this search
}

export interface AwardSegment {
  flightNumber: string;
  origin: string;
  destination: string;
  departLocal: string; // "YYYY-MM-DDTHH:MM", airport-local
  arriveLocal: string;
  aircraft: string;
  fareClass: string;
}

export interface AwardTrip {
  tripId: string;
  /** The parent availability record's ID — the key for GET /trips/{id}. */
  availabilityId: string;
  origin: string;
  destination: string;
  date: string; // the record's departure date
  program: string; // mileage program (seats.aero "Source")
  cabin: string;
  miles: number;
  /** Taxes in MAJOR units (dollars), converted from the API's cents. */
  taxes: number;
  currency: string; // "" when the program does not publish it
  seats: number;
  stops: number;
  carriers: string;
  flightNumbers: string[];
  connections: string[];
  aircraft: string[];
  departLocal: string; // "YYYY-MM-DDTHH:MM"
  arriveLocal: string;
  durationMinutes: number;
  updatedAt: string;
  ageHours: number;
  /**
   * Per-leg detail. EMPTY from cached search (it does not return segments even with
   * include_trips=true — measured); filled by attachSegments() from
   * GET /trips/{availabilityId}, one call per availability record.
   */
  segments: AwardSegment[];
  /** The program's own booking search, when seats.aero supplied one (from /trips). */
  bookingLink?: string;
}

export interface AwardSearchResult {
  trips: AwardTrip[];
  pages: number;
  records: number;
  complete: boolean;
  incompleteReason?: string;
  rateLimit?: { limit?: number; remaining?: number; resetSeconds?: number };
}

export interface ClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number;
  base?: string;
}

export class AwardApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "2027-02-01T07:00:00Z" -> "2027-02-01T07:00". Wall clock only; no timezone math. */
export function localWallClock(iso: string | undefined): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso ?? "");
  if (!m) throw new Error(`seats.aero: unparseable time "${iso}"`);
  return `${m[1]}T${m[2]}`;
}

function rateLimitOf(h: Headers): AwardSearchResult["rateLimit"] {
  const n = (k: string) => {
    const v = h.get(k);
    return v === null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v);
  };
  return {
    limit: n("x-ratelimit-limit"),
    remaining: n("x-ratelimit-remaining"),
    resetSeconds: n("x-ratelimit-reset"),
  };
}

export async function apiGet(
  path: string,
  params: Record<string, string>,
  opts: ClientOptions,
): Promise<{ json: any; headers: Headers }> {
  const url = new URL((opts.base ?? SEATS_AERO_BASE) + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, { headers: { "Partner-Authorization": opts.apiKey, accept: "application/json" } });
  } catch (e) {
    throw new AwardApiError(`seats.aero ${path}: network error — ${redact(String(e), opts.apiKey)}`, 0);
  }
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " (key rejected — is the seats.aero Pro subscription active, and is the key current?)"
        : res.status === 429
          ? " (daily rate limit reached — the reset time is in the x-ratelimit-reset header)"
          : "";
    throw new AwardApiError(
      `seats.aero ${path}: HTTP ${res.status}${hint} — ${redact(text, opts.apiKey).slice(0, 300)}`,
      res.status,
    );
  }
  try {
    return { json: JSON.parse(text), headers: res.headers };
  } catch {
    throw new AwardApiError(`seats.aero ${path}: response was not JSON — ${redact(text, opts.apiKey).slice(0, 200)}`, res.status);
  }
}

export function segmentsOf(t: any): AwardSegment[] {
  return [...(t?.AvailabilitySegments ?? [])]
    .sort((a: any, b: any) => (a.Order ?? 0) - (b.Order ?? 0))
    .map((s: any) => ({
      flightNumber: String(s.FlightNumber ?? ""),
      origin: String(s.OriginAirport ?? ""),
      destination: String(s.DestinationAirport ?? ""),
      departLocal: localWallClock(s.DepartsAt),
      arriveLocal: localWallClock(s.ArrivesAt),
      aircraft: String(s.AircraftName ?? s.AircraftCode ?? ""),
      fareClass: String(s.FareClass ?? ""),
    }));
}

/**
 * Fills `segments` (and `bookingLink`) from GET /trips/{availabilityId}. One API call
 * per distinct availability record, cheapest records first, capped at `maxCalls`.
 * Returns how many records were fetched and how many trips still lack detail.
 */
export async function attachSegments(
  trips: AwardTrip[],
  opts: ClientOptions,
  maxCalls: number,
): Promise<{ calls: number; detailed: number; missing: number }> {
  const order: string[] = [];
  for (const t of sortByCost(trips)) if (t.availabilityId && !order.includes(t.availabilityId)) order.push(t.availabilityId);
  const sleep = opts.sleepMs ?? defaultSleep;
  let calls = 0;
  for (const id of order.slice(0, Math.max(0, maxCalls))) {
    if (calls > 0) await sleep(500 + Math.floor(Math.random() * 400));
    const { json } = await apiGet(`/trips/${encodeURIComponent(id)}`, {}, opts);
    calls++;
    const byTrip = new Map<string, any>((json?.data ?? []).map((x: any) => [String(x.ID), x]));
    const link = (json?.booking_links ?? []).find((b: any) => b?.primary)?.link ?? json?.booking_links?.[0]?.link;
    for (const t of trips) {
      if (t.availabilityId !== id) continue;
      const full = byTrip.get(t.tripId);
      if (full) t.segments = segmentsOf(full);
      if (link) t.bookingLink = String(link);
    }
  }
  const detailed = trips.filter((t) => t.segments.length > 0).length;
  return { calls, detailed, missing: trips.length - detailed };
}

/** Flattens search records into trip rows. Reads ONLY AvailabilityTrips, never record headers. */
export function tripsFromRecords(records: any[], now: number, cabins?: string[]): AwardTrip[] {
  const want = cabins?.length ? new Set(cabins.map((c) => c.toLowerCase())) : null;
  const out: AwardTrip[] = [];
  for (const rec of records) {
    for (const t of rec?.AvailabilityTrips ?? []) {
      const cabin = String(t.Cabin ?? "").toLowerCase();
      if (want && !want.has(cabin)) continue;
      const segs = segmentsOf(t);
      const updatedAt = String(t.UpdatedAt ?? rec.UpdatedAt ?? "");
      const updatedMs = Date.parse(updatedAt); // UpdatedAt IS a real UTC timestamp
      out.push({
        tripId: String(t.ID ?? ""),
        availabilityId: String(t.AvailabilityID ?? rec.ID ?? ""),
        origin: String(t.OriginAirport ?? rec.Route?.OriginAirport ?? ""),
        destination: String(t.DestinationAirport ?? rec.Route?.DestinationAirport ?? ""),
        date: String(rec.Date ?? ""),
        program: String(t.Source ?? rec.Source ?? ""),
        cabin,
        miles: Number(t.MileageCost ?? 0),
        taxes: Number(t.TotalTaxes ?? 0) / 100,
        currency: String(t.TaxesCurrency ?? rec.TaxesCurrency ?? ""),
        seats: Number(t.RemainingSeats ?? 0),
        stops: Number(t.Stops ?? -1),
        carriers: String(t.Carriers ?? ""),
        flightNumbers: String(t.FlightNumbers ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        connections: Array.isArray(t.Connections) ? t.Connections.map(String) : [],
        aircraft: Array.isArray(t.Aircraft) ? t.Aircraft.map(String) : [],
        departLocal: localWallClock(t.DepartsAt),
        arriveLocal: localWallClock(t.ArrivesAt),
        durationMinutes: Number(t.TotalDuration ?? 0),
        updatedAt,
        ageHours: Number.isNaN(updatedMs) ? NaN : Math.max(0, (now - updatedMs) / 3_600_000),
        segments: segs,
      });
    }
  }
  return out;
}

export function buildSearchParams(q: AwardQuery): Record<string, string> {
  const take = Math.min(1000, Math.max(10, q.take ?? 500));
  const p: Record<string, string> = {
    origin_airport: q.origin.toUpperCase(),
    destination_airport: q.destination.toUpperCase(),
    start_date: q.startDate,
    end_date: q.endDate,
    take: String(take),
    include_trips: "true",
  };
  if (q.cabins?.length) p.cabins = q.cabins.join(",");
  if (q.sources?.length) p.sources = q.sources.join(",");
  if (q.carriers?.length) p.carriers = q.carriers.map((c) => c.toUpperCase()).join(",");
  if (q.directOnly) p.only_direct_flights = "true";
  if (q.orderBy) p.order_by = q.orderBy;
  return p;
}

/**
 * Cached search with correct pagination and a hard page bound decided before the first
 * call. Reaching the bound with more pages left is reported as INCOMPLETE, never as
 * the whole answer.
 */
export async function searchAwards(q: AwardQuery, opts: ClientOptions): Promise<AwardSearchResult> {
  for (const d of [q.startDate, q.endDate]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`seats.aero: date must be YYYY-MM-DD, got "${d}"`);
  }
  if (q.endDate < q.startDate) throw new Error(`seats.aero: end date ${q.endDate} is before start date ${q.startDate}`);
  const maxPages = Math.max(1, q.maxPages ?? 5);
  const base = buildSearchParams(q);
  const sleep = opts.sleepMs ?? defaultSleep;
  const now = (opts.now ?? Date.now)();

  const records: any[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let hasMore = true;
  let rateLimit: AwardSearchResult["rateLimit"];
  while (pages < maxPages && hasMore) {
    const params = { ...base };
    if (cursor !== undefined) {
      params.cursor = cursor;
      params.skip = String(records.length);
    }
    const { json, headers } = await apiGet("/search", params, opts);
    rateLimit = rateLimitOf(headers);
    const data = Array.isArray(json?.data) ? json.data : [];
    records.push(...data);
    pages++;
    hasMore = json?.hasMore === true && data.length > 0;
    if (cursor === undefined && json?.cursor !== undefined && json?.cursor !== null) cursor = String(json.cursor);
    if (hasMore && cursor === undefined) {
      throw new AwardApiError("seats.aero /search: hasMore=true but the first response carried no cursor", 200);
    }
    if (hasMore && pages < maxPages) await sleep(700 + Math.floor(Math.random() * 500));
  }
  const complete = !hasMore;
  return {
    trips: tripsFromRecords(records, now, q.cabins),
    pages,
    records: records.length,
    complete,
    ...(complete
      ? {}
      : {
          incompleteReason: `stopped at the ${maxPages}-page bound with more results waiting; narrow the dates or raise --max-pages`,
        }),
    rateLimit,
  };
}

/** Cheapest first, then lowest taxes, then shortest. */
export function sortByCost(trips: AwardTrip[]): AwardTrip[] {
  return [...trips].sort((a, b) => a.miles - b.miles || a.taxes - b.taxes || a.durationMinutes - b.durationMinutes);
}

function dayDiff(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

/**
 * Converts an award trip into the ranker's Itinerary so the same painfulness model can
 * rank awards. Connection minutes come from segment wall clocks at the SAME airport,
 * which is sound; total duration comes from the API, never from cross-airport clock
 * subtraction. A connecting trip without segment detail cannot be ranked (it would
 * look like a nonstop and skip every connection floor), so it returns null.
 */
export function awardTripToItinerary(t: AwardTrip): Itinerary | null {
  if (t.stops > 0 && t.segments.length !== t.stops + 1) return null;
  const day0 = t.departLocal.slice(0, 10);
  // "AS68" -> AS / 68, "B6123" -> B6 / 123. IATA designators are two characters.
  const split = (fn: string) => /^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/.exec(fn.replace(/\s+/g, ""));
  const mk = (s: AwardSegment): Segment => ({
    marketingAirline: split(s.flightNumber)?.[1] ?? "?",
    flightNumber: split(s.flightNumber)?.[2] ?? (s.flightNumber || "?"),
    origin: s.origin,
    destination: s.destination,
    departLocal: s.departLocal.slice(11, 16),
    arriveLocal: s.arriveLocal.slice(11, 16),
    departDayOffset: dayDiff(day0, s.departLocal.slice(0, 10)),
    arriveDayOffset: dayDiff(day0, s.arriveLocal.slice(0, 10)),
    aircraft: s.aircraft || "?",
  });
  const segments: Segment[] =
    t.segments.length > 0
      ? t.segments.map(mk)
      : [
          {
            marketingAirline: t.carriers.split(",")[0]?.trim() || "?",
            flightNumber: t.flightNumbers[0] ?? "?",
            origin: t.origin || "?",
            destination: t.destination || "?",
            departLocal: t.departLocal.slice(11, 16),
            arriveLocal: t.arriveLocal.slice(11, 16),
            arriveDayOffset: dayDiff(day0, t.arriveLocal.slice(0, 10)),
            aircraft: t.aircraft[0] ?? "?",
          },
        ];
  return {
    segments,
    totalDurationMinutes: t.durationMinutes,
    priceFrom: t.miles,
    currency: "miles",
    sourceLabel: `seats.aero ${t.program} ${t.cabin} trip ${t.tripId}`,
  };
}

function hhmm(min: number): string {
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

function money(t: AwardTrip): string {
  const sym = t.currency === "USD" ? "$" : "";
  const unit = t.currency && t.currency !== "USD" ? ` ${t.currency}` : t.currency ? "" : " (cur?)";
  return `${sym}${t.taxes.toFixed(2)}${unit}`;
}

export function renderAwardTable(trips: AwardTrip[], staleAfterHours = 48): string {
  const lines: string[] = [];
  lines.push(
    "Date        Program        Cabin     Miles     Taxes        Stops  Via          Flights                 Depart (local)    Arrive (local)    Dur    Seats  Age",
  );
  lines.push("─".repeat(160));
  for (const t of trips) {
    const age = Number.isNaN(t.ageHours) ? "?" : t.ageHours < 48 ? `${Math.round(t.ageHours)}h` : `${Math.round(t.ageHours / 24)}d`;
    lines.push(
      [
        t.date.padEnd(11),
        t.program.slice(0, 14).padEnd(14),
        t.cabin.padEnd(9),
        t.miles.toLocaleString("en-US").padEnd(9),
        money(t).padEnd(12),
        String(t.stops).padEnd(6),
        (t.connections.join(",") || "nonstop").slice(0, 12).padEnd(12),
        t.flightNumbers.join(" ").slice(0, 23).padEnd(23),
        t.departLocal.replace("T", " ").padEnd(17),
        t.arriveLocal.replace("T", " ").padEnd(17),
        hhmm(t.durationMinutes).padEnd(6),
        String(t.seats).padEnd(6),
        age + (t.ageHours > staleAfterHours ? " STALE" : ""),
      ].join(" "),
    );
  }
  return lines.join("\n");
}
