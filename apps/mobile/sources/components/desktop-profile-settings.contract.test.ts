import { readFileSync } from 'node:fs';

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
    // The desktop foot is the viewer's own face AND username (R4, captain's
    // amendment); the 'PROFILE & SETTINGS' text row is retired.
    expect(sidebar).toContain('accessibilityLabel={');
    expect(sidebar).toContain("`${viewerIdentity.name} — Settings`");
    expect(sidebar).toContain('testID="profile-settings-name"');
    expect(sidebar).toContain('<IdentityMark\n                  seed={identityPubkey}');
    expect(sidebar).not.toContain('PROFILE & SETTINGS');
    // The identity screen IS the settings surface. `/settings` keeps a route
    // because `(app)/_layout.tsx` declares that screen and expo-router warns
    // a declared screen with no route out of existence, but it must stay a
    // redirect to the one hub — never a second Settings surface.
    const legacySettings = readFileSync(
      new URL('../app/(app)/settings/index.tsx', import.meta.url),
      'utf8',
    );
    expect(legacySettings).toContain('<Redirect href="/beeline/settings" />');
    expect(legacySettings).not.toMatch(/SettingsRow|AppearanceSetting|Sign out/);
  });

  it('keeps the person Identity controls on that destination', () => {
    expect(identitySettings).toContain('testID="identity-settings"');
    expect(identitySettings).toContain('testID="identity-managed-handle"');
    expect(identitySettings).toContain('testID="identity-face-setting"');
  });

  it('keeps Appearance on that same Settings surface, after the identity hero', () => {
    expect(identitySettings).toContain('<AppearanceSetting');
    expect(identitySettings).toContain('testID="appearance-section"');
    expect(identitySettings.indexOf('testID="identity-settings"')).toBeLessThan(
      identitySettings.indexOf('testID="appearance-section"'),
    );
  });
});
