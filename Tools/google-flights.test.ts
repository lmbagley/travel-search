/**
 * Google Flights parser tests — pinned to a false-empty reproduction.
 *
 * A search once returned 0 itineraries from a page holding 12 rendered
 * rows and "6 results returned": the visible-text regex handled Google's duplicated time
 * markup on the departure side but not the arrival side, and zero parses was returned
 * as data instead of an error. The fixtures are verbatim slices of the failing pages.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  airportCode,
  classifyZeroParse,
  driverCommand,
  airlineCode,
  googleFlightsUrl,
  parseGoogleFlightsAriaLabels,
  parseGoogleFlightsSummaries,
} from "./google-flights.ts";
import { ALL_FLIGHTS_TFU, base64url, tfsBytes } from "./google-url.ts";
import { applyHardRules, rank, renderTable, type Config } from "./painfulness.ts";
import { CFG } from "./test-helpers.ts";

const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures", n), "utf8");
const sfoHtml = fx("gf-onestop-6.html");
const twoStopHtml = fx("gf-twostop-10.html");
const oneStopRes = parseGoogleFlightsAriaLabels(sfoHtml, "SEA", "BDL");
const sfoIts = oneStopRes.itineraries;

describe("aria-label parser", () => {
  test("extracts all 6 unique itineraries from the page the old parser read as empty — zero drops", () => {
    expect(sfoIts.length).toBe(6);
    expect(oneStopRes.candidateCount).toBe(6);
    expect(oneStopRes.dropped).toEqual([]);
    expect(oneStopRes.departureDates.filter((d) => d.startsWith("Sunday, March 14")).length).toBe(6);
  });

  test("the 6:00 AM row carries measured fields, not inferred ones", () => {
    const row = sfoIts.find((i) => i.segments[0]?.departLocal === "06:00")!;
    expect(row).toBeDefined();
    expect(row.segments[0].arriveLocal).toBe("16:54");
    expect(row.segments[0].arriveDayOffset).toBe(0);
    expect(row.segments[0].aircraft).toBe("not expanded");
    expect(row.segments[0].operatedBy).toContain("PSA");
    expect(row.priceFrom).toBe(395);
    expect(row.totalDurationMinutes).toBe(474);
    expect(row.measuredConnections).toEqual([{ airport: "PHL", minutes: 62 }]);
  });

  test("next-day arrival is measured from differing label dates", () => {
    const redeye = sfoIts.find((i) => i.segments[0]?.departLocal === "23:40")!;
    expect(redeye.segments[0].arriveDayOffset).toBe(1);
    expect(sfoIts.filter((i) => i.segments[0]?.arriveDayOffset === 0).length).toBe(4);
  });

  test("printed layover minutes and hub-name → code mapping", () => {
    const conns = sfoIts.flatMap((i) => i.measuredConnections ?? []);
    expect(conns).toContainEqual({ airport: "CLT", minutes: 38 });
    expect(conns).toContainEqual({ airport: "PHL", minutes: 120 });
    expect(conns).toContainEqual({ airport: "ORD", minutes: 146 });
  });

  test("second golden: 10 itineraries incl. 2-stop rows with two measured connections each", () => {
    const res = parseGoogleFlightsAriaLabels(twoStopHtml, "BDL", "SEA");
    expect(res.dropped).toEqual([]);
    expect(res.candidateCount).toBe(10);
    expect(res.itineraries.length).toBe(10);
    const twoStop = res.itineraries.filter((i) => (i.measuredConnections?.length ?? 0) === 2);
    expect(twoStop.length).toBe(4);
    expect(twoStop.find((i) => i.segments[0].departLocal === "06:00")!.measuredConnections).toEqual([
      { airport: "DCA", minutes: 59 },
      { airport: "DFW", minutes: 41 },
    ]);
  });

  test("pseudo-segments feed the hard rules: the 5:05 AM / 38-min-CLT row rejects on real reasons", () => {
    const reasons = applyHardRules(sfoIts.find((i) => i.segments[0]?.departLocal === "05:05")!, CFG);
    expect(reasons).toContain("departs-too-early");
    expect(reasons).toContain("connection-below-floor");
  });

  test("parsed rows rank and render end-to-end without expansion", () => {
    const verdicts = rank(sfoIts, CFG);
    expect(verdicts.length).toBe(6);
    expect(() => renderTable(verdicts, CFG)).not.toThrow();
    expect(verdicts.some((v) => v.rejected.length === 0)).toBe(true);
  });

  test("sub-hour durations parse — 'Total duration 55 min' is not a drop", () => {
    const html = `<div aria-label="From 199 US dollars. Nonstop flight with American. Leaves Hollywood Burbank Airport at 9:00 AM on Sunday, March 14 and arrives at Harry Reid International Airport at 9:55 AM on Sunday, March 14. Total duration 55 min. 1 carry-on bag included and more text to satisfy the length gate of the label regex here"></div>`;
    const r = parseGoogleFlightsAriaLabels(html, "BUR", "LAS");
    expect(r.dropped).toEqual([]);
    expect(r.itineraries[0].totalDurationMinutes).toBe(55);
    expect(r.itineraries[0].measuredConnections).toEqual([]);
  });

  test("a stop-count/layover mismatch is a counted DROP — never a fake nonstop that skips the floors", () => {
    const html = `<div aria-label="From 395 US dollars. 1 stop flight with American. Leaves Seattle-Tacoma International Airport at 7:00 AM on Sunday, March 14 and arrives at Bradley International Airport at 6:52 PM on Sunday, March 14. Total duration 8 hr 52 min. Stopover of 2 hr at Philadelphia International Airport in Philadelphia reworded so the layover regex misses it entirely"></div>`;
    const r = parseGoogleFlightsAriaLabels(html, "SEA", "BDL");
    expect(r.itineraries).toEqual([]);
    expect(r.candidateCount).toBe(1);
    expect(r.dropped.length).toBe(1);
  });

  test("an unparseable layover duration is a DROP, not a fabricated 0-minute connection", () => {
    const html = `<div aria-label="From 395 US dollars. 1 stop flight with American. Leaves Seattle-Tacoma International Airport at 7:00 AM on Sunday, March 14 and arrives at Bradley International Airport at 6:52 PM on Sunday, March 14. Total duration 8 hr 52 min. Layover (1 of 1) is a brief layover at Philadelphia International Airport in Philadelphia. 1 carry-on bag included"></div>`;
    const r = parseGoogleFlightsAriaLabels(html, "SEA", "BDL");
    expect(r.itineraries).toEqual([]);
    expect(r.dropped.length).toBe(1);
  });

  test("multi-word carriers map to their IATA code", () => {
    const html = `<div aria-label="From 150 US dollars. Nonstop flight with Sun Country. Leaves Minneapolis-Saint Paul International Airport at 9:00 AM on Sunday, March 14 and arrives at Harry Reid International Airport at 10:55 AM on Sunday, March 14. Total duration 3 hr 55 min. padding padding padding"></div>`;
    expect(parseGoogleFlightsAriaLabels(html, "MSP", "LAS").itineraries[0].segments[0].marketingAirline).toBe("SY");
  });

  test("the published count parses from the reproduction fixture", () => {
    expect(/(\d+)\s+results?\s+returned/.exec(sfoHtml.replace(/<[^>]+>/g, " "))?.[1]).toBe("6");
  });
});

describe("airport name → code reference data", () => {
  test("overlapping names resolve to the right airport", () => {
    expect(airportCode("Dallas Fort Worth International Airport")).toBe("DFW");
    expect(airportCode("Dallas Love Field")).toBe("DAL");
    expect(airportCode("Chicago O'Hare International Airport")).toBe("ORD");
    expect(airportCode("Chicago Midway International Airport")).toBe("MDW");
  });
  test("unknown names pass through verbatim (the general connection floor still applies)", () => {
    expect(airportCode("Some Regional Airport")).toBe("Some Regional Airport");
  });
});

describe("fallback visible-text parser", () => {
  test("matches the duplicated-arrival-time shape that produced the false-empty", () => {
    const text =
      "Sorted by top flights 6:00 AM 6:00 AM on Sun, Mar 14 – 4:54 PM 4:54 PM on Sun, Mar 14 American Operated by PSA Airlines as American Eagle 7 hr 54 min SEA Seattle-Tacoma International Airport";
    const its = parseGoogleFlightsSummaries(text, "SEA", "BDL");
    expect(its.length).toBe(1);
    expect(its[0].segments[0].departLocal).toBe("06:00");
    expect(its[0].segments[0].arriveLocal).toBe("16:54");
    expect(its[0].totalDurationMinutes).toBe(474);
  });

  test("still matches the non-duplicated shape", () => {
    const its = parseGoogleFlightsSummaries("flights 7:25 AM – 4:29 PM on Sun, Mar 7 American 6 hr 4 min DFW", "SEA", "STL");
    expect(its.length).toBe(1);
    expect(its[0].segments[0].departLocal).toBe("07:25");
  });
});

describe("zero-parse classification — an empty result is only data when the page says so", () => {
  test("zero parses with rendered rows is a PARSE FAILURE", () => {
    const v = classifyZeroParse(12, "some page text with no recognizable markers", 2_600_000, null);
    expect(v.kind).toBe("parse-failure");
    expect(v.message).toContain("12 itinerary rows");
  });
  test("zero rows with no marker and no published zero is NOT A MEASUREMENT", () => {
    expect(classifyZeroParse(0, "window.WIZ_global_data = {}", 90_000, null).kind).toBe("not-a-measurement");
  });
  test("a no-results PHRASE alone is not proof — hidden templates carry the same words", () => {
    const v = classifyZeroParse(0, "shell with a hidden template saying No results found for this search", 90_000, null);
    expect(v.kind).toBe("not-a-measurement");
    expect(v.message).toContain("does not count as proof");
  });
  test("the source's own published zero is the one trusted empty", () => {
    const v = classifyZeroParse(0, "Search results 0 results returned. No results found.", 500_000, 0);
    expect(v.kind).toBe("proven-empty");
    expect(v.marker).toBeTruthy();
  });
});

describe("driver and URL", () => {
  test("driver defaults to interceptor and honours sources.schedule.driver_cmd", () => {
    expect(driverCommand(CFG)).toEqual(["interceptor"]);
    const c: Config = { ...CFG, sources: { ...CFG.sources, schedule: { driver_cmd: "my-browser --profile x" } } };
    expect(driverCommand(c)).toEqual(["my-browser", "--profile", "x"]);
  });
  test("the link is structured (no English for Google to misread) and asks for every flight", () => {
    const u = new URL(googleFlightsUrl("SEA", "JFK", "2027-01-05", "United"));
    expect(u.searchParams.has("q")).toBe(false);
    expect(u.searchParams.get("tfu")).toBe(ALL_FLIGHTS_TFU);
    const raw = Buffer.from(u.searchParams.get("tfs")!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    for (const part of ["2027-01-05", "SEA", "JFK", "UA"]) expect(raw).toContain(part);
    // The airline filter is optional, and a name and its code give the same link.
    expect(googleFlightsUrl("SEA", "JFK", "2027-01-05", "UA")).toBe(googleFlightsUrl("SEA", "JFK", "2027-01-05", "united"));
    const none = Buffer.from(new URL(googleFlightsUrl("SEA", "JFK", "2027-01-05")).searchParams.get("tfs")!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    expect(none).not.toContain("UA");
  });

  test("an airline name it does not know is an error, never a guess", () => {
    expect(airlineCode("aa")).toBe("AA");
    expect(() => airlineCode("Imaginary Air")).toThrow(/2-letter code/);
  });

  test("matches, byte for byte, the link Google itself wrote for this search (captured 2026-11-24)", () => {
    expect(base64url(tfsBytes({ origin: "SFO", destination: "ORD", date: "2026-12-10", cabin: "economy", airlines: ["AA"] }))).toBe(
      "CBwQAhoiEgoyMDI2LTEyLTEwMgJBQWoHCAESA1NGT3IHCAESA09SREABSAFwAYIBCwj___________8BmAEC",
    );
  });

  test("each cabin sets its own seat field, and bad input is refused", () => {
    const seat = (cabin: string) => tfsBytes({ origin: "SFO", destination: "ORD", date: "2026-12-10", cabin }).join(",");
    const all = ["economy", "premium", "business", "first"].map(seat);
    expect(new Set(all).size).toBe(4);
    expect(seat("economy")).toContain([0x48, 1].join(",")); // field 9 = 1
    expect(seat("first")).toContain([0x48, 4].join(",")); // field 9 = 4
    expect(() => tfsBytes({ origin: "SFO", destination: "ORD", date: "2026-12-10", cabin: "steerage" })).toThrow(/unknown cabin/);
    expect(() => tfsBytes({ origin: "sfo", destination: "ORD", date: "2026-12-10" })).toThrow(/3 capital letters/);
    expect(() => tfsBytes({ origin: "SFO", destination: "ORD", date: "12/10/26" })).toThrow(/YYYY-MM-DD/);
  });
});

describe("search pacing", () => {
  test("a search waits out the last Google request from any run (live gap 2026-11-24)", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ts-gpace-"));
    const log = join(dir, "opens.log");
    const fake = join(dir, "fake-driver.ts");
    // open: record when it happened; read: fail at once (this test is only about the open).
    writeFileSync(fake, `const [cmd] = process.argv.slice(2);
if (cmd === "open") { require("node:fs").appendFileSync(${JSON.stringify(log)}, Date.now() + "\\n"); console.log(JSON.stringify({ tabId: 7 })); }
else { console.error("no page"); process.exit(1); }`);
    // Its own process: the search takes the browser lock for the life of the process.
    const cfg: Config = {
      ...CFG,
      sources: { ...CFG.sources, schedule: { driver_cmd: `bun ${fake}`, pacing_ms: 1500, jitter_ms: 0, settle_ms: 0, settle_jitter_ms: 0 } },
    };
    const run = Bun.spawnSync(["bun", "-e", `
      import { recordRequest } from "${join(import.meta.dir, "browser.ts")}";
      import { collectGoogleFlights } from "${join(import.meta.dir, "google-flights.ts")}";
      const last = Date.now();
      recordRequest("www.google.com", last); // another run just loaded Google
      await collectGoogleFlights("SFO", "ORD", "2026-12-10", "AA", ${JSON.stringify(cfg)}).catch(() => {});
      console.log("LAST " + last);`], { env: { ...process.env, XDG_STATE_HOME: dir } });
    const last = Number(run.stdout.toString().match(/LAST (\d+)/)?.[1]);
    const opened = Number(readFileSync(log, "utf8").trim().split("\n")[0]);
    expect(last).toBeGreaterThan(0);
    expect(opened - last).toBeGreaterThanOrEqual(1400);
  }, 30_000);
});
