// -----------------------------------------------------------------------------
// The TomTom client: the request, the answers and errors, and the guards of
// the key (pace, daily quota, pauses, refusal), persisted across a restart.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { DAILY_LIMIT, LIMITED_MIN, REFUSED_BACKOFF } from '../src/constants.js';
import { NetworkError, get, setFetch } from '../src/http.js';
import { Store, memoryStorage, nextUtcMidnight } from '../src/store.js';
import { TomTomClient, TomTomError, checkAnswer, readingOf, routeUrl } from '../src/tomtom.js';
import { NOW, detailed, fixture, installFetch, json, xml } from './helpers/fakes.js';

const KEY = 'Secret-Key_42';
const [TRIP] = normalizeConfig({ trips: 'Work | 48.85661,2.35222 | 48.89198,2.23881' }).trips;
const CAR = { travelMode: 'car', avoidTolls: false, avoidMotorways: false };
const ROUTE = /^https:\/\/api\.tomtom\.com\/routing\/1\/calculateRoute\//;

let fake;
afterEach(() => fake?.restore());

function client({ storage = memoryStorage(), now = NOW } = {}) {
  const clock = { now };
  const c = new TomTomClient({
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    storage,
  });
  c.useKey(KEY);
  return { c, clock, storage };
}

test('the request: Calculate Route v1, traffic, all travel times, departure now', () => {
  const url = new URL(routeUrl(TRIP, CAR, KEY));
  assert.equal(url.origin, 'https://api.tomtom.com');
  assert.equal(url.pathname, '/routing/1/calculateRoute/48.85661,2.35222:48.89198,2.23881/json');
  const p = url.searchParams;
  assert.equal(p.get('traffic'), 'true');
  assert.equal(p.get('travelMode'), 'car');
  assert.equal(p.get('computeTravelTimeFor'), 'all');
  assert.equal(p.get('departAt'), 'now');
  assert.equal(p.get('routeRepresentation'), 'summaryOnly');
  assert.deepEqual(p.getAll('avoid'), []);
  assert.equal(p.get('key'), KEY);
  const truck = new URL(
    routeUrl(TRIP, { travelMode: 'truck', avoidTolls: true, avoidMotorways: true }, KEY),
  );
  assert.equal(truck.searchParams.get('travelMode'), 'truck');
  assert.deepEqual(truck.searchParams.getAll('avoid'), ['tollRoads', 'motorways']);
});

test('the summary of the first route', () => {
  const summary = checkAnswer({ status: 200, text: JSON.stringify(fixture('route.json')) });
  assert.deepEqual(readingOf(summary), {
    travelTime: 1740,
    trafficDelay: 312,
    length: 18234,
    noTrafficTime: 1290,
  });
  // No delay field: no delay. Garbage: null.
  assert.deepEqual(readingOf({ travelTimeInSeconds: 60, lengthInMeters: '5' }), {
    travelTime: 60,
    trafficDelay: 0,
    length: null,
    noTrafficTime: null,
  });
  assert.equal(checkAnswer({ status: 200, text: '{"routes":[]}' }).kind, 'failed');
  // A route without a travel time is no answer.
  const noTime = checkAnswer({
    status: 200,
    text: JSON.stringify({ routes: [{ summary: { lengthInMeters: 100 } }] }),
  });
  assert.equal(noTime.kind, 'failed');
  assert.equal(noTime.detail, 'unexpected answer');
  assert.equal(checkAnswer({ status: 200, text: '<html>' }).kind, 'failed');
});

test('the errors: key refused, quota, rate, no route, passing failures', () => {
  const kind = (status, text) => checkAnswer({ status, text }).kind;
  assert.equal(kind(403, '<h1>Developer Inactive</h1>'), 'refused');
  assert.equal(kind(403, '<h1>Not Authorized</h1>'), 'refused');
  assert.equal(kind(403, '<h1>Forbidden</h1>'), 'refused');
  assert.equal(kind(403, 'Invalid key'), 'refused');
  // A 403 TomTom does not explain (a proxy, a CDN): a pause, not a refusal.
  assert.equal(kind(403, ''), 'limited');
  assert.equal(kind(403, '<html>Access denied by the edge</html>'), 'limited');
  assert.equal(kind(401, ''), 'refused');
  assert.equal(kind(403, '<h1>Developer Over Rate</h1>'), 'quota');
  assert.equal(kind(403, 'Over the limit'), 'quota');
  assert.equal(kind(403, '<h1>Developer Over Qps</h1>'), 'limited');
  assert.equal(kind(429, ''), 'limited');
  const noRoute = checkAnswer({
    status: 400,
    text: JSON.stringify({ detailedError: { code: 'NO_ROUTE_FOUND', message: 'x' } }),
  });
  assert.equal(noRoute.kind, 'no_route');
  assert.equal(noRoute.detail, 'NO_ROUTE_FOUND');
  assert.equal(kind(400, JSON.stringify({ detailedError: { code: 'BAD_INPUT' } })), 'bad_request');
  assert.equal(kind(500, ''), 'failed');
  assert.equal(kind(503, ''), 'failed');
  // An unknown code is never echoed.
  const echo = checkAnswer({
    status: 400,
    text: JSON.stringify({ detailedError: { code: `ECHO ${KEY}`, message: KEY } }),
  });
  assert.doesNotMatch(echo.message, /Secret/);
});

test('a read: one request, its values, counted for the day and the trip', async () => {
  fake = installFetch([[ROUTE, () => json(fixture('route.json'))]]);
  const { c, clock } = client();
  const reading = await c.route(TRIP, CAR, { apiKey: KEY });
  assert.equal(reading.travelTime, 1740);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].init.redirect, 'error');
  assert.equal(c.store.used(), 1);
  assert.equal(c.store.trip(TRIP.id).lastAttemptAt, clock.now);
});

test('a 429 pauses every request of the key, persisted across a restart', async () => {
  fake = installFetch([[ROUTE, () => json({}, 429, { 'retry-after': '120' })]]);
  const storage = memoryStorage();
  const { c, clock } = client({ storage });
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY }), { kind: 'limited' });
  assert.equal(c.keyPausedUntil, clock.now + 120_000);
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY }), { kind: 'limited' });
  assert.equal(fake.calls.length, 1, 'the pause holds before the network');
  // A restart reads the pause back.
  const again = client({ storage, now: clock.now + 10_000 }).c;
  await assert.rejects(again.route(TRIP, CAR, { apiKey: KEY }), { kind: 'limited' });
  assert.equal(fake.calls.length, 1);
});

test('a 429 without Retry-After: 1 minute, doubling', async () => {
  fake = installFetch([[ROUTE, () => json({}, 429)]]);
  const { c, clock } = client();
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY }));
  assert.equal(c.keyPausedUntil - clock.now, LIMITED_MIN);
  clock.now = c.keyPausedUntil;
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY }));
  assert.equal(c.keyPausedUntil - clock.now, 2 * LIMITED_MIN);
});

test('a 403 for the quota pauses until the next UTC midnight, persisted', async () => {
  fake = installFetch([[ROUTE, () => xml('Developer Over Rate')]]);
  const storage = memoryStorage();
  const { c, clock } = client({ storage });
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY }), { kind: 'quota' });
  assert.equal(c.keyPausedUntil, nextUtcMidnight(clock.now));
  const again = client({ storage, now: clock.now + 3_600_000 }).c;
  assert.equal(again.keyState, 'quota');
  await assert.rejects(again.route(TRIP, CAR, { apiKey: KEY }), { kind: 'quota' });
  assert.equal(fake.calls.length, 1);
});

test('a refused key: 6 hours, the test button may try again, a new key starts afresh', async () => {
  fake = installFetch([[ROUTE, () => xml('Developer Inactive')]]);
  const storage = memoryStorage();
  const { c, clock } = client({ storage });
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY }), { kind: 'refused' });
  assert.equal(c.keyPausedUntil, clock.now + REFUSED_BACKOFF);
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY }), { kind: 'refused' });
  assert.equal(fake.calls.length, 1);
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY, force: true }), { kind: 'refused' });
  assert.equal(fake.calls.length, 2, 'force tries a refused key');
  // The state file holds a hash of the key, never the key.
  assert.doesNotMatch(JSON.stringify(storage.load()), /Secret-Key/);
  c.useKey('another-key');
  assert.equal(c.keyState, 'ok');
  await assert.rejects(c.route(TRIP, CAR, { apiKey: 'another-key' }), { kind: 'refused' });
  assert.equal(fake.calls.length, 3);
});

test('never more than 2,500 requests a UTC day, the count survives a restart', async () => {
  fake = installFetch([[ROUTE, () => json(fixture('route.json'))]]);
  const storage = memoryStorage({ day: '2026-10-18', count: DAILY_LIMIT - 1 });
  const { c, clock } = client({ storage });
  await c.route(TRIP, CAR, { apiKey: KEY });
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY }), { kind: 'budget' });
  assert.equal(fake.calls.length, 1);
  clock.now = nextUtcMidnight(clock.now);
  await c.route(TRIP, CAR, { apiKey: KEY });
  assert.equal(c.store.used(), 1);
});

test('the pace: never two requests within a second, even across a restart', async () => {
  fake = installFetch([[ROUTE, () => json(fixture('route.json'))]]);
  const storage = memoryStorage();
  const { c, clock } = client({ storage });
  const start = clock.now;
  await c.route(TRIP, CAR, { apiKey: KEY });
  await c.route(TRIP, CAR, { apiKey: KEY });
  assert.equal(clock.now - start, 1000);
  // A restart 200 ms later: the next request still waits for its second.
  const again = client({ storage, now: clock.now + 200 });
  await again.c.route(TRIP, CAR, { apiKey: KEY });
  assert.equal(again.clock.now, clock.now + 1000);
  assert.equal(fake.calls.length, 3);
});

test('the key never reaches an error, even when Node puts the URL in its error', async () => {
  for (const thrown of [
    new TypeError(`Failed to parse URL from https://api.tomtom.com/x?key=${KEY}`),
    Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND', message: `getaddrinfo ${KEY}` },
    }),
    Object.assign(new Error(`redirect ${KEY}`), { code: KEY }),
    new DOMException(`aborted ${KEY}`, 'TimeoutError'),
  ]) {
    fake = installFetch([
      [
        ROUTE,
        () => {
          throw thrown;
        },
      ],
    ]);
    const { c } = client();
    const err = await c.route(TRIP, CAR, { apiKey: KEY }).catch((e) => e);
    assert.ok(err instanceof NetworkError);
    assert.match(err.message, /api\.tomtom\.com/);
    assert.doesNotMatch(`${err.message} ${err.stack}`, /Secret-Key/i);
    fake.restore();
  }
});

test('the answer is bounded: a huge body is cut and fails', async () => {
  const previous = setFetch(async () => new Response('x'.repeat(200_000), { status: 200 }));
  try {
    await assert.rejects(
      get(`https://api.tomtom.com/?key=${KEY}`, { maxBytes: 64 * 1024 }),
      (err) => {
        assert.ok(err instanceof NetworkError);
        assert.match(err.message, /too large/);
        assert.doesNotMatch(err.message, /Secret/);
        return true;
      },
    );
  } finally {
    setFetch(previous);
  }
});

test('the state file: checked field by field, no prototype pollution, pauses capped', () => {
  const file = JSON.parse(
    '{"__proto__":{"polluted":true},"day":"2026-10-18","count":12,' +
      '"key":{"hash":"0123456789abcdef","state":"refused","pausedUntil":9e15,"streak":3,' +
      '"__proto__":{"x":1}},"trips":{"__proto__":{"lastAttemptAt":1},"work":' +
      '{"lastAttemptAt":9e15},"bad id!":{"lastAttemptAt":1}}}',
  );
  const store = new Store({
    storage: memoryStorage(file),
    now: () => NOW,
    dailyLimit: DAILY_LIMIT,
    limits: { refused: REFUSED_BACKOFF },
  });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(store.count, 12);
  assert.equal(store.key.pausedUntil, NOW + REFUSED_BACKOFF);
  assert.deepEqual([...store.trips.keys()], ['work']);
  assert.equal(store.trips.get('work').lastAttemptAt, NOW, 'a future instant counts as now');
});

test('an unreadable state file: half the quota assumed spent', () => {
  const store = new Store({
    storage: { load: () => ({ unreadable: true }), save() {} },
    now: () => NOW,
    dailyLimit: DAILY_LIMIT,
  });
  assert.equal(store.used(), DAILY_LIMIT / 2);
});

test('TomTomError messages hold only fixed texts', () => {
  assert.equal(
    new TomTomError('no_route', 'NO_ROUTE_FOUND').message,
    'TomTom no_route (NO_ROUTE_FOUND)',
  );
  assert.ok(detailed('BAD_INPUT', 'x') instanceof Response);
});

test('concurrent callers: the gap is checked in the turn, one request only', async () => {
  fake = installFetch([[ROUTE, () => json(fixture('route.json'))]]);
  const { c } = client();
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      c.route(TRIP, CAR, { apiKey: KEY, manual: true, minGap: 120_000 }),
    ),
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(
    results.filter((r) => r.status === 'rejected').every((r) => r.reason.kind === 'too_soon'),
  );
});

test('the manual reads of the day are capped, the count persisted', async () => {
  fake = installFetch([[ROUTE, () => json(fixture('route.json'))]]);
  const storage = memoryStorage();
  const { c, clock } = client({ storage });
  await c.route(TRIP, CAR, { apiKey: KEY, manual: true, manualLimit: 2 });
  await c.route(TRIP, CAR, { apiKey: KEY, manual: true, manualLimit: 2 });
  await assert.rejects(c.route(TRIP, CAR, { apiKey: KEY, manual: true, manualLimit: 2 }), {
    kind: 'manual_budget',
  });
  // Periodic reads are not held by it.
  await c.route(TRIP, CAR, { apiKey: KEY });
  assert.equal(fake.calls.length, 3);
  const again = client({ storage, now: clock.now });
  assert.equal(again.c.store.manualUsed(), 2);
  await assert.rejects(again.c.route(TRIP, CAR, { apiKey: KEY, manual: true, manualLimit: 2 }), {
    kind: 'manual_budget',
  });
  again.clock.now = nextUtcMidnight(again.clock.now);
  assert.equal(again.c.store.manualUsed(), 0);
});

test('a state file that cannot be written is reported', () => {
  const store = new Store({
    storage: { load: () => undefined, save: () => false },
    now: () => NOW,
    dailyLimit: DAILY_LIMIT,
  });
  assert.equal(store.writable, true);
  store.save();
  assert.equal(store.writable, false);
});
