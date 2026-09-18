import { readFileSync, statSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sidebar = readFileSync(new URL('./SidebarView.tsx', import.meta.url), 'utf8');
const identitySettings = readFileSync(
  new URL('../app/(app)/beeline/settings/identity.tsx', import.meta.url),
  'utf8',
);

describe('desktop profile settings path', () => {
  it('routes the persistent PC navigation to the unified Identity settings surface', () => {
    expect(sidebar).toContain('testID="profile-settings-navigation"');
    expect(sidebar).toContain("router.push('/beeline/settings' as Href)");
    // The desktop foot is the viewer's own face (R4), labelled "Settings" for
    // assistive technology; the 'PROFILE & SETTINGS' text row is retired.
    expect(sidebar).toContain('accessibilityLabel="Settings"');
    expect(sidebar).toContain('<IdentityMark seed={identityPubkey} kind="human"');
    expect(sidebar).not.toContain('PROFILE & SETTINGS');
    // The duplicated /settings redirect door is gone; the identity screen IS
    // the settings surface.
    expect(() =>
      statSync(new URL('../app/(app)/settings/index.tsx', import.meta.url)),
    ).toThrow();
  });

  it('keeps the person Identity controls on that destination', () => {
    expect(identitySettings).toContain('testID="identity-settings"');
    expect(identitySettings).toContain('testID="identity-person-name-input"');
    expect(identitySettings).toContain('testID="identity-managed-handle"');
    expect(identitySettings).toContain('testID="identity-face-setting"');
  });

  it('keeps Appearance on that same Settings surface, above Identity', () => {
    expect(identitySettings).toContain('<AppearanceSetting');
    expect(identitySettings).toContain('testID="appearance-section"');
    expect(identitySettings.indexOf('testID="appearance-section"')).toBeLessThan(
      identitySettings.indexOf('testID="identity-settings"'),
    );
  });
});
