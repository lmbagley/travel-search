/**
 * Seat-monitor rules. Every flight, seat
 * and date here is made up; each regression keeps the shape of the failure it pins.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DEPART_TIME,
  DISCORD_CONTENT_LIMIT,
  MOVE_LINE,
  MONITOR_STATE_VERSION,
  alertMessage,
  comparableTier,
  currentSeatTierFrom,
  departTimeOf,
  diffForAlert,
  emptyState,
  failureMessage,
  hoursToDeparture,
  intervalMinutes,
  isDue,
  isPrunable,
  normalizeDateISO,
  parseState,
  phaseOf,
  pruneDeparted,
  rungLabel,
  shouldAlertFailure,
  validateMonitorConfig,
  watchKey,
  type AlertDiff,
  type MonitorCadence,
  type MonitorConfig,
  type MonitorState,
  type MonitorWatch,
  type SeatSnapshot,
  type WatchState,
} from "./monitor.ts";
import { scrubWebhook } from "./notify.ts";

const cadence: MonitorCadence = {
  far_hours: 48,
  hot_hours: 8,
  far_every_min: 240,
  near_every_min: 60,
  hot_every_min: 25,
};

const watch: MonitorWatch = {
  airline: "UA",
  flightNumber: "1234",
  origin: "ORD",
  destination: "DEN",
  date: "2027-03-10",
  current_seat: "14C",
  depart_time: "07:25",
};

const prefs = ["exit_row_aisle", "exit_row_window", "mce_aisle", "mce_window"];

function state(seats: SeatSnapshot, alertedSeatIds: string[] = []): WatchState {
  return {
    lastChecked: 1,
    consecutiveFailures: 0,
    failureAlerted: false,
    seats,
    alertedSeatIds,
  };
}

function snap(entries: readonly [string, number, string?][]): SeatSnapshot {
  const out: SeatSnapshot = {};
  for (const [id, tier, seatState] of entries) out[id] = { tier, state: seatState ?? "available" };
  return out;
}

function expectThrowMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err.message;
    return String(err);
  }
  throw new Error("expected function to throw");
}

describe("monitor cadence", () => {
  test("phaseOf uses tighter cadence on exact boundaries", () => {
    expect(phaseOf(cadence.hot_hours, cadence)).toBe("hot");
    expect(phaseOf(cadence.far_hours, cadence)).toBe("near");
    expect(phaseOf(cadence.far_hours + 0.01, cadence)).toBe("far");
    expect(phaseOf(cadence.hot_hours - 0.01, cadence)).toBe("hot");
    expect(phaseOf(-0.01, cadence)).toBe("departed");
    expect(phaseOf(0, cadence)).toBe("hot");
  });

  test("intervalMinutes maps active phases and omits departed", () => {
    expect(intervalMinutes("far", cadence)).toBe(240);
    expect(intervalMinutes("near", cadence)).toBe(60);
    expect(intervalMinutes("hot", cadence)).toBe(25);
    expect(intervalMinutes("departed", cadence)).toBeUndefined();
  });

  test("isDue respects phase intervals, never-checked, departed, and future state", () => {
    const now = 1_000_000_000;
    expect(isDue(now - 239 * 60_000, now, "far", cadence)).toBe(false);
    expect(isDue(now - 240 * 60_000, now, "far", cadence)).toBe(true);
    expect(isDue(now - 59 * 60_000, now, "near", cadence)).toBe(false);
    expect(isDue(now - 60 * 60_000, now, "near", cadence)).toBe(true);
    expect(isDue(now - 24 * 60_000, now, "hot", cadence)).toBe(false);
    expect(isDue(now - 25 * 60_000, now, "hot", cadence)).toBe(true);
    expect(isDue(0, now, "far", cadence)).toBe(true);
    expect(isDue(now - 10 * 60_000, now, "departed", cadence)).toBe(false);
    expect(isDue(now + 1, now, "near", cadence)).toBe(true);
  });

  test("hoursToDeparture is not rounded", () => {
    expect(hoursToDeparture(3_600_000 + 1_800_000, 0)).toBe(1.5);
  });
});

describe("alert diffs", () => {
  test("new better seat fires", () => {
    const diff = diffForAlert(state(snap([["14C", 2]])), snap([["14C", 2], ["24D", 0]]), 2);
    expect(diff).toEqual({ kind: "new", seats: [{ id: "24D", state: "available", tier: 0 }], alertedSeatIds: ["24D"] });
  });

  test("same seat on next pass is suppressed", () => {
    const diff = diffForAlert(state(snap([["24D", 0]]), ["24D"]), snap([["24D", 0]]), 2);
    expect(diff).toEqual({ kind: "none", seats: [], alertedSeatIds: ["24D"] });
  });

  test("seat that goes away drops suppression and re-fires when it returns", () => {
    const gone = diffForAlert(state(snap([["24D", 0]]), ["24D"]), snap([["14C", 2]]), 2);
    expect(gone.alertedSeatIds).toEqual([]);
    const returned = diffForAlert(state(snap([["14C", 2]]), gone.alertedSeatIds), snap([["14C", 2], ["24D", 0]]), 2);
    expect(returned.kind).toBe("new");
    expect(returned.seats.map((s) => s.id)).toEqual(["24D"]);
  });

  test("first pass reports a baseline when qualifying seats exist", () => {
    const diff = diffForAlert(undefined, snap([["24D", 0], ["24A", 1]]), 2);
    expect(diff.kind).toBe("baseline");
    expect(diff.seats.map((s) => s.id)).toEqual(["24D", "24A"]);
    expect(diff.alertedSeatIds).toEqual(["24D", "24A"]);
  });

  test("first pass with no qualifying seats returns none", () => {
    expect(diffForAlert(undefined, snap([["14C", 2], ["8C", 3]]), 2)).toEqual({ kind: "none", seats: [], alertedSeatIds: [] });
  });

  test("equal, worse, and junk seats never fire", () => {
    const diff = diffForAlert(state({}), snap([["14C", 2], ["8C", 3], ["20B", -1]]), 2);
    expect(diff).toEqual({ kind: "none", seats: [], alertedSeatIds: [] });
  });

  test("missing current seat lets every real rung fire", () => {
    const diff = diffForAlert(undefined, snap([["24D", 0], ["8C", 2], ["20B", -1]]), Number.POSITIVE_INFINITY);
    expect(diff.kind).toBe("baseline");
    expect(diff.seats.map((s) => s.id)).toEqual(["24D", "8C"]);
  });

  test("a JUNK current seat (-1) still fires — junk is the worst rung, not the best", () => {
    // Recorded failure class: comparing a real rung against a raw -1 makes every
    // seat look worse, so a traveler stuck in a middle seat gets a permanently
    // silent monitor. -1 must compare as worse than everything, like a seat that
    // is not on the map at all.
    const diff = diffForAlert(state(snap([["20B", -1]])), snap([["20B", -1], ["24D", 0], ["8C", 3]]), -1);
    expect(diff.kind).toBe("new");
    expect(diff.seats.map((s) => s.id)).toEqual(["24D", "8C"]);
    expect(comparableTier(-1)).toBe(Number.POSITIVE_INFINITY);
    expect(comparableTier(0)).toBe(0);
    expect(comparableTier(3)).toBe(3);
  });

  test("a junk current seat on a first pass still reports a baseline", () => {
    const diff = diffForAlert(undefined, snap([["24D", 0], ["20B", -1]]), -1);
    expect(diff.kind).toBe("baseline");
    expect(diff.seats.map((s) => s.id)).toEqual(["24D"]);
  });

  test("alertedSeatIds drops ids no longer present", () => {
    const diff = diffForAlert(state(snap([["24D", 0], ["24A", 1]]), ["24D", "24A"]), snap([["24A", 1]]), 2);
    expect(diff.alertedSeatIds).toEqual(["24A"]);
  });

  test("output is sorted by tier then id", () => {
    const diff = diffForAlert(undefined, snap([["24F", 1], ["24D", 0], ["24C", 0]]), 2);
    expect(diff.seats.map((s) => s.id)).toEqual(["24C", "24D", "24F"]);
  });

  // Recorded failure: a "blocked" seat on a good rung used to be alert-worthy
  // because only tier was checked. An airline desk could not assign a seat the map showed
  // as blocked, so this must never fire, however good the rung.
  test("a blocked seat never fires, even on a better rung than current", () => {
    const diff = diffForAlert(undefined, snap([["24D", 0, "blocked"], ["14C", 2]]), 2);
    expect(diff.kind).toBe("none");
    expect(diff.seats).toEqual([]);
  });

  test("mixed blocked+available: only the genuinely available seat fires", () => {
    const diff = diffForAlert(undefined, snap([["24D", 0, "blocked"], ["24A", 1]]), 2);
    expect(diff.kind).toBe("baseline");
    expect(diff.seats.map((s) => s.id)).toEqual(["24A"]);
  });
});

describe("failure alerting", () => {
  test("fires exactly once on threshold crossing", () => {
    expect(shouldAlertFailure(1, 3)).toBe(false);
    expect(shouldAlertFailure(2, 3)).toBe(false);
    expect(shouldAlertFailure(3, 3)).toBe(true);
    expect(shouldAlertFailure(4, 3)).toBe(false);
    expect(shouldAlertFailure(10, 3)).toBe(false);
    expect(shouldAlertFailure(0, 0)).toBe(false);
    expect(shouldAlertFailure(1, 0)).toBe(false);
  });
});

describe("departure pruning", () => {
  test("isPrunable uses a six-hour default grace", () => {
    const depart = 1_000_000;
    expect(isPrunable(depart, depart + 7 * 3_600_000)).toBe(true);
    expect(isPrunable(depart, depart + 5 * 3_600_000)).toBe(false);
  });

  test("pruneDeparted removes old and absent watches without mutating input", () => {
    const oldKey = "UA-1-ORD-DEN-2027-03-10";
    const keepKey = "UA-2-ORD-DEN-2027-03-10";
    const deadKey = "UA-3-ORD-DEN-2027-03-10";
    const now = 20 * 3_600_000;
    const input: MonitorState = {
      version: MONITOR_STATE_VERSION,
      watches: {
        [oldKey]: state(snap([["1A", 0]])),
        [keepKey]: state(snap([["2A", 0]]), ["2A"]),
        [deadKey]: state(snap([["3A", 0]])),
      },
    };

    const result = pruneDeparted(input, { [oldKey]: now - 7 * 3_600_000, [keepKey]: now - 5 * 3_600_000 }, now);
    expect(result.pruned.sort()).toEqual([deadKey, oldKey].sort());
    expect(Object.keys(result.state.watches)).toEqual([keepKey]);
    expect(Object.keys(input.watches).sort()).toEqual([deadKey, keepKey, oldKey].sort());
    expect(result.state.watches[keepKey]).not.toBe(input.watches[keepKey]);
  });
});

describe("messages", () => {
  test("alertMessage carries full flight context and current tier", () => {
    const diff: AlertDiff = {
      kind: "new",
      seats: [
        { id: "24D", state: "available", tier: 0 },
        { id: "24A", state: "available", tier: 1 },
      ],
      alertedSeatIds: ["24D", "24A"],
    };
    const msg = alertMessage({ watch, diff, currentSeatTier: 2, prefs, aircraft: "Boeing 737-900 (739)" });
    expect(msg).toContain("Newly-open better seats");
    expect(msg).toContain("UA 1234");
    expect(msg).toContain("ORD-DEN");
    expect(msg).toContain("2027-03-10");
    expect(msg).toContain("Boeing 737-900 (739)");
    expect(msg).toContain("24D exit-row aisle T1");
    expect(msg).toContain("24A exit-row window T2");
    expect(msg).toContain("currently 14C (MCE aisle T3)");
    expect(msg.endsWith(MOVE_LINE)).toBe(true);
  });

  test("alertMessage says plainly when the current seat is missing", () => {
    const diff: AlertDiff = { kind: "baseline", seats: [{ id: "24D", state: "available", tier: 0 }], alertedSeatIds: ["24D"] };
    const msg = alertMessage({ watch, diff, currentSeatTier: Number.POSITIVE_INFINITY, prefs, aircraft: "Boeing 737-900 (739)" });
    expect(msg).toContain("current seat 14C was NOT found on this map");
    expect(msg).toContain("treated as worse than every seat listed");
  });

  test("alertMessage distinguishes a junk current seat from a missing one", () => {
    const diff: AlertDiff = { kind: "new", seats: [{ id: "24D", state: "available", tier: 0 }], alertedSeatIds: ["24D"] };
    const msg = alertMessage({ watch: { ...watch, current_seat: "20B" }, diff, currentSeatTier: -1, prefs, aircraft: "Boeing 737-900 (739)" });
    expect(msg).toContain("currently 20B, which sits on no rung of your ladder (junk)");
    expect(msg).not.toContain("T0");
    expect(msg).not.toContain("NOT found on this map");
    expect(msg.endsWith(MOVE_LINE)).toBe(true);
  });

  test("alertMessage stays inside Discord's cap and marks dropped seats", () => {
    const seats = Array.from({ length: 200 }, (_, i) => ({ id: `${20 + i}D`, state: "available", tier: i % 3 }));
    const diff: AlertDiff = { kind: "new", seats, alertedSeatIds: seats.map((s) => s.id) };
    const msg = alertMessage({ watch, diff, currentSeatTier: 3, prefs, aircraft: "Boeing 737-900 (739)" });
    expect(msg.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(msg).toMatch(/\(\+\d+ more\)/);
    expect(msg).toContain("currently 14C (MCE window T4)");
    expect(msg.endsWith(MOVE_LINE)).toBe(true);
  });

  test("failureMessage includes the actual error and no external lookup instructions", () => {
    const msg = failureMessage(watch, 3, "seat-map source returned 503 Service Unavailable");
    expect(msg).toContain("UA 1234");
    expect(msg).toContain("ORD-DEN");
    expect(msg).toContain("2027-03-10");
    expect(msg).toContain("streak 3");
    expect(msg).toContain("seat-map source returned 503 Service Unavailable");
    expect(msg.toLowerCase()).not.toContain("log");
    expect(msg.toLowerCase()).not.toContain("dashboard");
    expect(msg.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
  });
});

describe("small pure helpers", () => {
  test("normalizeDateISO accepts strings and Date objects, and throws loudly", () => {
    expect(normalizeDateISO("2027-03-10")).toBe("2027-03-10");
    expect(normalizeDateISO(new Date("2027-03-10T12:34:56.000Z"))).toBe("2027-03-10");
    expect(() => normalizeDateISO("03/10/27")).toThrow(/received string/);
  });

  test("watchKey is stable", () => {
    expect(watchKey(watch)).toBe("UA-1234-ORD-DEN-2027-03-10");
  });

  test("departure default is end-of-day local", () => {
    expect(DEFAULT_DEPART_TIME).toBe("23:59");
    expect(departTimeOf(watch)).toBe("07:25");
    expect(departTimeOf({ ...watch, depart_time: undefined })).toBe(DEFAULT_DEPART_TIME);
  });

  test("currentSeatTierFrom is case and whitespace tolerant, and missing means Infinity", () => {
    const seats = [
      { id: "14C", tier: 2 },
      { id: "24D", tier: 0 },
    ];
    expect(currentSeatTierFrom(seats, " 14c ")).toBe(2);
    expect(currentSeatTierFrom(seats, "11A")).toBe(Number.POSITIVE_INFINITY);
  });

  test("rungLabel derives labels from preference strings", () => {
    expect(rungLabel(undefined, 2)).toBe("T3");
    expect(rungLabel("", 2)).toBe("T3");
    expect(rungLabel("exit_row_aisle", 0)).toBe("exit-row aisle");
    expect(rungLabel("mce_window", 1)).toBe("MCE window");
    expect(rungLabel("bulkhead", 2)).toBe("bulkhead");
  });

  test("the alert names no airline website", () => {
    expect(MOVE_LINE).not.toMatch(/\.com|\.net|\baa\b|united|delta/i);
  });

  test("scrubWebhook removes explicit and Discord-shaped webhook URLs", () => {
    const webhook = "https://discord.com/api/webhooks/123/secret";
    const msg = scrubWebhook(`failed ${webhook} plus https://discordapp.com/api/webhooks/456/token`, webhook);
    expect(msg).not.toContain(webhook);
    expect(msg).not.toContain("456/token");
    expect(msg).toContain("[discord-webhook]");
  });
});

describe("config validation", () => {
  const valid = {
    discord_webhook: "https://discord.com/api/webhooks/secret",
    cadence,
    failure_alert_after: 3,
    watches: [watch],
  };

  test("validateMonitorConfig accepts the real shape and coerces numeric flight numbers", () => {
    const raw = { ...valid, watches: [{ ...watch, flightNumber: 1234, date: new Date("2027-03-10T00:00:00Z") }] };
    const cfg: MonitorConfig = validateMonitorConfig(raw);
    expect(cfg.discord_webhook).toBe(valid.discord_webhook);
    expect(cfg.watches[0]!.flightNumber).toBe("1234");
    expect(cfg.watches[0]!.date).toBe("2027-03-10");
  });

  test("validateMonitorConfig names missing or ill-typed top-level keys without leaking webhook", () => {
    const cases: readonly [unknown, RegExp][] = [
      [{ ...valid, discord_webhook: "" }, /monitor\.discord_webhook must be a non-empty string/],
      [{ ...valid, cadence: undefined }, /monitor\.cadence is required/],
      [{ ...valid, failure_alert_after: Number.NaN }, /monitor\.failure_alert_after must be a number/],
      [{ ...valid, watches: "UA1234" }, /monitor\.watches must be an array/],
    ];
    for (const [raw, pattern] of cases) {
      const msg = expectThrowMessage(() => validateMonitorConfig(raw));
      expect(msg).toMatch(pattern);
      expect(msg).not.toContain(valid.discord_webhook);
    }
  });

  test("validateMonitorConfig accepts an empty watch list as the idle state between trips", () => {
    expect(validateMonitorConfig({ ...valid, watches: [] }).watches).toEqual([]);
  });

  test("validateMonitorConfig names missing cadence fields", () => {
    const broken = { ...valid, cadence: { ...cadence, hot_hours: undefined } };
    const msg = expectThrowMessage(() => validateMonitorConfig(broken));
    expect(msg).toContain("monitor.cadence.hot_hours");
    expect(msg).not.toContain(valid.discord_webhook);
  });

  test("validateMonitorConfig names missing watch fields", () => {
    const fields = ["airline", "flightNumber", "origin", "destination", "date", "current_seat"] as const;
    for (const field of fields) {
      const brokenWatch: Record<string, unknown> = { ...watch, [field]: undefined };
      const msg = expectThrowMessage(() => validateMonitorConfig({ ...valid, watches: [brokenWatch] }));
      expect(msg).toContain(`monitor.watches[0].${field}`);
      expect(msg).not.toContain(valid.discord_webhook);
    }
  });

  test("validateMonitorConfig rejects ill-typed optional depart_time", () => {
    const msg = expectThrowMessage(() => validateMonitorConfig({ ...valid, watches: [{ ...watch, depart_time: 725 }] }));
    expect(msg).toContain("monitor.watches[0].depart_time");
  });
});

describe("state parsing", () => {
  test("parseState returns empty state for garbage", () => {
    expect(parseState("garbage")).toEqual(emptyState());
    expect(parseState({ version: 999, watches: {} })).toEqual(emptyState());
    expect(parseState({ version: MONITOR_STATE_VERSION })).toEqual(emptyState());
  });

  test("parseState coerces watch fields and drops non-object entries", () => {
    const parsed = parseState({
      version: MONITOR_STATE_VERSION,
      watches: {
        good: {
          lastChecked: 123,
          consecutiveFailures: "bad",
          failureAlerted: true,
          seats: { "24D": { state: "available", tier: 0 }, bad: "drop" },
          alertedSeatIds: ["24D", 7],
        },
        bad: "drop",
      },
    });
    expect(parsed).toEqual({
      version: MONITOR_STATE_VERSION,
      watches: {
        good: {
          lastChecked: 123,
          consecutiveFailures: 0,
          failureAlerted: true,
          seats: { "24D": { state: "available", tier: 0 } },
          alertedSeatIds: ["24D"],
        },
      },
    });
  });
});

describe("corrupted state recovery", () => {
  test("unparseable state file degrades to first-pass WITH a warning, never a crash", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "ts-state-"));
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    try {
      const { readState, stateDir, statePath } = await import("./monitor-run.ts");
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(statePath(), "{ this is not json");
      const read = readState();
      expect(read.warning).toBeDefined();
      expect(read.state).toBeDefined();
      expect(Object.keys(read.state.watches ?? {}).length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
  });
});
