import type { PhoneContext } from './context.js';
import { OPTIONAL_ENRICHMENT_DEADLINE_MS, ENRICHMENT_LOG_INTERVAL_MS } from './values.js';



  export async function phoneOptionalEnrichment<T>(ctx: PhoneContext, name: string, work: Promise<T>): Promise<T | undefined> {

    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`optional ${name} enrichment timed out`)),
            OPTIONAL_ENRICHMENT_DEADLINE_MS,
          );
          deadline.unref?.();
        }),
      ]);
    } catch (error) {
      const now = Date.now();
      if (now - (ctx.lastEnrichmentLogAt.get(name) ?? 0) >= ENRICHMENT_LOG_INTERVAL_MS) {
        ctx.lastEnrichmentLogAt.set(name, now);
        console.warn(
          '[room-enrichment-degraded]',
          JSON.stringify({
            enrichment: name,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return undefined;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
