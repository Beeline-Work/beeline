/** Postgres reports a deadlock victim with SQLSTATE 40P01. */
export function isDeadlock(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '40P01';
}

/**
 * The release migration runs against live traffic, so a schema statement can
 * lose a lock race and be chosen as a deadlock victim. Every step is
 * idempotent, so the safe response is to run the whole migration again after a
 * short backoff rather than fail the release.
 */
export async function retryOnDeadlock(
  run: () => Promise<void>,
  options: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? 6;
  const delayMs =
    options.delayMs ?? ((attempt) => 2_000 * attempt + Math.floor(Math.random() * 1_000));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      if (!isDeadlock(error) || attempt >= attempts) throw error;
      const wait = delayMs(attempt);
      console.warn(`[migration] deadlock on attempt ${attempt}/${attempts}; retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}
