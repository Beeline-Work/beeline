import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../../components/buzz/WorkspaceSettingsPanel.tsx', import.meta.url), 'utf8');

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

const tabs = readFileSync(new URL('../../../../components/buzz/SettingsScopeTabs.tsx', import.meta.url), 'utf8');
const route = readFileSync(new URL('./workspace.tsx', import.meta.url), 'utf8');

describe('Workspace naming', () => {
  it('lives in the Settings workspace tab, and the old page redirects there', () => {
    expect(source).not.toContain('<PageHeader');
    expect(source).not.toContain('{WORKSPACE_LABEL} Settings');
    expect(route).toContain('<Redirect');
    expect(route).toContain("tab: 'workspace'");
  });

  it('wears the 2px brass bezel on the selected tab tile and drops the WORKSPACE grouping', () => {
    // The bezel is named once, with the rest of the tile's geometry
    // (`buzz/workspace-tile`, where the picture's seat is derived from it).
    expect(tabs).toContain('const tile = WORKSPACE_SETTINGS_TILE');
    expect(styleBlock(tabs, 'tile')).toContain('borderWidth: tile.borderWidth');
    expect(styleBlock(tabs, 'tileSelected')).toContain('borderColor: hull.accent');
    expect(source).not.toMatch(/title="Workspace"|title={WORKSPACE_LABEL}/);
    expect(source).not.toContain('Danger zone');
  });

  it('heads General, People and Rooms and keeps delete as a red row', () => {
    expect(source).toContain('<RoomListSectionHeader title="General" inset="content" />');
    expect(source).toContain('<RoomListSectionHeader title="People" inset="content" />');
    expect(source).toContain('<RoomListSectionHeader title={`${ROOM_LABEL}s`} inset="content" />');
    expect(source).toMatch(/testID="workspace-delete-row"[\s\S]*tone="destructive"/);
  });
});
