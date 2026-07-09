/**
 * Serialized request queue with a minimum spacing between task starts — the
 * same politeness pattern the Semantic Scholar and arXiv clients use, shared
 * so each metadata service can keep its own budget without bursting when
 * several hovers resolve at once.
 */
export function createThrottledQueue(minIntervalMs: number): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  let nextAllowedAt = 0;

  return function run<T>(task: () => Promise<T>): Promise<T> {
    const slot = tail.then(async () => {
      const wait = nextAllowedAt - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      nextAllowedAt = Date.now() + minIntervalMs;
      return task();
    });
    tail = slot.then(
      () => undefined,
      () => undefined,
    );
    return slot;
  };
}
