# gladys-tomtom-travel-time

Unofficial [Gladys Assistant](https://gladysassistant.com) external
integration: the travel time of your trips with live traffic, the traffic
delay, the distance and the travel time without traffic, through the official
[TomTom Routing API](https://developer.tomtom.com/routing-api/documentation/tomtom-maps/calculate-route)
(Calculate Route) and a free API key (2,500 requests a day).

Not affiliated with TomTom. **Never tested with a real TomTom key yet.**

- One Gladys device per trip ("Name | lat,lon | lat,lon"), four features:
  travel time with traffic, traffic delay, travel time without traffic
  (`duration`, minutes) and distance (`distance-sensor`, km).
- Car or truck, avoid toll roads, avoid motorways, departure now.
- Read every 10 minutes by default, 5 at least; an optional reading window
  (e.g. 6 to 20) saves the quota. The status shows the requests a day the
  configuration plans; a configuration over 2,500 is refused.
- Scene action "Refresh a TomTom trip now", at most once every 2 minutes per
  trip.
- The count of the day, the pauses (429, 403 for the quota, refused key) and
  the last read of each trip survive a restart (`/data`): never more than
  2,500 requests a UTC day, never a trip read faster than its interval.

User documentation: [English](docs/en.md), [français](docs/fr.md).

A [Mapbox Traffic integration by qleg](https://community.gladysassistant.com/t/11024)
does the same with Mapbox. The ergonomics follow Home Assistant's "Waze
Travel Time" integration (Apache-2.0); no code is taken from it.

## Development

Node.js 22+, ESM, no build step. The only runtime dependency is
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

```bash
npm install
npm run format:check
npm run lint
npm test
npm audit --omit=dev
npx github:GladysAssistant/integration-store .
```

```
index.js           SDK wiring only
src/app.js         trips, due times, devices, status, test button, scene action
src/tomtom.js      the TomTom client: request, answers, pauses, quota
src/store.js       what survives a restart (/data/tomtom-state.json)
src/config.js      configuration, trips, planned requests, reading window
src/devices.js     the Gladys device of a trip and its states
src/http.js        bounded fetch; errors keep the host only (never the key)
```

Releases go through the **Release** workflow (Actions → Release); see
`CLAUDE.md` for the project rules.

## License

[Apache-2.0](LICENSE).
