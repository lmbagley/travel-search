/**
 * End-to-end CLI and installer tests. Every run points HOME and TRAVEL_SEARCH_CONFIG
 * at a temp dir, so nothing here can read or write the real user's files.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXAMPLE_CONFIG_PATH, loadConfig } from "./config.ts";
import { parseGoogleFlightsAriaLabels } from "./google-flights.ts";
import { install, VERSION } from "../install.ts";

const TOOL = resolve(import.meta.dir, "travel.ts");

function run(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "ts-home-"));
  const p = Bun.spawnSync(["bun", TOOL, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TRAVEL_SEARCH_CONFIG: EXAMPLE_CONFIG_PATH,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function fixtureFile(claimed: number | null): string {
  const html = readFileSync(join(import.meta.dir, "fixtures", "gf-onestop-6.html"), "utf8");
  const its = parseGoogleFlightsAriaLabels(html, "SEA", "BDL").itineraries;
  const f = join(mkdtempSync(join(tmpdir(), "ts-fx-")), "set.json");
  writeFileSync(f, JSON.stringify({ claimedResultCount: claimed, itineraries: its }));
  return f;
}

describe("config", () => {
  test("the shipped example loads and validates", () => {
    const c = loadConfig(EXAMPLE_CONFIG_PATH);
    expect(c.painfulness.hard.no_redeye).toBe(true);
    expect(c.defaults.airline).toBeTruthy();
  });

  test("a missing config fails loudly, naming the path and the example", () => {
    const r = run(["config"], { TRAVEL_SEARCH_CONFIG: "/nonexistent/travel.yaml" });
    expect(r.rc).toBe(1);
    expect(r.err).toContain("/nonexistent/travel.yaml");
    expect(r.err).toContain("config.example.yaml");
  });

  test("an invalid config names every missing section", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ts-bad-")), "c.yaml");
    writeFileSync(f, "traveler: {}\n");
    const r = run(["config"], { TRAVEL_SEARCH_CONFIG: f });
    expect(r.rc).toBe(1);
    for (const s of ["painfulness.hard", "painfulness.scored", "defaults.airline", "sources"]) expect(r.err).toContain(s);
  });
});

describe("score", () => {
  test("ranks a complete set, prints the fare gate and the seat-map gap", () => {
    const r = run(["score", fixtureFile(6)]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("Verdict");
    expect(r.out).toContain("fare gate");
    expect(r.out).toContain("seat map: UNAVAILABLE");
    expect(r.out).toContain("exit rows are NOT guessed");
  });

  test("refuses an incomplete set with exit 4 unless told otherwise", () => {
    const f = fixtureFile(9);
    expect(run(["score", f]).rc).toBe(4);
    expect(run(["score", f, "--allow-incomplete"]).rc).toBe(0);
  });
});

describe("award without a key", () => {
  test("exits 3 and names every way to supply the key", () => {
    const r = run(["award", "search", "SEA", "NRT", "2027-02-01"], { SEATS_AERO_API_KEY: "" });
    expect(r.rc).toBe(3);
    expect(r.err).toContain("SEATS_AERO_API_KEY");
    expect(r.err).toContain("op://");
  });

  test("an unknown cabin is a usage error (exit 2), before any network call", () => {
    const r = run(["award", "search", "SEA", "NRT", "2027-02-01", "--cabin", "lounge"], { SEATS_AERO_API_KEY: "x".repeat(20) });
    expect(r.rc).toBe(2);
    expect(r.err).toContain("unknown cabin");
  });
});

describe("doctor", () => {
  test("reports every capability by name with a missing browser driver", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ts-cfg-")), "c.yaml");
    writeFileSync(
      f,
      readFileSync(EXAMPLE_CONFIG_PATH, "utf8").replace("driver_cmd: interceptor", "driver_cmd: definitely-not-a-browser-zz"),
    );
    const r = run(["doctor"], { TRAVEL_SEARCH_CONFIG: f, SEATS_AERO_API_KEY: "" });
    expect(r.out).toMatch(/^config\s+OK/m);
    expect(r.out).toMatch(/^browser\s+MISSING definitely-not-a-browser-zz/m);
    expect(r.out).toMatch(/^award\s+MISSING/m);
    expect(r.out).toMatch(/^seat maps\s+NONE/m);
  });
});

describe("install", () => {
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), "ts-inst-"));
    return { claudeDir: join(root, ".claude"), configDir: join(root, ".config", "travel-search"), root };
  };

  test("copies the skill without .git or node_modules and scaffolds the config", () => {
    const o = fresh();
    install({ ...o, link: false });
    const dest = join(o.claudeDir, "skills", "TravelSearch");
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "Tools", "travel.ts"))).toBe(true);
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    expect(readFileSync(join(o.configDir, "config.yaml"), "utf8")).toBe(readFileSync(EXAMPLE_CONFIG_PATH, "utf8"));
  });

  test("never overwrites an existing config, and re-installs cleanly", () => {
    const o = fresh();
    mkdirSync(o.configDir, { recursive: true });
    writeFileSync(join(o.configDir, "config.yaml"), "mine\n");
    install({ ...o, link: false });
    install({ ...o, link: false });
    expect(readFileSync(join(o.configDir, "config.yaml"), "utf8")).toBe("mine\n");
  });

  test("is idempotent: a second run changes nothing and says so", () => {
    const o = fresh();
    const first = install({ ...o, link: false });
    const dest = join(o.claudeDir, "skills", "TravelSearch");
    expect(first[0]).toContain(`installed ${VERSION}`);
    const before = readdirSync(dest, { recursive: true }).sort();
    const second = install({ ...o, link: false });
    expect(second[0]).toContain("unchanged");
    expect(readdirSync(dest, { recursive: true }).sort()).toEqual(before);
    expect(readFileSync(join(dest, "VERSION"), "utf8").trim()).toBe(VERSION);
    expect(readdirSync(join(o.claudeDir, "skills"))).toEqual(["TravelSearch"]);
  });

  test("an upgrade replaces stale files and names the old version", () => {
    const o = fresh();
    install({ ...o, link: false });
    const dest = join(o.claudeDir, "skills", "TravelSearch");
    writeFileSync(join(dest, "VERSION"), "0.9.0\n");
    writeFileSync(join(dest, "Tools", "removed-long-ago.ts"), "old\n");
    const log = install({ ...o, link: false });
    expect(log[0]).toContain("(was 0.9.0)");
    expect(existsSync(join(dest, "Tools", "removed-long-ago.ts"))).toBe(false);
    expect(readdirSync(join(o.claudeDir, "skills"))).toEqual(["TravelSearch"]);
  });

  test("--link twice is a no-op, and copy then link then copy all work", () => {
    const o = fresh();
    install({ ...o, link: false });
    expect(install({ ...o, link: true })[0]).toContain("linked");
    expect(install({ ...o, link: true })[0]).toContain("unchanged");
    expect(install({ ...o, link: false })[0]).toContain("replaced a symlink");
    expect(lstatSync(join(o.claudeDir, "skills", "TravelSearch")).isSymbolicLink()).toBe(false);
  });

  test("refuses to write through a dangling config symlink", () => {
    const o = fresh();
    mkdirSync(o.configDir, { recursive: true });
    symlinkSync(join(o.root, "gone.yaml"), join(o.configDir, "config.yaml"));
    expect(() => install({ ...o, link: false })).toThrow(/does not exist/);
    expect(existsSync(join(o.root, "gone.yaml"))).toBe(false);
  });

  test("refuses to replace a directory that is not a TravelSearch install", () => {
    const o = fresh();
    const dest = join(o.claudeDir, "skills", "TravelSearch");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "---\nname: SomethingElse\n---\n");
    expect(() => install({ ...o, link: false })).toThrow(/refusing to overwrite/);
  });

  test("--link makes a symlink to the checkout", () => {
    const o = fresh();
    install({ ...o, link: true });
    expect(lstatSync(join(o.claudeDir, "skills", "TravelSearch")).isSymbolicLink()).toBe(true);
  });
});

describe("seat maps, decide and monitor without a plug-in", () => {
  test("seats exits 3 and names the setting when no seat-map source is configured", () => {
    const r = run(["seats", "UA", "1234", "ORD", "DEN", "2027-03-10"]);
    expect(r.rc).toBe(3);
    expect(r.err).toContain("sources.seatmap.enabled");
  });

  test("a bad date is a usage error before anything loads", () => {
    expect(run(["seats", "UA", "1234", "ORD", "DEN", "03/10/27"]).rc).toBe(2);
    expect(run(["decide", "ORD", "DEN", "03/10/27"]).rc).toBe(2);
  });

  test("monitor status and run say the monitor is idle with no watches, and run exits 0", () => {
    const s = run(["monitor", "status"]);
    expect(s.rc).toBe(0);
    expect(s.out).toContain("NO WATCHES CONFIGURED");
    const r = run(["monitor", "run"]);
    expect(r.rc).toBe(0);
    expect(r.out).toContain("NO WATCHES CONFIGURED: monitor is idle.");
  });

  test("monitor run with a watch but no seat-map source exits 3, never a silent success", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ts-cfg-")), "c.yaml");
    writeFileSync(
      f,
      readFileSync(EXAMPLE_CONFIG_PATH, "utf8").replace(
        "  watches: []",
        '  watches:\n    - { airline: UA, flightNumber: "1234", origin: ORD, destination: DEN, date: 2099-03-10, current_seat: 14C }',
      ),
    );
    const r = run(["monitor", "run"], { TRAVEL_SEARCH_CONFIG: f });
    expect(r.rc).toBe(3);
    expect(r.err).toContain("sources.seatmap");
  });

  test("doctor reports the monitor and the empty seat-map slot", () => {
    const r = run(["doctor"], { SEATS_AERO_API_KEY: "" });
    expect(r.out).toMatch(/^monitor\s+CONFIG\s+no watches \(idle\)/m);
    expect(r.out).toMatch(/^seat maps\s+NONE/m);
  });
});
