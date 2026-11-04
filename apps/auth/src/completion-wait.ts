/** One correlated auth ceremony: subscribe before inspecting the committed
 * ticket, then inspect only on actual notifications. Deadline terminates; no
 * failed read/timer may start another observation. */
export function waitForAuthTicket<T>(subscribe: (wake: () => void) => () => void,
  read: () => Promise<T | null>, waitMs: number, signal?: AbortSignal): Promise<T | null> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let closed = false, reading = false, dirty = false;
    let release: (() => void) | undefined;
    const finish = (value: T | null, error?: unknown) => {
      if (closed) return; closed = true; clearTimeout(timer); release?.();
      signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error); else resolve(value);
    };
    const abort = () => finish(null, signal?.reason ?? new Error('Auth request closed'));
    const timer = setTimeout(() => finish(null), waitMs); timer.unref?.();
    const inspect = async () => {
      dirty = true; if (reading || closed) return; reading = true;
      try {
        do { dirty = false; const value = await read(); if (value) { finish(value); return; } }
        while (dirty && !closed);
      } catch (error) { finish(null, error); } finally { reading = false; }
    };
    try { release = subscribe(() => { void inspect(); }); }
    catch (error) { finish(null, error); return; }
    if (closed) { release(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    void inspect();
  });
}
