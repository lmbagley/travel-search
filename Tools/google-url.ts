/**
 * google-url.ts — Google Flights search links built as structured data, not English.
 *
 * Google Flights reads a `tfs=` parameter: a small protobuf message (base64url) that
 * names origin, destination, date, cabin, trip type, passengers and airlines exactly.
 * The alternative, `q=` plain English, goes through Google's language parser, which on
 * 2026-11-24 intermittently served the Flights landing page instead of results for the
 * same query that had worked minutes earlier. A structured link has nothing to parse.
 *
 * The bytes match the link Google itself writes for the same search (captured live
 * 2026-11-24 and pinned in a test), field for field:
 *   Info        { 1: 28; 2: 2; data: FlightData = 3; passengers: enum = 8 (1 adult);
 *                 seat: enum = 9; 14: 1; 16: { 1: no price cap }; trip: enum = 19 }
 *   FlightData  { date: string = 2; airlines: string = 6 (repeated);
 *                 from: Place = 13; to: Place = 14 }
 *   Place       { kind: 1 (airport) = 1; code: string = 2 }
 *   seat: 1 economy, 2 premium economy, 3 business, 4 first      trip: 2 one way
 *
 * `tfu=EgYIABABGAA` is Google's own UI state for "all flights shown". Without it the
 * results stop at about nine rows behind a "View more flights" button that ignores
 * scripted clicks, so most itineraries come back unpriced.
 */

const SEAT: Record<string, number> = { economy: 1, premium: 2, premium_economy: 2, business: 3, first: 4 };

function varint(n: number | bigint): number[] {
  const out: number[] = [];
  let v = BigInt.asUintN(64, BigInt(n));
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

const key = (field: number, wire: number) => varint((field << 3) | wire);
const enc = new TextEncoder();
const bytesField = (field: number, b: number[]) => [...key(field, 2), ...varint(b.length), ...b];
const strField = (field: number, s: string) => bytesField(field, [...enc.encode(s)]);
const intField = (field: number, n: number | bigint) => [...key(field, 0), ...varint(n)];
const place = (code: string) => [...intField(1, 1), ...strField(2, code)];

export interface FlightSearch {
  origin: string; // IATA
  destination: string; // IATA
  date: string; // YYYY-MM-DD
  cabin?: string; // economy | premium | business | first (default economy)
  airlines?: string[]; // IATA codes; empty = all
}

/** The protobuf bytes for a one-way, one-adult search. */
export function tfsBytes(s: FlightSearch): number[] {
  if (!/^[A-Z]{3}$/.test(s.origin) || !/^[A-Z]{3}$/.test(s.destination)) {
    throw new Error(`airport codes must be 3 capital letters, got ${s.origin}-${s.destination}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) throw new Error(`date must be YYYY-MM-DD, got "${s.date}"`);
  const cabin = (s.cabin ?? "economy").toLowerCase();
  const seat = SEAT[cabin];
  if (!seat) throw new Error(`unknown cabin "${s.cabin}" (economy, premium, business, first)`);
  for (const a of s.airlines ?? []) if (!/^[A-Z0-9]{2}$/.test(a)) throw new Error(`airline must be a 2-character IATA code, got "${a}"`);

  const leg = [
    ...strField(2, s.date),
    ...(s.airlines ?? []).flatMap((a) => strField(6, a)),
    ...bytesField(13, place(s.origin)),
    ...bytesField(14, place(s.destination)),
  ];
  return [
    ...intField(1, 28),
    ...intField(2, 2),
    ...bytesField(3, leg),
    ...intField(8, 1),
    ...intField(9, seat),
    ...intField(14, 1),
    ...bytesField(16, intField(1, -1n)),
    ...intField(19, 2),
  ];
}

export function base64url(b: number[]): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Google's UI state for "all flights shown" (no "View more flights" cut-off). */
export const ALL_FLIGHTS_TFU = "EgYIABABGAA";

export function googleFlightsSearchUrl(s: FlightSearch): string {
  return `https://www.google.com/travel/flights/search?tfs=${base64url(tfsBytes(s))}&tfu=${ALL_FLIGHTS_TFU}&hl=en&curr=USD`;
}
