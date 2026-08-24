import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settings = Object.fromEntries(
  ['appearance', 'agents', 'features', 'language'].map((name) => [
    name,
    readFileSync(new URL(`../app/(app)/settings/${name}.tsx`, import.meta.url), 'utf8'),
  ]),
);
const item = readFileSync(new URL('./Item.tsx', import.meta.url), 'utf8');
const itemGroup = readFileSync(new URL('./ItemGroup.tsx', import.meta.url), 'utf8');
const itemList = readFileSync(new URL('./ItemList.tsx', import.meta.url), 'utf8');
const settingSwitch = readFileSync(new URL('./Switch.tsx', import.meta.url), 'utf8');
const header = readFileSync(new URL('./navigation/Header.tsx', import.meta.url), 'utf8');

describe('legacy settings leaves use the Beeline design contract', () => {
  it('keeps leaf screens free of glass, generic icon packs, and local palette colors', () => {
    for (const [name, source] of Object.entries(settings)) {
      expect(source, `${name} reintroduced legacy glass or Ionicons`).not.toMatch(
        /MobileGlass|Ionicons|@expo\/vector-icons/,
      );
      expect(source, `${name} contains a local hex color`).not.toMatch(/#[0-9a-f]{6}/i);
    }
  });

  it('renders settings as a flat hairline index with semantic prose and mono chrome', () => {
    expect(item).toContain('fontFamily: theme.buzz.proseSemibold');
    expect(item).toContain('fontFamily: theme.buzz.proseRegular');
    expect(item).toContain('fontFamily: theme.buzz.monoRegular');
    expect(item).toContain('backgroundColor: theme.buzz.border');
    expect(itemGroup).toContain('backgroundColor: \'transparent\'');
    expect(itemGroup).toContain('borderTopWidth: StyleSheet.hairlineWidth');
    expect(itemGroup).not.toMatch(/borderRadius|shadowRadius|elevation:/);
    expect(itemList).toContain('backgroundColor: theme.buzz.bgTerminal');
  });

  it('uses the shared box radius for toggles and flat header defaults', () => {
    expect(settingSwitch.match(/borderRadius: theme\.buzz\.radius/g)).toHaveLength(2);
    expect(settingSwitch).not.toMatch(/RNSwitch|borderRadius:\s*\d/);
    expect(header).not.toMatch(/MobileGlass|Ionicons|@expo\/vector-icons/);
    expect(header).toContain('backgroundColor: theme.buzz.bgTerminal');

    const backButton = header.slice(
      header.indexOf('const DefaultBackButton'),
      header.indexOf('// Component wrapper for navigation header'),
    );
    expect(backButton).not.toMatch(/MobileGlass|Ionicons/);
    expect(backButton).toContain('>‹</Text>');
  });
});
