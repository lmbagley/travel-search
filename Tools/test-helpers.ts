/** Shared test fixtures. Declared here so tests never depend on anyone's live config. */
import type { Config, Itinerary, Segment } from "./painfulness.ts";

export const CFG: Config = {
  traveler: { name: "T", home_airports: ["ORD"] },
  defaults: { airline: "AA", prefer_mainline: true },
  painfulness: {
    hard: {
      no_redeye: true,
      redeye_window: { start: "23:00", end: "05:00" },
      reject_overnight_arrival: true,
      depart_not_before: "06:30",
      arrive_not_after: "22:00",
      min_connection_minutes: 60,
      min_connection_minutes_by_airport: { DFW: 75, ORD: 75, PHX: 60 },
    },
    scored: {
      arrival_window: { start: "13:00", end: "19:00", weight: 30 },
      connection_sweet: { min_minutes: 75, max_minutes: 165, weight: 25 },
      mainline_metal: { weight: 20 },
      departure_window: { start: "07:00", end: "11:30", weight: 15 },
      total_duration: { weight: 10 },
    },
  },
  seating: { want_open_middle: true, never_guess_rows: true },
  sources: {
    seatmap: { provider: "example", enabled: false },
    schedule: { provider: "google_flights", pacing_ms: 4000, jitter_ms: 1500 },
  },
};

export function seg(p: Partial<Segment> & Pick<Segment, "departLocal" | "arriveLocal">): Segment {
  return { marketingAirline: "AA", flightNumber: "1", origin: "AAA", destination: "BBB", aircraft: "Airbus A321", ...p };
}

export function oneStop(
  dep: string,
  viaArr: string,
  viaDep: string,
  arr: string,
  via = "DFW",
  opts: { operatedBy?: string; arriveDayOffset?: number; duration?: number } = {},
): Itinerary {
  return {
    segments: [
      seg({ departLocal: dep, arriveLocal: viaArr, destination: via, operatedBy: opts.operatedBy }),
      seg({
        departLocal: viaDep,
        arriveLocal: arr,
        origin: via,
        flightNumber: "2",
        operatedBy: opts.operatedBy,
        arriveDayOffset: opts.arriveDayOffset,
      }),
    ],
    totalDurationMinutes: opts.duration ?? 424,
    sourceLabel: "test",
  };
}

