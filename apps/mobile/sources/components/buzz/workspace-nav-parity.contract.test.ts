import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const rail = readFileSync(new URL('./CommunityRail.tsx', import.meta.url), 'utf8');
const desktopRail = readFileSync(new URL('./DesktopWorkspaceRail.tsx', import.meta.url), 'utf8');
const workspaceSettings = readFileSync(
  new URL('../../app/(app)/beeline/settings/workspace.tsx', import.meta.url),
  'utf8',
);

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

  it('keeps the named ADD, WORKSPACE and SETTINGS foot commands (never bare glyphs)', () => {
    expect(rail).toContain("'ADD'");
    expect(rail).toContain('`ADD ${WORKSPACE_LABEL.toUpperCase()}`');
    expect(rail).toContain("label=\"WORKSPACE\"");
    expect(rail).toContain("label=\"SETTINGS\"");
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
