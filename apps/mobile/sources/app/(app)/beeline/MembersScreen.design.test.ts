import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./MembersScreen.tsx', import.meta.url), 'utf8');

function styleBlock(text: string, name: string): string {
  const start = text.indexOf(`    ${name}: {`);
  expect(start, `missing style ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated style ${name}`);
}

describe('Members page layout contract', () => {
  it('carries no seeded-souls Workspace switch (removed C99)', () => {
    // The per-agent seeded soul (singular `seededSoul`, the soul editor's
    // restore-to-default) stays; only the removed Workspace-wide plural
    // switch and its control must be gone.
    expect(source).not.toMatch(/seededSouls\b/);
    expect(source).not.toMatch(/workspace-seeded-souls/);
    expect(source).not.toContain('setWorkspaceSeededSouls');
    expect(source).not.toContain('Seeded souls');
  });

  it('aligns the section + on the same trailing axis as the row chevron (C99)', () => {
    // The row's trailing chevron sits flush against the row's own padding
    // edge; the section head's + control is a 44pt hit target, so its
    // content must align to that same trailing edge rather than centering
    // inside the hit box, or the two visually disagree by half the glyph
    // width (captain report, second complaint on this page).
    expect(styleBlock(source, 'sectionHeadRow')).toContain('paddingRight: hull.space.sm');
    expect(styleBlock(source, 'row')).toContain('paddingHorizontal: hull.space.sm');
    expect(styleBlock(source, 'sectionAdd')).toContain("alignItems: 'flex-end'");
  });
});
