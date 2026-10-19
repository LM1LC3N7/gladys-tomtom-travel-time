// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake TomTom.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TravelTimeApp } from '../src/app.js';
import { ACTIONS, MANUAL_MIN_GAP, SCENE_ACTIONS, TICK } from '../src/constants.js';
import { memoryStorage } from '../src/store.js';
import { TomTomClient } from '../src/tomtom.js';
import {
  NOW,
  createFakeTimers,
  fixture,
  installFetch,
  json,
  recordingLogger,
  xml,
} from './helpers/fakes.js';

const KEY = 'Secret-Key_42';
const WORK = 'Work | 48.85661,2.35222 | 48.89198,2.23881';
const SCHOOL = 'School | 48.80000,2.30000 | 48.81000,2.31000';
const DEVICE = 'ext:tomtom:trip:work';
const ROUTE = /^https:\/\/api\.tomtom\.com\/routing\/1\/calculateRoute\//;

let fake;
afterEach(() => fake?.restore());

async function setup({
  config = { api_key: KEY, trips: WORK },
  storage = memoryStorage(),
  now = NOW,
  answer = () => json(fixture('route.json')),
  start = true,
} = {}) {
  const answers = { route: answer };
  fake = installFetch([[ROUTE, (c) => answers.route(c)]]);
  const gladys = createFakeGladys({ selector: 'tomtom', config });
  const timers = createFakeTimers();
  const clock = { now };
  const logger = recordingLogger();
  const client = new TomTomClient({
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    storage,
  });
  const app = new TravelTimeApp({ gladys, logger, now: () => clock.now, timers, client });
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onSceneAction(SCENE_ACTIONS.REFRESH, (fields) => app.refreshTrip(fields));
  gladys.onDeviceCreated(() => app.publishStates());
  await gladys.connect();
  if (start) {
    await app.start(config);
  }
  return { app, gladys, timers, clock, answers, logger, storage };
}

const requests = () => fake.calls.filter((c) => ROUTE.test(c.url));

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

async function runMinutes(timers, clock, minutes) {
  for (let i = 0; i < minutes; i += 1) {
    clock.now += TICK;
    await timers.runIntervals();
  }
}

test('a trip: one request, its device with four features, the status', async () => {
  const { gladys, timers } = await setup();
  assert.equal(requests().length, 1);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.name, 'Work');
  assert.equal(device.external_id, DEVICE);
  assert.deepEqual(
    device.features.map((f) => [
      f.external_id.slice(DEVICE.length + 1),
      f.category,
      f.type,
      f.unit,
    ]),
    [
      ['travel_time', 'duration', 'decimal', 'minutes'],
      ['traffic_delay', 'duration', 'decimal', 'minutes'],
      ['distance', 'distance-sensor', 'decimal', 'km'],
      ['no_traffic_time', 'duration', 'decimal', 'minutes'],
    ],
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /144 requests a day planned, out of 2,500/);
  assert.match(gladys.fake.connectionStatus.message.fr, /144 requêtes par jour prévues/);
  assert.deepEqual(
    timers.intervals().map((t) => t.ms),
    [TICK],
  );
});

test('a created device gets its values: minutes and km', async () => {
  const { gladys } = await setup();
  await createAll(gladys);
  assert.equal(gladys.fake.lastState(`${DEVICE}:travel_time`), 29);
  assert.equal(gladys.fake.lastState(`${DEVICE}:traffic_delay`), 5.2);
  assert.equal(gladys.fake.lastState(`${DEVICE}:distance`), 18.2);
  assert.equal(gladys.fake.lastState(`${DEVICE}:no_traffic_time`), 21.5);
});

test('each trip is read every 10 minutes, not more', async () => {
  const { timers, clock } = await setup({ config: { api_key: KEY, trips: `${WORK};${SCHOOL}` } });
  assert.equal(requests().length, 2);
  await runMinutes(timers, clock, 9);
  assert.equal(requests().length, 2);
  await runMinutes(timers, clock, 1);
  assert.equal(requests().length, 4);
  // A whole day (the first read at minute 0, the last one at minute 1440):
  // 145 reads of each trip at most.
  await runMinutes(timers, clock, 24 * 60 - 10);
  assert.ok(requests().length <= 2 * 145);
  assert.ok(requests().length >= 2 * 144);
});

test('an error is never read again faster than the interval', async () => {
  const { timers, clock, answers, gladys } = await setup({ answer: () => json({}, 503) });
  assert.equal(requests().length, 1);
  await runMinutes(timers, clock, 9);
  assert.equal(requests().length, 1);
  await runMinutes(timers, clock, 1);
  assert.equal(requests().length, 2);
  assert.match(gladys.fake.connectionStatus.message.en, /Without value: Work \(no answer\)/);
  answers.route = () => json(fixture('route.json'));
  await runMinutes(timers, clock, 10);
  assert.equal(requests().length, 3);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /Without value/);
});

test('a restart never reads a trip sooner than its interval', async () => {
  const storage = memoryStorage();
  const first = await setup({ storage });
  assert.equal(requests().length, 1);
  first.app.stop();
  fake.restore();
  // The container restarts 3 minutes later, with the same /data.
  const second = await setup({ storage, now: first.clock.now + 3 * 60_000 });
  assert.equal(requests().length, 0);
  await runMinutes(second.timers, second.clock, 6);
  assert.equal(requests().length, 0);
  await runMinutes(second.timers, second.clock, 1);
  assert.equal(requests().length, 1);
});

test('a reconnection publishes the status and the Discovery again, without a request', async () => {
  const { app, gladys } = await setup();
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  assert.ok(discoveries >= 1);
  await app.start({ api_key: KEY, trips: WORK });
  assert.equal(requests().length, 1);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
});

test('a 429 keeps its pause across a reconnection, and its status says so', async () => {
  const { app, gladys, timers, clock, answers } = await setup({
    answer: () => json({}, 429, { 'retry-after': '1800' }),
  });
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  await app.start({ api_key: KEY, trips: WORK });
  await runMinutes(timers, clock, 29);
  assert.equal(requests().length, 1);
  answers.route = () => json(fixture('route.json'));
  await runMinutes(timers, clock, 1);
  assert.equal(requests().length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a refused key: the status says it, connected false, nothing more for 6 hours', async () => {
  const { gladys, timers, clock } = await setup({ answer: () => xml('Developer Inactive') });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /a refusé la clé/);
  await runMinutes(timers, clock, 6 * 60 - 1);
  assert.equal(requests().length, 1);
});

test('a configuration over 2,500 requests a day is refused: nothing is read', async () => {
  const trips = Array.from({ length: 9 }, (_, i) => `T${i} | 1,1 | 2,2`).join(';');
  const { gladys, timers, clock } = await setup({
    config: { api_key: KEY, trips, poll_interval: 5 },
  });
  assert.equal(requests().length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /Configuration refused: it plans 2,592/);
  await runMinutes(timers, clock, 30);
  assert.equal(requests().length, 0);
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(ack.data.message.en, /Configuration refused/);
  assert.equal(requests().length, 0);
});

test('the reading window: no request outside it', async () => {
  // 06:30 UTC = 08:30 in Paris; the window opens at 9.
  const { gladys, timers, clock } = await setup({
    config: { api_key: KEY, trips: WORK, active_from: 9, active_until: 20 },
  });
  assert.equal(requests().length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /9:00 to 20:00 \(Europe\/Paris\)/);
  await runMinutes(timers, clock, 29);
  assert.equal(requests().length, 0);
  await runMinutes(timers, clock, 1);
  assert.equal(requests().length, 1);
  // 11 hours: 66 reads in all, then nothing until the next morning.
  await runMinutes(timers, clock, 11 * 60 + 60);
  assert.equal(requests().length, 66);
});

test('the scene action: a request now, never twice within 2 minutes', async () => {
  const { gladys, clock } = await setup();
  let ack = await gladys.fake.sceneAction(SCENE_ACTIONS.REFRESH, { trip: DEVICE });
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.outputs, {
    refreshed: false,
    age_minutes: 0,
    travel_time_minutes: 29,
    traffic_delay_minutes: 5.2,
    distance_km: 18.2,
    no_traffic_time_minutes: 21.5,
  });
  assert.equal(requests().length, 1);
  clock.now += MANUAL_MIN_GAP;
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.REFRESH, { trip: DEVICE });
  assert.equal(ack.data.outputs.refreshed, true);
  assert.equal(requests().length, 2);
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.REFRESH, { trip: 'ext:tomtom:trip:nope' });
  assert.equal(ack.success, false);
});

test('a tick, five scenes and the test button at once: one request', async () => {
  const { app, gladys, clock } = await setup();
  clock.now += 10 * 60_000;
  await Promise.all([
    app.tick(),
    ...Array.from({ length: 5 }, () =>
      gladys.fake.sceneAction(SCENE_ACTIONS.REFRESH, { trip: DEVICE }),
    ),
    gladys.fake.action(ACTIONS.TEST),
  ]);
  assert.equal(requests().length, 2, 'the setup read, then one request');
});

test('a configuration saved during a tick never reads a trip twice', async () => {
  const { app, clock } = await setup();
  clock.now += 10 * 60_000;
  await Promise.all([app.tick(), app.start({ api_key: KEY, trips: WORK })]);
  assert.equal(requests().length, 2);
});

test('a looping scene stops at the manual reads of the day, the periodic reads go on', async () => {
  // 17 trips every 10 minutes: 2,448 planned, 52 manual reads left.
  const trips = [WORK, ...Array.from({ length: 16 }, (_, i) => `T${i} | 1,1 | 2,2`)].join(';');
  const { app, gladys, timers, clock } = await setup({ config: { api_key: KEY, trips } });
  assert.equal(app.manualLimit, 52);
  let refreshed = 0;
  for (let i = 0; i < 80; i += 1) {
    clock.now += MANUAL_MIN_GAP;
    const ack = await gladys.fake.sceneAction(SCENE_ACTIONS.REFRESH, { trip: DEVICE });
    refreshed += ack.data.outputs.refreshed ? 1 : 0;
    assert.equal(typeof ack.data.outputs.travel_time_minutes, 'number');
  }
  assert.equal(refreshed, 52);
  const before = requests().length;
  await runMinutes(timers, clock, 10);
  assert.ok(requests().length > before, 'the periodic reads still go');
});

test('a /data that cannot be written: a warning, and the first read waits an interval', async () => {
  const { gladys, timers, clock } = await setup({
    storage: { load: () => undefined, save: () => false },
  });
  assert.equal(requests().length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /\/data folder cannot be written/);
  await runMinutes(timers, clock, 9);
  assert.equal(requests().length, 0);
  await runMinutes(timers, clock, 1);
  assert.equal(requests().length, 1);
});

test('a manual refresh pushes the next periodic read by a whole interval', async () => {
  const { gladys, timers, clock } = await setup();
  await runMinutes(timers, clock, 5);
  await gladys.fake.sceneAction(SCENE_ACTIONS.REFRESH, { trip: DEVICE });
  assert.equal(requests().length, 2);
  await runMinutes(timers, clock, 9);
  assert.equal(requests().length, 2);
  await runMinutes(timers, clock, 1);
  assert.equal(requests().length, 3);
});

test('the test button: the plan, today count and the values of every trip', async () => {
  const { gladys, clock } = await setup({ config: { api_key: KEY, trips: `${WORK};${SCHOOL}` } });
  clock.now += MANUAL_MIN_GAP;
  const ack = await gladys.fake.action(ACTIONS.TEST);
  const { en, fr } = ack.data.message;
  assert.match(en, /288 requests a day planned; 3\/2,500 used today/);
  assert.match(en, /- Work: 29 min, delay 5\.2 min, 18\.2 km, without traffic 21\.5 min/);
  assert.match(fr, /- Work : 29 min, retard 5,2 min, 18,2 km, sans trafic 21,5 min/);
  assert.equal(requests().length, 3);
});

test('the key never reaches a log, a status or a message', async () => {
  const { gladys, logger, clock } = await setup({
    answer: () => {
      throw new TypeError(`Failed to parse URL from https://api.tomtom.com/?key=${KEY}`);
    },
  });
  clock.now += MANUAL_MIN_GAP;
  const ack = await gladys.fake.action(ACTIONS.TEST);
  const seen = JSON.stringify([
    logger.lines,
    gladys.fake.connectionStatuses,
    ack,
    gladys.fake.requests,
  ]);
  assert.doesNotMatch(seen, /Secret-Key/i);
  assert.ok(logger.lines.some((l) => /network failed on api\.tomtom\.com/.test(l)));
  assert.equal(new TravelTimeApp({ gladys, logger }).scrub(`x?key=${KEY}&y`).includes(KEY), false);
});

test('a device published again never loses a feature', async () => {
  const { app, gladys } = await setup();
  await createAll(gladys);
  // The device as Gladys holds it (gladys.devices, kept up to date by the SDK).
  const created = gladys.devices.find((d) => d.external_id === DEVICE);
  created.features.push({
    name: 'Old feature',
    external_id: `${DEVICE}:old`,
    category: 'duration',
    type: 'decimal',
    unit: 'minutes',
    min: 0,
    max: 10,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  });
  await app.publishDiscovered({ force: true });
  const [device] = gladys.fake.discoveredDevices;
  assert.deepEqual(
    device.features.map((f) => f.external_id.slice(DEVICE.length + 1)),
    ['travel_time', 'traffic_delay', 'distance', 'no_traffic_time', 'old'],
  );
});

test('nothing configured: a status, no request', async () => {
  const { gladys } = await setup({ config: {} });
  assert.equal(requests().length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /Enter your TomTom API key/);
});

test('invalid trips are named in the status, never their coordinates', async () => {
  const { gladys } = await setup({
    config: { api_key: KEY, trips: `${WORK}; Home | 48.123456,2.654321` },
  });
  const { en } = gladys.fake.connectionStatus.message;
  assert.match(en, /1 trip ignored .*: Home/);
  assert.doesNotMatch(en, /48\.123456/);
});
