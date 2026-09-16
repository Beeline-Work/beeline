import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./StatusBarProvider.tsx', import.meta.url), 'utf8');

describe('StatusBarProvider', () => {
  it('backs the Android status tray with a darker bar in light mode only', () => {
    // Bone's cream canvas otherwise sits under the system's white tray strip,
    // and the two read as one washed field. bgRaised is the one persistent
    // raised stop the language already owns, so the tray stands apart without
    // inventing a color. The fill is scoped to light mode: obsidian keeps the
    // tray it already has.
    expect(source).toContain("theme.dark ? 'light' : 'dark'");
    expect(source).toContain('theme.dark ? undefined : theme.buzz.bgRaised');
    expect(source).toContain('backgroundColor={statusBarBackground}');
  });
});
