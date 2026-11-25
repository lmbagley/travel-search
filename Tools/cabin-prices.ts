/**
 * cabin-prices.ts — headline prices per cabin from Google Flights.
 *
 * The link is Google Flights' own structured search (google-url.ts) with the cabin set as
 * a field and every flight listed, so nothing hides behind "View more flights".
 * Its rows do not print flight numbers, so prices join to itineraries on
 * (departure time, arrival time). An itinerary with no matching row has no price for
 * that cabin and says "n/a"; nothing is filled in.
 */

import type { BrowserDriver } from "./seatmap-api.ts";
import { googleFlightsUrl, to24h } from "./google-flights.ts";

export interface CabinPrice {
  cabin: string; // "economy" | "premium" | "business" | "first"
  price: number;
  currency: string;
  departTime: string; // HH:MM local — join key
  arriveTime: string; // HH:MM local — join key
  stops: number;
  raw: string; // the label this was parsed from
}

export function cabinPriceUrl(origin: string, destination: string, isoDate: string, cabin: string, airline?: string): string {
  return googleFlightsUrl(origin, destination, isoDate, airline, cabin);
}

export async function fetchCabinPrices(
  browser: BrowserDriver,
  origin: string,
  destination: string,
  isoDate: string,
  cabin: string,
  airlineName?: string,
  /** Told when rows stayed hidden, so callers can name the gap instead of printing n/a. */
  onIncomplete: (why: string) => void = () => {},
): Promise<CabinPrice[]> {
  const tab = await browser.open(cabinPriceUrl(origin, destination, isoDate, cabin, airlineName));
  const html = await browser.read(tab, (h) => /aria-label="[^"]*US dollars/.test(h) || /couldn(?:&#39;|')t find|No results/i.test(h), 60_000);
  // The link asks for every flight. If Google still collapsed the list, say so: rows left
  // hidden would otherwise read as "no price". (Its expand button ignores scripted clicks.)
  if (/aria-label="View more flights"/.test(html)) {
    onIncomplete(`Google collapsed the ${cabin} list behind "View more flights"; only the rows shown were priced`);
  }
  const rows = parseCabinPriceRows(html);
  if (!rows.length) throw new Error(`Google Flights returned no parseable ${cabin} rows for ${origin}-${destination} ${isoDate}`);
  return rows.map((p) => ({ ...p, cabin }));
}

export function parseCabinPriceRows(html: string): Omit<CabinPrice, "cabin">[] {
  const out: Omit<CabinPrice, "cabin">[] = [];
  for (const m of html.matchAll(/aria-label="((?:[^"]|&quot;)*?US dollars(?:[^"]|&quot;)*?)"/g)) {
    const label = m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const price = label.match(/From (\d[\d,]*) US dollars/);
    const dep = label.match(/[Ll]eaves .*? at (\d{1,2}:\d\d\s*[AP]M)/);
    const arr = label.match(/arrives at .*? at (\d{1,2}:\d\d\s*[AP]M)/);
    if (!price || !dep || !arr) continue;
    const layovers = label.match(/Layover \(1 of (\d)\)/);
    out.push({
      price: Number(price[1]!.replace(/,/g, "")),
      currency: "USD",
      departTime: to24h(dep[1]!.replace(/\s+/g, " ")),
      arriveTime: to24h(arr[1]!.replace(/\s+/g, " ")),
      stops: /[Nn]onstop/.test(label) ? 0 : layovers ? Number(layovers[1]) : 1,
      raw: label.slice(0, 160),
    });
  }
  // Google repeats rows across its "Best" and "Other" lists.
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.departTime}|${p.arriveTime}|${p.price}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
