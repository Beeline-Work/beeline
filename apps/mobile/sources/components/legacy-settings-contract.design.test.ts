import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const textSelection = readFileSync(
  new URL('../app/(app)/text-selection.tsx', import.meta.url),
  'utf8',
);
const appLayout = readFileSync(new URL('../app/(app)/_layout.tsx', import.meta.url), 'utf8');
const workflows = readFileSync(
  new URL('../app/(app)/beeline/settings/workflows.tsx', import.meta.url),
  'utf8',
);

describe('retained settings leaves use the Beeline design contract', () => {
  it('keeps leaf screens free of glass, generic icon packs, and local palette colors', () => {
    for (const [name, source] of Object.entries({ workflows, textSelection })) {
      expect(source, `${name} reintroduced legacy glass or Ionicons`).not.toMatch(
        /MobileGlass|Ionicons|@expo\/vector-icons/,
      );
      expect(source, `${name} contains a local hex color`).not.toMatch(/#[0-9a-f]{6}/i);
    }
  });

  it('draws the shared PageHeader instead of a stack header', () => {
    expect(existsSync(new URL('./navigation/Header.tsx', import.meta.url))).toBe(false);
    expect(appLayout).not.toContain('createHeader');
    expect(appLayout).toMatch(/screenOptions=\{\{[\s\S]*?headerShown: false/);
    for (const source of [textSelection, workflows]) {
      expect(source).toContain('<PageHeader');
    }
    expect(textSelection).not.toContain('navigation.setOptions');
  });

  it('reuses the shared navigation and dialog idioms on migrated leaves', () => {
    expect(textSelection).toContain('<HullDialog');
    expect(textSelection).not.toMatch(/MobileGlass|Ionicons|@expo\/vector-icons|@\/modal/);
    expect(appLayout).not.toContain('name="settings/language"');
    expect(existsSync(new URL('../app/(app)/settings/language.tsx', import.meta.url))).toBe(false);
  });
});
