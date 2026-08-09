import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('production iOS capabilities', () => {
  it('does not declare push or Associated Domains before they are implemented', () => {
    const projectRoot = new URL('../..', import.meta.url).pathname;
    const output = execFileSync(
      'npx',
      ['expo', 'config', '--type', 'introspect', '--json'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, APP_ENV: 'production' },
      },
    );
    const config = JSON.parse(output) as {
      ios?: { associatedDomains?: string[] };
      _internal?: {
        modResults?: {
          ios?: {
            entitlements?: Record<string, unknown>;
            infoPlist?: { UIBackgroundModes?: string[] };
          };
        };
      };
    };
    const nativeIos = config._internal?.modResults?.ios;

    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(nativeIos?.entitlements).not.toHaveProperty('aps-environment');
    expect(nativeIos?.entitlements).not.toHaveProperty(
      'com.apple.developer.associated-domains',
    );
    expect(nativeIos?.infoPlist?.UIBackgroundModes).not.toContain(
      'remote-notification',
    );
  }, 15_000);
});
