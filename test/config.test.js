import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  inWindow,
  normalizeConfig,
  parsePoint,
  parseTrips,
  plannedRequests,
  slug,
} from '../src/config.js';

const WORK = 'Work | 48.85661,2.35222 | 48.89198,2.23881';

test('the defaults: no trip, every 10 minutes, a car, all day long', () => {
  const config = normalizeConfig();
  assert.equal(config.apiKey, '');
  assert.deepEqual(config.trips, []);
  assert.equal(config.intervalMinutes, DEFAULT_CONFIG.poll_interval);
  assert.equal(config.intervalMinutes, 10);
  assert.equal(config.travelMode, 'car');
  assert.equal(config.avoidTolls, false);
  assert.equal(config.avoidMotorways, false);
  assert.equal(config.timezone, 'Europe/Paris');
  assert.equal(config.planned, 0);
});

test('points: "lat,lon" with a decimal point, in range', () => {
  assert.deepEqual(parsePoint('48.8566,2.3522'), { lat: 48.8566, lon: 2.3522 });
  assert.deepEqual(parsePoint(' -33.9, 151.2 '), { lat: -33.9, lon: 151.2 });
  for (const bad of ['', '48.8566', '48,8566, 2,3522', '91,0', '0,181', 'a,b', '48.8;2.3', null]) {
    assert.equal(parsePoint(bad), undefined, String(bad));
  }
});

test('trips: name | origin | destination, separated by ";" or a line break', () => {
  const { trips, invalid } = parseTrips(
    `${WORK};\nÉcole des enfants | 48.80000,2.30000 | 48.81000,2.31000`,
  );
  assert.deepEqual(
    trips.map((t) => [t.id, t.name]),
    [
      ['work', 'Work'],
      ['ecole-des-enfants', 'École des enfants'],
    ],
  );
  assert.deepEqual(trips[0].origin, { lat: 48.85661, lon: 2.35222 });
  assert.deepEqual(invalid, []);
});

test('invalid trips are reported by name only, duplicates refused', () => {
  const { trips, invalid } = parseTrips(
    `${WORK}; Work | 1,1 | 2,2; Broken | 48.8,2.3; Same | 1,1 | 1,1; | 1,1 | 2,2`,
  );
  assert.equal(trips.length, 1);
  assert.deepEqual(invalid, ['Work', 'Broken', 'Same', '?']);
});

test('twenty trips at most', () => {
  const text = Array.from({ length: 23 }, (_, i) => `T${i} | 1,1 | 2,2`).join(';');
  const { trips, dropped } = parseTrips(text);
  assert.equal(trips.length, 20);
  assert.equal(dropped, 3);
});

test('slugs are stable and safe ids (no "__proto__")', () => {
  assert.equal(slug('__proto__'), 'proto');
  assert.equal(slug('Saint-Étienne → Lyon'), 'saint-etienne-lyon');
  assert.equal(slug('x'.repeat(80)).length, 40);
});

test('the interval: 5 minutes at least', () => {
  assert.equal(normalizeConfig({ poll_interval: 1 }).intervalMinutes, 5);
  assert.equal(normalizeConfig({ poll_interval: '15' }).intervalMinutes, 15);
  assert.equal(normalizeConfig({ poll_interval: '' }).intervalMinutes, 10);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).intervalMinutes, 240);
});

test('the requests a day planned, and the refusal past 2,500', () => {
  const trips = (n) => Array.from({ length: n }, (_, i) => `T${i} | 1,1 | 2,2`).join(';');
  assert.equal(normalizeConfig({ trips: trips(1) }).planned, 144);
  assert.equal(normalizeConfig({ trips: trips(3), poll_interval: 5 }).planned, 864);
  assert.equal(normalizeConfig({ trips: trips(17) }).overQuota, false);
  const over = normalizeConfig({ trips: trips(18) });
  assert.equal(over.planned, 2592);
  assert.equal(over.overQuota, true);
  // A reading window from 6 to 20 saves the quota: 14 hours.
  const windowed = normalizeConfig({ trips: trips(18), active_from: 6, active_until: 20 });
  assert.equal(windowed.planned, 18 * 84);
  assert.equal(windowed.overQuota, false);
  // Across midnight: 22 to 6 is 8 hours.
  assert.equal(
    plannedRequests({ trips: [1], intervalMinutes: 10, activeFrom: 22, activeUntil: 6 }),
    48,
  );
  // 7 minutes: ceil(1440 / 7) = 206 reads.
  assert.equal(normalizeConfig({ trips: trips(1), poll_interval: 7 }).planned, 206);
});

test('travel mode and avoidances', () => {
  const config = normalizeConfig({
    travel_mode: 'truck',
    avoid_tolls: true,
    avoid_motorways: 'true',
  });
  assert.equal(config.travelMode, 'truck');
  assert.equal(config.avoidTolls, true);
  assert.equal(config.avoidMotorways, true);
  assert.equal(normalizeConfig({ travel_mode: 'rocket' }).travelMode, 'car');
});

test('an unknown time zone falls back to Europe/Paris, and says so', () => {
  const config = normalizeConfig({ timezone: 'Mars/Olympus' });
  assert.equal(config.timezone, 'Europe/Paris');
  assert.equal(config.invalidTimezone, true);
  assert.equal(normalizeConfig({ timezone: 'Europe/Lisbon' }).timezone, 'Europe/Lisbon');
});

test('the reading window, in local time, west and east of Paris around midnight', () => {
  const config = (zone, from, until) =>
    normalizeConfig({ trips: WORK, timezone: zone, active_from: from, active_until: until });
  // 2026-10-18 22:30 UTC: 23:30 in Lisbon, 00:30 in Paris, 01:30 in Helsinki.
  const at = Date.parse('2026-10-18T22:30:00Z');
  assert.equal(inWindow(config('Europe/Lisbon', 6, 24), at), true);
  assert.equal(inWindow(config('Europe/Paris', 6, 24), at), false);
  assert.equal(inWindow(config('Europe/Helsinki', 1, 6), at), true);
  assert.equal(inWindow(config('Europe/Paris', 1, 6), at), false);
  // Across midnight: 22 to 6.
  assert.equal(inWindow(config('Europe/Paris', 22, 6), at), true);
  assert.equal(inWindow(config('Europe/Paris', 22, 6), Date.parse('2026-10-18T10:00:00Z')), false);
  // 6 to 20: 08:30 in Paris is in, 20:00 is out.
  assert.equal(inWindow(config('Europe/Paris', 6, 20), Date.parse('2026-10-18T06:30:00Z')), true);
  assert.equal(inWindow(config('Europe/Paris', 6, 20), Date.parse('2026-10-18T18:00:00Z')), false);
  // 0 to 24, or the same hour twice: all day long.
  assert.equal(inWindow(config('Europe/Paris', 0, 24), at), true);
  assert.equal(inWindow(config('Europe/Paris', 7, 7), at), true);
});
