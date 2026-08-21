import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('production iOS capabilities', () => {
  it('declares the relay invite domain without enabling push', () => {
    const projectRoot = new URL('../..', import.meta.url).pathname;
    const { NODE_ENV: _nodeEnv, VITEST: _vitest, ...cliEnv } = process.env;
    const output = execFileSync(
      process.execPath,
      [
        resolve(projectRoot, 'node_modules/expo/bin/cli'),
        'config',
        '--type',
        'introspect',
        '--json',
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...cliEnv, APP_ENV: 'production' },
      },
    );
    const config = JSON.parse(output) as {
      extra?: { app?: { buzzyRelayUrl?: string; buzzyPushGatewayUrl?: string } };
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
    const relayAssociation = JSON.parse(
      readFileSync(
        new URL(
          '../../../../relay-stack/web/.well-known/apple-app-site-association',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { applinks?: { details?: Array<{ paths?: string[] }> } };

    expect(config.extra?.app?.buzzyRelayUrl).toBe('https://usebeeline.app');
    expect(config.extra?.app?.buzzyPushGatewayUrl).toBe('https://push.buzzrouter.com');
    expect(config.ios?.associatedDomains).toEqual([
      'applinks:usebeeline.app',
      'applinks:relay.buzzrouter.com',
    ]);
    expect(config.android?.package).toBe('app.buzzy.mobile');
    expect(config.android?.intentFilters).toContainEqual(
      expect.objectContaining({
        action: 'VIEW',
        autoVerify: true,
        data: expect.arrayContaining([
          {
            scheme: 'https',
            host: 'usebeeline.app',
            pathPrefix: '/join/',
          },
          {
            scheme: 'https',
            host: 'usebeeline.app',
            pathPrefix: '/auth/github/mobile-callback',
          },
          {
            scheme: 'https',
            host: 'relay.buzzrouter.com',
            pathPrefix: '/join/',
          },
          {
            scheme: 'https',
            host: 'relay.buzzrouter.com',
            pathPrefix: '/auth/github/mobile-callback',
          },
        ]),
      }),
    );
    expect(nativeIos?.entitlements).not.toHaveProperty('aps-environment');
    expect(nativeIos?.entitlements?.['com.apple.developer.associated-domains']).toEqual([
      'applinks:usebeeline.app',
      'applinks:relay.buzzrouter.com',
    ]);
    expect(nativeIos?.infoPlist?.UIBackgroundModes).not.toContain('remote-notification');
    expect(relayAssociation.applinks?.details?.[0]?.paths).toEqual(
      expect.arrayContaining([
        '/join/*',
        '/auth/github/mobile-callback',
        // The auth service keeps this recovery-compatible server endpoint even
        // though the mobile app no longer registers or routes it.
        '/auth/oidc/mobile-callback',
      ]),
    );
  }, 15_000);
});
