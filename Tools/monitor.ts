/**
 * monitor.ts — the standing seat monitor's rules, kept pure so the runner can fail loudly
 * at the edges while "is there a better seat now?" stays deterministic and tested.
 *
 * You list flights you are booked on and the seat you hold. On a schedule the runner
 * reads each seat map and posts to Discord when a seat higher on your ladder opens.
 * Checks tighten as departure nears.
 */

export interface MonitorCadence {
  far_hours: number;
  hot_hours: number;
  far_every_min: number;
  near_every_min: number;
  hot_every_min: number;
}

export interface MonitorWatch {
  airline: string;
  flightNumber: string;
  origin: string;
  destination: string;
  date: string;
  current_seat: string;
  depart_time?: string;
}

export interface MonitorConfig {
  /** A secret reference (env:NAME, op://..., or a file path) to the Discord webhook URL. */
  discord_webhook: string;
  cadence: MonitorCadence;
  failure_alert_after: number;
  watches: MonitorWatch[];
}

export type MonitorPhase = "far" | "near" | "hot" | "departed";

export interface SeatSnapshotEntry {
  state: string;
  tier: number;
}
export type SeatSnapshot = Record<string, SeatSnapshotEntry>;

export interface WatchState {
  lastChecked: number;
  consecutiveFailures: number;
  failureAlerted: boolean;
  seats: SeatSnapshot;
  alertedSeatIds: string[];
}

export interface MonitorState {
  version: number;
  watches: Record<string, WatchState>;
}

export interface AlertSeat {
  id: string;
  state: string;
  tier: number;
}

export interface AlertDiff {
  kind: "baseline" | "new" | "none";
  seats: AlertSeat[];
  alertedSeatIds: string[];
}

export interface AlertMessageInput {
  watch: MonitorWatch;
  diff: AlertDiff;
  currentSeatTier: number;
  prefs: readonly string[];
  aircraft: string;
}

export const MONITOR_STATE_VERSION = 1;
export const DEFAULT_DEPART_TIME = "23:59";
export const PRUNE_GRACE_HOURS = 6;
export const DISCORD_CONTENT_LIMIT = 2000;
/** Last line of every seat alert. Deliberately names no airline. */
export const MOVE_LINE = "Change seats with the airline.";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const POSITION_SUFFIX = /_(aisle|window)$/;

export function watchKey(w: MonitorWatch): string {
  return `${w.airline}-${w.flightNumber}-${w.origin}-${w.destination}-${w.date}`;
}

export function normalizeDateISO(v: unknown): string {
  if (typeof v === "string" && ISO_DATE.test(v)) return v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  throw new Error(`monitor watch date must be YYYY-MM-DD string or valid Date; received ${receivedName(v)}`);
}

export function departTimeOf(w: MonitorWatch): string {
  return w.depart_time ?? DEFAULT_DEPART_TIME;
}

export function hoursToDeparture(departEpochMs: number, nowEpochMs: number): number {
  return (departEpochMs - nowEpochMs) / 3_600_000;
}

export function phaseOf(hoursToDeparture: number, cadence: MonitorCadence): MonitorPhase {
  if (hoursToDeparture < 0) return "departed";
  if (hoursToDeparture <= cadence.hot_hours) return "hot";
  if (hoursToDeparture <= cadence.far_hours) return "near";
  return "far";
}

export function intervalMinutes(phase: MonitorPhase, cadence: MonitorCadence): number | undefined {
  if (phase === "far") return cadence.far_every_min;
  if (phase === "near") return cadence.near_every_min;
  if (phase === "hot") return cadence.hot_every_min;
  return undefined;
}

export function isDue(lastCheckedEpochMs: number, nowEpochMs: number, phase: MonitorPhase, cadence: MonitorCadence): boolean {
  if (phase === "departed") return false;
  if (lastCheckedEpochMs <= 0) return true;
  const elapsed = nowEpochMs - lastCheckedEpochMs;
  if (elapsed < 0) return true;
  const minutes = intervalMinutes(phase, cadence);
  return minutes !== undefined && elapsed >= minutes * 60_000;
}

export function isPrunable(departEpochMs: number, nowEpochMs: number, graceHours = PRUNE_GRACE_HOURS): boolean {
  return nowEpochMs > departEpochMs + graceHours * 3_600_000;
}

export function currentSeatTierFrom(seats: readonly { id: string; tier: number }[], currentSeatId: string): number {
  const wanted = currentSeatId.trim().toUpperCase();
  const seat = seats.find((s) => s.id.trim().toUpperCase() === wanted);
  return seat ? seat.tier : Number.POSITIVE_INFINITY;
}

/**
 * The ladder's "lower is better" ordering holds only across REAL rungs: -1 is
 * junk, i.e. the worst seat on the aircraft, not the best. Compared raw, a
 * traveler sitting in a junk seat would make every real rung look worse and the
 * monitor would go silent for exactly the person who most needs it. Junk and
 * "not on this map" are the same thing to a comparison: worse than everything.
 */
export function comparableTier(tier: number): number {
  return tier < 0 ? Number.POSITIVE_INFINITY : tier;
}

export function diffForAlert(prev: WatchState | undefined, next: SeatSnapshot, currentSeatTier: number): AlertDiff {
  const nextIds = new Set(Object.keys(next));
  const carried = (prev?.alertedSeatIds ?? []).filter((id) => nextIds.has(id));
  const bar = comparableTier(currentSeatTier);
  // Only "available" is alert-worthy. A "blocked" seat on a good rung is tracked (it can
  // open before departure) but never reported as an opportunity: blocked is not bookable
  // even with top-tier status, and an alert implying otherwise sends you chasing a seat
  // you cannot get.
  const candidates = sortedAlertSeats(
    Object.entries(next)
      .filter(([, s]) => s.tier >= 0 && s.tier < bar && s.state === "available")
      .map(([id, s]) => ({ id, state: s.state, tier: s.tier })),
  );

  if (prev === undefined) {
    if (candidates.length === 0) return { kind: "none", seats: [], alertedSeatIds: [] };
    return { kind: "baseline", seats: candidates, alertedSeatIds: candidates.map((s) => s.id) };
  }

  const carriedSet = new Set(carried);
  // Availability is the alert trigger. A seat already present last pass whose
  // tier improves is deliberately quiet until it disappears and returns.
  const newly = sortedAlertSeats(candidates.filter((s) => !(s.id in prev.seats) && !carriedSet.has(s.id)));
  return {
    kind: newly.length > 0 ? "new" : "none",
    seats: newly,
    alertedSeatIds: [...carried, ...newly.map((s) => s.id)],
  };
}

export function shouldAlertFailure(consecutiveFailures: number, threshold: number): boolean {
  return threshold >= 1 && consecutiveFailures === threshold;
}

export function rungLabel(pref: string | undefined, tier: number): string {
  if (!pref) return `T${tier + 1}`;
  const suffix = pref.match(POSITION_SUFFIX);
  const position = suffix?.[1];
  const prefix = position ? pref.slice(0, -position.length - 1) : pref;
  const product = prefix === "mce" ? "MCE" : prefix.replaceAll("_", "-");
  return position ? `${product} ${position}` : product;
}

export function describeSeat(s: AlertSeat, prefs: readonly string[]): string {
  // diffForAlert only produces "available" candidates, so this is a defensive label.
  // It never says "needs status to book": status does not unlock a blocked seat.
  const state = s.state && s.state !== "available" ? ` — ${s.state.toUpperCase()} (not bookable)` : "";
  return `${s.id} ${rungLabel(prefs[s.tier], s.tier)} T${s.tier + 1}${state}`;
}

export function alertMessage(input: AlertMessageInput): string {
  const kind = input.diff.kind === "baseline" ? "Baseline open better seats" : "Newly-open better seats";
  const flight = `${input.watch.airline} ${input.watch.flightNumber}`;
  const route = `${input.watch.origin}-${input.watch.destination}`;
  const headline = `${kind} for ${flight} ${route} ${input.watch.date} on ${input.aircraft}.`;
  const seatLines = input.diff.seats.map((s) => describeSeat(s, input.prefs));
  return boundedAlertMessage(headline, seatLines, currentSeatLine(input));
}

/** The three honest states of "what am I sitting in now": a real rung, a junk
 * seat, or a seat this map does not contain. Each reads differently to a human
 * even though the last two compare identically. */
function currentSeatLine(input: AlertMessageInput): string {
  const tier = input.currentSeatTier;
  const seat = input.watch.current_seat;
  if (!Number.isFinite(tier)) {
    return `current seat ${seat} was NOT found on this map and is therefore treated as worse than every seat listed.`;
  }
  if (tier < 0) {
    return `currently ${seat}, which sits on no rung of your ladder (junk) — every seat listed beats it.`;
  }
  return `currently ${seat} (${rungLabel(input.prefs[tier], tier)} T${tier + 1})`;
}

export function failureMessage(watch: MonitorWatch, consecutiveFailures: number, error: string): string {
  const flight = `${watch.airline} ${watch.flightNumber}`;
  const route = `${watch.origin}-${watch.destination}`;
  const prefix = `Seat monitor failed for ${flight} ${route} ${watch.date}; streak ${consecutiveFailures}. Error: `;
  const room = Math.max(0, DISCORD_CONTENT_LIMIT - prefix.length);
  return `${prefix}${truncateTo(error, room)}`;
}

export function validateMonitorConfig(raw: unknown): MonitorConfig {
  const root = expectRecord(raw, "monitor");
  const discord_webhook = requireNonEmptyString(root, "discord_webhook", "monitor.discord_webhook");
  const cadenceRaw = requireKey(root, "cadence", "monitor.cadence");
  const cadenceRecord = expectRecord(cadenceRaw, "monitor.cadence");
  const cadence: MonitorCadence = {
    far_hours: requirePositiveFiniteNumber(cadenceRecord, "far_hours", "monitor.cadence.far_hours"),
    hot_hours: requirePositiveFiniteNumber(cadenceRecord, "hot_hours", "monitor.cadence.hot_hours"),
    far_every_min: requirePositiveFiniteNumber(cadenceRecord, "far_every_min", "monitor.cadence.far_every_min"),
    near_every_min: requirePositiveFiniteNumber(cadenceRecord, "near_every_min", "monitor.cadence.near_every_min"),
    hot_every_min: requirePositiveFiniteNumber(cadenceRecord, "hot_every_min", "monitor.cadence.hot_every_min"),
  };
  const failure_alert_after = requireFiniteNumber(root, "failure_alert_after", "monitor.failure_alert_after");
  const watchesRaw = requireKey(root, "watches", "monitor.watches");
  // An empty list is a valid idle state between trips; run and status both say so out loud.
  if (!Array.isArray(watchesRaw)) throw new Error("monitor.watches must be an array");
  const watches = watchesRaw.map((watchRaw, index) => validateWatch(watchRaw, index));
  return { discord_webhook, cadence, failure_alert_after, watches };
}

export function emptyState(): MonitorState {
  return { version: MONITOR_STATE_VERSION, watches: {} };
}

export function parseState(raw: unknown): MonitorState {
  if (!isRecord(raw)) return emptyState();
  if (raw["version"] !== MONITOR_STATE_VERSION) return emptyState();
  const watchesRaw = raw["watches"];
  if (!isRecord(watchesRaw)) return emptyState();

  const watches: Record<string, WatchState> = {};
  for (const [key, value] of Object.entries(watchesRaw)) {
    if (!isRecord(value)) continue;
    watches[key] = {
      lastChecked: finiteNumberOr(value["lastChecked"], 0),
      consecutiveFailures: finiteNumberOr(value["consecutiveFailures"], 0),
      failureAlerted: typeof value["failureAlerted"] === "boolean" ? value["failureAlerted"] : false,
      seats: parseSeatSnapshot(value["seats"]),
      alertedSeatIds: parseStringArray(value["alertedSeatIds"]),
    };
  }
  return { version: MONITOR_STATE_VERSION, watches };
}

export function pruneDeparted(
  state: MonitorState,
  departEpochByKey: Record<string, number>,
  nowEpochMs: number,
): { state: MonitorState; pruned: string[] } {
  const watches: Record<string, WatchState> = {};
  const pruned: string[] = [];

  for (const [key, watchState] of Object.entries(state.watches)) {
    const departEpochMs = departEpochByKey[key];
    if (departEpochMs === undefined || isPrunable(departEpochMs, nowEpochMs)) {
      pruned.push(key);
    } else {
      watches[key] = cloneWatchState(watchState);
    }
  }

  return { state: { version: MONITOR_STATE_VERSION, watches }, pruned };
}

function sortedAlertSeats(seats: AlertSeat[]): AlertSeat[] {
  return [...seats].sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
}

function boundedAlertMessage(headline: string, seatLines: string[], currentLine: string): string {
  let kept = seatLines.length;
  while (kept >= 0) {
    const dropped = seatLines.length - kept;
    const lines = [headline, ...seatLines.slice(0, kept)];
    if (dropped > 0) lines.push(`(+${dropped} more)`);
    lines.push(currentLine, MOVE_LINE);
    const message = lines.join("\n");
    if (message.length <= DISCORD_CONTENT_LIMIT) return message;
    kept -= 1;
  }

  const fixedTail = `${currentLine}\n${MOVE_LINE}`;
  const room = Math.max(0, DISCORD_CONTENT_LIMIT - fixedTail.length - 1);
  return `${truncateTo(headline, room)}\n${fixedTail}`;
}

function truncateTo(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, Math.max(0, maxLength));
  return `${value.slice(0, maxLength - 1)}...`.slice(0, maxLength);
}

function validateWatch(raw: unknown, index: number): MonitorWatch {
  const path = `monitor.watches[${index}]`;
  const w = expectRecord(raw, path);
  const flightRaw = requireKey(w, "flightNumber", `${path}.flightNumber`);
  const flightNumber =
    typeof flightRaw === "number" && Number.isFinite(flightRaw)
      ? String(flightRaw)
      : expectNonEmptyString(flightRaw, `${path}.flightNumber`);
  const departRaw = w["depart_time"];
  if (departRaw !== undefined && typeof departRaw !== "string") throw new Error(`${path}.depart_time must be a string`);

  return {
    airline: requireNonEmptyString(w, "airline", `${path}.airline`),
    flightNumber,
    origin: requireNonEmptyString(w, "origin", `${path}.origin`),
    destination: requireNonEmptyString(w, "destination", `${path}.destination`),
    date: normalizeDateISO(requireKey(w, "date", `${path}.date`)),
    current_seat: requireNonEmptyString(w, "current_seat", `${path}.current_seat`),
    ...(departRaw !== undefined ? { depart_time: departRaw } : {}),
  };
}

function parseSeatSnapshot(raw: unknown): SeatSnapshot {
  if (!isRecord(raw)) return {};
  const out: SeatSnapshot = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const state = typeof value["state"] === "string" ? value["state"] : "";
    const tier = finiteNumberOr(value["tier"], -1);
    out[id] = { state, tier };
  }
  return out;
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

function cloneWatchState(state: WatchState): WatchState {
  const seats: SeatSnapshot = {};
  for (const [id, seat] of Object.entries(state.seats)) seats[id] = { ...seat };
  return {
    lastChecked: state.lastChecked,
    consecutiveFailures: state.consecutiveFailures,
    failureAlerted: state.failureAlerted,
    seats,
    alertedSeatIds: [...state.alertedSeatIds],
  };
}

function requireKey(record: Record<string, unknown>, key: string, path: string): unknown {
  const value = record[key];
  if (value === undefined) throw new Error(`${path} is required`);
  return value;
}

function requireNonEmptyString(record: Record<string, unknown>, key: string, path: string): string {
  return expectNonEmptyString(requireKey(record, key, path), path);
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requireFiniteNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = requireKey(record, key, path);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a number`);
  return value;
}

function requirePositiveFiniteNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = requireFiniteNumber(record, key, path);
  if (value <= 0) throw new Error(`${path} must be a finite number > 0`);
  return value;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function receivedName(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "invalid Date" : "Date";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
