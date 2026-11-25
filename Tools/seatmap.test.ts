/**
 * The seat-map plug-in contract: loading, version checks, availability checks, and the
 * browser lock. Fake providers are written to a temp directory and loaded for real.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBrowserLock, htmlFromRead, lockPath } from "./browser.ts";
import { assertProvider, checkAvailability, loadSeatMapProvider, seatMapSettings, SeatMapUnavailable } from "./seatmap.ts";
import { SEATMAP_API_VERSION, type BrowserDriver } from "./seatmap-api.ts";
import { CFG } from "./test-helpers.ts";
import type { Config } from "./painfulness.ts";

const browser: BrowserDriver = {
  open: async () => 1,
  read: async () => "",
  click: async () => {},
  requests: () => 0,
};

function providerFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-provider-"));
  const f = join(dir, "provider.ts");
  writeFileSync(f, body);
  return f;
}

function withModule(module: string, extra: Record<string, unknown> = {}): Config {
  return { ...CFG, sources: { ...CFG.sources, seatmap: { enabled: true, module, options: { pace: 7 }, ...extra } } };
}

describe("loading a provider", () => {
  test("a well-formed provider loads and receives the shared browser and its options", async () => {
    const f = providerFile(`
      export const createProvider = (ctx) => ({
        apiVersion: ${SEATMAP_API_VERSION}, name: "fake",
        seatMap: async () => ({ sawBrowser: ctx.browser.requests() === 0, pace: ctx.options.pace }),
      });`);
    const p = await loadSeatMapProvider(withModule(f), browser);
    expect(p.name).toBe("fake");
    expect(await p.seatMap({} as never)).toEqual({ sawBrowser: true, pace: 7 } as never);
  });

  test("a default export works too", async () => {
    const f = providerFile(`export default () => ({ apiVersion: ${SEATMAP_API_VERSION}, name: "d", seatMap: async () => ({}) });`);
    expect((await loadSeatMapProvider(withModule(f), browser)).name).toBe("d");
  });

  test("a provider built for another API version is refused, naming both versions", async () => {
    const f = providerFile(`export const createProvider = () => ({ apiVersion: 99, name: "old", seatMap: async () => ({}) });`);
    const err = await loadSeatMapProvider(withModule(f), browser).catch((e) => e);
    expect(err).toBeInstanceOf(SeatMapUnavailable);
    expect(err.message).toContain("version 99");
    expect(err.message).toContain(`version ${SEATMAP_API_VERSION}`);
  });

  test("a provider without seatMap is refused, naming what is missing", () => {
    expect(() => assertProvider({ apiVersion: SEATMAP_API_VERSION, name: "x" }, "p")).toThrow(/missing seatMap/);
    expect(() => assertProvider({ apiVersion: SEATMAP_API_VERSION, name: "x", seatMap: async () => ({}) as never, check: 3 as never }, "p")).toThrow(
      /check must be a function/,
    );
    expect(() => assertProvider(undefined, "p")).toThrow(/returned nothing/);
  });

  test("disabled, unset, missing, and broken modules each fail with their own reason", async () => {
    const msg = async (c: Config) => (await loadSeatMapProvider(c, browser).catch((e) => e)).message as string;
    expect(await msg(CFG)).toContain("sources.seatmap.enabled");
    expect(await msg({ ...CFG, sources: { ...CFG.sources, seatmap: { enabled: true } } })).toContain("sources.seatmap.module is not set");
    expect(await msg(withModule("/nonexistent/provider.ts"))).toContain("not found at /nonexistent/provider.ts");
    expect(await msg(withModule(providerFile("export const nothing = 1;")))).toContain("does not export createProvider");
    expect(await msg(withModule(providerFile("throw new Error('boom at import')")))).toContain("boom at import");
  });

  test("settings default sensibly and read overrides", () => {
    const d = seatMapSettings(CFG);
    expect([d.enabled, d.cabins, d.topN, d.maxFetches, d.economyCabin, d.premiumCabin]).toEqual([false, ["Y", "F"], 4, 16, "Y", "F"]);
    const o = seatMapSettings(withModule("x", { cabins: ["W"], top_n: 2, max_fetches: 5, economy_cabin: "W", premium_cabin: "J" }));
    expect([o.cabins, o.topN, o.maxFetches, o.economyCabin, o.premiumCabin]).toEqual([["W"], 2, 5, "W", "J"]);
  });
});

describe("availability from a provider is checked before use", () => {
  const seg = {
    airline: "UA", flightNumber: "1234", origin: "ORD", destination: "DEN",
    departDate: "2027-03-10", departTime: "07:25", arriveDate: "2027-03-10", arriveTime: "09:05",
    aircraft: "739", buckets: [{ cls: "J", count: 4 }],
  };
  const ok = { itineraries: [{ segments: [seg] }], complete: true };

  test("a good result passes", () => {
    expect(checkAvailability(ok, "p").itineraries).toHaveLength(1);
  });

  test("each kind of bad field is named", () => {
    const bad = (s: Record<string, unknown>) => () => checkAvailability({ itineraries: [{ segments: [{ ...seg, ...s }] }], complete: true }, "p");
    expect(bad({ departTime: "7:25 AM" })).toThrow(/departTime must be HH:MM/);
    expect(bad({ departDate: "03/10/27" })).toThrow(/departDate must be YYYY-MM-DD/);
    expect(bad({ buckets: [{ cls: "J", count: 12 }] })).toThrow(/not 0-9/);
    expect(bad({ buckets: [{ cls: "JJ", count: 1 }] })).toThrow(/bad fare class/);
    expect(bad({ flightNumber: "" })).toThrow(/flightNumber missing/);
    expect(() => checkAvailability({ itineraries: [{ segments: [] }], complete: true }, "p")).toThrow(/no segments/);
  });

  test("an incomplete result must say why", () => {
    expect(() => checkAvailability({ ...ok, complete: false }, "p")).toThrow(/no note/);
    expect(checkAvailability({ ...ok, complete: false, note: "budget ran out" }, "p").note).toBe("budget ran out");
  });
});

describe("the shared browser", () => {
  test("a cut-off read still yields markup", () => {
    expect(htmlFromRead(JSON.stringify({ html: "<p>x</p>" }))).toBe("<p>x</p>");
    expect(htmlFromRead('{"html":"<rect data-name=\\"12A\\"')).toContain('<rect data-name="12A"');
  });

  test("a second process waits for the lock and says so, then gives up naming the owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-lock-"));
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    // Hold the lock from a child process that stays alive for the test.
    const child = Bun.spawn(["bun", "-e", `
      import { acquireBrowserLock } from "${join(import.meta.dir, "browser.ts")}";
      await acquireBrowserLock(1000, () => {});
      console.log("held"); await Bun.sleep(5000);`], { stdout: "pipe", env: { ...process.env, XDG_STATE_HOME: dir } });
    try {
      const reader = child.stdout.getReader();
      await reader.read(); // "held"
      const said: string[] = [];
      const err = await acquireBrowserLock(2500, (m) => said.push(m)).catch((e) => e);
      expect(said[0]).toContain(`process ${child.pid}`);
      expect(String(err?.message)).toContain(`in use by travel-search process ${child.pid}`);
    } finally {
      child.kill();
      await child.exited;
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
  });

  test("a lock left by a dead process is taken over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-lock-"));
    const out = Bun.spawnSync(["bun", "-e", `
      import { writeFileSync, mkdirSync } from "node:fs";
      import { acquireBrowserLock, lockPath, stateDir } from "${join(import.meta.dir, "browser.ts")}";
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(lockPath(), "999999");
      await acquireBrowserLock(1000, () => {});
      console.log("took it");`], { env: { ...process.env, XDG_STATE_HOME: dir } });
    expect(out.stdout.toString()).toContain("took it");
    expect(lockPath()).toContain("travel-search");
  });
});
