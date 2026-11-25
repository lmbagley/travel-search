# travel-search

Find the **least painful** flight, not the cheapest one, and search **award space** through
[seats.aero](https://seats.aero). Packaged as a skill for
[PAI / LifeOS](https://github.com/danielmiessler/LifeOS) and Claude Code,
and usable on its own as a CLI.

- **Ranks by your rules, not by price.** Hard rules reject (redeyes, too early, too late,
  next-day arrival, tight connections, with stricter floors at the hubs you name). Scored
  rules rank the rest (arrival window, connection comfort, mainline over regional,
  departure window, duration as a tie-breaker). All of it lives in one YAML file you own.
- **Refuses to bluff.** Completeness is checked against the source's own count. An empty
  page is an error unless the page says "0 results". Exit rows and seat occupancy are never
  guessed. The headline cash fare is checked against the fare ladder, because it is often
  Basic Economy.
- **Award search that reads the API correctly.** Trip-level rows only (not the misleading
  per-day summary fields), correct pagination, taxes converted from cents, airport-local
  times left alone, data age on every row, and optional ranking of award trips with the
  same painfulness model.
- **Seats you could actually sit in, through a plug-in** ([how to write one](docs/seatmap-plugins.md)). Point the config at a seat-map
  plug-in and `seats` ranks a flight's open seats against your own ladder (exit row,
  extra legroom, bulkhead), `decide` joins ranking, prices per cabin, seats and an
  upgrade estimate in one table, and the **seat monitor** posts to Discord when a better
  seat opens on a flight you hold. Blocked seats are shown but never called bookable.

## Requirements

- [Bun](https://bun.sh) 1.2.21 or newer (uses Bun's built-in YAML parser). No other dependencies.
- **For cash-fare search:** a real-browser CLI (see [Browser driver](#browser-driver)).
  Without one you can still rank options you collect yourself with `score`.
- **For award search:** a seats.aero **Pro** subscription and its API key.
- **For seats, `decide` and the monitor:** a seat-map plug-in (see
  [Seat-map plug-ins](#seat-map-plug-ins)). This repo ships the interface, not a reader.

## Install

As a PAI / LifeOS / Claude Code skill:

```sh
git clone https://github.com/lmbagley/travel-search.git
cd travel-search
bun install.ts            # copies into ~/.claude/skills/TravelSearch (honours $CLAUDE_DIR)
```

`install.ts` also creates `~/.config/travel-search/config.yaml` from
`config.example.yaml` if you do not have one yet. It never overwrites an existing config.
Use `bun install.ts --link` instead if you want the skill to point at your checkout so
edits go live.

To upgrade, `git pull && bun install.ts`. The installer is safe to run any number of
times: it builds the new copy beside the old one and swaps it in only when complete,
removes files a newer version dropped, prints `unchanged` when there is nothing to do,
and writes the installed version to `~/.claude/skills/TravelSearch/VERSION`.

Then:

```sh
$EDITOR ~/.config/travel-search/config.yaml
bun ~/.claude/skills/TravelSearch/Tools/travel.ts doctor
```

After that, ask your assistant things like *"least painful flight ORD to SFO on March 12"*
or *"business award SFO to Tokyo, first week of February, Aeroplan or United"*.

## Configure

Everything about you lives in one file outside the repo:
`$TRAVEL_SEARCH_CONFIG`, else `~/.config/travel-search/config.yaml`.
`config.example.yaml` documents every setting. The parts worth editing first:

| Setting | What it does |
|---|---|
| `defaults.airline` | Your loyalty airline; the `Prog` column marks mainline-only trips it markets |
| `painfulness.hard.*` | What gets rejected outright |
| `painfulness.hard.min_connection_minutes_by_airport` | Stricter connection floors at hubs you distrust |
| `painfulness.scored.*` | Weights for what ranks the survivors |
| `sources.schedule.driver_cmd` | Your browser CLI |
| `sources.award.api_key` | Where your seats.aero key lives (a reference, never the key) |
| `seating.preference_order` | Your seat ladder, best rung first |
| `seat_data` | Exit, extra-legroom and bulkhead rows per airline and aircraft, from a source you can cite |
| `sources.seatmap` | Your seat-map plug-in |
| `monitor` | Flights to watch, the seat you hold, and a reference to your Discord webhook |

The tool refuses to run without a config. Ranking against someone else's preferences is
worse than not ranking.

## seats.aero key

Get a Pro API key from your seats.aero account settings. Then pick one:

```sh
# a file (default location)
read -rs K && printf '%s' "$K" > ~/.config/travel-search/seats-aero-key && unset K
chmod 600 ~/.config/travel-search/seats-aero-key

# or an environment variable (always wins when set)
export SEATS_AERO_API_KEY=...

# or 1Password: set this in config.yaml
#   sources.award.api_key: op://<vault>/<item>/<field>
```

`travel.ts award probe` makes one cheap call to prove the key works. Pro allows 1,000
calls a day; every search page and every leg-detail fetch is one call, and each search
prints how many you have left.

## Browser driver

Cash-fare search reads Google Flights in a real browser, because headless scrapers get
challenged. The driver is any CLI with two commands:

```text
<driver> open <url>            prints JSON containing {"tabId": <int>}
<driver> read --tab <tabId>    prints JSON containing {"html": "<page html>"}
```

PAI users with the Interceptor skill already have this as `interceptor` (the default).
Anything else: set `sources.schedule.driver_cmd`. With no driver, `search` exits 3 and you
can still build the JSON by hand (see `References/DataShapes.md`) and run `score`.

## Commands

```text
travel.ts search <ORIG> <DEST> <YYYY-MM-DD> [--airline <Name>]   collect (JSON)
travel.ts score <file.json> [--allow-incomplete]                rank, fare gate
travel.ts award search <ORIG> <DEST> <START> [END] [--cabin business,first]
          [--program aeroplan,united] [--carriers NH,JL] [--direct]
          [--max-pages N] [--sort cost|pain] [--detail N] [--limit N] [--json]
travel.ts award probe | award routes <program>
travel.ts seats <AL> <FLT> <ORIG> <DEST> <YYYY-MM-DD> [--cabin Y] [--json]
travel.ts avail <ORIG> <DEST> <YYYY-MM-DD> [--airlines UA] [--json]
travel.ts price <ORIG> <DEST> <YYYY-MM-DD> [--cabin first] [--airline <Name>]
travel.ts decide <ORIG> <DEST> <YYYY-MM-DD> [--airlines UA] [--top N] [--no-seatmaps] [--json]
travel.ts monitor run [--force] [--json] | monitor status
travel.ts doctor | config
```

Exit codes: `0` ok, `1` error, `2` usage, `3` capability unavailable, `4` data incomplete.

## Seat-map plug-ins

Seat maps come from a separate module you point the config at:

```yaml
sources:
  seatmap:
    enabled: true
    module: ~/src/my-seatmap-plugin/provider.ts
```

The contract is one file, `Tools/seatmap-api.ts`, and
[docs/seatmap-plugins.md](docs/seatmap-plugins.md) explains how to write one.
travel-search checks everything a plug-in returns (versions, seat ids, states, dates,
fare-class counts) and refuses anything it cannot trust rather than ranking it. Plug-ins
use the same browser driver as Google Flights, so requests stay paced and serial, and a
lock file keeps two travel-search processes from driving the browser at once.

## Seat monitor

List the flights you hold and the seat you are in under `monitor.watches`, put your
Discord webhook URL in a file (`chmod 600`) and point `monitor.discord_webhook` at it.
Then run it on a timer:

```sh
cp systemd/travel-search-monitor.* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now travel-search-monitor.timer
```

The timer fires every 20 minutes; each flight is only checked when it is due (every 4
hours when far out, hourly inside 48 hours, every 25 minutes in the last day). It alerts
when a seat higher on your ladder than yours becomes **available**, alerts once if a
flight keeps failing, and with no watches it idles and says so. If your browser driver
lives outside the unit's `PATH`, add its directory there: a unit that cannot find it
fails every check.

## Things the API docs do not shout about

Learned the hard way, each now covered by a test:

1. **seats.aero pagination:** `cursor` is the value from the *first* response, and `skip`
   is the number of rows already retrieved. Sending the cursor as `skip` quietly returns
   the wrong pages.
2. **seats.aero `TotalTaxes` is in cents.** `1290` is $12.90.
3. **seats.aero trip times are airport-local**, even though they end in `Z`. Parsing them
   as UTC shifts every flight.
4. **seats.aero record fields like `JMileageCost` are per-day index summaries**, not a
   bookable itinerary. Only `AvailabilityTrips` rows are real.
5. **Cached search returns no per-leg times**, even with `include_trips=true`. Leg detail
   comes from `GET /trips/{id}` (one call per record).
6. **Google Flights hides results behind "View more flights"**, and the hidden one is often
   the worst. Parsed-versus-published is checked on every search.

## Develop

```sh
bun install        # dev types only
bun test Tools
bunx tsc --noEmit
```

## License

MIT
