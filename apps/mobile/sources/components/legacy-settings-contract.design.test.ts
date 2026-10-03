import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settings = Object.fromEntries(
  ['language'].map((name) => [
    name,
    readFileSync(new URL(`../app/(app)/settings/${name}.tsx`, import.meta.url), 'utf8'),
  ]),
);
const item = readFileSync(new URL('./Item.tsx', import.meta.url), 'utf8');
const itemGroup = readFileSync(new URL('./ItemGroup.tsx', import.meta.url), 'utf8');
const itemList = readFileSync(new URL('./ItemList.tsx', import.meta.url), 'utf8');
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
    for (const [name, source] of Object.entries(settings)) {
      expect(source, `${name} reintroduced legacy glass or Ionicons`).not.toMatch(
        /MobileGlass|Ionicons|@expo\/vector-icons/,
      );
      expect(source, `${name} contains a local hex color`).not.toMatch(/#[0-9a-f]{6}/i);
    }
  });

  it('renders settings as a flat hairline index with semantic prose and mono chrome', () => {
    // Row title/subtitle/detail read through the shared type roles now
    // (`theme.buzz.type.*`, DESIGN.md → Type) rather than a bare fontFamily —
    // bodyStrong/meta/machine resolve to the same proseSemibold/proseRegular/
    // monoRegular families these families named directly before.
    expect(item).toContain('...theme.buzz.type.bodyStrong');
    expect(item).toContain('...theme.buzz.type.meta');
    expect(item).toContain('...theme.buzz.type.machine');
    expect(item).toContain('backgroundColor: theme.buzz.border');
    expect(itemGroup).toContain("backgroundColor: 'transparent'");
    expect(itemGroup).toContain('borderTopWidth: StyleSheet.hairlineWidth');
    expect(itemGroup).not.toMatch(/borderRadius|shadowRadius|elevation:/);
    expect(itemList).toContain('backgroundColor: theme.buzz.bgTerminal');
  });

  it('draws the shared PageHeader instead of a stack header', () => {
    expect(existsSync(new URL('./navigation/Header.tsx', import.meta.url))).toBe(false);
    expect(appLayout).not.toContain('createHeader');
    expect(appLayout).toMatch(/screenOptions=\{\{[\s\S]*?headerShown: false/);
    for (const source of [settings.language, textSelection, workflows]) {
      expect(source).toContain('<PageHeader');
    }
    expect(textSelection).not.toContain('navigation.setOptions');
  });

  it('reuses the shared navigation and dialog idioms on migrated leaves', () => {
    expect(settings.language).toContain('<HullDialog');
    expect(textSelection).toContain('<HullDialog');
    expect(textSelection).not.toMatch(/MobileGlass|Ionicons|@expo\/vector-icons|@\/modal/);
    expect(appLayout).toContain('name="settings/language"');
    expect(appLayout).toContain('<Stack.Screen name="settings/language" options={{ headerShown: false }} />');
    expect(settings.language).toContain("title={t('settingsLanguage.title')}");
  });
});
