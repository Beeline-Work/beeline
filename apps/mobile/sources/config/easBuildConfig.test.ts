import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('EAS build hooks', () => {
  it('builds local package dependencies in dependency order', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const hook = packageJson.scripts?.['eas-build-post-install'] ?? '';

    const nostrBuild = hook.indexOf('tsconfig.eas-nostr.json');
    const clientBuild = hook.indexOf('tsconfig.eas-buzz-client.json');
    expect(nostrBuild).toBeGreaterThanOrEqual(0);
    expect(clientBuild).toBeGreaterThan(nostrBuild);
  });
});
