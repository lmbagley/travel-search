#!/usr/bin/env bun
/**
 * travel.ts — find the least painful flight, not the cheapest one; and find award seats.
 *
 * Exit codes:  0 ok · 1 error · 2 usage · 3 capability unavailable · 4 data incomplete
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig } from "./config.ts";
import { collectGoogleFlights, driverCommand } from "./google-flights.ts";
import {
  assertComplete,
  legroomFare,
  num,
  rank,
  renderTable,
  seatableFare,
  str,
  type Config,
  type Itinerary,
} from "./painfulness.ts";
import {
  AwardApiError,
  CABINS,
  apiGet,
  attachSegments,
  awardTripToItinerary,
  renderAwardTable,
  searchAwards,
  sortByCost,
  type Cabin,
} from "./seats-aero.ts";
import { redact, resolveSecret, type ResolvedSecret } from "./secrets.ts";
import { createBrowser } from "./browser.ts";
import { fetchCabinPrices } from "./cabin-prices.ts";
import { decide, renderDecision, renderSeatLine } from "./decide.ts";
import { airlineNameFor } from "./google-flights.ts";
import { monitorRun, statusLines } from "./monitor-run.ts";
import { checkAvailability, checkSeatMap, loadSeatMapProvider, seatMapSettings, SeatMapUnavailable } from "./seatmap.ts";
import type { BrowserDriver, SeatMapProvider } from "./seatmap-api.ts";
import { legSeatReality, SEAT_LEGEND, seatToken } from "./seats.ts";

const HELP = `travel-search — rank flights by least painful, not cheapest; search award space.

  travel.ts search <ORIG> <DEST> <YYYY-MM-DD> [--airline <Name>]
        Collect one direction from Google Flights (needs a browser driver). Prints JSON.
  travel.ts score <file.json> [--allow-incomplete]
        Rank a collected set against your painfulness model. No network.
  travel.ts award search <ORIG> <DEST> <START> [END] [--cabin business,first]
        [--program aeroplan,united] [--carriers NH,JL] [--direct] [--max-pages N]
        [--sort cost|pain] [--detail N] [--limit N] [--json]
        seats.aero cached award search. ORIG/DEST may be comma lists (SFO,LAX).
        --sort pain ranks with your painfulness model; it fetches leg detail for the
        N cheapest availability records (default 10, one API call each).
  travel.ts award probe          One cheap call to prove the seats.aero key works.
  travel.ts award routes <program>   Routes seats.aero tracks for a mileage program.
  travel.ts seats <AL> <FLT> <ORIG> <DEST> <YYYY-MM-DD> [--cabin Y] [--json]
        Read one flight's seat map through your seat-map plug-in and rank it on your ladder.
  travel.ts avail <ORIG> <DEST> <YYYY-MM-DD> [--airlines UA] [--json]
        Fare-class availability for the day, if your seat-map plug-in offers it.
  travel.ts price <ORIG> <DEST> <YYYY-MM-DD> [--cabin first] [--airline <Name>] [--json]
        Google Flights headline prices for one cabin.
  travel.ts decide <ORIG> <DEST> <YYYY-MM-DD> [--airlines UA] [--top N] [--no-seatmaps] [--json]
        One table: pain ranking, price per cabin, seats you could sit in, upgrade estimate.
  travel.ts monitor run [--force] [--json]    One pass of the seat monitor (for a timer).
  travel.ts monitor status                    What each watch is doing.
  travel.ts doctor               Check config, browser driver, award key, seat maps.
  travel.ts config               Show the active config path and painfulness model.

Exit: 0 ok, 1 error, 2 usage, 3 capability unavailable, 4 data incomplete.`;

async function providerOrExit(cfg: Config, browser: BrowserDriver): Promise<SeatMapProvider> {
  try {
    return await loadSeatMapProvider(cfg, browser);
  } catch (e) {
    if (e instanceof SeatMapUnavailable) {
      console.error(e.message);
      process.exit(3);
    }
    throw e;
  }
}

function airlineNameOrUsage(code: string, override?: string): string | undefined {
  return override ?? airlineNameFor(code);
}

async function cmdSeats(rest: string[], cfg: Config) {
  const [al, flt, o, d, date] = positional(rest);
  if (!al || !flt || !o || !d || !date) throw new UsageError("seats needs <AL> <FLT> <ORIG> <DEST> <YYYY-MM-DD>");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`date must be YYYY-MM-DD, got "${date}"`);
  const browser = createBrowser(cfg);
  const provider = await providerOrExit(cfg, browser);
  const req = { airline: al.toUpperCase(), flightNumber: flt, origin: o.toUpperCase(), destination: d.toUpperCase(), date, cabin: flag(rest, "--cabin") ?? seatMapSettings(cfg).economyCabin };
  const reality = legSeatReality(cfg, checkSeatMap(await provider.seatMap(req), req, provider.name));
  if (rest.includes("--json")) {
    console.log(JSON.stringify(reality, null, 2));
    return;
  }
  console.log(renderSeatLine(reality, req.cabin));
  for (const s of reality.sitable.slice(0, 20)) {
    console.log(`    ${seatToken(s).padEnd(10)} ${s.position.padEnd(6)} ${(s.tier >= 0 ? `T${s.tier + 1}` : "off").padEnd(4)} ${s.state}`);
  }
  console.log("\n  " + SEAT_LEGEND.replace("\n", "\n  "));
  console.log(`\nsource: ${provider.name} | browser requests: ${browser.requests()}`);
}

async function cmdAvail(rest: string[], cfg: Config) {
  const [o, d, date] = positional(rest);
  if (!o || !d || !date) throw new UsageError("avail needs <ORIG> <DEST> <YYYY-MM-DD>");
  const browser = createBrowser(cfg);
  const provider = await providerOrExit(cfg, browser);
  if (!provider.availability) {
    console.error(`seat-map source "${provider.name}" does not offer fare-class availability`);
    process.exit(3);
  }
  const airlines = (flag(rest, "--airlines") ?? cfg.defaults.airline).split(",").map((a) => a.trim().toUpperCase());
  const res = checkAvailability(await provider.availability({ origin: o.toUpperCase(), destination: d.toUpperCase(), date, airlines }), provider.name);
  if (rest.includes("--json")) console.log(JSON.stringify(res, null, 2));
  else {
    for (const it of res.itineraries) {
      console.log(it.segments.map((s) => `${s.airline} ${s.flightNumber} ${s.origin} ${s.departTime} → ${s.destination} ${s.arriveTime} (${s.aircraft}) [${s.buckets.map((b) => b.cls + b.count).join(" ")}]`).join("  ||  "));
    }
    console.log(`\n${res.itineraries.length} itineraries from ${provider.name}${res.complete ? "" : ` — INCOMPLETE: ${res.note}`} | browser requests: ${browser.requests()}`);
  }
  if (!res.complete) process.exit(4);
}

async function cmdPrice(rest: string[], cfg: Config) {
  const [o, d, date] = positional(rest);
  if (!o || !d || !date) throw new UsageError("price needs <ORIG> <DEST> <YYYY-MM-DD>");
  const cabin = flag(rest, "--cabin") ?? "first";
  const name = flag(rest, "--airline") ?? str(cfg.sources?.schedule as Record<string, unknown>, "airline_name") ?? airlineNameFor(cfg.defaults.airline);
  const browser = createBrowser(cfg);
  let incomplete = "";
  const prices = await fetchCabinPrices(browser, o.toUpperCase(), d.toUpperCase(), date, cabin, name, (why) => (incomplete = why));
  if (rest.includes("--json")) console.log(JSON.stringify(prices, null, 2));
  else console.log(prices.map((p) => `${p.departTime} → ${p.arriveTime}  ${p.stops} stop(s)  ${p.price}`).join("\n"));
  if (incomplete) {
    console.error(`INCOMPLETE: ${incomplete}`);
    process.exitCode = 4;
  }
}

async function cmdDecide(rest: string[], cfg: Config) {
  const [o, d, date] = positional(rest);
  if (!o || !d || !date) throw new UsageError("decide needs <ORIG> <DEST> <YYYY-MM-DD>");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`date must be YYYY-MM-DD, got "${date}"`);
  const airlines = (flag(rest, "--airlines") ?? cfg.defaults.airline).split(",").map((a) => a.trim().toUpperCase());
  const browser = createBrowser(cfg);
  let provider: SeatMapProvider | undefined;
  if (seatMapSettings(cfg).enabled) provider = await providerOrExit(cfg, browser);
  const top = flag(rest, "--top");
  const res = await decide(cfg, browser, provider, o.toUpperCase(), d.toUpperCase(), date, {
    airlines,
    airlineName: airlineNameOrUsage(airlines[0]!, flag(rest, "--airline") ?? str(cfg.sources?.schedule as Record<string, unknown>, "airline_name")),
    seatmaps: !rest.includes("--no-seatmaps"),
    topN: top ? Number(top) : undefined,
  });
  if (rest.includes("--json")) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`flights from: ${res.flightsFrom}`);
    console.log(renderDecision(res));
    if (res.failures.length) {
      console.log("\nSOURCE FAILURES (the table above is missing these inputs):");
      for (const f of res.failures) console.log(`  ✗ ${f.source}: ${f.error}`);
    }
    console.log(`\nbrowser requests: ${res.requests} | fetched ${res.fetchedAt}`);
  }
  if (res.failures.length) process.exit(4);
}

async function cmdMonitor(rest: string[], cfg: Config) {
  const [sub] = rest;
  if (sub === "status") {
    console.log(statusLines(cfg).join("\n"));
    return;
  }
  if (sub !== "run") throw new UsageError(`unknown monitor command "${sub ?? ""}" (run | status)`);
  const browser = createBrowser(cfg);
  const lines = statusLines(cfg); // validates the monitor block before anything else
  const idle = lines.some((l) => l.startsWith("NO WATCHES CONFIGURED"));
  const provider = idle ? undefined : await providerOrExit(cfg, browser);
  const result = provider
    ? await monitorRun(cfg, browser, provider, { force: rest.includes("--force") })
    : { ranAt: new Date().toISOString(), passes: [], pruned: [], requests: 0, alertsSent: 0, failures: 0 };
  if (rest.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    if ("stateWarning" in result && result.stateWarning) console.log(`WARNING: ${result.stateWarning}`);
    for (const p of result.passes) {
      const alert = p.alertKind ? ` | alert ${p.alertKind}: ${(p.alertedSeats ?? []).join(",")}${p.messageId ? ` (message ${p.messageId})` : ""}` : "";
      const fail = p.error !== undefined ? ` | FAILURE: ${p.error}` : "";
      const h = p.hoursToDeparture === undefined ? "?" : p.hoursToDeparture.toFixed(1);
      console.log(`${p.flight} | phase ${p.phase} | h=${h} | ${p.due ? "due" : "skipped"} | ${p.checked ? "checked" : "not checked"}${alert}${fail}`);
    }
    if (result.passes.length === 0) console.log("NO WATCHES CONFIGURED: monitor is idle.");
    console.log(`\nalerts sent: ${result.alertsSent} | failures: ${result.failures} | pruned: ${result.pruned.length} | browser requests: ${result.requests}`);
  }
  if (result.failures > 0) process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
  return v;
}

class UsageError extends Error {}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (!["--direct", "--json", "--allow-incomplete", "--no-seatmaps", "--force"].includes(args[i])) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function awardCfg(cfg: Config): Record<string, unknown> {
  return (cfg.sources?.award as Record<string, unknown> | undefined) ?? {};
}

/** Resolution order: $SEATS_AERO_API_KEY, sources.award.api_key, sources.award.token_path, default file. */
export async function resolveAwardKey(cfg: Config): Promise<ResolvedSecret> {
  if (process.env.SEATS_AERO_API_KEY?.trim()) return resolveSecret("env:SEATS_AERO_API_KEY");
  const a = awardCfg(cfg);
  const ref =
    str(a, "api_key") ?? str(a, "token_path") ?? join(homedir(), ".config", "travel-search", "seats-aero-key");
  return resolveSecret(ref);
}

function parseCabins(v: string | undefined): Cabin[] | undefined {
  if (!v) return undefined;
  const list = v.split(",").map((c) => c.trim().toLowerCase());
  for (const c of list) {
    if (!(CABINS as readonly string[]).includes(c)) throw new UsageError(`unknown cabin "${c}" (use ${CABINS.join(", ")})`);
  }
  return list as Cabin[];
}

async function cmdScore(rest: string[], cfg: Config) {
  const file = positional(rest)[0];
  if (!file) throw new UsageError("score needs a file path");
  const data = JSON.parse(readFileSync(file, "utf8")) as { itineraries: Itinerary[]; claimedResultCount?: number };
  const comp = assertComplete(data.itineraries.length, data.claimedResultCount);
  if (!comp.complete && !rest.includes("--allow-incomplete")) {
    console.error(`INCOMPLETE: ${comp.reason}`);
    console.error(`Re-collect, or pass --allow-incomplete to rank anyway (and say so out loud).`);
    process.exit(4);
  }
  const verdicts = rank(data.itineraries, cfg);
  console.log(renderTable(verdicts, cfg));

  // Fare-brand gate: a pick you cannot choose a seat on is a wrong answer.
  const top = verdicts.find((v) => v.rejected.length === 0);
  if (top) {
    const seatable = seatableFare(top.itinerary);
    const legroom = legroomFare(top.itinerary);
    const headline = top.itinerary.priceFrom;
    console.log("\nfare gate (top eligible option):");
    if (!top.itinerary.fares?.length) {
      console.log("  fare ladder UNKNOWN — headline price may be Basic Economy. Verify before quoting.");
    } else if (seatable && headline !== undefined && seatable.price > headline) {
      console.log(
        `  headline $${headline} is ${top.itinerary.fares[0].brand} — NO seat selection.` +
          `\n  cheapest fare you can actually pick a seat on: ${seatable.brand} $${seatable.price}` +
          (legroom ? `\n  cheapest fare including extra legroom (exit-row bucket): ${legroom.brand} $${legroom.price}` : ""),
      );
    } else if (seatable) {
      console.log(
        `  headline fare ${seatable.brand} $${seatable.price} includes free seat selection` +
          (legroom ? `; extra legroom included from ${legroom.brand} $${legroom.price}` : ""),
      );
    }
  }
  const sm = seatMapSettings(cfg);
  if (!sm.enabled) {
    console.log(
      `\nseat map: UNAVAILABLE — sources.seatmap.enabled is not true in ${configPath()}` +
        `\n  aircraft type is reported above; exit rows are NOT guessed. Add a seat-map plug-in, then use 'travel.ts seats' or 'decide'.`,
    );
  } else {
    console.log(`\nseat maps: run 'travel.ts decide' or 'travel.ts seats <AL> <FLT> ...' for the flights above.`);
  }
}

async function cmdSearch(rest: string[], cfg: Config) {
  const [orig, dest, date] = positional(rest);
  if (!orig || !dest || !date) throw new UsageError("search needs <ORIG> <DEST> <YYYY-MM-DD>");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`search date must be YYYY-MM-DD, got "${date}"`);
  const airline = flag(rest, "--airline") ?? str(cfg.sources?.schedule as Record<string, unknown>, "airline_name");
  const drv = driverCommand(cfg);
  if (!Bun.which(drv[0])) {
    console.error(
      `browser driver "${drv[0]}" is not on PATH, so Google Flights cannot be read.\n` +
        `  set sources.schedule.driver_cmd in ${configPath()} (README "Browser driver"),\n` +
        `  or collect the options another way and rank them with: travel.ts score <file.json>`,
    );
    process.exit(3);
  }
  const res = await collectGoogleFlights(orig.toUpperCase(), dest.toUpperCase(), date, airline, cfg);
  console.log(
    JSON.stringify(
      {
        complete: res.complete,
        claimedResultCount: res.claimedResultCount,
        parsedCount: res.parsedCount,
        incompleteReason: res.incompleteReason,
        zeroProof: res.zeroProof,
        itineraries: res.itineraries,
      },
      null,
      2,
    ),
  );
  // 0 = data (complete, or proven empty); 4 = data but incomplete; errors exit 1.
  if (!res.complete) process.exit(4);
}

async function cmdAward(rest: string[], cfg: Config) {
  const [sub, ...args] = rest;
  const a = awardCfg(cfg);
  if (a.enabled === false) {
    console.error(`award search is disabled (sources.award.enabled: false in ${configPath()})`);
    process.exit(3);
  }
  let key: ResolvedSecret;
  try {
    key = await resolveAwardKey(cfg);
  } catch (e) {
    console.error(
      `seats.aero key unavailable: ${(e as Error).message}\n` +
        `  set SEATS_AERO_API_KEY, or put the key in ~/.config/travel-search/seats-aero-key (chmod 600),\n` +
        `  or point sources.award.api_key at env:NAME / op://vault/item/field / a file path.`,
    );
    process.exit(3);
  }
  if (key.warning) console.error(`warning: ${key.warning}`);
  const opts = { apiKey: key.value };

  try {
    if (sub === "probe") {
      const today = new Date();
      const d = new Date(today.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
      const { json, headers } = await apiGet(
        "/search",
        { origin_airport: "SFO", destination_airport: "JFK", start_date: d, end_date: d, take: "10" },
        opts,
      );
      console.log(`seats.aero: key accepted (via ${key.via})`);
      console.log(
        `rate limit: ${headers.get("x-ratelimit-remaining") ?? "?"} of ${headers.get("x-ratelimit-limit") ?? "?"} calls left today`,
      );
      console.log(`probe returned ${Array.isArray(json?.data) ? json.data.length : 0} records`);
      return;
    }
    if (sub === "routes") {
      const program = positional(args)[0];
      if (!program) throw new UsageError("award routes needs a program, e.g. aeroplan");
      const { json } = await apiGet("/routes", { source: program }, opts);
      const routes = Array.isArray(json) ? json : (json?.data ?? []);
      for (const r of routes) console.log(`${r.OriginAirport}-${r.DestinationAirport}`);
      console.error(`${routes.length} routes for ${program}`);
      return;
    }
    if (sub === "search") {
      const [orig, dest, start, endArg] = positional(args);
      if (!orig || !dest || !start) throw new UsageError("award search needs <ORIG> <DEST> <START> [END]");
      const end = endArg ?? start;
      const res = await searchAwards(
        {
          origin: orig,
          destination: dest,
          startDate: start,
          endDate: end,
          cabins: parseCabins(flag(args, "--cabin")),
          sources: flag(args, "--program")?.split(","),
          carriers: flag(args, "--carriers")?.split(","),
          directOnly: args.includes("--direct"),
          maxPages: Number(flag(args, "--max-pages") ?? num(a, "max_pages", 5)),
          take: num(a, "page_size", 500),
        },
        opts,
      );
      const sort = flag(args, "--sort") ?? "cost";
      const limit = Number(flag(args, "--limit") ?? 40);
      const stale = num(a, "stale_after_hours", 48);

      if (args.includes("--json")) {
        console.log(JSON.stringify(res, null, 2));
      } else if (sort === "pain") {
        // Cached search carries no per-leg times, so connections are unknown until
        // each availability record's trips are fetched (one call each, bounded).
        const detailCalls = Number(flag(args, "--detail") ?? num(a, "detail_calls", 10));
        const det = await attachSegments(res.trips, opts, detailCalls);
        console.error(`fetched leg detail for ${det.detailed}/${res.trips.length} trips with ${det.calls} call(s)`);
        const pairs = res.trips.map((t) => ({ t, it: awardTripToItinerary(t) }));
        const rankable = pairs.filter((p) => p.it !== null);
        const verdicts = rank(rankable.map((p) => p.it!), cfg);
        const byIt = new Map(rankable.map((p) => [p.it, p.t]));
        console.log(renderAwardTable(verdicts.slice(0, limit).map((v) => byIt.get(v.itinerary)!), stale));
        console.log("\npain ranking (same order as the table):");
        for (const v of verdicts.slice(0, limit)) {
          const t = byIt.get(v.itinerary)!;
          console.log(
            `  ${t.date} ${t.flightNumbers.join(" ")}  score ${v.score}  ${v.rejected.length ? `REJECT: ${v.rejected.join(",")}` : "eligible"}` +
              (v.connections.length ? `  conx ${v.connections.map((c) => `${c.airport} ${c.minutes}m`).join(", ")}` : ""),
          );
        }
        const unrankable = pairs.length - rankable.length;
        if (unrankable) {
          console.log(
            `\n${unrankable} connecting trips have no leg detail and were NOT ranked (raise --detail to fetch more; each is one API call).`,
          );
        }
        const links = new Map<string, string>();
        for (const v of verdicts.slice(0, limit)) {
          const t = byIt.get(v.itinerary)!;
          if (t.bookingLink && !links.has(t.program)) links.set(t.program, t.bookingLink);
        }
        if (links.size) {
          console.log("\nbook / verify on the program's site:");
          for (const [p, l] of links) console.log(`  ${p}: ${l}`);
        }
      } else if (sort === "cost") {
        console.log(renderAwardTable(sortByCost(res.trips).slice(0, limit), stale));
      } else {
        throw new UsageError(`--sort must be cost or pain, got "${sort}"`);
      }
      if (!args.includes("--json")) {
        console.log(
          `\n${res.trips.length} trips from ${res.records} records over ${res.pages} page(s)` +
            (res.trips.length > limit ? `; showing ${limit} (--limit to change)` : "") +
            `. Cached data: verify on the program's own site before transferring points.`,
        );
        if (res.rateLimit?.remaining !== undefined) console.log(`seats.aero calls left today: ${res.rateLimit.remaining}`);
      }
      if (!res.complete) {
        console.error(`INCOMPLETE: ${res.incompleteReason}`);
        process.exit(4);
      }
      return;
    }
    throw new UsageError(`unknown award command "${sub ?? ""}" (search | probe | routes)`);
  } catch (e) {
    if (e instanceof AwardApiError) {
      console.error(redact(e.message, key.value));
      process.exit(e.status === 401 || e.status === 429 ? 3 : 1);
    }
    throw e;
  }
}

async function cmdDoctor(cfg: Config) {
  const lines: string[] = [];
  let ok = true;
  lines.push(`config        OK      ${configPath()}`);

  const drv = driverCommand(cfg);
  const found = Bun.which(drv[0]);
  lines.push(
    found
      ? `browser       OK      ${drv.join(" ")} (${found}) — Google Flights search available`
      : `browser       MISSING ${drv.join(" ")} is not on PATH — 'search' will not work; 'score' and 'award' still do`,
  );

  const a = awardCfg(cfg);
  if (a.enabled === false) {
    lines.push(`award         OFF     sources.award.enabled is false`);
  } else {
    try {
      const key = await resolveAwardKey(cfg);
      try {
        const d = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
        const { headers } = await apiGet(
          "/search",
          { origin_airport: "SFO", destination_airport: "JFK", start_date: d, end_date: d, take: "10" },
          { apiKey: key.value },
        );
        lines.push(
          `award         OK      seats.aero key accepted via ${key.via}; ${headers.get("x-ratelimit-remaining") ?? "?"} calls left today` +
            (key.warning ? ` — WARNING: ${key.warning}` : ""),
        );
      } catch (e) {
        ok = false;
        lines.push(`award         FAIL    key found via ${key.via} but rejected: ${redact((e as Error).message, key.value)}`);
      }
    } catch (e) {
      lines.push(`award         MISSING ${(e as Error).message} — see README "seats.aero key"`);
    }
  }

  if (!seatMapSettings(cfg).enabled) {
    lines.push(`seat maps     NONE    no seat-map plug-in; exit rows and occupancy are reported UNKNOWN, never guessed`);
  } else {
    try {
      const provider = await loadSeatMapProvider(cfg, createBrowser(cfg));
      if (!provider.check) {
        lines.push(`seat maps     LOADED  ${provider.name} (it offers no readiness check)`);
      } else {
        const c = await provider.check();
        if (!c.ok) ok = false;
        const tag = c.ok ? "OK     " : c.status === "logged-out" ? "LOGGED OUT" : "FAIL   ";
        lines.push(`seat maps     ${tag} ${provider.name}: ${c.detail}${provider.availability ? "" : " (no fare-class availability)"}`);
      }
    } catch (e) {
      ok = false;
      lines.push(`seat maps     FAIL    ${(e as Error).message}`);
    }
  }
  const mon = cfg.monitor ? statusLines(cfg).filter((l) => /^NO WATCHES|^[A-Z0-9]{2} \S+ [A-Z]{3}-[A-Z]{3}/.test(l)) : [];
  lines.push(cfg.monitor ? `monitor       CONFIG  ${mon.some((l) => l.startsWith("NO WATCHES")) ? "no watches (idle)" : `${mon.length} watch(es)`}` : `monitor       OFF     no monitor section`);
  console.log(lines.join("\n"));
  if (!ok) process.exit(1);
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP + `\n\nConfig: ${configPath()}`);
    return;
  }
  const cfg = loadConfig();
  switch (cmd) {
    case "config":
      console.log(`config: ${configPath()}`);
      console.log(JSON.stringify(cfg.painfulness, null, 2));
      return;
    case "score":
      return cmdScore(rest, cfg);
    case "search":
      return cmdSearch(rest, cfg);
    case "award":
      return cmdAward(rest, cfg);
    case "doctor":
      return cmdDoctor(cfg);
    case "seats":
      return cmdSeats(rest, cfg);
    case "avail":
      return cmdAvail(rest, cfg);
    case "price":
      return cmdPrice(rest, cfg);
    case "decide":
      return cmdDecide(rest, cfg);
    case "monitor":
      return cmdMonitor(rest, cfg);
    default:
      throw new UsageError(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

/** main() plus the exit-code contract. Wrappers that re-expose this CLI should call this. */
export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  try {
    await main(argv);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(e instanceof UsageError ? 2 : 1);
  }
}

if (import.meta.main) await runCli();
