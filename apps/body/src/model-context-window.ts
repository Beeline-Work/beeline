import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Pi's isolated model catalog is the model profile actually used by the Room. */
export async function modelContextWindowTokens(
  model: string | undefined,
  piHome: string | undefined,
): Promise<number | undefined> {
  if (!model || !piHome) return undefined;
  try {
    const catalog = JSON.parse(await readFile(join(piHome, 'models.json'), 'utf8')) as {
      providers?: Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }>;
    };
    const parts = model.split('/');
    const preferredProvider = parts.length > 2 ? parts.shift() : undefined;
    const modelId = parts.join('/');
    const providers = preferredProvider
      ? [catalog.providers?.[preferredProvider]].filter(Boolean)
      : Object.values(catalog.providers ?? {});
    for (const provider of providers) {
      const window = provider?.models?.find((entry) => entry.id === modelId)?.contextWindow;
      if (window && Number.isFinite(window) && window > 0) return Math.floor(window);
    }
  } catch {
    // Other harnesses and built-in models have no local Pi catalog.
  }
  return undefined;
}
