import type { PhoneContext } from './context.js';
import { ENRICHMENT_LOG_INTERVAL_MS } from './values.js';



  export async function phoneOptionalEnrichment<T>(ctx: PhoneContext, name: string, work: Promise<T>): Promise<T | undefined> {

    try {
      return await work;
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
    }
  }
