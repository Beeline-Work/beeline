import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sources = {
  'RoomDeckComposeMenu.tsx': readFileSync(
    new URL('./RoomDeckComposeMenu.tsx', import.meta.url),
    'utf8',
  ),
  'HullActionSheet.tsx': readFileSync(new URL('./HullActionSheet.tsx', import.meta.url), 'utf8'),
  'HullDialog.tsx': readFileSync(new URL('./HullDialog.tsx', import.meta.url), 'utf8'),
  'SettingsRow.tsx': readFileSync(new URL('./SettingsRow.tsx', import.meta.url), 'utf8'),
  'EmptyLedgerState.tsx': readFileSync(new URL('./EmptyLedgerState.tsx', import.meta.url), 'utf8'),
  'workspace.tsx': readFileSync(
    new URL('../../app/(app)/beeline/settings/workspace.tsx', import.meta.url),
    'utf8',
  ),
  '[channelId].tsx': readFileSync(
    new URL('../../app/(app)/beeline/chat/[channelId].tsx', import.meta.url),
    'utf8',
  ),
};
const groknightSource = readFileSync(new URL('../../buzz/groknight.ts', import.meta.url), 'utf8');

describe('Beeline leaf-surface prohibited patterns', () => {
  it('ships overlays without BlurView or translucent sheet fill', () => {
    for (const name of ['RoomDeckComposeMenu.tsx', 'HullActionSheet.tsx'] as const) {
      expect(sources[name], `${name} must stay de-glassed`).not.toMatch(/BlurView|expo-blur/);
    }
    expect(sources['HullActionSheet.tsx']).toContain('<HullFloatingSurface');
    expect(sources['HullDialog.tsx']).toContain('backgroundColor: hull.bgRaised');
    expect(sources['HullActionSheet.tsx']).not.toMatch(/rgba?\(/);
  });

  it('routes every system-surface box through the shared radius token', () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, `${name} contains a local radius literal`).not.toMatch(/borderRadius:\s*\d/);
    }
    expect(groknightSource.match(/radius:\s*3,/g)).toHaveLength(1);
    expect(groknightSource).not.toMatch(/radius:\s*(?!3,)\d+/);
  });

  it('uses the named primitives only on their intended leaf surfaces', () => {
    expect(sources['RoomDeckComposeMenu.tsx']).toContain('<HullActionSheet');
    // Workspace Settings is one list of the shared settings row: the picture,
    // the name, visibility, Members, Rooms, and one row per Room — no screen
    // -local row shape beside them (C106).
    expect(sources['workspace.tsx'].match(/<SettingsRow/g)?.length).toBeGreaterThanOrEqual(6);
    expect(sources['workspace.tsx']).not.toMatch(/<SettingsNavigationRow/);
    expect(sources['[channelId].tsx']).toContain('<EmptyLedgerState');
  });
});
