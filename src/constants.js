// -----------------------------------------------------------------------------
// Endpoints, quotas, pacing and the keys users store (manifest keys, device
// type, feature keys, scene keys): the keys are forever, never rename them.
// -----------------------------------------------------------------------------

/** The official TomTom Routing API v1, Calculate Route (global endpoint). */
export const ROUTE_URL = 'https://api.tomtom.com/routing/1/calculateRoute';

export const USER_AGENT =
  'gladys-tomtom-travel-time (+https://github.com/LM1LC3N7/gladys-tomtom-travel-time)';

/** One HTTP call. */
export const HTTP_TIMEOUT = 20_000;

/**
 * The most an answer may weigh. With `routeRepresentation=summaryOnly` a
 * route answer is about 1 KB; an error page (XML or HTML) a few KB.
 */
export const MAX_BODY = 64 * 1024;

/**
 * The free plan: 2,500 non-tile requests a day. Every call of the integration
 * (periodic reads, scene refreshes, test button) is counted against it, per
 * UTC day, and none goes past it.
 */
export const DAILY_LIMIT = 2500;

/** At most this many trips (each one costs requests). */
export const MAX_TRIPS = 20;

/** The read interval of each trip (minutes): 10 by default, 5 at least. */
export const DEFAULT_INTERVAL = 10;
export const MIN_INTERVAL = 5;
export const MAX_INTERVAL = 240;

/** Never two calls closer than this (the free plan allows a few per second). */
export const API_MIN_GAP = 1_000;

/** How often the integration checks what is due. */
export const TICK = 60_000;

/**
 * A refresh asked by a scene (or the test button) never reads the same trip
 * twice within this: a scene in a loop cannot drain the daily quota.
 */
export const MANUAL_MIN_GAP = 2 * 60_000;

/**
 * At most this many manual reads (scenes, test button) per UTC day, and never
 * more than what the planned reads leave of the daily quota.
 */
export const MANUAL_DAILY_MAX = 100;

/** A 429 (or a 403 for the requests per second): between 1 minute and 6 hours. */
export const LIMITED_MIN = 60_000;
export const LIMITED_MAX = 6 * 60 * 60_000;

/** A 403 for the daily quota: until the next UTC midnight, between 1 and 24 hours. */
export const QUOTA_MIN = 60 * 60_000;
export const QUOTA_MAX = 24 * 60 * 60_000;

/** A refused key: no call with it for 6 hours (or until the key changes). */
export const REFUSED_BACKOFF = 6 * 60 * 60_000;

/** No route between the points, or a request TomTom calls invalid: retried after this. */
export const TRIP_ERROR_RETRY = 60 * 60_000;

/** A reading older than this is not sent to a device just created. */
export const STALE = 60 * 60_000;

/** An unchanged value is re-sent this often (only after a read), so Gladys keeps it recent. */
export const HEARTBEAT = 30 * 60_000;

/** The test button answers within this. */
export const TEST_DEADLINE = 100_000;

/** The file under /data (the one writable volume) that survives a restart. */
export const STATE_FILE = '/data/tomtom-state.json';

/** Device type of the external ids (`ext:<selector>:trip:<slug of the name>`). */
export const DEVICE_TYPE = 'trip';

/** Feature keys (part of the external ids). */
export const FEATURES = {
  TRAVEL_TIME: 'travel_time',
  TRAFFIC_DELAY: 'traffic_delay',
  DISTANCE: 'distance',
  NO_TRAFFIC_TIME: 'no_traffic_time',
};

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** Manifest `scene_actions` keys. */
export const SCENE_ACTIONS = {
  REFRESH: 'refresh_trip',
};
