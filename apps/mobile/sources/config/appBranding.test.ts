import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
    expect(appConfig).toContain('scheme: "buzzy"');
    expect(appConfig).toContain('production: "app.buzzy.mobile"');
    expect(easConfig).toContain('"appName": "Buzzy"');
  });

  it('binds each native variant to its matching EAS Updates channel', () => {
    expect(appConfig).toContain('preview: "preview"');
    expect(appConfig).toContain('"expo-channel-name": updatesChannel');
    expect(appConfig).toContain('runtimeVersion: "21"');
    expect(appConfig).toContain("variant === 'preview' ? {} : { googleServicesFile");
  });
});
