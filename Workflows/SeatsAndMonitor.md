# SeatsAndMonitor — the seats you could actually sit in, and watching for better ones

`T="bun ${CLAUDE_DIR:-$HOME/.claude}/skills/TravelSearch/Tools/travel.ts"`

Needs a seat-map plug-in (`docs/seatmap-plugins.md`). `$T doctor` says whether one
is loaded and whether it is signed in. Without one, every command here exits 3 and seat
facts stay UNKNOWN; say so rather than filling them in.

## One flight's seats

`$T seats <AL> <FLT> <ORIG> <DEST> <YYYY-MM-DD> [--cabin Y]; echo $?`

The first line is the verdict: open / occupied / blocked counts, how many seats on the
user's ladder are open, and `⚠ NO ACCEPTABLE SEAT` when none is. Then the best seats with
their rung. Read the legend: `(blo)` is **blocked and not bookable**, never an option.

## The whole decision

`$T decide <ORIG> <DEST> <YYYY-MM-DD> [--airlines UA] [--top N]; echo $?`

One table: the pain ranking, price per cabin, seat lines for the top N eligible
itineraries, and an upgrade estimate. Then **SOURCE FAILURES**: everything that was
missing or cut short. Exit 4 means that list is not empty; quote it.

- A row with no seat line was **not fetched** (past `top_n`), not full.
- `exit rows UNKNOWN` means `seat_data` has no entry for that aircraft. Offer to add one
  from a source the user can cite; never infer rows from the map.
- If the plug-in offers no availability, flights come from Google Flights, which prints no
  flight numbers, so `decide` cannot fetch seats; use `seats` on a specific flight instead.

## Watching a booked flight

Add the flight under `monitor.watches` in the config with the seat the user holds:

```yaml
- { airline: UA, flightNumber: "1234", origin: ORD, destination: DEN, date: 2027-03-10, current_seat: 14C, depart_time: "07:25" }
```

- `$T monitor status` shows each watch's phase, when it was last checked, and failures.
- `$T monitor run --force` runs one pass now (posts to Discord if a better seat is open).
- On a timer: the unit files in `systemd/` (see README "Seat monitor"). **Installing or
  enabling a timer is a change to the user's machine: ask first.**

The monitor only alerts on seats that are `available` and higher on the ladder than the
one held. Blocked seats are tracked (they can open up) but never alerted. When a watch
fails three times running, it alerts once with the error text.

Update `current_seat` when the user moves, and delete watches after the trip; an empty
list is fine and both commands say the monitor is idle.
