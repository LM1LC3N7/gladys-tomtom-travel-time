// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`, and the
// number of requests a day it plans.
// -----------------------------------------------------------------------------

import {
  DAILY_LIMIT,
  DEFAULT_INTERVAL,
  MAX_INTERVAL,
  MAX_TRIPS,
  MIN_INTERVAL,
} from './constants.js';

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  trips: '',
  poll_interval: DEFAULT_INTERVAL,
  travel_mode: 'car',
  avoid_tolls: false,
  avoid_motorways: false,
  active_from: 0,
  active_until: 24,
  timezone: 'Europe/Paris',
};

export const TRAVEL_MODES = ['car', 'truck'];

const number = (value, fallback, min, max) => {
  const n = Number(value);
  return value !== '' && value !== null && value !== undefined && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

const flag = (value, fallback) =>
  value === undefined || value === null || value === ''
    ? fallback
    : value === true || value === 'true';

const clean = (value) =>
  (typeof value === 'string' || typeof value === 'number' ? String(value) : '').trim();

/** Printable characters only, trimmed and cut. */
export const printable = (value, max) =>
  [...clean(value)]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, max);

/** "Saint-Étienne" -> "saint-etienne": a stable id piece, ASCII only. */
export function slug(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * "48.8566,2.3522" (a space after the comma is fine) -> { lat, lon }, or
 * undefined. Decimal point only: "48,85, 2,35" would be ambiguous.
 */
export function parsePoint(text) {
  const match = /^\s*(-?\d{1,3}(?:\.\d{1,10})?)\s*,\s*(-?\d{1,3}(?:\.\d{1,10})?)\s*$/.exec(
    clean(text),
  );
  if (!match) {
    return undefined;
  }
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
    return undefined;
  }
  return { lat, lon };
}

/** A point as it travels to TomTom: 5 decimals, about one meter. */
export const pointText = ({ lat, lon }) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/**
 * "Work | 48.8566,2.3522 | 48.8920,2.2370; School | ..." -> the trips. One
 * trip per entry, separated by ";" or a line break; each entry is a name, an
 * origin and a destination separated by "|". The id of a trip is the slug of
 * its name (its device keeps it as long as the name stays).
 */
export function parseTrips(text) {
  const trips = [];
  const invalid = [];
  let dropped = 0;
  const seen = new Set();
  for (const entry of clean(text).split(/[;\n\r]+/)) {
    const value = entry.trim();
    if (!value) {
      continue;
    }
    const parts = value.split('|').map((p) => p.trim());
    const name = printable(parts[0], 60);
    const id = slug(name);
    const origin = parsePoint(parts[1]);
    const destination = parsePoint(parts[2]);
    if (
      parts.length !== 3 ||
      !id ||
      !origin ||
      !destination ||
      (origin.lat === destination.lat && origin.lon === destination.lon)
    ) {
      // Only the name is shown back (never the coordinates of a home).
      invalid.push(name || '?');
      continue;
    }
    if (seen.has(id)) {
      invalid.push(name);
      continue;
    }
    if (trips.length >= MAX_TRIPS) {
      dropped += 1;
      continue;
    }
    seen.add(id);
    trips.push({ id, name, origin, destination });
  }
  return { trips, invalid, dropped };
}

/** An IANA time zone Node knows, or undefined. */
export function validTimezone(value) {
  const zone = clean(value);
  if (!zone || zone.length > 64) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** The minutes a day the trips are read: the whole day, or the reading window. */
export function windowMinutes({ activeFrom, activeUntil }) {
  const hours = (activeUntil - activeFrom + 24) % 24;
  return (hours === 0 ? 24 : hours) * 60;
}

/** Whether the reading window covers the whole day. */
export const allDay = (config) => windowMinutes(config) === 24 * 60;

/**
 * The requests a day the configuration plans: each trip read every
 * `interval` minutes while the window is open (`ceil(window / interval)`
 * reads, the first one at the opening).
 */
export function plannedRequests(config) {
  return config.trips.length * Math.ceil(windowMinutes(config) / config.intervalMinutes);
}

export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const { trips, invalid, dropped } = parseTrips(source.trips ?? DEFAULT_CONFIG.trips);
  const zone = validTimezone(source.timezone ?? DEFAULT_CONFIG.timezone);
  const mode = clean(source.travel_mode);
  const config = {
    apiKey: clean(source.api_key),
    trips,
    invalidTrips: invalid,
    droppedTrips: dropped,
    intervalMinutes: number(
      source.poll_interval,
      DEFAULT_CONFIG.poll_interval,
      MIN_INTERVAL,
      MAX_INTERVAL,
    ),
    travelMode: TRAVEL_MODES.includes(mode) ? mode : DEFAULT_CONFIG.travel_mode,
    avoidTolls: flag(source.avoid_tolls, DEFAULT_CONFIG.avoid_tolls),
    avoidMotorways: flag(source.avoid_motorways, DEFAULT_CONFIG.avoid_motorways),
    activeFrom: number(source.active_from, DEFAULT_CONFIG.active_from, 0, 23),
    activeUntil: number(source.active_until, DEFAULT_CONFIG.active_until, 1, 24),
    timezone: zone ?? DEFAULT_CONFIG.timezone,
    invalidTimezone: zone === undefined,
  };
  config.planned = plannedRequests(config);
  config.overQuota = config.planned > DAILY_LIMIT;
  return config;
}

/** The local hour and minute of an instant in a time zone. */
export function localTime(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: get('hour') % 24, minute: get('minute') };
}

/** Whether the reading window is open at `ms` (local time of the configuration). */
export function inWindow(config, ms) {
  if (allDay(config)) {
    return true;
  }
  const { hour } = localTime(ms, config.timezone);
  const { activeFrom: from, activeUntil: until } = config;
  const end = until % 24;
  return from < end ? hour >= from && hour < end : hour >= from || hour < end;
}
