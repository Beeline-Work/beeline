import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./workspace.tsx', import.meta.url), 'utf8');

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

describe('Workspace naming', () => {
  it('uses Workspace for the page', () => {
    expect(source).toContain('<Text style={styles.title}>{WORKSPACE_LABEL}</Text>');
    expect(source).not.toContain('{WORKSPACE_LABEL} Settings');
  });

  it('centres a 2px brass-bezelled workspace tile and drops the WORKSPACE grouping', () => {
    expect(styleBlock(source, 'ident')).toContain("alignItems: 'center'");
    // The 2px brass bezel is named once, with the rest of the tile's geometry
    // (`buzz/workspace-tile`, where the picture's seat is derived from it).
    expect(source).toContain('const PICTURE_TILE = WORKSPACE_SETTINGS_TILE');
    expect(styleBlock(source, 'tile')).toContain('borderWidth: PICTURE_TILE.borderWidth');
    expect(styleBlock(source, 'tile')).toContain('borderColor: hull.accent');
    expect(source).toContain('testID="workspace-picture-change"');
    expect(source).not.toMatch(/sectionLabel}>{WORKSPACE_LABEL}</);
    expect(source).not.toContain('Danger zone');
  });

  it('keeps Rooms as a headed list and delete as a red row', () => {
    expect(source).toMatch(/sectionLabel}>{ROOM_LABEL}s</);
    expect(source).toContain('testID="workspace-delete-row"');
    expect(source).toMatch(/testID="workspace-delete-row"[\s\S]*tone="destructive"/);
    expect(source).toContain('testID="workspace-census"');
  });
});
