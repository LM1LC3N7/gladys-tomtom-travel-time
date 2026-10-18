// -----------------------------------------------------------------------------
// The only place that talks HTTP: `fetch` with a timeout, a User-Agent that
// names the integration, no redirection followed and a bounded body. The
// tests replace it with `setFetch()`.
//
// TomTom wants the API key in the query string. Node puts the URL in some of
// its errors (an invalid URL, for one): no error built here ever carries more
// than the HOST of the URL, and the error of fetch itself never leaves this
// file, so the key reaches neither a log nor a status.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, USER_AGENT } from './constants.js';

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the fetch implementation (tests only). Returns the previous one. */
export function setFetch(impl) {
  const previous = fetchImpl;
  fetchImpl = impl;
  return previous;
}

/** Retry-After: seconds, or an HTTP date. */
export function retryAfterMs(header, now = Date.now()) {
  if (header === null || header === undefined || header === '') {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return 'an invalid address';
  }
};

/** The network failed (DNS, timeout, a body too large...): the host only. */
export class NetworkError extends Error {
  constructor(url, reason) {
    super(`network ${reason} on ${hostOf(url)}`);
    this.name = 'NetworkError';
  }
}

/** A short code for why fetch failed: never its message (it may hold the URL). */
const reasonOf = (err) => {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return 'timeout';
  }
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'failed';
};

/** Read at most `maxBytes` of the body; past it, the read stops and fails. */
async function readBounded(response, url, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new NetworkError(url, 'answer too large');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new NetworkError(url, 'answer too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * GET a document. Never throws on an HTTP status: resolves
 * `{ status, text, contentType, retryAfterMs }`. Throws a NetworkError when the
 * request or the body read fails, or on a redirection (never followed: the
 * key would go along).
 */
export async function get(url, { timeout = HTTP_TIMEOUT, maxBytes = Infinity } = {}) {
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, timeout)),
    });
    text = await readBounded(response, url, maxBytes);
  } catch (err) {
    throw err instanceof NetworkError ? err : new NetworkError(url, reasonOf(err));
  }
  return {
    status: Number(response.status) || 0,
    text,
    contentType: String(response.headers?.get?.('content-type') ?? '').toLowerCase(),
    retryAfterMs: retryAfterMs(response.headers?.get?.('retry-after')),
  };
}
