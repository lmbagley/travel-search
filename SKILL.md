---
name: TravelSearch
description: "Find the LEAST PAINFUL flight rather than the cheapest one, and search award (points/miles) space through seats.aero. Ranks itineraries against the user's own painfulness model in ~/.config/travel-search/config.yaml (no redeyes, departure floor, arrival ceiling, per-airport connection floors, preferred arrival window, mainline over regional, fare brands that allow seat selection), collects schedules from Google Flights through a real browser, asserts completeness against the source's own published count, and never guesses exit rows or seat occupancy. Award search reads trip-level rows only, converts taxes from cents, keeps airport-local times, flags stale cached data, and can rank awards with the same painfulness model. With a seat-map plug-in it also ranks the seats on a flight against the user's seat ladder (exit row, extra legroom, bulkhead), joins pain ranking, per-cabin prices, seats and an upgrade estimate in one decide table, and runs a seat monitor that alerts on Discord when a better seat opens. USE WHEN find me a flight, least painful flight, which flight should I take, flight options, compare flights, trip to <city>, connection time, redeye, award search, award space, points flight, miles, saver availability, business class award, seats.aero, transfer points to book, Aeroplan, United miles, AAdvantage award, seat map, exit row, which seat, better seat, seat monitor, watch my seat, upgrade odds. NOT FOR hotels, car rentals, or booking/ticketing."
effort: medium
---

# TravelSearch

The user does not want the cheapest flight. They want the **least painful** one, and
"painful" has a mechanical meaning that lives in their config file, not in your head.
Read it; never assume it.

**Tool:** `bun ${CLAUDE_DIR:-$HOME/.claude}/skills/TravelSearch/Tools/travel.ts <command>`
(below, `travel.ts` means that full path).

**Config:** `$TRAVEL_SEARCH_CONFIG`, else `~/.config/travel-search/config.yaml`.
Run `travel.ts config` to see the active model before ranking anything.

**Customizations:** if your PAI/LifeOS install keeps per-skill notes
(`USER/SKILLCUSTOMIZATIONS/TravelSearch/`), read them first. They hold the user's own
sources and habits that do not belong in a shared skill.

## Pick the workflow

| The user wants | Workflow |
|---|---|
| A cash flight, ranked by pain | `Workflows/FindFlight.md` |
| Award space / a points booking | `Workflows/AwardSearch.md` |
| Seats on a flight, the full decide table, or watching for a better seat | `Workflows/SeatsAndMonitor.md` |
| To change a preference ("I hate DFW connections under 90 minutes") | edit the config, then say what changed |
| First run, or something failed | `travel.ts doctor` |

## The model in one paragraph

**Hard rules reject:** redeyes, departures before the floor, arrivals after the ceiling or
on the next calendar day, and connections below the floor (with higher floors at the hubs
the user names). **Scored rules rank the survivors:** arrival inside the preferred window,
a comfortable connection, mainline aircraft, a civilised departure, and total duration only
as a tie-breaker. **The fastest itinerary is often the worst one** — it lands at 23:44 or
connects in 35 minutes. The tool is built to say so.

## Rules that are not optional

- **Every flight number, time, aircraft, price and seat count comes from a source read in
  this session.** Never fill one in from memory.
- **Seat facts come only from a seat-map plug-in read this session.** Without one, report
  the aircraft type and say seat maps were not checked. "I could not check" and "there is
  no exit row" are different sentences. Exit and extra-legroom rows come from `seat_data`
  in the config; when it says UNKNOWN, say UNKNOWN.
- **A blocked seat is not an option.** Never present one as bookable, for any status.
- **Completeness before ranking.** Exit code 4 means the data is incomplete (Google showed
  fewer rows than it said it found; seats.aero had more pages). Say so; do not present a
  partial set as the answer.
- **The headline cash price is often Basic Economy**, which forbids seat selection. Quote
  the fare-gate line from `score`, not the headline.
- **Award data is cached.** Every row shows its age; anything marked STALE must be checked
  on the program's own site before the user transfers points. Transfers are one-way.
- **Show the losers.** The user wants the option they are not taking and the reason it lost.
- **Capture new preferences in the config**, one question at a time, then confirm what
  changed. A preference only stated in chat is forgotten next session.

## Exit codes

0 ok · 1 error (message names the cause) · 2 usage · 3 capability unavailable (missing key
or browser) · 4 data incomplete.

## Gotchas

- **Google Flights hides results behind "View more flights", and the hidden one is often
  the worst.** That is why `search` exits 4 when parsed < published.
- **Collapsed Google rows carry no flight number or aircraft.** Rows that already fail a
  hard rule on summary data need no expansion; say which ones you skipped and why.
- **A bot challenge stops the run.** Do not retry into it; wait and try later.
- **seats.aero `--sort pain` costs extra calls.** Cached search has no per-leg times, so the
  tool fetches leg detail for the cheapest N records (`--detail N`, default 10). Connecting
  trips without detail are listed as unranked, never treated as nonstops.
- **Long-haul and award searches:** `reject_overnight_arrival` rejects nearly every
  transpacific or transatlantic flight. If the user is searching long-haul, suggest turning
  it off for that search (a copy of the config via `TRAVEL_SEARCH_CONFIG`) rather than
  presenting an all-rejected table.
- **`decide` exit 4 is normal when a source failed.** The table is still printed; quote
  the SOURCE FAILURES list with it. A row with no seat line was not fetched, not full.
- **Installing or enabling the monitor timer changes the user's machine.** Ask first.
- **Capture exit codes on the command itself** (`travel.ts ...; echo $?`), never after a
  pipe — a pipe reports the last stage's status.
