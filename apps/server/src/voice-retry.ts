/** Only known transport/database failures are retryable, never arbitrary operations. */
export async function retryVoice<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await work(); } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } })?.code ??
        (error as { cause?: { code?: string } })?.cause?.code;
      const transient = !!code && /^(08|40|53|57P0|unavailable|deadline_exceeded|ECONN|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(code) ||
        error instanceof Error && /^(Connection terminated (unexpectedly|due to connection timeout)|Connection ended unexpectedly)$/.test(error.message);
      if (attempt === 2 || !transient) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); },
          [250, 1000][attempt]! * (0.8 + Math.random() * 0.4));
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
}
