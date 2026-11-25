/**
 * monitor-run.ts — one pass of the seat monitor: read each due watch's seat map, compare
 * with the last pass, alert on newly open better seats, and alert once when a watch keeps
 * failing. State and a journal live under $XDG_STATE_HOME/travel-search. A run with no
 * seat-map source or no webhook fails loudly; it never "succeeds" having checked nothing.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./browser.ts";
import { configPath } from "./config.ts";
import { to24h } from "./google-flights.ts";
import type { Config } from "./painfulness.ts";
import type { BrowserDriver, SeatMapProvider } from "./seatmap-api.ts";
import { checkSeatMap, seatMapSettings } from "./seatmap.ts";
import { resolveSecret } from "./secrets.ts";
import { airportZone } from "./time.ts";
import {
  alertMessage,
  departTimeOf,
  diffForAlert,
  emptyState,
  failureMessage,
  hoursToDeparture,
  isDue,
  parseState,
  phaseOf,
  pruneDeparted,
  shouldAlertFailure,
  validateMonitorConfig,
  watchKey,
} from "./monitor.ts";
import type { MonitorConfig, MonitorPhase, MonitorState, MonitorWatch, SeatSnapshot, WatchState } from "./monitor.ts";
import { scrubWebhook, sendDiscord } from "./notify.ts";
import { legSeatReality, tierForSeatId } from "./seats.ts";
import { zonedEpoch } from "./time.ts";

export interface MonitorRunOptions {
  force: boolean;
}

export interface WatchPassResult {
  key: string;
  flight: string;
  phase: MonitorPhase | "unknown";
  hoursToDeparture: number | undefined;
  due: boolean;
  checked: boolean;
  alertKind?: "baseline" | "new";
  alertedSeats?: string[];
  messageId?: string;
  error?: string;
  consecutiveFailures: number;
  failureAlerted: boolean;
}

export interface MonitorRunResult {
  ranAt: string;
  passes: WatchPassResult[];
  pruned: string[];
  requests: number;
  alertsSent: number;
  failures: number;
  /** Set only when the state file could not be read and this run started blind. */
  stateWarning?: string;
}

export interface StateRead {
  state: MonitorState;
  warning?: string;
}

interface DepartureInfo {
  epochMs: number;
  error?: string;
}

interface FailureBase {
  key: string;
  flight: string;
  phase: MonitorPhase | "unknown";
  hoursToDeparture: number | undefined;
  due: boolean;
  checked: boolean;
}

interface FailureResult {
  pass: WatchPassResult;
  alertsSent: number;
}

export { stateDir };

export function statePath(): string {
  return join(stateDir(), "monitor-state.json");
}

export function journalPath(): string {
  return join(stateDir(), "monitor-journal.jsonl");
}

/**
 * A corrupt state file must never wedge the monitor. `parseState` already
 * degrades unrecognised CONTENT, but unparseable JSON throws before it ever
 * runs — and a throw here kills every pass forever while the timer quietly
 * fails, which is the one outcome a standing monitor cannot have. So we degrade
 * to "first-ever pass" and carry the reason out for the caller to report; the
 * warning is never swallowed.
 */
export function readState(): StateRead {
  const path = statePath();
  if (!existsSync(path)) return { state: emptyState() };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    return {
      state: emptyState(),
      warning: `state file ${path} is not readable JSON (${errorText(err)}) — every watch is treated as a first-ever pass this run`,
    };
  }
  return { state: parseState(raw) };
}

export function writeState(state: MonitorState): void {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const path = statePath();
  const tmp = join(dir, `.monitor-state.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function monitorConfigOf(cfg: Config): MonitorConfig {
  if (cfg.monitor === undefined) {
    throw new Error(`no monitor section in ${configPath()} — add one (shape in config.example.yaml)`);
  }
  return validateMonitorConfig(cfg.monitor);
}

export async function monitorRun(
  cfg: Config,
  browser: BrowserDriver,
  provider: SeatMapProvider,
  opts: MonitorRunOptions,
): Promise<MonitorRunResult> {
  const mon = monitorConfigOf(cfg);
  if (mon.watches.length) {
    // Resolve the webhook reference once, up front: a run that cannot alert must say so now.
    mon.discord_webhook = (await resolveSecret(mon.discord_webhook)).value;
  }
  const prefs = cfg.seating?.preference_order ?? [];
  const cabin = seatMapSettings(cfg).economyCabin;
  const now = Date.now();
  const read = readState();
  let state = read.state;
  const departures = departureInfoByKey(cfg, mon);
  const departEpochByKey = departEpochs(departures);
  const prunedResult = pruneDeparted(state, departEpochByKey, now);
  state = prunedResult.state;

  const passes: WatchPassResult[] = [];
  let alertsSent = 0;

  for (const watch of mon.watches) {
    const key = watchKey(watch);
    const flight = flightLabel(watch);
    const prev = state.watches[key];
    const departure = departures.get(key);

    if (departure === undefined) {
      const failure = await recordFailure(state, mon, watch, prev, now, {
        key,
        flight,
        phase: "unknown",
        hoursToDeparture: undefined,
        due: true,
        checked: false,
      }, `internal monitor error: no departure calculation for ${key}`);
      alertsSent += failure.alertsSent;
      passes.push(failure.pass);
      continue;
    }

    if (departure.error !== undefined) {
      const failure = await recordFailure(state, mon, watch, prev, now, {
        key,
        flight,
        phase: "unknown",
        hoursToDeparture: undefined,
        due: true,
        checked: false,
      }, departure.error);
      alertsSent += failure.alertsSent;
      passes.push(failure.pass);
      continue;
    }

    const h = hoursToDeparture(departure.epochMs, now);
    const phase = phaseOf(h, mon.cadence);
    const due = phase === "departed" ? false : opts.force || isDue(prev?.lastChecked ?? 0, now, phase, mon.cadence);
    if (!due) {
      passes.push({
        key,
        flight,
        phase,
        hoursToDeparture: h,
        due,
        checked: false,
        consecutiveFailures: prev?.consecutiveFailures ?? 0,
        failureAlerted: prev?.failureAlerted ?? false,
      });
      continue;
    }

    try {
      const req = { airline: watch.airline, flightNumber: watch.flightNumber, origin: watch.origin, destination: watch.destination, date: watch.date, cabin };
      const map = checkSeatMap(await provider.seatMap(req), req, provider.name);
      const reality = legSeatReality(cfg, map);
      const next: SeatSnapshot = {};
      for (const seat of reality.sitable) next[seat.id] = { state: seat.state, tier: seat.tier };

      // Your own seat usually shows as "occupied" (you hold it), and occupied seats never
      // enter `sitable`, so its rung is looked up directly rather than by widening what
      // counts as bookable.
      const currentSeatTier = tierForSeatId(cfg, map, watch.current_seat);
      const diff = diffForAlert(prev, next, currentSeatTier);
      let messageId: string | undefined;

      if (diff.kind !== "none") {
        const msg = alertMessage({ watch, diff, currentSeatTier, prefs, aircraft: map.aircraftName });
        try {
          messageId = await sendDiscord(mon.discord_webhook, msg);
          alertsSent += 1;
        } catch (err) {
          const failure = await recordFailure(state, mon, watch, prev, now, {
            key,
            flight,
            phase,
            hoursToDeparture: h,
            due,
            checked: true,
          }, scrubWebhook(errorText(err), mon.discord_webhook));
          alertsSent += failure.alertsSent;
          passes.push(failure.pass);
          continue;
        }
      }

      state.watches[key] = {
        lastChecked: now,
        consecutiveFailures: 0,
        failureAlerted: false,
        seats: next,
        alertedSeatIds: diff.alertedSeatIds,
      };
      passes.push({
        key,
        flight,
        phase,
        hoursToDeparture: h,
        due,
        checked: true,
        ...(diff.kind !== "none" ? { alertKind: diff.kind, alertedSeats: diff.seats.map((seat) => seat.id) } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
        consecutiveFailures: 0,
        failureAlerted: false,
      });
    } catch (err) {
      const failure = await recordFailure(state, mon, watch, prev, now, {
        key,
        flight,
        phase,
        hoursToDeparture: h,
        due,
        checked: true,
      }, scrubWebhook(errorText(err), mon.discord_webhook));
      alertsSent += failure.alertsSent;
      passes.push(failure.pass);
    }
  }

  const result: MonitorRunResult = {
    ranAt: new Date(now).toISOString(),
    passes,
    pruned: prunedResult.pruned,
    requests: browser.requests(),
    alertsSent,
    failures: passes.filter((pass) => pass.error !== undefined).length,
    ...(read.warning !== undefined ? { stateWarning: read.warning } : {}),
  };
  writeState(state);
  appendJournal(result);
  return result;
}

export function statusLines(cfg: Config): string[] {
  const mon = monitorConfigOf(cfg);
  const now = Date.now();
  const read = readState();
  const state = read.state;
  const departures = departureInfoByKey(cfg, mon);
  const pruned = pruneDeparted(state, departEpochs(departures), now).pruned;
  const lines = [`state file: ${statePath()}`, `stale/prunable state keys: ${pruned.length}`];
  if (read.warning !== undefined) lines.push(`WARNING: ${read.warning}`);
  if (mon.watches.length === 0) lines.push("", "NO WATCHES CONFIGURED: monitor is idle. Add one under monitor.watches.");

  for (const watch of mon.watches) {
    const key = watchKey(watch);
    const prev = state.watches[key];
    const departure = departures.get(key);
    lines.push("", `${flightLabel(watch)} current seat ${watch.current_seat}`);
    if (departure === undefined) {
      lines.push("  departure: unknown (internal monitor error: no departure calculation)");
      lines.push("  phase: unknown; hours to departure: unknown; due now: yes");
    } else if (departure.error !== undefined) {
      lines.push(`  departure: unknown (${departure.error})`);
      lines.push("  phase: unknown; hours to departure: unknown; due now: yes");
    } else {
      const h = hoursToDeparture(departure.epochMs, now);
      const phase = phaseOf(h, mon.cadence);
      const due = phase === "departed" ? false : isDue(prev?.lastChecked ?? 0, now, phase, mon.cadence);
      lines.push(`  phase: ${phase}; hours to departure: ${h.toFixed(1)}; due now: ${due ? "yes" : "no"}`);
    }
    lines.push(`  last checked: ${relativeAge(prev?.lastChecked ?? 0, now)}; consecutive failures: ${prev?.consecutiveFailures ?? 0}`);
    lines.push(`  tracked seats: ${Object.keys(prev?.seats ?? {}).length}; suppressed ids: ${prev?.alertedSeatIds.length ?? 0}`);
  }

  return lines;
}

function departureInfoByKey(cfg: Config, mon: MonitorConfig): Map<string, DepartureInfo> {
  const out = new Map<string, DepartureInfo>();
  for (const watch of mon.watches) {
    const key = watchKey(watch);
    const tz = airportZone(cfg, watch.origin);
    if (tz === undefined) {
      out.set(key, { epochMs: Number.POSITIVE_INFINITY, error: `no time zone known for ${watch.origin}; add it under airport_tz in ${configPath()}` });
      continue;
    }
    try {
      const t = departTimeOf(watch);
      out.set(key, { epochMs: zonedEpoch(watch.date, /[AP]M$/i.test(t.trim()) ? to24h(t) : t, tz) });
    } catch (err) {
      out.set(key, { epochMs: Number.POSITIVE_INFINITY, error: errorText(err) });
    }
  }
  return out;
}

function departEpochs(departures: Map<string, DepartureInfo>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of departures) out[key] = value.epochMs;
  return out;
}

async function recordFailure(
  state: MonitorState,
  mon: MonitorConfig,
  watch: MonitorWatch,
  prev: WatchState | undefined,
  now: number,
  base: FailureBase,
  reason: string,
): Promise<FailureResult> {
  const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
  const alreadyAlerted = prev?.failureAlerted === true;
  // `shouldAlertFailure` is the crossing predicate — one alert per streak, at the
  // threshold. `overdueRetry` covers the case where that one send failed: without
  // it, a Discord hiccup on exactly the crossing pass silences a broken watch
  // forever, which is the failure this monitor exists to prevent. The
  // `failureAlerted` flag (cleared on the next success) keeps it to one alert.
  const crossing = shouldAlertFailure(consecutiveFailures, mon.failure_alert_after);
  const overdueRetry = mon.failure_alert_after >= 1 && consecutiveFailures > mon.failure_alert_after;
  const shouldSendFailure = !alreadyAlerted && (crossing || overdueRetry);
  let failureAlerted = alreadyAlerted;
  let messageId: string | undefined;
  let error = scrubWebhook(reason, mon.discord_webhook);
  let alertsSent = 0;

  if (shouldSendFailure) {
    try {
      messageId = await sendDiscord(mon.discord_webhook, failureMessage(watch, consecutiveFailures, error));
      alertsSent = 1;
      // Only a delivered alert marks the streak as reported.
      failureAlerted = true;
    } catch (err) {
      error = `${error}; failure alert send failed: ${scrubWebhook(errorText(err), mon.discord_webhook)}`;
    }
  }

  state.watches[base.key] = {
    lastChecked: now,
    consecutiveFailures,
    failureAlerted,
    seats: copySnapshot(prev?.seats ?? {}),
    alertedSeatIds: [...(prev?.alertedSeatIds ?? [])],
  };

  return {
    alertsSent,
    pass: {
      ...base,
      ...(messageId !== undefined ? { messageId } : {}),
      error,
      consecutiveFailures,
      failureAlerted,
    },
  };
}

function appendJournal(result: MonitorRunResult): void {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(journalPath(), `${JSON.stringify(result)}\n`);
}

function copySnapshot(seats: SeatSnapshot): SeatSnapshot {
  const out: SeatSnapshot = {};
  for (const [id, seat] of Object.entries(seats)) out[id] = { state: seat.state, tier: seat.tier };
  return out;
}

function flightLabel(watch: MonitorWatch): string {
  return `${watch.airline} ${watch.flightNumber} ${watch.origin}-${watch.destination} ${watch.date}`;
}

function relativeAge(epochMs: number, now: number): string {
  if (epochMs <= 0) return "never";
  const elapsedMs = now - epochMs;
  if (elapsedMs < 0) return "in the future";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 48) return remainder === 0 ? `${hours}h ago` : `${hours}h ${remainder}m ago`;
  const days = Math.floor(hours / 24);
  const dayHours = hours % 24;
  return dayHours === 0 ? `${days}d ago` : `${days}d ${dayHours}h ago`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const encoded = JSON.stringify(err);
  return encoded ?? String(err);
}
