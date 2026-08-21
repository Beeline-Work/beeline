import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function loadNativeIdentity(variant: 'development' | 'preview' | 'production'): {
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
      env: { ...process.env, APP_ENV: variant },
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
    expect(appConfig).toContain('development: "Beeline (dev)"');
    expect(appConfig).toContain('preview: "Beeline (preview)"');
    expect(appConfig).toContain('production: "Beeline"');
    expect(appConfig).toContain('faceIDPermission: "Allow Beeline to verify');
    expect(channelsScreen).toContain('{WORKSPACE_LABEL}');
    expect(channelsScreen).not.toContain("'beeline home'");
    expect(channelsScreen).not.toContain("'buzzy home'");
    expect(inviteScreen).toContain('Return to Beeline');
    expect(inviteScreen).not.toMatch(/Return to buzzy/i);
  });

  it('preserves install identifiers and the submit-only app name', () => {
    expect(appConfig).toContain('slug: "buzzy"');
    expect(appConfig).toContain('production: "app.buzzy.mobile"');
    expect(easConfig).toContain('"appName": "Buzzy"');
  });

  it('gives every installed variant its own callback scheme while preserving production', () => {
    const identities = {
      development: loadNativeIdentity('development'),
      preview: loadNativeIdentity('preview'),
      production: loadNativeIdentity('production'),
    };

    expect(new Set(Object.values(identities).map(({ scheme }) => scheme))).toHaveLength(3);
    expect(identities).toMatchObject({
      development: {
        scheme: 'buzzy-dev',
        iosBundleIdentifier: 'app.buzzy.mobile.dev',
        androidPackage: 'app.buzzy.mobile.dev',
      },
      preview: {
        scheme: 'buzzy-preview',
        iosBundleIdentifier: 'app.buzzy.mobile.preview',
        androidPackage: 'app.buzzy.mobile.preview',
      },
      production: {
        scheme: 'buzzy',
        iosBundleIdentifier: 'app.buzzy.mobile',
        androidPackage: 'app.buzzy.mobile',
      },
    });
  });

  it('keeps every build and publish path on the single preview EAS Updates channel', () => {
    const easBuildProfiles = JSON.parse(easConfig).build as Record<string, { channel?: string }>;
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(Object.keys(easBuildProfiles)).not.toHaveLength(0);
    for (const profile of Object.values(easBuildProfiles)) {
      expect(profile.channel).toBe('preview');
    }
    for (const [name, script] of Object.entries(packageJson.scripts ?? {})) {
      if (!script.includes('eas update')) continue;
      expect(script, `${name} must publish to preview`).toMatch(/--(?:branch|channel)\s+preview\b/);
      expect(script, `${name} must not publish to another channel`).not.toMatch(
        /--(?:branch|channel)\s+(?!preview\b)\S+/,
      );
    }

    expect(appConfig).toContain('const updatesChannel = "preview"');
    expect(appConfig).toContain('"expo-channel-name": updatesChannel');
    expect(appConfig).toContain('runtimeVersion: "21"');
    expect(appConfig).toContain("variant === 'preview' ? {} : { googleServicesFile");
  });
});
