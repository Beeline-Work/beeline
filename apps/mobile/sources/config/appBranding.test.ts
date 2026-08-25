import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { assertIosDisplayVersion } = require('../../scripts/check-release-version.cjs') as {
  assertIosDisplayVersion(version: string): void;
};

function loadNativeIdentity(appEnv?: string): {
  scheme: string;
  iosBundleIdentifier: string;
  androidPackage: string;
} {
  const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "import configModule from './app.config.js'; const config = configModule.default ?? configModule; process.stdout.write(JSON.stringify({ scheme: config.expo.scheme, iosBundleIdentifier: config.expo.ios.bundleIdentifier, androidPackage: config.expo.android.package }));",
    ],
    {
      cwd: mobileRoot,
      encoding: 'utf8',
      env: { ...process.env, ...(appEnv ? { APP_ENV: appEnv } : {}) },
    },
  );
  return JSON.parse(output) as {
    scheme: string;
    iosBundleIdentifier: string;
    androidPackage: string;
  };
}

function loadNativeVersion(): string {
  const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "import configModule from './app.config.js'; const config = configModule.default ?? configModule; process.stdout.write(config.expo.version);",
    ],
    { cwd: mobileRoot, encoding: 'utf8', env: process.env },
  );
  return output;
}

function loadUpdatesChannel(updatesChannel?: string): string {
  const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));
  return execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "import configModule from './app.config.js'; const config = configModule.default ?? configModule; process.stdout.write(config.expo.updates.requestHeaders['expo-channel-name']);",
    ],
    {
      cwd: mobileRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(updatesChannel ? { EXPO_UPDATES_CHANNEL: updatesChannel } : {}),
      },
    },
  );
}

function loadGoogleServicesFile(appEnv?: string): string | undefined {
  const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "import configModule from './app.config.js'; const config = configModule.default ?? configModule; process.stdout.write(config.expo.android.googleServicesFile ?? '');",
    ],
    {
      cwd: mobileRoot,
      encoding: 'utf8',
      env: { ...process.env, ...(appEnv ? { APP_ENV: appEnv } : {}) },
    },
  );
  return output || undefined;
}

type EasBuildProfile = {
  extends?: string;
  channel?: string;
  android?: { buildType?: string };
  ios?: { credentialsSource?: 'local' | 'remote' };
  [key: string]: unknown;
};

type IosSubmissionConfig = {
  ascAppId: string;
  appName: string;
  bundleIdentifier: string;
};

/**
 * App Store Connect app IDs cannot change bundle identifiers. Keep this small
 * registry beside the submission config so a stale record is caught before EAS
 * uploads an archive to the wrong listing.
 */
const APP_STORE_CONNECT_BUNDLE_IDENTIFIERS: Record<string, string> = {
  '6803948500': 'app.usebeeline.mobile',
  '6799574618': 'app.buzzy.mobile',
};

function assertSubmissionMatchesAppStoreConnect(submission: IosSubmissionConfig): void {
  expect(APP_STORE_CONNECT_BUNDLE_IDENTIFIERS[submission.ascAppId]).toBe(
    submission.bundleIdentifier,
  );
}

function resolveEasBuildProfile(
  profiles: Record<string, EasBuildProfile>,
  name: string,
): EasBuildProfile {
  const profile = profiles[name];
  if (!profile) throw new Error(`Missing EAS build profile: ${name}`);
  if (!profile.extends) return profile;

  const parent = resolveEasBuildProfile(profiles, profile.extends);
  return {
    ...parent,
    ...profile,
    android: { ...parent.android, ...profile.android },
  };
}

describe('Beeline display branding', () => {
  const appConfig = readFileSync(new URL('../../app.config.js', import.meta.url), 'utf8');
  const easConfig = readFileSync(new URL('../../eas.json', import.meta.url), 'utf8');
  const channelsScreen = readFileSync(
    new URL('../app/(app)/buzz/channels.tsx', import.meta.url),
    'utf8',
  );
  const inviteScreen = readFileSync(
    new URL('../app/(app)/join/[token].tsx', import.meta.url),
    'utf8',
  );

  it('uses Beeline for launcher names and the Face ID permission', () => {
    expect(loadNativeIdentity()).toMatchObject({
      scheme: 'beeline',
      iosBundleIdentifier: 'app.usebeeline.mobile',
      androidPackage: 'app.usebeeline.mobile',
    });
    expect(appConfig).toContain('const name = "Beeline"');
    expect(appConfig).toContain('faceIDPermission: "Allow Beeline to verify');
    expect(channelsScreen).toContain('{WORKSPACE_LABEL}');
    expect(channelsScreen).not.toContain("'beeline home'");
    expect(channelsScreen).not.toContain("'buzzy home'");
    expect(inviteScreen).toContain('Return to Beeline');
    expect(inviteScreen).not.toMatch(/Return to buzzy/i);
  });

  it('uses an iOS-valid display version and rejects retired variant suffixes before builds', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(packageJson.version).toBe('0.2.18');
    expect(loadNativeVersion()).toBe(packageJson.version);
    expect(() => assertIosDisplayVersion(packageJson.version)).not.toThrow();
    expect(() => assertIosDisplayVersion('0.2.18-preview.1')).toThrow(
      'must use an iOS display version',
    );
  });

  it('submits the Beeline bundle to its matching App Store Connect record', () => {
    const iosSubmission = (
      JSON.parse(easConfig) as { submit: { production: { ios: IosSubmissionConfig } } }
    ).submit.production.ios;

    expect(iosSubmission).toMatchObject({
      ascAppId: '6803948500',
      appName: 'Beeline - team workspaces',
      bundleIdentifier: 'app.usebeeline.mobile',
    });
    assertSubmissionMatchesAppStoreConnect(iosSubmission);
  });

  it('rejects the former Buzzy App Store Connect record for the Beeline bundle', () => {
    expect(() =>
      assertSubmissionMatchesAppStoreConnect({
        ascAppId: '6799574618',
        appName: 'Beeline - team workspaces',
        bundleIdentifier: 'app.usebeeline.mobile',
      }),
    ).toThrow();
  });

  it('uses local signing credentials for iOS only', () => {
    const easBuildProfiles = JSON.parse(easConfig).build as Record<string, EasBuildProfile>;
    const production = resolveEasBuildProfile(easBuildProfiles, 'production');
    const productionApk = resolveEasBuildProfile(easBuildProfiles, 'production-apk');

    expect(easBuildProfiles.production).not.toHaveProperty('credentialsSource');
    expect(production.ios).toEqual({ credentialsSource: 'local' });
    expect(productionApk.ios).toEqual({ credentialsSource: 'local' });
    expect(production.android).toBeUndefined();
    expect(productionApk.android).toEqual({ buildType: 'apk' });
  });

  it('produces one native identity regardless of local APP_ENV', () => {
    const identities = [undefined, 'development', 'preview', 'production'].map(loadNativeIdentity);

    expect(new Set(identities.map((identity) => JSON.stringify(identity)))).toHaveLength(1);
    expect(identities[0]).toEqual({
      scheme: 'beeline',
      iosBundleIdentifier: 'app.usebeeline.mobile',
      androidPackage: 'app.usebeeline.mobile',
    });
  });

  it('keeps production binaries on production and gives the canary a beta-only APK', () => {
    const easBuildProfiles = JSON.parse(easConfig).build as Record<string, EasBuildProfile>;
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(Object.keys(easBuildProfiles)).toEqual(['production', 'production-apk', 'beta-apk']);
    expect(resolveEasBuildProfile(easBuildProfiles, 'production').channel).toBe('production');
    expect(resolveEasBuildProfile(easBuildProfiles, 'production-apk').channel).toBe('production');
    expect(resolveEasBuildProfile(easBuildProfiles, 'beta-apk').channel).toBe('beta');
    for (const [name, script] of Object.entries(packageJson.scripts ?? {})) {
      if (!script.includes('eas update')) continue;
      expect(script, `${name} must publish candidates to beta`).toMatch(
        /--(?:branch|channel)\s+beta\b/,
      );
      expect(script, `${name} must not publish directly to production`).not.toMatch(
        /--(?:branch|channel)\s+production\b/,
      );
    }

    expect(appConfig).toContain('process.env.EXPO_UPDATES_CHANNEL || "production"');
    expect(appConfig).toContain('"expo-channel-name": updatesChannel');
    expect(loadUpdatesChannel()).toBe('production');
    expect(loadUpdatesChannel('beta')).toBe('beta');
    expect(appConfig).toContain('runtimeVersion: "21"');
  });

  it('packages the production app as an APK without creating another app variant', () => {
    const easBuildProfiles = JSON.parse(easConfig).build as Record<string, EasBuildProfile>;
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const production = resolveEasBuildProfile(easBuildProfiles, 'production');
    const productionApk = resolveEasBuildProfile(easBuildProfiles, 'production-apk');

    // #322 pins the APK profile onto the production OTA channel explicitly.
    expect(easBuildProfiles['production-apk']).toEqual({
      extends: 'production',
      channel: 'production',
      android: { buildType: 'apk' },
    });
    expect(easBuildProfiles['beta-apk']).toEqual({
      extends: 'production-apk',
      channel: 'beta',
      env: {
        EXPO_UPDATES_CHANNEL: 'beta',
        SHARP_IGNORE_GLOBAL_LIBVIPS: '1',
      },
    });
    expect(productionApk).toEqual({
      ...production,
      extends: 'production',
      android: { ...production.android, buildType: 'apk' },
    });
    expect(loadNativeIdentity()).toEqual({
      scheme: 'beeline',
      iosBundleIdentifier: 'app.usebeeline.mobile',
      androidPackage: 'app.usebeeline.mobile',
    });
    expect(packageJson.scripts?.['release:build:apk']).toBe(
      'npm run version:check && eas build --profile production-apk --platform android --no-wait --non-interactive',
    );
  });

  it('ships the registered Beeline Firebase client for every build path', () => {
    const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));
    const configuredPaths = [undefined, 'development', 'preview', 'production'].map(
      loadGoogleServicesFile,
    );

    expect(new Set(configuredPaths)).toEqual(new Set(['./google-services.json']));

    const googleServices = JSON.parse(
      readFileSync(resolve(mobileRoot, configuredPaths[0]!), 'utf8'),
    ) as {
      client: Array<{
        client_info: {
          mobilesdk_app_id: string;
          android_client_info: { package_name: string };
        };
      }>;
    };
    const beelineClient = googleServices.client.find(
      (client) => client.client_info.android_client_info.package_name === 'app.usebeeline.mobile',
    );

    expect(beelineClient?.client_info.mobilesdk_app_id).toBe(
      '1:31955293663:android:a08dd03afc4ea13503206a',
    );
  });
});
