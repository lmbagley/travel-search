/**
 * painfulness.ts — the pure ranking core. No I/O.
 *
 * Turns a config-declared painfulness model into a deterministic ranking:
 *   - hard rules REJECT (redeye, too early, too late, next-day arrival, tight connection)
 *   - scored rules RANK the survivors (arrival window, connection comfort, mainline
 *     metal, departure window, total duration as a tie-breaker)
 *
 * Every weight and threshold comes from config. Nothing in this file is specific to a
 * traveler, an airline, or a route.
 */

// ─────────────────────────────── types ───────────────────────────────

export interface Segment {
  marketingAirline: string; // e.g. "AA"
  flightNumber: string; // e.g. "1234"
  origin: string;
  destination: string;
  departLocal: string; // "HH:MM"
  arriveLocal: string; // "HH:MM"
  departDayOffset?: number; // 0 = search date
  arriveDayOffset?: number;
  aircraft: string; // as printed by the source
  operatedBy?: string; // set when a regional carrier operates it
}

export interface Itinerary {
  /**
   * Per-leg detail when the source's expanded view was read. When only the collapsed
   * summary was read, this holds a SINGLE pseudo-segment carrying the true first
   * departure and true final arrival, with `aircraft: "not expanded"` — never invented
   * intermediate times. Pair it with `measuredConnections`.
   */
  segments: Segment[];
  /**
   * Layovers as PRINTED by the source. Takes precedence over deriving them from
   * segment times, so a summary-only itinerary is still ruled on with real numbers
   * instead of a plausible reconstruction.
   */
  measuredConnections?: Connection[];
  totalDurationMinutes: number;
  /**
   * The source's headline price. DANGEROUS ON ITS OWN — it is frequently a Basic
   * Economy fare that forbids seat selection outright. Always read `fares` alongside it.
   */
  priceFrom?: number;
  currency?: string;
  /** Fare-brand ladder as printed by the source, cheapest first. */
  fares?: FareBrand[];
  sourceLabel: string; // raw text this was parsed from — provenance
}

export interface FareBrand {
  brand: string; // "Basic Economy", "Main Cabin", "Main Plus", ...
  price: number;
  freeSeatSelection: boolean;
  extraLegroomIncluded: boolean;
}

export interface Connection {
  airport: string;
  minutes: number;
}

export type RejectReason =
  | "redeye"
  | "overnight-arrival"
  | "departs-too-early"
  | "arrives-too-late"
  | "connection-below-floor";

export interface Verdict {
  itinerary: Itinerary;
  rejected: RejectReason[];
  score: number;
  breakdown: Record<string, number>;
  connections: Connection[];
  mainlineOnly: boolean;
  notes: string[];
}

export interface Config {
  traveler?: {
    name?: string;
    home_airports?: string[];
    programs?: { airline: string; number?: string; status?: string }[];
  };
  defaults: { airline: string; cabin?: string; prefer_mainline?: boolean };
  painfulness: {
    hard: {
      no_redeye?: boolean;
      redeye_window?: { start: string; end: string };
      reject_overnight_arrival?: boolean;
      depart_not_before?: string;
      arrive_not_after?: string;
      min_connection_minutes?: number;
      min_connection_minutes_by_airport?: Record<string, number>;
    };
    scored: Record<string, Record<string, unknown>>;
  };
  seating?: {
    preference_order?: string[];
    want_open_middle?: boolean;
    never_guess_rows?: boolean;
    extra_legroom_bulkhead_preferred?: boolean;
    mce_bulkhead_preferred?: boolean; // older name for the line above
  };
  sources: Record<string, Record<string, unknown>>;
  output?: Record<string, unknown>;
  /** Per airline, per aircraft code: { exit_rows, extra_legroom_rows, bulkhead_rows, source }. */
  seat_data?: Record<string, Record<string, Record<string, unknown>>>;
  /** IATA airport -> IANA time zone, for trip lengths and connections across zones. */
  airport_tz?: Record<string, string>;
  upgrade_estimate?: unknown;
  monitor?: unknown;
}

// ─────────────────────────── time helpers ───────────────────────────

/** "HH:MM" -> minutes past midnight. Throws rather than returning a wrong number. */
export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`travel-search: bad time "${hhmm}" (want HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`travel-search: out-of-range time "${hhmm}"`);
  return h * 60 + min;
}

/** Absolute minutes from the search-date midnight, accounting for +N day offsets. */
function absolute(time: string, dayOffset = 0): number {
  return dayOffset * 1440 + toMinutes(time);
}

/** True when `t` falls inside a window that may wrap past midnight. */
export function inWindow(t: number, start: number, end: number): boolean {
  return start <= end ? t >= start && t <= end : t >= start || t <= end;
}

export function connectionsOf(it: Itinerary): Connection[] {
  // Printed layovers beat reconstructed ones.
  if (it.measuredConnections?.length) return it.measuredConnections;
  const out: Connection[] = [];
  for (let i = 0; i < it.segments.length - 1; i++) {
    const arr = it.segments[i];
    const dep = it.segments[i + 1];
    out.push({
      airport: arr.destination,
      minutes:
        absolute(dep.departLocal, dep.departDayOffset ?? 0) -
        absolute(arr.arriveLocal, arr.arriveDayOffset ?? 0),
    });
  }
  return out;
}

export function isMainlineOnly(it: Itinerary): boolean {
  return it.segments.every((s) => !s.operatedBy);
}

// ───────────────────────────── hard rules ─────────────────────────────

export function applyHardRules(it: Itinerary, cfg: Config): RejectReason[] {
  const h = cfg.painfulness.hard;
  const reasons: RejectReason[] = [];
  const first = it.segments[0];
  const last = it.segments[it.segments.length - 1];

  const dep = toMinutes(first.departLocal);
  const arr = toMinutes(last.arriveLocal);
  const arrOffset = last.arriveDayOffset ?? 0;

  if (h.no_redeye && h.redeye_window) {
    const s = toMinutes(h.redeye_window.start);
    const e = toMinutes(h.redeye_window.end);
    // Departing into the red-eye window, or landing out of it, is a red-eye.
    if (inWindow(dep, s, e) || inWindow(arr, s, e)) reasons.push("redeye");
  }
  if (h.reject_overnight_arrival && arrOffset > 0 && !reasons.includes("redeye")) {
    reasons.push("overnight-arrival");
  }
  if (h.depart_not_before && dep < toMinutes(h.depart_not_before)) {
    reasons.push("departs-too-early");
  }
  if (h.arrive_not_after && arrOffset === 0 && arr > toMinutes(h.arrive_not_after)) {
    reasons.push("arrives-too-late");
  }

  for (const c of connectionsOf(it)) {
    const floor = h.min_connection_minutes_by_airport?.[c.airport] ?? h.min_connection_minutes ?? 0;
    if (c.minutes < floor) {
      if (!reasons.includes("connection-below-floor")) reasons.push("connection-below-floor");
    }
  }
  return reasons;
}

// ─────────────────────────────── scoring ───────────────────────────────

export function num(o: Record<string, unknown> | undefined, k: string, dflt = 0): number {
  const v = o?.[k];
  return typeof v === "number" ? v : dflt;
}
export function str(o: Record<string, unknown> | undefined, k: string): string | undefined {
  const v = o?.[k];
  return typeof v === "string" ? v : undefined;
}

/**
 * Score in [0, sum(weights)]. Each rule returns a 0..1 fit multiplied by its weight,
 * so re-weighting in config changes ranking without touching this file.
 */
export function scoreItinerary(
  it: Itinerary,
  cfg: Config,
  fleetShortest?: number,
): { score: number; breakdown: Record<string, number> } {
  const s = cfg.painfulness.scored;
  const breakdown: Record<string, number> = {};
  const last = it.segments[it.segments.length - 1];
  const first = it.segments[0];

  // Arrival window — decays by hours outside. Inside, an optional earlier_gradient
  // makes EARLIER arrivals outrank later ones (0 or absent = flat window). Late
  // arrivals decay from the window-END fit, never from full marks, so a 19:01
  // arrival can never outscore an 18:59 one.
  {
    const r = s.arrival_window;
    const w = num(r, "weight");
    if (w) {
      const a = toMinutes(last.arriveLocal);
      const st = toMinutes(str(r, "start") ?? "00:00");
      const en = toMinutes(str(r, "end") ?? "23:59");
      const g = Math.min(1, Math.max(0, num(r, "earlier_gradient", 0)));
      const miss = a < st ? st - a : a > en ? a - en : 0;
      let fit: number;
      if (miss === 0) {
        fit = 1 - g * ((a - st) / Math.max(1, en - st));
      } else if (a > en) {
        fit = (1 - g) * Math.max(0, 1 - miss / 240);
      } else {
        fit = Math.max(0, 1 - miss / 240);
      }
      breakdown.arrival_window = w * fit;
    }
  }

  // Connection comfort — full marks inside the band, decaying either side.
  {
    const r = s.connection_sweet;
    const w = num(r, "weight");
    const conns = connectionsOf(it);
    if (w) {
      if (conns.length === 0) {
        breakdown.connection_sweet = w; // nonstop is maximally comfortable
      } else {
        const lo = num(r, "min_minutes", 0);
        const hi = num(r, "max_minutes", 1440);
        const fits = conns.map((c) => {
          const miss = c.minutes < lo ? lo - c.minutes : c.minutes > hi ? c.minutes - hi : 0;
          return Math.max(0, 1 - miss / 120);
        });
        breakdown.connection_sweet = w * Math.min(...fits);
      }
    }
  }

  // Mainline metal.
  {
    const w = num(s.mainline_metal, "weight");
    if (w) {
      const mainline = it.segments.filter((x) => !x.operatedBy).length;
      breakdown.mainline_metal = w * (mainline / it.segments.length);
    }
  }

  // Departure window.
  {
    const r = s.departure_window;
    const w = num(r, "weight");
    if (w) {
      const d = toMinutes(first.departLocal);
      const st = toMinutes(str(r, "start") ?? "00:00");
      const en = toMinutes(str(r, "end") ?? "23:59");
      const miss = d < st ? st - d : d > en ? d - en : 0;
      breakdown.departure_window = w * Math.max(0, 1 - miss / 240);
    }
  }

  // Total duration — relative to the SHORTEST option actually offered: the shortest
  // gets full marks, a trip twice as long gets a quarter. (An earlier version divided
  // the LONGEST by each trip, which is >= 1 for every trip, so every trip got full marks
  // and the tie-breaker never broke a tie — a 15h one-stop tied an 11h nonstop.)
  {
    const w = num(s.total_duration, "weight");
    if (w) {
      const shortest = fleetShortest && fleetShortest > 0 ? fleetShortest : it.totalDurationMinutes;
      breakdown.total_duration = w * Math.max(0, Math.min(1, shortest / it.totalDurationMinutes) ** 2);
    }
  }

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score: Math.round(score * 10) / 10, breakdown };
}

export function rank(itins: Itinerary[], cfg: Config): Verdict[] {
  const durations = itins.map((i) => i.totalDurationMinutes).filter((d) => d > 0);
  const shortest = durations.length ? Math.min(...durations) : 0;
  return itins
    .map((it) => {
      const rejected = applyHardRules(it, cfg);
      const { score, breakdown } = scoreItinerary(it, cfg, shortest);
      const connections = connectionsOf(it);
      const mainlineOnly = isMainlineOnly(it);
      const notes: string[] = [];
      if (!mainlineOnly) {
        notes.push(
          "regional metal on at least one leg — no true exit row, and a smaller cabin to pick from",
        );
      }
      for (const c of connections) {
        const floor =
          cfg.painfulness.hard.min_connection_minutes_by_airport?.[c.airport] ??
          cfg.painfulness.hard.min_connection_minutes ??
          0;
        if (c.minutes < floor + 15 && c.minutes >= floor) {
          notes.push(`${c.airport} connection ${c.minutes}m is only just above the ${floor}m floor`);
        }
      }
      return { itinerary: it, rejected, score, breakdown, connections, mainlineOnly, notes };
    })
    .sort((a, b) => {
      if (a.rejected.length !== b.rejected.length) return a.rejected.length - b.rejected.length;
      return b.score - a.score;
    });
}

// ───────────────────────────── fare gate ─────────────────────────────

/**
 * The cheapest fare brand that actually lets you choose a seat. The headline price is
 * routinely Basic Economy, where seats are auto-assigned. Returns null when the source
 * published no fare ladder — reported as unknown, never assumed fine.
 */
export function seatableFare(it: Itinerary): FareBrand | null {
  if (!it.fares?.length) return null;
  const ok = it.fares.filter((f) => f.freeSeatSelection).sort((a, b) => a.price - b.price);
  return ok[0] ?? null;
}

/** The cheapest brand that includes extra legroom (the bucket exit rows sit in). */
export function legroomFare(it: Itinerary): FareBrand | null {
  if (!it.fares?.length) return null;
  const ok = it.fares.filter((f) => f.extraLegroomIncluded).sort((a, b) => a.price - b.price);
  return ok[0] ?? null;
}

// ─────────────────────────── completeness ───────────────────────────

/**
 * Hard completeness assertion so a silently-truncated set is never ranked as if it
 * were the whole population. `parsed >= claimed` is the only thing that counts as
 * complete; a missing claim is NOT complete.
 */
export function assertComplete(parsed: number, claimed: number | null | undefined): {
  complete: boolean;
  reason?: string;
} {
  if (claimed === null || claimed === undefined) {
    return { complete: false, reason: "source published no result count — completeness cannot be asserted" };
  }
  if (parsed >= claimed) return { complete: true };
  return {
    complete: false,
    reason: `source published ${claimed} results, parsed ${parsed} — expand "View more flights" and re-read before trusting this set`,
  };
}

// ─────────────────────────────── rendering ───────────────────────────────

export function renderTable(verdicts: Verdict[], cfg: Config): string {
  const programAirline = cfg.defaults.airline;
  const label = (str(cfg.output, "loyalty_label") ?? "Prog").slice(0, 4);
  const lines: string[] = [];
  lines.push(
    `Dep (local)  Flt#     Via   Layover  Via dep   Arrive (local)  Metal        Price  ${label.padEnd(3)} Score  Verdict`,
  );
  lines.push("─".repeat(112));
  for (const v of verdicts) {
    const it = v.itinerary;
    const f = it.segments[0];
    const l = it.segments[it.segments.length - 1];
    const c = v.connections[0];
    const verdict = v.rejected.length ? `REJECT: ${v.rejected.join(",")}` : "eligible";
    // "yes" = every leg is mainline AND marketed by your program airline.
    const prog = v.mainlineOnly && f?.marketingAirline === programAirline ? "yes" : "part";
    lines.push(
      [
        (f?.departLocal ?? "?").padEnd(12),
        `${f?.marketingAirline ?? ""}${f?.flightNumber ?? "?"}`.padEnd(8),
        (c?.airport ?? "nonstop").padEnd(5),
        `${c ? `${Math.floor(c.minutes / 60)}h${String(c.minutes % 60).padStart(2, "0")}` : "-"}`.padEnd(8),
        (it.segments[1]?.departLocal ?? "-").padEnd(9),
        (l?.arriveLocal ?? "?").padEnd(15),
        (f?.aircraft ?? "?").slice(0, 12).padEnd(12),
        (it.priceFrom ? `$${it.priceFrom}` : "-").padEnd(6),
        prog.padEnd(3),
        String(v.score).padEnd(6),
        verdict,
      ].join(" "),
    );
  }
  return lines.join("\n");
}
