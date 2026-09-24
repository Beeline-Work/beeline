import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The settings tile lives two directories away, so this contract names it by
 * relative path. Moving the file should read as this contract needing its path
 * updated, not as a stack trace out of `readFileSync`.
 */
function surfaceSource(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  if (!existsSync(url)) {
    throw new Error(
      `workspace nav parity cannot find ${relativePath}. If that surface moved, ` +
        'point this contract at its new path — do not drop it from the contract.',
    );
  }
  return readFileSync(url, 'utf8');
}

const rail = surfaceSource('./CommunityRail.tsx');
const desktopRail = surfaceSource('./DesktopWorkspaceRail.tsx');
const workspaceSettings = surfaceSource('../../app/(app)/beeline/settings/workspace.tsx');

describe('workspace nav parity (mobile drawer ↔ desktop rail)', () => {
  it('draws the mobile drawer tile with the desktop radius and brass bezel', () => {
    // The 48px tile at 14px radius is named once, in `buzz/workspace-tile`,
    // because the picture seated inside it is measured off the border's inner
    // curve and the two numbers must not be able to drift apart.
    expect(rail).toContain('const TILE = WORKSPACE_RAIL_TILE');
    expect(rail).toContain('borderRadius: TILE_RADIUS');
    // The current workspace wears the 2px brass bezel; idle tiles sit at
    // full strength (no opacity fade — the bezel is the whole story).
    expect(rail).toContain('railButtonCurrent: {\n      borderWidth: 2,\n      borderColor: groknight.selectedBorder,');
    expect(rail).not.toContain('railButtonIdle');
    expect(rail).not.toContain('opacity: 0.5');
  });

  it('scales the room-list header plate to the same treatment', () => {
    expect(rail).toContain('const HEADER_PLATE = WORKSPACE_HEADER_PLATE');
    expect(rail).toContain(
      'drawerTriggerPlate: {\n' +
        "      position: 'relative',\n" +
        '      width: HEADER_PLATE.size,\n' +
        '      height: HEADER_PLATE.size,\n' +
        "      alignItems: 'center',\n" +
        "      justifyContent: 'center',\n" +
        '      borderRadius: HEADER_PLATE.radius,\n' +
        '      borderWidth: HEADER_PLATE.borderWidth,\n' +
        '      borderColor: groknight.selectedBorder,',
    );
  });

  it('keeps named ADD and SETTINGS rail commands and no Workspace Settings command', () => {
    expect(rail).toContain("'ADD'");
    expect(rail).toContain('`ADD ${WORKSPACE_LABEL.toUpperCase()}`');
    expect(rail).toContain('label="SETTINGS"');
    expect(rail).not.toContain('label="WORKSPACE"');
  });

  it('keeps the desktop rail as the reference tile (48px, 14px radius, 2px bezel, left pill)', () => {
    expect(desktopRail).toContain('const TILE = WORKSPACE_RAIL_TILE');
    expect(desktopRail).toContain('borderRadius: TILE_RADIUS');
    expect(desktopRail).toContain('currentTile: { borderWidth: 2, borderColor: hull.accent }');
  });

  it('seats the Workspace picture off one derivation on every surface that wears it', () => {
    // A picture in a frame, not a picture cropped by one — and the same rule
    // whether the tile is the rail's 48px, the header plate's 34px or the
    // settings page's 76px. Each surface names its tile and asks
    // `workspacePictureSeat` for the radius; none of them hardcodes one.
    // What that paints is measured in `workspace-picture-seat.browser.test.ts`.
    const seats: Array<[string, string, string]> = [
      ['mobile drawer', rail, 'TILE_SEAT'],
      ['room-list header plate', rail, 'HEADER_PLATE_SEAT'],
      ['desktop rail', desktopRail, 'TILE_SEAT'],
      ['workspace settings', workspaceSettings, 'PICTURE_SEAT'],
    ];
    for (const [, source, seat] of seats) {
      expect(source).toContain("from '@/buzz/workspace-tile'");
      expect(source).toContain(`const ${seat} = workspacePictureSeat(`);
      expect(source).toContain(`borderRadius: ${seat}.pictureRadius`);
      expect(source).toContain(`size={${seat}.pictureSize}`);
      expect(source).toContain("overflow: 'hidden'");
    }
    // The old treatment cropped the picture against the bezel itself: the
    // settings tile clipped its own box, and the header plate rounded nothing.
    expect(workspaceSettings).not.toContain('const IDENTITY_TILE_RADIUS');
    expect(rail).not.toContain('padding: 2,');
  });
});
