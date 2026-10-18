# TomTom Travel Time

Unofficial connector, not affiliated with TomTom. For each trip you enter,
Gladys gets the travel time with live traffic, the traffic delay, the distance
and the travel time without traffic, read through the official **TomTom
Routing API** (Calculate Route) with a free key.

> This integration has **never been tested with a real TomTom key**: it
> follows TomTom's official documentation and its tests simulate the answers
> of the API. Feedback is welcome.

It replaces the idea of a Waze integration: the Waze API can only be reached
by getting around its anti-bot protection. A **Mapbox Traffic** integration by
qleg already exists and does the same with Mapbox (forum thread 11024:
https://community.gladysassistant.com/t/11024): pick the one whose provider
suits you.

The ergonomics (a trip with a name, an origin and a destination, read
periodically) are inspired by Home Assistant's "Waze Travel Time"
integration (Apache-2.0). No code is taken from it.

## Create the free key

1. Create an account on https://developer.tomtom.com/user/register (no credit
   card asked) and confirm the e-mail address.
2. Sign in on https://developer.tomtom.com, open your dashboard, then
   **Keys**.
3. A first key comes with the account and gives access to the APIs, Routing
   included. Copy it (or create a new one and tick **Routing API**).
4. Paste it in the **TomTom API key** field of the integration.

The free plan allows **2,500 requests a day**. The key is kept by Gladys in
its database, never shown again, and sent only to `api.tomtom.com`. It never
appears in the logs, the messages or the statuses.

## Enter the trips

**Trips** field: one trip per entry, separated by `;`. Each trip is a name, the
origin and the destination as `latitude,longitude` (decimal point), separated
by `|`:

```
Work | 48.85661,2.35222 | 48.89198,2.23881; School | 48.80000,2.30000 | 48.81000,2.31000
```

- To find coordinates: right-click a point in Google Maps or OpenStreetMap,
  then copy the two numbers.
- Twenty trips at most; two trips cannot share a name.
- An invalid trip is ignored and named in the status (never its
  coordinates).
- The name identifies the device: renaming a trip creates a new device (the
  old one keeps its history). Changing its coordinates keeps the device.
- Addresses are not supported yet (no call to TomTom's Search API): give
  coordinates.

Options shared by every trip:

- **Vehicle**: car, or truck (the roads and speeds of a truck, without its
  dimensions or weight).
- **Avoid toll roads**, **Avoid motorways**.
- The departure is always **now**, with live traffic.

## The devices

Once saved, each trip shows up in the **Discovery** tab. Add it to get:

| Feature                     | Gladys category   | Unit    |
| --------------------------- | ----------------- | ------- |
| Travel time with traffic    | `duration`        | minutes |
| Traffic delay               | `duration`        | minutes |
| Distance                    | `distance-sensor` | km      |
| Travel time without traffic | `duration`        | minutes |

Values are rounded to a tenth. The travel time without traffic is the one
TomTom computes without any traffic (`noTrafficTravelTimeInSeconds`).

## The quota and the interval

Each read of a trip costs one request. **Requests a day = trips × (minutes of
the reading window ÷ interval)**.

| Interval         | Requests per trip and day (all day long) | Trips that fit |
| ---------------- | ---------------------------------------- | -------------- |
| 5 min (minimum)  | 288                                      | 8              |
| 10 min (default) | 144                                      | 17             |
| 15 min           | 96                                       | 20             |

- The status of the integration shows the planned requests a day after each
  save.
- A configuration planning **more than 2,500 requests a day is refused**:
  nothing is read, and the status says what to change.
- The integration counts its own requests per UTC day and never sends more
  than 2,500, scene refreshes and test button included. The count survives a
  restart (a file under `/data`).
- A trip is never read again faster than its interval, even after an error
  or a restart.
- A 429 from TomTom pauses every request (Retry-After, else 1 minute,
  doubling, between 1 minute and 6 hours). A 403 for the daily quota pauses
  them until the next UTC midnight (1 hour at least). A refused key stops the
  reads, with one new try every 6 hours until the key changes. These pauses
  survive a restart.

## Reading window (optional)

To save the quota, read the trips only between two hours, e.g. 6 to 20 (14
hours: 84 requests per trip at 10 minutes). 0 to 24 reads all day long; a
window may cross midnight (22 to 6). The hours are those of the given **time
zone** (the one of your Gladys, `Europe/Paris` by default). Outside the
window, the last values stay shown and are not sent again.

## Scene: refresh a trip now

The scene action **Refresh a TomTom trip now** reads the chosen trip at once,
unless it was read less than **2 minutes** ago (a scene in a loop cannot drain
the quota): it then gives back its last values. It works outside the reading
window too. Outputs, for the following actions: `refreshed` (read now or
not), `travel_time_minutes`, `traffic_delay_minutes`, `distance_km`,
`no_traffic_time_minutes`. The next periodic read comes a whole interval
later.

Example: every weekday at 7:30, refresh "Work", then send a message when
`traffic_delay_minutes` is over 10.

## "Test TomTom" button

Reads the first trip (one request, at most once every 2 minutes), then shows
the planned requests, the ones used today, and the last values of every trip.

## Privacy

The coordinates of your trips (often your home) and the key are sent to
TomTom (`api.tomtom.com`) on each read, and to nobody else. The file
`/data/tomtom-state.json` keeps the count of the day, the pauses, a hash of
the key (never the key) and the instant each trip was last read.

## Troubleshooting

- **"TomTom refused the API key"**: check the key on developer.tomtom.com and
  that it has access to the Routing API.
- **"no route between the points"**: a point is far from any road, or the
  points are not linked by road; tried again every hour at most.
- **Configuration refused**: raise the interval, shorten the reading window or
  remove trips.
- Integration logs: from the Gladys interface.

## License

Apache-2.0. TomTom is a trademark of TomTom N.V.; this connector is neither
affiliated with nor endorsed by TomTom.
