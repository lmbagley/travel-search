/**
 * google-flights.ts — collect one direction/date of itineraries from Google Flights.
 *
 * Drives a REAL browser through a small CLI (default: `interceptor`, the PAI browser
 * skill). The driver must support two commands:
 *
 *   <driver> open <url>            -> JSON on stdout containing { "tabId": <int> }
 *   <driver> read --tab <tabId>    -> JSON on stdout containing { "html": "<page html>" }
 *
 * Set `sources.schedule.driver_cmd` in config to use a different driver.
 *
 * Honesty rules enforced here, not left to the caller:
 *   - zero rows is only data when the page itself published "0 results returned"
 *   - a partial parse (any label that looked like an itinerary and failed) is an error
 *   - the page must name this route and this date, or the read hit the wrong tab
 *   - a bot challenge stops the run immediately; there is no retry
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { num, type Config, type Connection, type Itinerary } from "./painfulness.ts";

import { acquireBrowserLock, driverCommand, runDriver as driver } from "./browser.ts";

export { driverCommand };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

export interface CollectResult {
  itineraries: Itinerary[];
  claimedResultCount: number | null;
  parsedCount: number;
  complete: boolean;
  incompleteReason?: string;
  /** Set ONLY on a proven empty result — quotes the page's own no-results text. */
  zeroProof?: string;
}

const NO_RESULTS_RE = /\bno (?:results|flights|options)\b[^<>.]{0,80}/i;

export type ZeroParseVerdict =
  | { kind: "proven-empty"; marker: string; message?: undefined }
  | { kind: "parse-failure" | "not-a-measurement"; marker?: undefined; message: string };

/**
 * Classifies a zero-itinerary parse:
 *   (a) PARSE FAILURE when the page renders rows the parser missed;
 *   (b) proven empty ONLY when the source's own published count says 0;
 *   (c) NOT A MEASUREMENT for everything else, fail-closed. A bare "no flights" phrase
 *       is not proof — hidden empty-state templates carry the same words.
 */
export function classifyZeroParse(
  rows: number,
  text: string,
  htmlBytes: number,
  claimedResultCount: number | null,
): ZeroParseVerdict {
  if (rows > 0) {
    return {
      kind: "parse-failure",
      message:
        `travel-search: PARSE FAILURE — the page renders ${rows} itinerary rows but the parser extracted 0. ` +
        `The page shape has changed; refusing to report an empty result as a measurement.`,
    };
  }
  const marker = NO_RESULTS_RE.exec(text)?.[0]?.trim();
  if (claimedResultCount === 0) {
    return { kind: "proven-empty", marker: marker ?? "0 results returned" };
  }
  return {
    kind: "not-a-measurement",
    message:
      `travel-search: NOT A MEASUREMENT — the page shows no itinerary rows and the source did not publish a ` +
      `zero count (${htmlBytes} bytes read${marker ? `; a "${marker}" phrase is present but unrendered-page templates carry the same words, so it does not count as proof` : ""}). ` +
      `Cannot distinguish "no flights" from "did not render".`,
  };
}

export function googleFlightsUrl(origin: string, destination: string, isoDate: string, airlineName?: string): string {
  const q = `Flights from ${origin} to ${destination} on ${isoDate} oneway${airlineName ? ` on ${airlineName}` : ""}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

/**
 * Drives Google Flights for one date/direction. Paced and jittered per config so the
 * access pattern never looks mechanical.
 */
export async function collectGoogleFlights(
  origin: string,
  destination: string,
  isoDate: string,
  airlineName: string | undefined,
  cfg: Config,
): Promise<CollectResult> {
  const sched = cfg.sources.schedule as Record<string, unknown>;
  const pace = num(sched, "pacing_ms", 4000);
  const jitter = num(sched, "jitter_ms", 1500);
  const cmd = driverCommand(cfg);
  await acquireBrowserLock();

  const opened = await driver(cmd, ["open", googleFlightsUrl(origin, destination, isoDate, airlineName)]);
  // A read that cannot be pinned to the tab we opened may drift to whichever tab last
  // loaded — in a round-trip search that is the PREVIOUS direction's results.
  let tabId: number | undefined;
  try {
    const t = JSON.parse(opened).tabId;
    if (Number.isInteger(t) && t > 0) tabId = t;
  } catch {
    /* handled below */
  }
  if (tabId === undefined) {
    throw new Error(
      `travel-search: could not pin the results tab — '${cmd[0]} open' returned ${opened.trim().slice(0, 200)}. ` +
        `Refusing an unpinned read; it can return a different tab's data as this route's.`,
    );
  }
  await sleep(pace + Math.random() * jitter + 12_000);

  const readArgs = ["read", "--tab", String(tabId)];

  // Settle loop: a read that races the renderer returns neither rows nor a result
  // marker. Re-reads hit the already-loaded tab (local DOM, no new requests). Settled
  // = the source published its count, or the row count is stable across two reads.
  const READS = 5;
  let html = "";
  let text = "";
  let rows = 0;
  let prevRows = -1;
  let lastReadError = "";
  for (let attempt = 1; attempt <= READS; attempt++) {
    const raw = await driver(cmd, readArgs, 90_000);
    try {
      const parsed = JSON.parse(raw);
      html = parsed.html ?? "";
      if (!html && parsed.error) lastReadError = String(parsed.error);
    } catch {
      html = raw;
    }
    prevRows = rows;
    rows = (html.match(/<li class="pIav2d/g) ?? []).length;
    text = stripTags(html);
    // Challenge detection: title region + RENDERED text only. Every benign Google
    // Flights page carries "captcha" in its script blob, so never scan the raw html.
    if (
      /Challenge Validation|unusual traffic|captcha/i.test(html.slice(0, 4000)) ||
      /Challenge Validation|unusual traffic|captcha/i.test(text)
    ) {
      throw new Error("travel-search: source returned a bot challenge. Stopping and backing off — no retry.");
    }
    if (/\d+\s+results?\s+returned/i.test(text) || (rows > 0 && rows === prevRows)) break;
    if (attempt < READS) await sleep(4_000);
  }

  const claimed = /(\d+)\s+results?\s+returned/.exec(text);
  const claimedResultCount = claimed ? Number(claimed[1]) : null;

  // Primary: aria-labels in raw html. Fallback: the visible-text regex.
  const aria = parseGoogleFlightsAriaLabels(html, origin, destination);
  let itineraries = aria.itineraries;
  if (itineraries.length === 0 && aria.candidateCount === 0) {
    itineraries = parseGoogleFlightsSummaries(text, origin, destination);
  }

  if (itineraries.length === 0) {
    const zero = classifyZeroParse(rows, text, html.length, claimedResultCount);
    if (zero.kind !== "proven-empty") {
      throw new Error(zero.message + (lastReadError ? ` Last read error: ${lastReadError}.` : ""));
    }
    return { itineraries: [], claimedResultCount, parsedCount: 0, complete: true, zeroProof: zero.marker };
  }
  // A partial parse is not data — a dropped row can be the winner. The raw page is
  // saved so an unknown label variant can become a test fixture.
  if (aria.dropped.length > 0 || (aria.candidateCount > 0 && itineraries.length < aria.candidateCount)) {
    const dump = join(tmpdir(), `travel-search-parse-degraded-${Date.now()}.html`);
    writeFileSync(dump, html);
    throw new Error(
      `travel-search: PARSE DEGRADED — ${aria.candidateCount} itinerary labels on the page, ${itineraries.length} parsed, ` +
        `${aria.dropped.length} dropped. Refusing partial data (a dropped row can be the winner). ` +
        `Raw page saved to ${dump}. First dropped label: "${aria.dropped[0] ?? "n/a"}"`,
    );
  }
  // The rows must be THIS query's page: route from the page's own route line, date
  // from every label's departure date.
  const routeRe = new RegExp(`\\b${origin}\\b[^–]{1,160}–\\s*${destination}\\b`);
  if (!routeRe.test(text)) {
    throw new Error(
      `travel-search: WRONG PAGE — the page never pairs ${origin} → ${destination} in its route line. ` +
        `The read may have hit a different tab or route; refusing to label its data ${origin}→${destination}.`,
    );
  }
  if (aria.departureDates.length > 0) {
    const [y, mo, d] = isoDate.split("-").map(Number);
    const expected = new Date(y, mo - 1, d).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const mismatched = aria.departureDates.filter((x) => x !== expected);
    if (mismatched.length > 0) {
      throw new Error(
        `travel-search: WRONG DATE — requested ${isoDate} ("${expected}") but ${mismatched.length}/${aria.departureDates.length} ` +
          `parsed labels depart "${mismatched[0]}". The read likely hit a stale tab; refusing to report it as ${isoDate}.`,
      );
    }
  }

  const complete = claimedResultCount === null ? false : itineraries.length >= claimedResultCount;
  return {
    itineraries,
    claimedResultCount,
    parsedCount: itineraries.length,
    complete,
    incompleteReason: complete
      ? undefined
      : claimedResultCount === null
        ? "source published no result count — completeness cannot be asserted"
        : `source published ${claimedResultCount} results, parsed ${itineraries.length}; expand "View more flights" before trusting this set`,
  };
}

/**
 * Airport display names (as Google prints them in layover sentences) → IATA codes.
 * Reference data, not config. Unknown names pass through verbatim: the general
 * connection floor still applies; only per-airport floor lookup needs the code.
 * Order matters where names overlap (Dallas Fort Worth before Dallas Love).
 */
const AIRPORT_NAME_TO_CODE: [RegExp, string][] = [
  [/O'Hare/i, "ORD"],
  [/Midway/i, "MDW"],
  [/Sky Harbor/i, "PHX"],
  [/Charlotte Douglas/i, "CLT"],
  [/Philadelphia International/i, "PHL"],
  [/Dallas Fort Worth/i, "DFW"],
  [/Dallas Love/i, "DAL"],
  [/Reagan Washington National/i, "DCA"],
  [/Washington Dulles/i, "IAD"],
  [/Baltimore/i, "BWI"],
  [/Los Angeles International/i, "LAX"],
  [/San Francisco International/i, "SFO"],
  [/San Diego International/i, "SAN"],
  [/Seattle-Tacoma|Seattle–Tacoma/i, "SEA"],
  [/Portland International/i, "PDX"],
  [/John F\.? Kennedy/i, "JFK"],
  [/LaGuardia/i, "LGA"],
  [/Newark Liberty/i, "EWR"],
  [/Logan International/i, "BOS"],
  [/Miami International/i, "MIA"],
  [/Fort Lauderdale/i, "FLL"],
  [/Orlando International/i, "MCO"],
  [/Hartsfield|Atlanta International/i, "ATL"],
  [/Denver International/i, "DEN"],
  [/George Bush Intercontinental/i, "IAH"],
  [/William P\.? Hobby/i, "HOU"],
  [/Detroit Metropolitan/i, "DTW"],
  [/Minneapolis/i, "MSP"],
  [/Salt Lake City International/i, "SLC"],
  [/Harry Reid/i, "LAS"],
  [/Austin-Bergstrom|Austin–Bergstrom/i, "AUS"],
  [/Nashville International/i, "BNA"],
  [/Raleigh-Durham|Raleigh–Durham/i, "RDU"],
  [/Kansas City International/i, "MCI"],
  [/St\.? Louis Lambert/i, "STL"],
  [/Honolulu|Daniel K\.? Inouye/i, "HNL"],
];

export function airportCode(displayName: string): string {
  for (const [re, code] of AIRPORT_NAME_TO_CODE) if (re.test(displayName)) return code;
  return displayName.trim();
}

export const MARKETING_TO_IATA: Record<string, string> = {
  American: "AA",
  Delta: "DL",
  United: "UA",
  Alaska: "AS",
  Southwest: "WN",
  JetBlue: "B6",
  Hawaiian: "HA",
  Frontier: "F9",
  Spirit: "NK",
  "Sun Country": "SY",
  Allegiant: "G4",
  Breeze: "MX",
};

function decodeAttr(v: string): string {
  return v
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

export interface AriaParseResult {
  itineraries: Itinerary[];
  /** Unique labels that LOOK like itinerary labels (permissive counter, independent of the strict parse). */
  candidateCount: number;
  /** Labels that looked like itineraries but failed the strict parse — each one is surfaced, never skipped. */
  dropped: string[];
  /** The departure-date phrase from each parsed label ("Sunday, August 30"). */
  departureDates: string[];
}

/**
 * PRIMARY parser: reads the itinerary aria-labels from RAW html. The accessibility text
 * carries price, stops, carrier, operated-by, dep/arr times WITH dates (so +1 is
 * measured, not inferred), total duration, and each layover's printed minutes and
 * airport. Emits a single pseudo-segment (aircraft "not expanded") so a summary row
 * can be ruled and scored without fabricating metal.
 */
export function parseGoogleFlightsAriaLabels(rawHtml: string, origin: string, destination: string): AriaParseResult {
  const itineraries: Itinerary[] = [];
  const dropped: string[] = [];
  const departureDates: string[] = [];
  const seen = new Set<string>();
  let candidateCount = 0;
  const labelRe = /aria-label="(From [^"]{100,}?)"/g;
  let lm: RegExpExecArray | null;
  while ((lm = labelRe.exec(rawHtml)) !== null) {
    const label = decodeAttr(lm[1]);
    if (seen.has(label)) continue;
    seen.add(label);

    // Permissive candidate test, deliberately looser than the strict parse, so a
    // phrasing drift shows up as candidates > parsed instead of rows vanishing.
    const isCandidate = / flight with /.test(label) && /\d{1,2}:\d{2} [AP]M/.test(label);
    if (!isCandidate) continue;
    candidateCount++;

    const legs =
      /Leaves .+? at (\d{1,2}:\d{2} [AP]M) on ([A-Za-z]+, [A-Za-z]+ \d{1,2}) and arrives at .+? at (\d{1,2}:\d{2} [AP]M) on ([A-Za-z]+, [A-Za-z]+ \d{1,2})/.exec(
        label,
      );
    const dur = /Total duration (?:(\d+) hr ?)?(?:(\d+) min)?\./.exec(label);
    const declaredStops = /\bNonstop flight with /.test(label)
      ? 0
      : Number(/(\d+) stops? flight with /.exec(label)?.[1] ?? NaN);
    if (!legs || !dur || (dur[1] === undefined && dur[2] === undefined) || Number.isNaN(declaredStops)) {
      dropped.push(label.slice(0, 220));
      continue;
    }

    const connections: Connection[] = [];
    let badConnection = false;
    for (const c of label.matchAll(/Layover \(\d+ of \d+\) is a (?:(\d+) hr ?)?(?:(\d+) min )?layover at (.+?) in .+?\./g)) {
      const minutes = Number(c[1] ?? 0) * 60 + Number(c[2] ?? 0);
      // An unparsed layover duration would fabricate a 0-minute connection.
      if (minutes <= 0) {
        badConnection = true;
        break;
      }
      connections.push({ airport: airportCode(c[3]), minutes });
    }
    // Parsed layovers must agree with the label's own stop count, or a phrasing drift
    // silently turns a connection into a "nonstop" that skips every floor.
    if (badConnection || connections.length !== declaredStops) {
      dropped.push(label.slice(0, 220));
      continue;
    }

    const price = /^From (\d[\d,]*) US dollars/.exec(label);
    const carrier = /(?:Nonstop|\d+ stops?) flight with ([A-Za-z][A-Za-z ]*?)\./.exec(label);
    const oper = /\. Operated by ([^.]+)\./.exec(label);
    const plusOne = legs[2] !== legs[4];

    const marketing = carrier?.[1]?.trim() ?? "?";
    departureDates.push(legs[2]);
    itineraries.push({
      segments: [
        {
          marketingAirline: MARKETING_TO_IATA[marketing] ?? marketing,
          flightNumber: "?",
          origin,
          destination,
          departLocal: to24h(legs[1]),
          arriveLocal: to24h(legs[3]),
          arriveDayOffset: plusOne ? 1 : 0,
          aircraft: "not expanded",
          ...(oper ? { operatedBy: oper[1] } : {}),
        },
      ],
      measuredConnections: connections,
      totalDurationMinutes: Number(dur[1] ?? 0) * 60 + Number(dur[2] ?? 0),
      ...(price ? { priceFrom: Number(price[1].replace(/,/g, "")), currency: "USD" } : {}),
      sourceLabel: label.slice(0, 220),
    });
  }
  return { itineraries, candidateCount, dropped, departureDates };
}

/**
 * FALLBACK parser over stripped visible text, for markup variants without aria-labels.
 * Handles Google's duplicated time markup ("4:54 PM 4:54 PM on Sun, Aug 30") on both
 * the departure and the arrival side.
 */
export function parseGoogleFlightsSummaries(text: string, origin: string, destination: string): Itinerary[] {
  const out: Itinerary[] = [];
  const seen = new Set<string>();
  const re =
    /(\d{1,2}:\d{2}\s?[AP]M)\s+\1?\s*(?:on [^–]+)?–\s+(\d{1,2}:\d{2}\s?[AP]M)(?:\s+\2)?(\s*\+1)?\s+[^A-Za-z]*?on [^A-Za-z]*?[A-Za-z]+, \w+ \d+\s+(.{0,80}?)\s+(\d+) hr(?: (\d+) min)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const dep12 = m[1];
    const arr12 = m[2];
    const plusOne = Boolean(m[3]);
    const carrierBlurb = m[4] ?? "";
    const hrs = Number(m[5]);
    const mins = Number(m[6] ?? 0);
    // Carrier is part of identity: two airlines with identical times are two itineraries.
    const key = `${dep12}|${arr12}|${hrs}:${mins}|${carrierBlurb.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const marketing = /with ([A-Za-z]+)/.exec(carrierBlurb)?.[1] ?? carrierBlurb.trim().split(/\s+/)[0] ?? "?";
    out.push({
      segments: [
        {
          marketingAirline: MARKETING_TO_IATA[marketing] ?? marketing,
          flightNumber: "?",
          origin,
          destination,
          departLocal: to24h(dep12.replace(/\s?([AP]M)/, " $1")),
          arriveLocal: to24h(arr12.replace(/\s?([AP]M)/, " $1")),
          arriveDayOffset: plusOne ? 1 : 0,
          aircraft: "not expanded",
        },
      ],
      totalDurationMinutes: hrs * 60 + mins,
      sourceLabel: `${dep12} -> ${arr12}${plusOne ? " +1" : ""} | ${carrierBlurb.trim()}`,
    });
  }
  return out;
}

/** "7:25 AM" -> "07:25" */
export function to24h(t12: string): string {
  const m = /^(\d{1,2}):(\d{2})\s?([AP]M)$/i.exec(t12.trim());
  if (!m) throw new Error(`travel-search: bad 12h time "${t12}"`);
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** Google Flights' airline filter name for a carrier code ("UA" -> "United"), or undefined. */
export function airlineNameFor(code: string): string | undefined {
  const c = code.trim().toUpperCase();
  return Object.entries(MARKETING_TO_IATA).find(([, iata]) => iata === c)?.[0];
}
