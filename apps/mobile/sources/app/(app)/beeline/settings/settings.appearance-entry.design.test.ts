import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #1273 shipped Appearance on the Settings surface (`identity.tsx`, which the
// Settings index re-exports). The captain still could not find light mode
// (2026-09-18) because that destination was labeled YOU in the switcher and
// the Settings row contract never named Appearance. Keep the control on this
// path, under a Settings-named entry, in the unheaded run with Text size.
const index = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('./identity.tsx', import.meta.url), 'utf8');
const appearance = readFileSync(
  new URL('../../../../components/buzz/AppearanceSetting.tsx', import.meta.url),
  'utf8',
);
const rail = readFileSync(
  new URL('../../../../components/buzz/CommunityRail.tsx', import.meta.url),
  'utf8',
);

describe('Settings Appearance entry', () => {
  it('routes Settings to the screen that mounts AppearanceSetting', () => {
    expect(index.trim()).toBe("export { default } from './identity';");
    expect(settings).toContain("import { AppearanceSetting } from '@/components/buzz/AppearanceSetting'");
    expect(settings).toContain('<AppearanceSetting');
    expect(settings).toContain('testID="appearance-section"');
  });

  it('keeps Appearance as a plain row with no Display heading', () => {
    expect(settings).toContain('testID="appearance-section"');
    expect(settings).not.toMatch(/sectionLabel}>Display</);
    expect(settings.indexOf('testID="identity-settings"')).toBeLessThan(
      settings.indexOf('testID="appearance-section"'),
    );
  });

  it('names the row Appearance with a light/dark picker', () => {
    expect(appearance).toContain('title="Appearance"');
    expect(appearance).toContain('testID="appearance-setting"');
    expect(appearance).toContain("'light'");
    expect(appearance).toContain("'dark'");
  });

  it('labels the switcher destination Settings, not YOU', () => {
    expect(rail).toContain('testID="community-rail-settings"');
    expect(rail).toContain('label="SETTINGS"');
    expect(rail).toContain('accessibilityLabel="Settings"');
    expect(rail).not.toContain('label="YOU"');
  });
});
