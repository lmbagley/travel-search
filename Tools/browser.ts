/**
 * browser.ts — the one real-browser driver every source shares.
 *
 * The driver is any CLI with `open <url>` → `{"tabId": N}` and `read --tab N` →
 * `{"html": "..."}` (and, for clicks, `act click <selector> --tab N`). It is set once
 * with `sources.schedule.driver_cmd`. Google Flights and any seat-map plug-in use the
 * same instance, so requests are paced and never run in parallel. A lock file keeps a
 * second travel-search process (say, the seat monitor firing while you run `seats` by
 * hand) from driving the same browser at the same time.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { str, type Config } from "./painfulness.ts";
import type { BrowserDriver } from "./seatmap-api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function driverCommand(cfg: Config): string[] {
  const raw = str(cfg.sources?.schedule as Record<string, unknown> | undefined, "driver_cmd") ?? "interceptor";
  return raw.split(/\s+/).filter(Boolean);
}

/** Run one driver command. A timed-out kill never returns partial output as data. */
export async function runDriver(cmd: string[], args: string[], timeoutMs = 90_000): Promise<string> {
  let proc;
  try {
    proc = Bun.spawn([...cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error(
      `travel-search: browser driver "${cmd.join(" ")}" is not installed or not on PATH. ` +
        `Set sources.schedule.driver_cmd in your config (see README "Browser driver").`,
    );
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  clearTimeout(timer);
  const code = await proc.exited;
  if (timedOut) {
    throw new Error(`${cmd[0]} ${args[0]} TIMED OUT after ${timeoutMs}ms — partial output discarded, not returned as data`);
  }
  if (code !== 0) {
    throw new Error(`${cmd[0]} ${args[0]} failed (exit ${code}): ${err.trim().slice(0, 300)} ${out.trim().slice(0, 300)}`);
  }
  return out;
}

/** Pull `html` out of a `read` response. Very large pages can arrive cut off mid-JSON;
 *  unescaping the raw stream still gives the settle check and parsers real markup. */
export function htmlFromRead(out: string): string {
  try {
    return (JSON.parse(out) as { html?: string }).html ?? "";
  } catch {
    return out.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
  }
}

// ───────────────────────────── cross-process lock ─────────────────────────────

export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "state"), "travel-search");
}

/** When each site was last opened, by any travel-search process. */
export function pacingPath(): string {
  return join(stateDir(), "last-request.json");
}

/** Last open time per host, shared across runs so back-to-back commands are paced too. */
export function lastRequestAt(host: string): number {
  try {
    const v = (JSON.parse(readFileSync(pacingPath(), "utf8")) as Record<string, unknown>)[host];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function recordRequest(host: string, at = Date.now()): void {
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(pacingPath(), "utf8"));
  } catch {
    /* first request, or an unreadable file: start over */
  }
  all[host] = at;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(pacingPath(), JSON.stringify(all));
}

/** How long to wait before the next open of a host: the paced gap minus time already passed. */
export function pacingWait(last: number, gapMs: number, now = Date.now()): number {
  if (last <= 0) return 0;
  return Math.max(0, Math.min(gapMs, last + gapMs - now));
}

export function lockPath(): string {
  return join(stateDir(), "browser.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

let held = false;

/**
 * Take the browser lock for the rest of this process. A lock whose owner is gone is
 * taken over. Waits up to `waitMs`, saying so once, then fails naming the owner.
 */
export async function acquireBrowserLock(waitMs = 10 * 60_000, log: (m: string) => void = (m) => console.error(m)): Promise<void> {
  if (held) return;
  mkdirSync(stateDir(), { recursive: true });
  const path = lockPath();
  const start = Date.now();
  let told = false;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      held = true;
      const release = () => {
        try {
          if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path);
        } catch {
          /* exiting anyway */
        }
      };
      process.on("exit", release);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const owner = Number(readFileSafe(path));
    if (!Number.isInteger(owner) || owner <= 0 || !pidAlive(owner)) {
      rmSync(path, { force: true }); // stale: its owner is gone
      continue;
    }
    if (Date.now() - start > waitMs) {
      throw new Error(`browser is in use by travel-search process ${owner} (lock ${path}); waited ${Math.round(waitMs / 1000)}s`);
    }
    if (!told) {
      log(`waiting for the browser: travel-search process ${owner} is using it`);
      told = true;
    }
    await sleep(2_000);
  }
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

// ───────────────────────────── shared driver ─────────────────────────────

/** Build the one driver instance for this run. Default pacing comes from sources.schedule. */
export function createBrowser(cfg: Config): BrowserDriver {
  const cmd = driverCommand(cfg);
  const sched = (cfg.sources?.schedule ?? {}) as Record<string, unknown>;
  const defaultPacing = {
    pacingMs: typeof sched.pacing_ms === "number" ? sched.pacing_ms : 4000,
    jitterMs: typeof sched.jitter_ms === "number" ? sched.jitter_ms : 1500,
  };
  let count = 0;

  return {
    async open(url, pacing = defaultPacing) {
      await acquireBrowserLock();
      // Paced per site across every travel-search run, not just within this one: the lock
      // makes runs serial, and the shared timestamp makes a new run wait out the last one.
      const host = new URL(url).host;
      const gap = pacing.pacingMs + Math.floor(Math.random() * pacing.jitterMs);
      const wait = pacingWait(lastRequestAt(host), gap);
      if (wait > 0) await sleep(wait);
      recordRequest(host);
      count++;
      const out = await runDriver(cmd, ["open", url], 90_000);
      let tabId: unknown;
      try {
        tabId = (JSON.parse(out) as { tabId?: unknown }).tabId;
      } catch {
        /* reported below */
      }
      if (!Number.isInteger(tabId) || (tabId as number) <= 0) {
        throw new Error(`${cmd[0]} open did not return a tab id: ${out.trim().slice(0, 200)}`);
      }
      return tabId as number;
    },
    async read(tabId, settled, deadlineMs = 45_000) {
      const start = Date.now();
      let last = "";
      while (Date.now() - start < deadlineMs) {
        await sleep(2500);
        last = htmlFromRead(await runDriver(cmd, ["read", "--tab", String(tabId)], 60_000));
        if (last.length > 0 && settled(last)) return last;
      }
      throw new Error(`page in tab ${tabId} did not settle within ${deadlineMs}ms (last read ${last.length} bytes)`);
    },
    async click(tabId, selector) {
      await runDriver(cmd, ["act", "click", selector, "--tab", String(tabId)], 30_000);
    },
    requests: () => count,
  };
}
