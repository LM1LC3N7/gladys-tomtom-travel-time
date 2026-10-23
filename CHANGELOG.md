# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-19

### Added

- The travel time of your trips in Gladys, through the official TomTom
  Routing API (Calculate Route) and a free API key: one device per trip, with
  the travel time with live traffic, the traffic delay, the travel time
  without traffic (minutes) and the distance (km).
- Trips entered as "Name | lat,lon | lat,lon", twenty at most; car or truck,
  avoid toll roads, avoid motorways, departure now.
- Each trip read every 10 minutes by default, 5 at least, with an optional
  reading window (local hours, may cross midnight) to save the quota.
- The status shows the requests a day the configuration plans (trips × reads
  a day); a configuration over the 2,500 requests a day of the free plan is
  refused.
- Never more than 2,500 requests a UTC day, never a trip read faster than its
  interval, even after an error or a restart; a 429 or a 403 for the quota
  pauses every request, a refused key stops the reads (one new try every 6
  hours). The count, the pauses and the last read of each trip are kept under
  `/data` with a hash of the key, never the key.
- Scene action "Refresh a TomTom trip now", at most once every 2 minutes per
  trip and 100 manual reads a UTC day (fewer when the planned reads leave
  less of the 2,500), with the values and their age as outputs; simultaneous
  calls send one request only.
- A warning in the status when `/data` cannot be written; the first reads
  then wait a whole interval after each start.
- "Test TomTom" button: one request, the planned and used requests, the last
  values of every trip.

[Unreleased]: https://github.com/LM1LC3N7/gladys-tomtom-travel-time/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-tomtom-travel-time/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-tomtom-travel-time/releases/tag/v0.1.1
