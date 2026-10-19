# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real TomTom key: the devices of the
      Discovery tab, their values, the status, the test button, the scene
      action. Never done yet.
- [ ] Check the CI (Docker build, Node 22 and 24), then run the store
      validator once the image is published. The Docker image was never built
      locally (no Docker on the development PC).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm with a real key

- [ ] The exact body of the 403 errors (XML or HTML, not the documented JSON
      error format): "Developer Inactive", "Not Authorized" (refused key),
      "Developer Over Rate" / "Over the limit" (daily quota), "Developer Over
      Qps" (requests per second) are the expected texts, matched without case.
      A 403 without a known message is a doubling pause, not a refusal.
- [ ] When TomTom resets the daily quota (UTC midnight assumed: the count of
      the integration and the 403 pause follow the UTC day).
- [ ] Whether TomTom sends `Retry-After` on a 429 (used when it does).
- [ ] That `routeRepresentation=summaryOnly` with `computeTravelTimeFor=all`
      keeps `noTrafficTravelTimeInSeconds` in the summary (documented, not
      seen).
- [ ] The answer to `travelMode=truck` without any vehicle dimension.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-tomtom-travel-time:0.1.0`); the first patch
  release gives 0.1.1.
- **Official API only**: TomTom Routing API v1, Calculate Route, `GET
https://api.tomtom.com/routing/1/calculateRoute/<lat,lon>:<lat,lon>/json`,
  with `traffic=true`, `travelMode=car|truck`, `routeType=fastest`,
  `departAt=now`, `computeTravelTimeFor=all`,
  `routeRepresentation=summaryOnly`, `avoid=tollRoads` / `avoid=motorways`.
  No library: Node's `fetch`; no runtime dependency besides the Gladys SDK.
  Replaces the Waze module (its API only answers when getting around its
  anti-bot protection).
- **Home Assistant "Waze Travel Time" (Apache-2.0)** only for the ergonomics
  (a named trip, an origin, a destination, a periodic read): no code taken,
  credited in the docs. The docs point to qleg's Mapbox Traffic integration
  (forum thread 11024), which does the same with Mapbox.
- **Trips in one text field** ("Name | lat,lon | lat,lon", separated by
  `;`): the manifest has no list type, and twenty fixed slots of three fields
  would make a very long form. Twenty trips at most, names unique.
- **External ids**: `trip:<slug of the name>`, then `travel_time`,
  `traffic_delay`, `distance`, `no_traffic_time`. Renaming a trip creates a
  new device; changing its coordinates keeps it. The device always has its
  four features (built from the configuration, not from the answer), and a
  feature of the created device this version does not build is kept when the
  device is published again.
- **Categories and units of the core only**: `duration`/`decimal` in
  `minutes` (travel time, delay, travel time without traffic) and
  `distance-sensor`/`decimal` in `km`, from `DEVICE_FEATURE_UNITS_BY_CATEGORY`
  of `server/utils/constants.js` (checked by `test/manifest.test.js`). Values
  rounded to a tenth. A missing `trafficDelayInSeconds` next to a travel time
  counts as 0.
- **Coordinates only, no address** in v1: geocoding would cost requests of
  the same daily quota and send the address to TomTom; see Ideas.
- **Quota** (free plan: 2,500 requests a day): 10 minutes by default, 5 at
  least, 240 at most. Planned requests a day = trips × ceil(window minutes ÷
  interval), shown in the status and the test button; over 2,500 the
  configuration is refused (status disconnected, nothing read). The
  integration counts every request per UTC day in `/data` and stops at 2,500
  whatever their origin (periodic, scene, test). An unreadable state file
  counts half the quota as spent.
- **Never faster than the interval**: the instant of the last request of
  each trip is persisted; after a restart, a reconnection or an error, the
  next read waits for it. A manual read (scene, test button) is refused
  within 2 minutes of the last one of that trip and pushes the next periodic
  read a whole interval later. A new key may read again after those 2
  minutes.
- **Pauses** (persisted with a hash of the key, capped when read back): 429
  or 403 "Over Qps" → Retry-After, else 1 minute doubling, 1 minute to 6
  hours; 403 for the quota → until the next UTC midnight, 1 to 24 hours;
  401/403 otherwise → refused key, 6 hours (the test button may try again).
  A 400 without route → the trip waits an hour at least; 5xx, network → the
  usual interval. A reconnection keeps them all.
- **The key**: a `secret` field, which Gladys does NOT encrypt: the docs say
  "kept by Gladys in its database, never shown again, sent only to
  api.tomtom.com". It travels in the query string (TomTom's only way):
  `src/http.js` never puts more than the host in an error (Node puts the URL
  in some of its own), the fetch error itself never leaves that file,
  `app.scrub()` removes the key and any `key=` from every logged message, and
  no redirection is followed.
- **Bounded answers**: 64 KB (`summaryOnly` answers are about 1 KB);
  20-second timeout; error bodies only matched, never shown (only known
  TomTom codes such as `NO_ROUTE_FOUND`).
- **State file read field by field** into a `Map`: no prototype pollution,
  every instant in the future capped to now.
- **Reading window** in whole local hours with an IANA time zone field
  (`Europe/Paris` by default; Gladys does not give its time zone to an
  integration). Outside it, nothing is read nor published; the scene action
  still works.
- **States** published only after a read, through `publishChangedStates`
  (30-minute heartbeat), only for the features the user created; a device
  just created gets values younger than an hour.
- **Status and Discovery published again on every `connected`** (their
  dedup caches are cleared), the trips listed from the configuration without
  any request.
- **Demo files of the template removed** (`src/devices/`, `src/scenes.js`,
  `src/widgets.js`, `src/weather.js` and their tests).
- **LICENSE**: Apache-2.0 text without any name.

## Decisions of the review (Milestone 1 fixes)

- **Gaps checked in the turn of the pacer** (`route({ minGap })`): the
  interval for a periodic read, 2 minutes for a manual one, against the
  persisted instant of the last request of the trip. Concurrent callers (a
  tick, scenes, the test button, a configuration saved during a tick) never
  stack requests: the late ones get the last values (`refreshed: false`).
- **Manual budget per UTC day**: `min(100, 2,500 − planned)` manual reads
  (scenes and test button), persisted in `/data`; beyond it, the last values
  without a request. The periodic reads are not held by it.
- **A new key no longer shortens the wait**: the periodic reads keep the
  interval; the test button can check the new key after the 2-minute gap.
- **403**: refused only on a known key message (inactive, not authorized,
  forbidden, invalid key, developer); quota and "Qps" as before; any other
  403 is a pause that doubles (like a 429).
- **A 200 without a travel time** is a failure ("unexpected answer"), never
  published.
- **Names**: control, format (`\p{Cf}`, bidi overrides, zero-width) and
  line/paragraph separators removed; a name needs a Latin letter or a digit
  and must not be coordinates; an invalid entry is shown with its numbers
  masked, or as `#<position>`.
- **`/data` not writable**: a note in the status, and the first reads wait a
  whole interval after each start of the process.
- **Scene output `age_minutes`** (age of the values returned).
- **Key creation**: my.tomtom.com and my.tomtom.com/keys ("My first API key");
  the docs say the 2,500 are shared by every use of the key and that "Pay As
  You Grow" may bill beyond them.

## Ideas

- Addresses through the TomTom Search API (geocoded once, cached in `/data`,
  counted in the quota).
- Options per trip (vehicle, avoidances), and an "arrive at" time.
- Gladys houses as origin or destination (`location: true`).
- Truck dimensions and weight.
- A scene trigger when the delay passes a threshold.
