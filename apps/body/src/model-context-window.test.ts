import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelContextWindowTokens } from './model-context-window.js';

describe('model context window', () => {
  it('reads the selected Pi model profile', async () => {
    const home = await mkdtemp(join(tmpdir(), 'beeline-model-window-'));
    try {
      await writeFile(
        join(home, 'models.json'),
        JSON.stringify({
          providers: { openrouter: { models: [{ id: 'vendor/small', contextWindow: 16_000 }] } },
        }),
      );
      expect(await modelContextWindowTokens('openrouter/vendor/small', home)).toBe(16_000);
      expect(await modelContextWindowTokens('vendor/small', home)).toBe(16_000);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
