/**
 * cabin-prices.ts — headline prices per cabin from Google Flights.
 *
 * Google Flights takes a plain-English `q=` search ("ORD to DEN on 2027-02-01 one way
 * first class United"), which selects a cabin without building its binary URL format.
 * Its collapsed rows do not print flight numbers, so prices join to itineraries on
 * (departure time, arrival time). An itinerary with no matching row has no price for
 * that cabin and says "n/a"; nothing is filled in.
 */

import type { BrowserDriver } from "./seatmap-api.ts";
import { to24h } from "./google-flights.ts";

export interface CabinPrice {
  cabin: string; // "economy" | "premium" | "business" | "first"
  price: number;
  currency: string;
  departTime: string; // HH:MM local — join key
  arriveTime: string; // HH:MM local — join key
  stops: number;
  raw: string; // the label this was parsed from
}

const GF_BASE = "https://www.google.com/travel/flights";

export function cabinPriceUrl(origin: string, destination: string, isoDate: string, cabin: string, airlineName?: string): string {
  const q = `${origin} to ${destination} on ${isoDate} one way ${cabin === "economy" ? "" : `${cabin} class `}${airlineName ?? ""}`;
  return `${GF_BASE}?q=${encodeURIComponent(q.replace(/\s+/g, " ").trim())}&hl=en&curr=USD`;
}

export async function fetchCabinPrices(
  browser: BrowserDriver,
  origin: string,
  destination: string,
  isoDate: string,
  cabin: string,
  airlineName?: string,
): Promise<CabinPrice[]> {
  const tab = await browser.open(cabinPriceUrl(origin, destination, isoDate, cabin, airlineName));
  let html = await browser.read(tab, (h) => /aria-label="[^"]*US dollars/.test(h) || /couldn(?:&#39;|')t find|No results/i.test(h), 60_000);
  // Rows hide behind "View more flights", and the hidden one is often the one you want.
  if (/aria-label="View more flights"/.test(html)) {
    try {
      await browser.click(tab, 'button[aria-label="View more flights"]');
      html = await browser.read(tab, (h) => !/aria-label="View more flights"/.test(h), 20_000);
    } catch {
      // Not fatal: parse what rendered. Anything left unpriced shows as n/a.
    }
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
