# Seat-map plug-ins

travel-search ships no seat-map reader. Seat maps come from a **plug-in**: one TypeScript
module, kept wherever you like, that the config points at. The plug-in reads a source you
have access to and hands back plain data; travel-search checks that data and does all the
ranking.

## Wiring one up

```yaml
sources:
  seatmap:
    enabled: true
    module: ~/src/my-seatmap-plugin/provider.ts
    options: {}          # handed to the plug-in untouched
    cabins: [Y, F]       # cabin letters 'decide' reads
```

Then `travel.ts doctor` should print `seat maps  OK  <name>`.

## Writing one

The whole contract is `Tools/seatmap-api.ts`: types and one constant, no imports. Copy it
into your plug-in repo, then export a factory:

```ts
import { SEATMAP_API_VERSION, type CreateProvider } from "./seatmap-api.ts";

export const createProvider: CreateProvider = (ctx) => ({
  apiVersion: SEATMAP_API_VERSION,
  name: "my-source",
  async seatMap(req) {
    const tab = await ctx.browser.open(urlFor(req));
    const html = await ctx.browser.read(tab, (h) => h.includes("seat-grid"));
    return { request: req, aircraftName: "...", aircraftCode: "...", seats: parse(html) };
  },
  // optional: async availability(req) { ... },
  // optional: async check() { return { ok: true, status: "ok", detail: "signed in" }; },
});
```

What you get in `ctx`:

| Field | Use |
|---|---|
| `browser` | The same real-browser driver Google Flights uses. Paced, serial, and locked so two travel-search processes never drive it at once. |
| `options` | `sources.seatmap.options` from the config. |
| `resolveSecret(ref)` | Turns `env:NAME`, `op://vault/item/field` or a file path into its value. |

## What travel-search checks, and refuses

| You return | Checked |
|---|---|
| `apiVersion` | Must equal travel-search's `SEATMAP_API_VERSION`, or the plug-in is not loaded. |
| `seats` | At least one. Every id like `12A`, no duplicates. State is exactly `available`, `occupied` or `blocked`. |
| seat position | Give `position` (`window`/`aisle`/`middle`) or an `x` drawing coordinate; positions are derived from `x` per row. Twin-aisle cabins need `position`. |
| `aircraftCode` | Required. It keys `seat_data` in the user's config, so print it the way the source does. |
| availability | Dates `YYYY-MM-DD`, times `HH:MM` 24h local, fare-class counts 0–9, and `complete: false` only with a `note` saying why. |

Anything else is an error naming the seat or field. Nothing is dropped quietly, and a
seat with an unknown state is never guessed into one of the three.

## Rules for plug-in authors

- **Read only.** A plug-in reads seat maps and availability. It never books, holds or
  changes anything.
- **Blocked means blocked.** Report what the source shows. travel-search treats `blocked`
  as never bookable, for everyone.
- **Say "logged out" separately.** If your source needs a login, make `check()` return
  `status: "logged-out"` so `doctor` tells the user what to do.
- **Respect the source's terms.** Some seat-map services forbid automated access. That is
  between you and the service; this repo stays neutral and ships no reader.
