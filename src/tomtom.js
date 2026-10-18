// -----------------------------------------------------------------------------
// The TomTom client: one Calculate Route request per trip read
// (Routing API v1, `traffic=true`, `computeTravelTimeFor=all`, departure now),
// following the official documentation of TomTom.
//
// Every guard of the API key lives here, so no path can skip one: the pace
// (1 s between calls), the daily quota (2,500 requests per UTC day), the
// pause after a 429 or a 403 for the quota, and the stop after a refused key.
// They are persisted under /data (src/store.js), so a restart keeps them.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  API_MIN_GAP,
  DAILY_LIMIT,
  LIMITED_MAX,
  LIMITED_MIN,
  MAX_BODY,
  QUOTA_MAX,
  QUOTA_MIN,
  REFUSED_BACKOFF,
  ROUTE_URL,
} from './constants.js';
import { pointText } from './config.js';
import { get } from './http.js';
import { createPacer } from './pacer.js';
import { Store, nextUtcMidnight } from './store.js';

/**
 * kind: refused (the key), quota (403: the daily quota of the key), limited
 * (429, or a 403 for the requests per second), budget (the integration's own
 * daily count is spent), no_route (no route between the points), bad_request
 * (TomTom refused the request), failed (network, 5xx, anything else).
 * `detail` is a known TomTom code or a fixed text: safe to show and log.
 */
export class TomTomError extends Error {
  constructor(kind, detail = kind, { retryAfterMs } = {}) {
    super(`TomTom ${kind}${detail && detail !== kind ? ` (${detail})` : ''}`);
    this.name = 'TomTomError';
    this.kind = kind;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The `detailedError.code` values shown as they are; any other is not. */
const KNOWN_CODES = [
  'BAD_INPUT',
  'NO_ROUTE_FOUND',
  'MAP_MATCHING_FAILURE',
  'COMPUTE_TIME_LIMIT_EXCEEDED',
  'CANNOT_RESTORE_BASEROUTE',
];
const NO_ROUTE_CODES = ['NO_ROUTE_FOUND', 'MAP_MATCHING_FAILURE'];

/** The JSON of an answer, or undefined (TomTom sends its key errors as XML). */
export function parseJson(text) {
  if (typeof text !== 'string' || !/^\s*[{[]/.test(text)) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const codeOf = (body) => {
  const code = body?.detailedError?.code ?? body?.error?.code;
  return typeof code === 'string' && KNOWN_CODES.includes(code) ? code : undefined;
};

/** A TomTom answer -> the summary of its first route, or the TomTomError it means. */
export function checkAnswer({ status, text, retryAfterMs }) {
  const body = parseJson(text);
  if (status >= 200 && status < 300) {
    const summary = body?.routes?.[0]?.summary;
    return summary && typeof summary === 'object' && !Array.isArray(summary)
      ? summary
      : new TomTomError('failed', 'unexpected answer');
  }
  // The text of an error page is only matched, never shown.
  const lower = typeof text === 'string' ? text.slice(0, 8192).toLowerCase() : '';
  if (status === 429) {
    return new TomTomError('limited', 'http 429', { retryAfterMs });
  }
  if (status === 401) {
    return new TomTomError('refused', 'http 401');
  }
  if (status === 403) {
    // The key errors come as XML or HTML: "Developer Over Qps" (the requests
    // per second), "Developer Over Rate" / "Over the limit" (the daily
    // quota), "Developer Inactive", "Not Authorized"... (the key).
    if (/qps|per second/.test(lower)) {
      return new TomTomError('limited', 'http 403, requests per second', { retryAfterMs });
    }
    if (/over\s*(the\s*)?(rate|limit|quota)|quota|limit exceeded|rate limit|exceeded/.test(lower)) {
      return new TomTomError('quota', 'http 403, quota', { retryAfterMs });
    }
    return new TomTomError('refused', 'http 403');
  }
  const code = codeOf(body);
  if (status === 400) {
    if (
      NO_ROUTE_CODES.includes(code) ||
      /no route|not connected|near a road|cannot find a route/.test(lower)
    ) {
      return new TomTomError('no_route', code ?? 'http 400');
    }
    return new TomTomError('bad_request', code ?? 'http 400');
  }
  return new TomTomError('failed', code ?? `http ${Number(status) || 0}`);
}

const seconds = (value, max) => {
  const n = typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

/** A route summary -> the values of a trip (seconds and meters), null when absent. */
export function readingOf(summary) {
  const travel = seconds(summary?.travelTimeInSeconds, 30 * 24 * 3600);
  const delay = seconds(summary?.trafficDelayInSeconds, 30 * 24 * 3600);
  return {
    travelTime: travel,
    // No delay field with a travel time: TomTom saw no traffic delay.
    trafficDelay: delay ?? (travel === null ? null : 0),
    length: seconds(summary?.lengthInMeters, 40_000_000),
    noTrafficTime: seconds(summary?.noTrafficTravelTimeInSeconds, 30 * 24 * 3600),
  };
}

/** The request of a trip. The key goes last, and only to api.tomtom.com. */
export function routeUrl(trip, options, apiKey) {
  const url = new URL(`${ROUTE_URL}/${pointText(trip.origin)}:${pointText(trip.destination)}/json`);
  const params = url.searchParams;
  params.set('traffic', 'true');
  params.set('travelMode', options.travelMode === 'truck' ? 'truck' : 'car');
  params.set('routeType', 'fastest');
  params.set('departAt', 'now');
  params.set('computeTravelTimeFor', 'all');
  params.set('routeRepresentation', 'summaryOnly');
  if (options.avoidTolls) {
    params.append('avoid', 'tollRoads');
  }
  if (options.avoidMotorways) {
    params.append('avoid', 'motorways');
  }
  params.set('key', apiKey);
  return url.href;
}

const clamp = (ms, min, max) => Math.min(max, Math.max(min, ms));

/** A truncated SHA-256 of the key: what is persisted, never the key. */
export const keyHash = (apiKey) =>
  apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : '';

const errorOfState = (state) =>
  state === 'refused'
    ? new TomTomError('refused', 'refused before')
    : state === 'quota'
      ? new TomTomError('quota', 'quota reached before')
      : new TomTomError('limited', 'paused before');

export class TomTomClient {
  constructor({ now = Date.now, sleep, storage } = {}) {
    this.now = now;
    this.store = new Store({
      storage,
      now,
      dailyLimit: DAILY_LIMIT,
      limits: { refused: REFUSED_BACKOFF, quota: QUOTA_MAX, limited: LIMITED_MAX },
    });
    this.pace = createPacer(API_MIN_GAP, { now, sleep, last: this.store.lastCallAt });
    /** The key state read from the file, applied by useKey() if the key matches. */
    this.savedKey = { ...this.store.key };
    this.keyEpoch = 0;
    this.currentKeyHash = undefined;
    this.keyError = undefined;
    this.clearKeyState();
  }

  get keyState() {
    return this.store.key.state;
  }

  get keyPausedUntil() {
    return this.store.key.pausedUntil;
  }

  clearKeyState() {
    this.store.key = { hash: this.currentKeyHash ?? '', state: 'ok', pausedUntil: 0, streak: 0 };
    this.keyError = undefined;
  }

  /**
   * The key of the configuration. The same key keeps its state (and, after a
   * restart, gets back the state saved for it); another key starts afresh.
   */
  useKey(apiKey) {
    const hash = keyHash(apiKey);
    if (hash === this.currentKeyHash) {
      return;
    }
    const firstUse = this.currentKeyHash === undefined;
    this.currentKeyHash = hash;
    const saved = this.savedKey;
    this.savedKey = undefined;
    this.keyEpoch += 1;
    this.clearKeyState();
    if (firstUse && saved?.hash && saved.hash === hash && saved.state !== 'ok') {
      // Store already capped the pause read from the file.
      if (this.now() < saved.pausedUntil) {
        this.store.key = { ...saved };
        this.keyError = errorOfState(saved.state);
      }
    }
    this.store.save();
  }

  /** How long the next 429 (or 403 for the quota) pauses the key. */
  pauseFor(err) {
    const key = this.store.key;
    key.streak = Math.min(16, key.streak + 1);
    if (err.kind === 'quota') {
      const untilMidnight = nextUtcMidnight(this.now()) - this.now();
      return clamp(Math.max(err.retryAfterMs ?? 0, untilMidnight), QUOTA_MIN, QUOTA_MAX);
    }
    const fallback = LIMITED_MIN * 2 ** Math.min(8, key.streak - 1);
    return clamp(err.retryAfterMs ?? fallback, LIMITED_MIN, LIMITED_MAX);
  }

  /** Why no call with the key may go now, or undefined. */
  blocked({ force = false } = {}) {
    if (this.now() < this.store.key.pausedUntil) {
      // The test button may try a refused key again; a pause always holds.
      if (!(force && this.store.key.state === 'refused')) {
        return this.keyError ?? errorOfState(this.store.key.state);
      }
    }
    if (!this.store.allows()) {
      return new TomTomError('budget', 'daily quota spent');
    }
    return undefined;
  }

  /** Read a trip now (in the queue of the pacer). Resolves its reading. */
  route(trip, options, { apiKey, manual = false, force = false }) {
    if (this.currentKeyHash === undefined) {
      this.useKey(apiKey);
    }
    const epoch = this.keyEpoch;
    const stale = () => new TomTomError('failed', 'configuration changed');
    return this.pace(async (sent) => {
      // A call queued with a key the configuration no longer holds never goes.
      if (epoch !== this.keyEpoch || keyHash(apiKey) !== this.currentKeyHash) {
        throw stale();
      }
      // Checked when the turn comes, not when queued: a 429 met by the
      // previous call stops this one before the network.
      const blocked = this.blocked({ force });
      if (blocked) {
        throw blocked;
      }
      const url = routeUrl(trip, options, apiKey);
      this.store.recordCall(trip.id, { manual });
      sent();
      const answer = await get(url, { maxBytes: MAX_BODY });
      if (epoch !== this.keyEpoch) {
        throw stale();
      }
      const result = checkAnswer(answer);
      const key = this.store.key;
      if (!(result instanceof TomTomError)) {
        if (key.state !== 'ok' || key.streak !== 0) {
          this.clearKeyState();
          this.store.save();
        }
        return readingOf(result);
      }
      if (result.kind === 'limited' || result.kind === 'quota') {
        key.pausedUntil = this.now() + this.pauseFor(result);
        key.state = result.kind;
        this.keyError = result;
        this.store.save();
      } else if (result.kind === 'refused') {
        key.state = 'refused';
        key.pausedUntil = this.now() + REFUSED_BACKOFF;
        this.keyError = result;
        this.store.save();
      } else if (key.state !== 'ok' || key.streak !== 0) {
        // The key answered (a trip without route...): its pause is over.
        this.clearKeyState();
        this.store.save();
      }
      throw result;
    });
  }
}
