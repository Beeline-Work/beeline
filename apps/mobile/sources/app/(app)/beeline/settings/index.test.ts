import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const index = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('./identity.tsx', import.meta.url), 'utf8');

describe('single Settings surface', () => {
  it('routes the Settings index directly to the unified screen', () => {
    expect(index.trim()).toBe("export { default } from './identity';");
  });

  it('keeps only the approved essential rows', () => {
    for (const label of ['Name', 'Handle', 'Face', 'Push notifications', 'GitHub', 'Version']) {
      expect(settings).toContain(`>${label}<`);
    }
    expect(settings).toContain('Sign out');
    expect(settings).toContain('Delete account');
    expect(settings).not.toMatch(/Backup key|Relay URL|Connected GitHub accounts|My Settings/);
  });

  it('labels the GitHub section as linked sign-in', () => {
    expect(settings).toContain('<Text style={styles.sectionLabel}>Linked sign-in</Text>');
    expect(settings).not.toContain('<Text style={styles.sectionLabel}>Preferences</Text>');
  });

  it('saves the inline name on blur or enter without a standing save button', () => {
    expect(settings).toContain('onBlur={() => {');
    expect(settings).toContain('onSubmitEditing={commitName}');
    expect(settings).not.toMatch(/Save profile|save-profile/);
  });

  it('omits notifications entirely when push is unsupported', () => {
    expect(settings).toContain('{pushSupported ? (');
    expect(settings).toContain('testID="notifications-section"');
    expect(settings).not.toMatch(/not supported|unsupported on this device/i);
  });
});
