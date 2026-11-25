# Data shapes

## Itinerary set (`search` output, `score` input)

```json
{
  "claimedResultCount": 6,
  "itineraries": [
    {
      "segments": [
        {
          "marketingAirline": "UA",
          "flightNumber": "1234",
          "origin": "ORD",
          "destination": "DEN",
          "departLocal": "07:10",
          "arriveLocal": "08:45",
          "arriveDayOffset": 0,
          "aircraft": "Boeing 737-900",
          "operatedBy": "SkyWest Airlines as United Express"
        }
      ],
      "measuredConnections": [{ "airport": "DEN", "minutes": 95 }],
      "totalDurationMinutes": 412,
      "priceFrom": 289,
      "currency": "USD",
      "fares": [
        { "brand": "Basic Economy", "price": 289, "freeSeatSelection": false, "extraLegroomIncluded": false },
        { "brand": "Economy", "price": 339, "freeSeatSelection": true, "extraLegroomIncluded": false }
      ],
      "sourceLabel": "where this row was read from"
    }
  ]
}
```

- `claimedResultCount` is the number the source said it found. Omit it and `score` refuses
  to rank (exit 4) unless you pass `--allow-incomplete`.
- A summary row (not expanded) has ONE pseudo-segment from first departure to final arrival,
  `flightNumber: "?"`, `aircraft: "not expanded"`, and the layovers in `measuredConnections`.
- Times are local `HH:MM`. `arriveDayOffset: 1` means the next calendar day.
- `operatedBy` present = regional metal (scored lower, never banned).

## Award trip (`award search --json`)

Each trip: `program`, `cabin`, `miles`, `taxes` (dollars, converted from cents), `currency`,
`seats`, `stops`, `connections`, `flightNumbers`, `departLocal`/`arriveLocal`
(`YYYY-MM-DDTHH:MM`, airport-local), `durationMinutes`, `updatedAt`, `ageHours`,
`segments` (empty unless leg detail was fetched), `bookingLink` (when fetched).
