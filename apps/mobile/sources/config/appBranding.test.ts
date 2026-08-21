import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

function assertSubmissionMatchesAppStoreConnect(
  submission: IosSubmissionConfig,
): void {
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

  it('keeps every build and publish path on the production EAS Updates channel', () => {
    const easBuildProfiles = JSON.parse(easConfig).build as Record<string, EasBuildProfile>;
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(Object.keys(easBuildProfiles)).toEqual(['production', 'production-apk']);
    for (const profileName of Object.keys(easBuildProfiles)) {
      expect(resolveEasBuildProfile(easBuildProfiles, profileName).channel).toBe('production');
    }
    for (const [name, script] of Object.entries(packageJson.scripts ?? {})) {
      if (!script.includes('eas update')) continue;
      expect(script, `${name} must publish to production`).toMatch(
        /--(?:branch|channel)\s+production\b/,
      );
      expect(script, `${name} must not publish to another channel`).not.toMatch(
        /--(?:branch|channel)\s+(?!production\b)\S+/,
      );
    }

    expect(appConfig).toContain('const updatesChannel = "production"');
    expect(appConfig).toContain('"expo-channel-name": updatesChannel');
    expect(appConfig).toContain('runtimeVersion: "21"');
    expect(appConfig).not.toContain('googleServicesFile');
  });

  it('packages the production app as an APK without creating another app variant', () => {
    const easBuildProfiles = JSON.parse(easConfig).build as Record<string, EasBuildProfile>;
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const production = resolveEasBuildProfile(easBuildProfiles, 'production');
    const productionApk = resolveEasBuildProfile(easBuildProfiles, 'production-apk');

    expect(easBuildProfiles['production-apk']).toEqual({
      extends: 'production',
      android: { buildType: 'apk' },
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
      'eas build --profile production-apk --platform android --no-wait --non-interactive',
    );
  });

  it('does not ship the package-mismatched Firebase client configuration', () => {
    const googleServicesPath = fileURLToPath(new URL('../../google-services.json', import.meta.url));

    expect(existsSync(googleServicesPath)).toBe(false);
    expect(appConfig).not.toContain('googleServicesFile');
  });
});
