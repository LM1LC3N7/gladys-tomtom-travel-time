// -----------------------------------------------------------------------------
// What must survive a restart, in a JSON file under /data: the request count
// of the UTC day, the instant of the last request, the pause or the refusal
// of the key, and the instant each trip was last read. So a container
// restarting in a loop neither drains the daily quota, nor hammers a refused
// or paused key, nor reads a trip faster than its interval. The key itself is
// never written: only a truncated SHA-256 of it.
//
// The file is read field by field, each one checked: nothing from it is ever
// merged into an object (no prototype pollution), and every instant in the
// future is capped.
// -----------------------------------------------------------------------------

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Returned by a storage whose file exists but cannot be read as JSON. */
export const UNREADABLE = Object.freeze({ unreadable: true });

/** The UTC day of an instant: "2026-10-18". */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The next UTC midnight after `ms`. */
export const nextUtcMidnight = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  return {
    load: () => value,
    save: (next) => {
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

/**
 * A JSON file, written atomically (a .tmp file, then a rename). A missing
 * file is a first start; an unreadable one is reported (once, without its
 * content) as UNREADABLE. A write failure is warned once: memory only then.
 */
export function fileStorage(path, { logger } = {}) {
  const warned = new Set();
  const warnOnce = (kind, text) => {
    if (!warned.has(kind)) {
      warned.add(kind);
      logger?.warn?.(text);
    }
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnOnce('read', `State file unreadable (${err.code ?? 'error'}): prudent defaults`);
          return UNREADABLE;
        }
        return undefined;
      }
      try {
        const value = JSON.parse(text.slice(0, 1024 * 1024));
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return value;
        }
      } catch {
        // Fall through: a corrupt file.
      }
      warnOnce('read', 'State file corrupt: prudent defaults');
      return UNREADABLE;
    },
    save(value) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
        return true;
      } catch (err) {
        warnOnce('write', `State file not writable (${err.code ?? 'error'}): kept in memory`);
        return false;
      }
    },
  };
}

const own = (object, key) =>
  object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
    ? object[key]
    : undefined;

const instant = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

const KEY_STATES = ['ok', 'refused', 'quota', 'limited'];

/**
 * The persisted state. `limits` caps every pause read back from the file:
 * `{ refused, quota, limited }` in ms from now.
 */
export class Store {
  constructor({ storage = memoryStorage(), now = Date.now, dailyLimit, limits }) {
    this.storage = storage;
    this.now = now;
    const at = now();
    const saved = storage.load();
    const unreadable = saved === UNREADABLE || own(saved, 'unreadable') === true;
    const data = unreadable || !saved || typeof saved !== 'object' ? {} : saved;

    const day = own(data, 'day');
    const count = own(data, 'count');
    this.day = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dayOf(at);
    this.count = Number.isInteger(count) && count >= 0 ? Math.min(count, dailyLimit) : 0;
    const manual = own(data, 'manual');
    this.manual = Number.isInteger(manual) && manual >= 0 ? Math.min(manual, dailyLimit) : 0;
    if (unreadable) {
      // Prudent: a file we cannot read may have held a busy day, a pause.
      this.count = Math.floor(dailyLimit / 2);
      this.manual = Math.floor(dailyLimit / 2);
    }
    /** False once a save failed: the state then lives in memory only. */
    this.writable = true;
    // An instant in the future (a clock set back, a bad file) counts as now.
    this.lastCallAt = Math.min(instant(own(data, 'lastCallAt')), at);

    const key = own(data, 'key');
    const keyState = own(key, 'state');
    const hash = own(key, 'hash');
    const state = KEY_STATES.includes(keyState) ? keyState : 'ok';
    const longest = limits?.[state] ?? 0;
    this.key = {
      hash: typeof hash === 'string' && /^[0-9a-f]{16}$/.test(hash) ? hash : '',
      state,
      pausedUntil: Math.min(instant(own(key, 'pausedUntil')), at + longest),
      streak: Math.min(Math.max(0, Number(own(key, 'streak')) | 0), 16),
    };
    if (this.key.state !== 'ok' && this.key.pausedUntil <= at) {
      this.key.state = 'ok';
      this.key.pausedUntil = 0;
    }

    /** trip id -> { lastAttemptAt, lastManualAt } */
    this.trips = new Map();
    const trips = own(data, 'trips');
    if (trips && typeof trips === 'object' && !Array.isArray(trips)) {
      for (const [id, entry] of Object.entries(trips).slice(0, 100)) {
        if (/^[a-z0-9-]{1,40}$/.test(id)) {
          this.trips.set(id, {
            lastAttemptAt: Math.min(instant(own(entry, 'lastAttemptAt')), at),
            lastManualAt: Math.min(instant(own(entry, 'lastManualAt')), at),
          });
        }
      }
    }
    this.dailyLimit = dailyLimit;
  }

  roll() {
    const today = dayOf(this.now());
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
      this.manual = 0;
    }
  }

  /** Manual requests (scenes, test button) made today (UTC). */
  manualUsed() {
    this.roll();
    return this.manual;
  }

  /** Requests made today (UTC). */
  used() {
    this.roll();
    return this.count;
  }

  /** Room for one more request today. */
  allows() {
    return this.used() < this.dailyLimit;
  }

  /** The next UTC midnight: when the count starts again. */
  resetsAt() {
    return nextUtcMidnight(this.now());
  }

  trip(id) {
    let entry = this.trips.get(id);
    if (!entry) {
      entry = { lastAttemptAt: 0, lastManualAt: 0 };
      this.trips.set(id, entry);
    }
    return entry;
  }

  /** A request leaves now, for `tripId`. */
  recordCall(tripId, { manual = false } = {}) {
    this.roll();
    const at = this.now();
    this.count += 1;
    this.lastCallAt = at;
    if (tripId) {
      const entry = this.trip(tripId);
      entry.lastAttemptAt = at;
      if (manual) {
        entry.lastManualAt = at;
      }
    }
    if (manual) {
      this.manual += 1;
    }
    this.save();
  }

  save() {
    // The trips of a former configuration are kept (a trip removed then put
    // back must not be read sooner), the most recent 100 at most.
    if (this.trips.size > 100) {
      const recent = [...this.trips].sort((a, b) => b[1].lastAttemptAt - a[1].lastAttemptAt);
      this.trips = new Map(recent.slice(0, 100));
    }
    const saved = this.storage.save({
      day: this.day,
      count: this.count,
      manual: this.manual,
      lastCallAt: this.lastCallAt,
      key: { ...this.key },
      trips: Object.fromEntries(
        [...this.trips].map(([id, e]) => [
          id,
          { lastAttemptAt: e.lastAttemptAt, lastManualAt: e.lastManualAt },
        ]),
      ),
    });
    this.writable = saved !== false;
  }
}
