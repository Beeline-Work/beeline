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

  it('uses the Beeline install identifiers and submit app name', () => {
    expect(easConfig).toContain('"appName": "Beeline"');
    expect(easConfig).toContain('"bundleIdentifier": "app.usebeeline.mobile"');
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

  it('keeps the sole build and every publish path on the production EAS Updates channel', () => {
    const easBuildProfiles = JSON.parse(easConfig).build as Record<string, { channel?: string }>;
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(Object.keys(easBuildProfiles)).toEqual(['production']);
    for (const profile of Object.values(easBuildProfiles)) {
      expect(profile.channel).toBe('production');
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

  it('does not ship the package-mismatched Firebase client configuration', () => {
    const googleServicesPath = fileURLToPath(new URL('../../google-services.json', import.meta.url));

    expect(existsSync(googleServicesPath)).toBe(false);
    expect(appConfig).not.toContain('googleServicesFile');
  });
});
