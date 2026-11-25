# AwardSearch — finding award (points/miles) space with seats.aero

Needs a seats.aero **Pro** API key (see README "seats.aero key"). Pro allows 1,000 calls a
day; every page and every leg-detail fetch is one call, and the tool prints how many are
left after each search.

`T="bun ${CLAUDE_DIR:-$HOME/.claude}/skills/TravelSearch/Tools/travel.ts"`

1. **Check the key once per session.** `$T award probe`. Exit 3 means no key or a rejected
   key (expired subscription returns 401); say which, and stop.

2. **Search a date window, not a single day.** Award space is lumpy; a ±3-day window
   usually costs the same one call.
   `$T award search <ORIG> <DEST> <START> <END> --cabin business,first; echo $?`
   - ORIG/DEST accept comma lists: `SFO,LAX,SEA` → `NRT,HND`.
   - `--program aeroplan,united` limits to the programs the user can transfer to.
   - `--carriers NH,JL` limits to operating carriers; `--direct` for nonstops only.
   - Exit 4 = more pages were waiting past `--max-pages`. Narrow the window or raise it.

3. **Read the table honestly.**
   - **Taxes** are already converted to dollars. A $1,254 "tax" on a 201k-mile ticket is a
     carrier surcharge; call that out, because it changes which program is the deal.
   - **Times are airport-local.** Do not convert them.
   - **Age / STALE** — cached data can be hours or weeks old. Anything STALE must be
     re-checked on the program's own site before the user transfers points.
   - **Seats** is the count seats.aero last saw, not a guarantee.

4. **Rank by pain when the user cares about the flight itself.**
   `$T award search ... --sort pain [--detail 10]`
   This fetches leg detail for the cheapest N availability records (one call each) and
   ranks with the user's painfulness model. Connecting trips without leg detail are listed
   as unranked. For long-haul, `reject_overnight_arrival` will reject almost everything;
   offer to rank with it switched off for this search.

5. **Present.**
   - Best by cost and best by pain (often different), each with program, miles, taxes,
     flights, times, seats, and data age.
   - The booking link for the program, when the tool printed one.
   - The transfer warning: points transfers are usually instant but **irreversible**. Tell
     the user to confirm the seat on the program's site, then transfer, then book.
   - Never promise the seat is there. Cached search shows what seats.aero last saw.
