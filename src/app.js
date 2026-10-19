// -----------------------------------------------------------------------------
// The integration itself: the trips of the configuration, when each is due,
// their Gladys devices and states, the connection status, the test button and
// the scene action. index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { inWindow, normalizeConfig } from './config.js';
import {
  DAILY_LIMIT,
  HEARTBEAT,
  MANUAL_DAILY_MAX,
  MANUAL_MIN_GAP,
  MAX_TRIPS,
  STALE,
  TEST_DEADLINE,
  TICK,
  TRIP_ERROR_RETRY,
} from './constants.js';
import { deviceOf, idsOf, statesOf, valuesOf } from './devices.js';
import { T, count, reason, schedule } from './i18n.js';
import { TomTomClient, TomTomError } from './tomtom.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };

/** The failures that hold every trip (the key), not one trip. */
const KEY_KINDS = ['refused', 'quota', 'limited', 'budget'];

/** 12.34 -> "12.3", "12,3" in French. */
const numberText = (value, lang) => {
  const text = String(Math.round(value * 10) / 10);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

/** The kind shown: an unexplained 403 is not "too many requests". */
const kindOf = (err) =>
  err?.kind === 'limited' && err.detail === 'http 403' ? 'blocked' : err?.kind;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class TravelTimeApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'tomtom' }),
    now = Date.now,
    timers = defaultTimers,
    client,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.config = normalizeConfig();
    // The client keeps the pace, the count of the day and the pauses: it
    // lives as long as the process, across reconnections to Gladys.
    this.client = client ?? new TomTomClient({ now });
    /** trip id -> { reading, ts, error, nextDue } (kept across start()). */
    this.track = new Map();
    this.interval = undefined;
    this.ticking = undefined;
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
    this.started = false;
    this.bootAt = now();
  }

  get intervalMs() {
    return this.config.intervalMinutes * 60_000;
  }

  /**
   * The manual reads (scenes, test button) allowed per UTC day: 100, and
   * never more than what the planned reads leave of the 2,500.
   */
  get manualLimit() {
    return Math.max(0, Math.min(MANUAL_DAILY_MAX, DAILY_LIMIT - this.config.planned));
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    const previous = this.started ? this.config : undefined;
    this.config = normalizeConfig(raw);
    this.started = true;
    const { config } = this;
    // A reconnection to Gladys gives the same configuration: the pauses, the
    // refusal of the key and the due times stay (they are in the client and
    // in /data). A new key starts afresh.
    const newKey = previous !== undefined && previous.apiKey !== config.apiKey;
    if (config.apiKey) {
      this.client.useKey(config.apiKey);
    }
    const ids = new Set(config.trips.map((t) => t.id));
    for (const id of this.track.keys()) {
      if (!ids.has(id)) {
        this.track.delete(id);
      }
    }
    for (const trip of config.trips) {
      const entry = this.track.get(trip.id) ?? { reading: undefined, ts: 0, error: undefined };
      // Never sooner than the interval after the last request, even across a
      // restart (the instant is kept in /data).
      const last = this.client.store.trip(trip.id).lastAttemptAt;
      entry.nextDue = last > 0 ? last + this.intervalMs : 0;
      if (entry.error && KEY_KINDS.includes(entry.error.kind) && !newKey) {
        entry.nextDue = Math.max(entry.nextDue, this.retryAt(trip, entry.error));
      }
      if (newKey && entry.error && KEY_KINDS.includes(entry.error.kind)) {
        // A new key reads again at the usual time (the test button may try
        // it sooner, once the manual gap is over).
        entry.error = undefined;
      }
      if (!this.client.store.writable) {
        // /data cannot keep the instants: a container restarting in a loop
        // must not read at each start. One whole interval after the start.
        entry.nextDue = Math.max(entry.nextDue, this.bootAt + this.intervalMs);
      }
      this.track.set(trip.id, entry);
    }
    // Gladys keeps the Discovery list and the status in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again, whatever the caches say.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    await this.publishDiscovered({ force: true });
    await this.refreshStatus();
    if (generation !== this.generation) {
      return;
    }
    await this.tick();
    if (generation !== this.generation) {
      return;
    }
    this.interval = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${this.scrub(err)}`)),
      TICK,
    );
  }

  stop() {
    this.generation += 1;
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** An error message without the key (nor its URL-encoded form). */
  scrub(err) {
    let message = String(err?.message ?? err);
    const key = this.config.apiKey;
    if (key) {
      for (const form of new Set([key, encodeURIComponent(key)])) {
        message = message.replace(new RegExp(escapeRegExp(form), 'gi'), '***');
      }
    }
    return message.replace(/([?&]key=)[^&\s"']*/gi, '$1***');
  }

  // --- Reading ---------------------------------------------------------------

  /** Read what is due, one trip at a time (a tick never overlaps another). */
  tick() {
    if (this.ticking && this.tickGeneration === this.generation) {
      return this.ticking;
    }
    const previous = this.ticking ?? Promise.resolve();
    const generation = this.generation;
    const run = previous
      .catch(() => {})
      .then(() => this.readDue())
      .finally(() => {
        if (this.ticking === run) {
          this.ticking = undefined;
        }
      });
    this.ticking = run;
    this.tickGeneration = generation;
    return run;
  }

  async readDue() {
    const generation = this.generation;
    const { config } = this;
    if (!config.apiKey || config.overQuota || !inWindow(config, this.now())) {
      return;
    }
    let read = false;
    for (const trip of config.trips) {
      if (generation !== this.generation) {
        return;
      }
      const entry = this.track.get(trip.id);
      if (entry && this.now() >= entry.nextDue) {
        await this.read(trip);
        read = true;
      }
    }
    if (read && generation === this.generation) {
      await this.refreshStatus();
    }
  }

  /** When a trip that failed with `err` is tried again: never sooner than its interval. */
  retryAt(trip, err) {
    const now = this.now();
    const last = this.client.store.trip(trip.id).lastAttemptAt;
    const usual = Math.max(now, last) + this.intervalMs;
    switch (err?.kind) {
      case 'refused':
      case 'quota':
      case 'limited':
        return Math.max(usual, this.client.keyPausedUntil);
      case 'budget':
        return Math.max(usual, this.client.store.resetsAt());
      case 'no_route':
      case 'bad_request':
        return Math.max(usual, now + TRIP_ERROR_RETRY);
      default:
        return usual;
    }
  }

  options() {
    const { travelMode, avoidTolls, avoidMotorways } = this.config;
    return { travelMode, avoidTolls, avoidMotorways };
  }

  /** Read one trip now; never throws. Resolves true when a value came. */
  async read(trip, { manual = false, force = false } = {}) {
    const generation = this.generation;
    const entry = this.track.get(trip.id);
    try {
      const reading = await this.client.route(trip, this.options(), {
        apiKey: this.config.apiKey,
        manual,
        force,
        minGap: manual ? MANUAL_MIN_GAP : this.intervalMs,
        manualLimit: this.manualLimit,
      });
      if (generation !== this.generation || !entry) {
        return false;
      }
      entry.reading = reading;
      entry.ts = this.now();
      entry.error = undefined;
      entry.nextDue = this.now() + this.intervalMs;
      // The key works again: the trips that waited for it are due at their
      // usual time, not hours later.
      for (const other of this.config.trips) {
        const waiting = this.track.get(other.id);
        if (other !== trip && waiting?.error && KEY_KINDS.includes(waiting.error.kind)) {
          const last = this.client.store.trip(other.id).lastAttemptAt;
          waiting.nextDue = Math.min(waiting.nextDue, Math.max(this.now(), last + this.intervalMs));
        }
      }
      await this.publishTripStates(trip);
      return true;
    } catch (err) {
      if (generation !== this.generation || !entry) {
        return false;
      }
      if (err?.kind === 'too_soon' || err?.kind === 'manual_budget') {
        // Nothing was sent: the trip keeps its values, and a periodic read
        // waits for the interval after the request made meanwhile.
        const last = this.client.store.trip(trip.id).lastAttemptAt;
        entry.nextDue = Math.max(entry.nextDue, last + this.intervalMs);
        if (err.kind === 'manual_budget') {
          this.logger.warn(`Manual read of ${trip.name} refused: ${err.message}`);
        }
        return false;
      }
      entry.error = err instanceof TomTomError ? err : new TomTomError('failed', 'network');
      entry.nextDue = this.retryAt(trip, entry.error);
      this.logger.warn(`TomTom read of ${trip.name} failed: ${this.scrub(err)}`);
      return false;
    }
  }

  // --- Gladys devices and states ---------------------------------------------

  /** The devices the user created, by external id. */
  createdDevices() {
    return new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
  }

  /**
   * The device of a trip. A feature of the created device this version does
   * not build is kept: a device published again never loses a feature.
   */
  deviceFor(trip, created) {
    const device = deviceOf(this.gladys, trip);
    const existing = created.get(device.external_id);
    const ours = new Set(device.features.map((f) => f.external_id));
    for (const feature of existing?.features ?? []) {
      if (feature?.external_id && !ours.has(feature.external_id)) {
        const {
          name,
          external_id,
          category,
          type,
          unit,
          min,
          max,
          read_only,
          has_feedback,
          keep_history,
        } = feature;
        device.features.push({
          name,
          external_id,
          category,
          type,
          ...(unit ? { unit } : {}),
          min,
          max,
          read_only,
          has_feedback,
          keep_history,
        });
      }
    }
    return device;
  }

  /** The Discovery tab: every configured trip, published again only when it changed. */
  async publishDiscovered({ force = false } = {}) {
    const created = this.createdDevices();
    const devices = this.config.trips.map((trip) => this.deviceFor(trip, created));
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    const ids = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        ids.add(feature.external_id);
      }
    }
    return ids;
  }

  async publish(states) {
    const created = this.createdFeatures();
    const wanted = states.filter((s) => created.has(s.device_feature_external_id));
    if (wanted.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(wanted, { heartbeat: HEARTBEAT });
    } catch (err) {
      this.logger.warn(`Publishing the states failed: ${err.message}`);
    }
  }

  /** The states of one trip, right after it was read. */
  async publishTripStates(trip) {
    const reading = this.track.get(trip.id)?.reading;
    if (reading) {
      await this.publish(statesOf(this.gladys, trip, reading));
    }
  }

  /** The recent values of every trip (a device was just created). */
  async publishStates() {
    const now = this.now();
    const states = [];
    for (const trip of this.config.trips) {
      const entry = this.track.get(trip.id);
      if (entry?.reading && now - entry.ts <= STALE) {
        states.push(...statesOf(this.gladys, trip, entry.reading));
      }
    }
    await this.publish(states);
  }

  // --- Status ----------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The state of the key when it holds every trip, or undefined. */
  keyIssue() {
    const { client } = this;
    const paused = this.now() < client.keyPausedUntil;
    if (paused && client.keyState === 'refused') {
      return { kind: 'refused', text: T.keyRefused };
    }
    if (paused && client.keyState === 'quota') {
      return { kind: 'quota', text: T.quotaReached(client.keyPausedUntil) };
    }
    if (paused && client.keyState === 'limited') {
      return {
        kind: 'limited',
        text:
          client.keyError?.detail === 'http 403'
            ? T.blocked(client.keyPausedUntil)
            : T.rateLimited(client.keyPausedUntil),
      };
    }
    if (!client.store.allows()) {
      return { kind: 'budget', text: T.budgetSpent(client.store.resetsAt()) };
    }
    return undefined;
  }

  withNotes(text) {
    const { config } = this;
    const notes = [];
    if (config.invalidTrips.length > 0 || config.droppedTrips > 0) {
      notes.push(T.invalidTrips(config.invalidTrips, config.droppedTrips, MAX_TRIPS));
    }
    if (config.invalidTimezone) {
      notes.push(T.invalidTimezone(config.timezone));
    }
    if (!this.client.store.writable) {
      notes.push(T.notWritable);
    }
    if (notes.length === 0) {
      return text;
    }
    return {
      en: `${text.en} ${notes.map((n) => `${n.en}.`).join(' ')}`,
      fr: `${text.fr} ${notes.map((n) => `${n.fr}.`).join(' ')}`,
    };
  }

  async refreshStatus() {
    const { config } = this;
    if (!config.apiKey && config.trips.length === 0) {
      return this.setStatus(false, this.withNotes(T.notConfigured));
    }
    if (!config.apiKey) {
      return this.setStatus(false, this.withNotes(T.noKey));
    }
    if (config.trips.length === 0) {
      return this.setStatus(false, this.withNotes(T.noTrip));
    }
    if (config.overQuota) {
      return this.setStatus(false, this.withNotes(T.overQuota(config.planned)));
    }
    const issue = this.keyIssue();
    const failing = config.trips
      .map((trip) => ({ name: trip.name, error: this.track.get(trip.id)?.error }))
      .filter(({ error }) => error && !(issue && KEY_KINDS.includes(error.kind)))
      .map(({ name, error }) => ({ name, kind: kindOf(error) }));
    const ok = T.ok({ config, failing });
    const text = issue ? { en: `${issue.text.en} ${ok.en}`, fr: `${issue.text.fr} ${ok.fr}` } : ok;
    const anyValue = config.trips.some((trip) => this.track.get(trip.id)?.reading);
    const connected =
      issue?.kind === 'refused' ? false : issue ? anyValue : anyValue || failing.length === 0;
    return this.setStatus(connected, this.withNotes(text));
  }

  // --- Scene action: refresh a trip now ---------------------------------------

  tripOf(deviceExternalId) {
    const id = String(deviceExternalId ?? '');
    return this.config.trips.find((trip) => idsOf(this.gladys, trip).device === id);
  }

  /**
   * Read a trip now, unless it was read less than MANUAL_MIN_GAP ago or the
   * manual reads of the day are spent (then its last values). The checks run
   * in the turn of the pacer: concurrent calls never stack requests.
   * Resolves the outputs of the scene action.
   */
  async refreshTrip(fields) {
    const trip = this.tripOf(fields?.trip);
    if (!trip) {
      throw new Error('Unknown trip: choose a trip of the TomTom integration');
    }
    if (!this.config.apiKey || this.config.overQuota) {
      throw new Error('TomTom is not configured, or its configuration is refused');
    }
    const refreshed = await this.read(trip, { manual: true });
    await this.refreshStatus();
    const entry = this.track.get(trip.id);
    const reading = entry?.reading;
    const outputs = { refreshed };
    if (reading) {
      outputs.age_minutes = Math.max(0, Math.round((this.now() - entry.ts) / 60_000));
      const values = valuesOf(reading);
      for (const [key, output] of [
        ['travel_time', 'travel_time_minutes'],
        ['traffic_delay', 'traffic_delay_minutes'],
        ['distance', 'distance_km'],
        ['no_traffic_time', 'no_traffic_time_minutes'],
      ]) {
        if (values[key] !== null) {
          outputs[output] = values[key];
        }
      }
    }
    return outputs;
  }

  // --- Configuration screen button --------------------------------------------

  line(trip, lang) {
    const entry = this.track.get(trip.id);
    const colon = lang === 'fr' ? ' :' : ':';
    const reading = entry?.reading;
    if (!reading) {
      const why = entry?.error
        ? reason(kindOf(entry.error))[lang]
        : lang === 'fr'
          ? 'pas encore lu'
          : 'not read yet';
      return `- ${trip.name}${colon} ${why}`;
    }
    const v = valuesOf(reading);
    const fr = lang === 'fr';
    const parts = [];
    if (v.travel_time !== null) {
      parts.push(`${numberText(v.travel_time, lang)} min`);
    }
    if (v.traffic_delay !== null) {
      parts.push(`${fr ? 'retard' : 'delay'} ${numberText(v.traffic_delay, lang)} min`);
    }
    if (v.distance !== null) {
      parts.push(`${numberText(v.distance, lang)} km`);
    }
    if (v.no_traffic_time !== null) {
      parts.push(
        `${fr ? 'sans trafic' : 'without traffic'} ${numberText(v.no_traffic_time, lang)} min`,
      );
    }
    const minutes = Math.max(0, Math.round((this.now() - entry.ts) / 60_000));
    parts.push(fr ? `relevé il y a ${minutes} min` : `read ${minutes} min ago`);
    if (entry.error) {
      parts.push(`(${reason(kindOf(entry.error))[lang]})`);
    }
    return `- ${trip.name}${colon} ${parts.join(', ')}`;
  }

  /** Read a trip, but stop waiting at `deadline`. */
  async readBefore(trip, deadline, options) {
    const left = deadline - this.now();
    if (left <= 0) {
      return;
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, left);
    });
    try {
      await Promise.race([this.read(trip, options), timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  async testConnection() {
    const { config } = this;
    if (!config.apiKey || config.trips.length === 0) {
      return this.withNotes(
        !config.apiKey && config.trips.length === 0
          ? T.notConfigured
          : !config.apiKey
            ? T.noKey
            : T.noTrip,
      );
    }
    if (config.overQuota) {
      return this.withNotes(T.overQuota(config.planned));
    }
    const deadline = this.now() + TEST_DEADLINE;
    // One request checks the key (the first trip), never twice within the
    // manual gap (checked in the turn of the pacer); the other trips show
    // their last values.
    const [first] = config.trips;
    await this.readBefore(first, deadline, { manual: true, force: true });
    const en = [];
    const fr = [];
    const issue = this.keyIssue();
    if (issue) {
      en.push(issue.text.en);
      fr.push(issue.text.fr);
    }
    const used = this.client.store.used();
    const manual = this.client.store.manualUsed();
    const limit = this.manualLimit;
    en.push(
      `Trips, ${schedule(config, 'en')}: ${count(config.planned, 'en')} requests a day planned; ${count(used, 'en')}/${count(DAILY_LIMIT, 'en')} used today (UTC), of which ${manual}/${limit} manual reads (scenes, this button).`,
    );
    fr.push(
      `Trajets, ${schedule(config, 'fr')} : ${count(config.planned, 'fr')} requêtes par jour prévues ; ${count(used, 'fr')}/${count(DAILY_LIMIT, 'fr')} utilisées aujourd'hui (UTC), dont ${manual}/${limit} relevés manuels (scènes, ce bouton).`,
    );
    for (const trip of config.trips) {
      en.push(this.line(trip, 'en'));
      fr.push(this.line(trip, 'fr'));
    }
    await this.refreshStatus();
    return this.withNotes({ en: en.join('\n'), fr: fr.join('\n') });
  }
}
