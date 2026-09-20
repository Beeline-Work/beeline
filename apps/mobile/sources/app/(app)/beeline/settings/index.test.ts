import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const index = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('./identity.tsx', import.meta.url), 'utf8');
const appearanceSetting = readFileSync(
  new URL('../../../../components/buzz/AppearanceSetting.tsx', import.meta.url),
  'utf8',
);
const pushLevelSetting = readFileSync(
  new URL('../../../../components/buzz/PushLevelSetting.tsx', import.meta.url),
  'utf8',
);

describe('single Settings surface', () => {
  it('routes the Settings index directly to the unified screen', () => {
    expect(index.trim()).toBe("export { default } from './identity';");
  });

  it('keeps only the approved essential rows', () => {
    expect(settings).toContain('testID="identity-face-setting"');
    expect(settings).toContain('testID="identity-managed-handle"');
    expect(appearanceSetting).toContain('title="Appearance"');
    expect(settings).toContain('<AppearanceSetting');
    expect(pushLevelSetting).toContain('title="Notifications"');
    expect(settings).toContain('Sign out');
    expect(settings).toContain('Delete account');
    expect(settings).not.toMatch(/Backup key|Relay URL|Connected GitHub accounts|My Settings/);
    expect(settings).not.toMatch(/Switch GitHub|Linked sign-in/);
  });

  it('omits the struck Display grouping and the GitHub switch-account row', () => {
    expect(settings).not.toContain('<Text style={styles.sectionLabel}>Display</Text>');
    expect(settings).not.toContain('<Text style={styles.sectionLabel}>Linked sign-in</Text>');
    expect(settings).not.toContain('<Text style={styles.sectionLabel}>Preferences</Text>');
  });

  it('omits notifications entirely when push is unsupported', () => {
    expect(settings).toContain('{pushSupported ? (');
    expect(settings).toContain('testID="notifications-section"');
    expect(settings).not.toMatch(/not supported|unsupported on this device/i);
  });
});
