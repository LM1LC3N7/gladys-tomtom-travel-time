// -----------------------------------------------------------------------------
// One call at a time, at least `gap` milliseconds apart: periodic reads, scene
// refreshes and the test button all go through the same pacer, so they never
// burst together.
// -----------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPacer(gap, { now = Date.now, sleep = defaultSleep, last: initial } = {}) {
  let tail = Promise.resolve();
  // The last call before a restart, so the spacing holds across it.
  let last = Number.isFinite(initial) && initial > 0 ? Math.min(initial, now()) : -Infinity;
  return function pace(task) {
    const run = tail.then(async () => {
      const wait = last + gap - now();
      if (wait > 0) {
        await sleep(wait);
      }
      let sent = false;
      try {
        return await task(() => {
          sent = true;
        });
      } finally {
        // Only a request really sent counts for the spacing: a call stopped
        // before the network (paused, quota) lets the next one go at once.
        if (sent) {
          last = now();
        }
      }
    });
    // The next call waits for this one, whatever its outcome.
    tail = run.catch(() => {});
    return run;
  };
}
