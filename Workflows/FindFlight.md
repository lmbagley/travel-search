# FindFlight — the least painful cash flight

`T="bun ${CLAUDE_DIR:-$HOME/.claude}/skills/TravelSearch/Tools/travel.ts"`

1. **Read the model.** `$T config`. If the user's request conflicts with it (a 6am
   departure they say is fine this time), ask once, then use a temporary copy of the
   config via `TRAVEL_SEARCH_CONFIG=/tmp/x.yaml` rather than silently ignoring the rule.

2. **Collect one direction at a time.**
   `$T search <ORIG> <DEST> <YYYY-MM-DD> [--airline <Google airline name>] > out.json; echo $?`
   - `0` → complete (or a proven-empty day).
   - `4` → incomplete: the page published more results than were parsed. Open the page
     with the browser, expand "View more flights", and re-run. Do not rank a partial set
     without saying so.
   - `1` → read the message. A bot challenge means stop; do not retry into it.
   - `3` → no browser driver. Run `$T doctor`; if the user has no browser driver, ask them
     to paste the options and build the JSON by hand (shape: `{ "claimedResultCount": N,
     "itineraries": [...] }`, see `References/DataShapes.md`).
   For a round trip, collect the return separately, after a pause.

3. **Rank.** `$T score out.json`. The table puts eligible rows first by score, then
   rejects with their reasons. Under it:
   - **fare gate** — the cheapest fare that allows seat selection and the cheapest with
     extra legroom. Quote these, not the headline.
   - **seat map** — UNAVAILABLE unless a seat-map plug-in is configured. With one, use
     `Workflows/SeatsAndMonitor.md` (`decide` does search, ranking, prices and seats at once).

4. **Expand the contenders only.** Summary rows have `aircraft: "not expanded"` and no
   flight number. For the top 2–3 eligible rows, read the expanded view in the browser to
   get flight numbers and aircraft. Rows already rejected on summary data need no expansion.

5. **Present.**
   - The pick, with flight numbers, times, connection, aircraft, and the fare-gate price.
   - The runner-up and why it lost (score breakdown, in plain words).
   - The rejects, one line each with the reason ("lands 23:44", "35 min at PHX").
   - What was not checked (seat maps, fare ladder if unknown).

6. **Capture preferences.** If the user says something like "I'd take a 6am if it gets me
   home by 5", that is a config change (`depart_not_before`, `arrival_window`,
   `earlier_gradient`). Propose the exact edit, make it on a yes, and re-rank.
