/**
 * time.ts — local clock times to real instants.
 *
 * Sources print local times. Durations and connections across time zones need each
 * airport's IANA zone: the built-in table of every IATA airport, overridden by `airport_tz` in
 * your config. An airport with no zone in either gives
 * an undefined duration, which callers report; it is never guessed.
 */

import type { Config } from "./painfulness.ts";
import BUILT_IN_ZONES from "./data/airport-tz.json" with { type: "json" };

/** IANA zone for every airport with an IATA code (mwgg/Airports, MIT; see data/README.md). */
export const AIRPORT_ZONES: Readonly<Record<string, string>> = BUILT_IN_ZONES;

/** The config's airport_tz wins (to correct or add an airport); otherwise the built-in table. */
export function airportZone(cfg: Config, airport: string): string | undefined {
  const code = airport.trim().toUpperCase();
  const v = (cfg.airport_tz ?? {})[code];
  if (typeof v === "string" && v.trim()) return v.trim();
  return AIRPORT_ZONES[code];
}

/** Epoch ms for a local date (YYYY-MM-DD) and time (HH:MM, 24h) in an IANA zone. */
export function zonedEpoch(isoDate: string, hhmm: string, tz: string): number {
  const dm = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!dm) throw new Error(`unparseable date "${isoDate}" (want YYYY-MM-DD)`);
  if (!tm) throw new Error(`unparseable time "${hhmm}" (want HH:MM)`);
  const wall = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  // Resolve the zone's offset at about that instant, then correct once for DST edges.
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - offsetMinutes(new Date(guess), tz) * 60_000;
  return guess;
}

function offsetMinutes(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

export function minutesBetween(a: number, b: number): number {
  return Math.round((b - a) / 60_000);
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
