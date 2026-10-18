// -----------------------------------------------------------------------------
// Fakes for the tests: fetch (routes requests to handlers, records every call,
// fails loudly on an unexpected URL) and timers (nothing fires by itself). No
// test touches the network nor the disk.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { setFetch } from '../../src/http.js';

setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** A key or quota error of TomTom: XML, not the JSON error format. */
export const xml = (text, status = 403, headers = {}) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><h1>${text}</h1>`, {
    status,
    headers: { 'content-type': 'text/xml', ...headers },
  });

/** The documented JSON error format. */
export const detailed = (code, message, status = 400) =>
  json({ formatVersion: '0.0.12', detailedError: { code, message } }, status);

/** 2026-10-18 06:30 UTC (08:30 in Paris). */
export const NOW = Date.parse('2026-10-18T06:30:00Z');

/** Install a fake fetch; `routes` is a list of [RegExp, handler({ url, params })]. */
export function installFetch(routes) {
  const calls = [];
  const previous = setFetch(async (url, init = {}) => {
    const parsed = new URL(url);
    const params = {};
    for (const [name, value] of parsed.searchParams) {
      params[name] = name in params ? [].concat(params[name], value) : value;
    }
    const call = { url, path: parsed.pathname, params, init };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) {
      throw new Error(`Unexpected network call in a test: ${url}`);
    }
    return route[1](call);
  });
  return { calls, restore: () => setFetch(previous) };
}

export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const add = (kind, fn, ms) => {
    const id = nextId++;
    pending.set(id, { id, kind, fn, ms });
    return id;
  };
  return {
    pending,
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    intervals: () => [...pending.values()].filter((t) => t.kind === 'interval'),
    async runIntervals() {
      for (const t of [...pending.values()].filter((t) => t.kind === 'interval')) {
        await t.fn();
      }
    },
  };
}

/** A logger that records what it is given. */
export function recordingLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map((a) => String(a?.stack ?? a)).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}
