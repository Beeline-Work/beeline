import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sidebar = readFileSync(new URL('./SidebarView.tsx', import.meta.url), 'utf8');
const settingsIndex = readFileSync(
  new URL('../app/(app)/beeline/settings/index.tsx', import.meta.url),
  'utf8',
);
const identitySettings = readFileSync(
  new URL('../app/(app)/beeline/settings/identity.tsx', import.meta.url),
  'utf8',
);

describe('desktop profile settings path', () => {
  it('routes the persistent PC navigation to the unified Identity settings surface', () => {
    expect(sidebar).toContain('testID="profile-settings-navigation"');
    expect(sidebar).toContain("router.push('/beeline/settings' as Href)");
    expect(sidebar).toContain("isDesktop ? 'PROFILE & SETTINGS' : 'SETTINGS'");
    expect(settingsIndex.trim()).toBe("export { default } from './identity';");
  });

  it('keeps the person Identity controls on that destination', () => {
    expect(identitySettings).toContain('testID="identity-settings"');
    expect(identitySettings).toContain('testID="identity-person-name-input"');
    expect(identitySettings).toContain('testID="identity-managed-handle"');
    expect(identitySettings).toContain('testID="identity-face-setting"');
  });
});
