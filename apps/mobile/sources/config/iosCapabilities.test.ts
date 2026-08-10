import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('production iOS capabilities', () => {
  it('declares the relay invite domain without enabling push', () => {
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
      android?: {
        package?: string;
        intentFilters?: Array<{
          action?: string;
          autoVerify?: boolean;
          data?: Array<{ scheme?: string; host?: string; pathPrefix?: string }>;
        }>;
      };
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

    expect(config.ios?.associatedDomains).toEqual([
      'applinks:relay.buzzrouter.com',
    ]);
    expect(config.android?.package).toBe('app.buzzy.mobile');
    expect(config.android?.intentFilters).toContainEqual(
      expect.objectContaining({
        action: 'VIEW',
        autoVerify: true,
        data: [
          {
            scheme: 'https',
            host: 'relay.buzzrouter.com',
            pathPrefix: '/join/',
          },
        ],
      }),
    );
    expect(nativeIos?.entitlements).not.toHaveProperty('aps-environment');
    expect(nativeIos?.entitlements?.['com.apple.developer.associated-domains']).toEqual([
      'applinks:relay.buzzrouter.com',
    ]);
    expect(nativeIos?.infoPlist?.UIBackgroundModes).not.toContain(
      'remote-notification',
    );
  }, 15_000);
});
