import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const rail = readFileSync(new URL('./CommunityRail.tsx', import.meta.url), 'utf8');
const desktopRail = readFileSync(new URL('./DesktopWorkspaceRail.tsx', import.meta.url), 'utf8');

describe('workspace nav parity (mobile drawer ↔ desktop rail)', () => {
  it('draws the mobile drawer tile with the desktop radius and brass bezel', () => {
    // 48px tile, 14px radius — the desktop tile geometry, named once here
    // because the picture seated inside it is measured off the border's inner
    // curve and the two numbers must not be able to drift apart.
    expect(rail).toContain('const TILE_RADIUS = 14');
    expect(rail).toContain('const TILE_BORDER_WIDTH = 2');
    expect(rail).toContain('const TILE_INNER_RADIUS = TILE_RADIUS - TILE_BORDER_WIDTH');
    expect(rail).toContain('borderRadius: TILE_RADIUS');
    // The current workspace wears the 2px brass bezel; idle tiles sit at
    // full strength (no opacity fade — the bezel is the whole story).
    expect(rail).toContain('railButtonCurrent: {\n      borderWidth: 2,\n      borderColor: groknight.selectedBorder,');
    expect(rail).not.toContain('railButtonIdle');
    expect(rail).not.toContain('opacity: 0.5');
  });

  it('scales the room-list header plate to the same treatment', () => {
    expect(rail).toContain('drawerTriggerPlate: {\n      position: \'relative\',\n      borderRadius: 8,\n      borderWidth: 2,\n      borderColor: groknight.selectedBorder,');
  });

  it('keeps the named ADD, WORKSPACE and SETTINGS foot commands (never bare glyphs)', () => {
    expect(rail).toContain("'ADD'");
    expect(rail).toContain('`ADD ${WORKSPACE_LABEL.toUpperCase()}`');
    expect(rail).toContain("label=\"WORKSPACE\"");
    expect(rail).toContain("label=\"SETTINGS\"");
  });

  it('keeps the desktop rail as the reference tile (48px, 14px radius, 2px bezel, left pill)', () => {
    expect(desktopRail).toContain('TILE_SIZE = 48');
    expect(desktopRail).toContain('const TILE_RADIUS = 14');
    expect(desktopRail).toContain('borderRadius: TILE_RADIUS');
    expect(desktopRail).toContain('currentTile: { borderWidth: 2, borderColor: hull.accent }');
  });

  it('seats the Workspace picture inside the bezel identically on both rails', () => {
    // A picture in a frame, not a picture cropped by one: 34px square centred
    // in the 44px box inside the bezel leaves 5px of slab on every side, and
    // the picture's own 7px radius (12 - 5) keeps its curve parallel to the
    // bezel's. Both rails wear the one tile, so both name the same numbers.
    for (const source of [rail, desktopRail]) {
      expect(source).toContain('const TILE_BORDER_WIDTH = 2');
      expect(source).toContain('const TILE_INNER_RADIUS = TILE_RADIUS - TILE_BORDER_WIDTH');
      expect(source).toContain('const TILE_PICTURE_SIZE = 34');
      expect(source).toContain(
        'const TILE_PICTURE_MARGIN = (TILE_SIZE - TILE_BORDER_WIDTH * 2 - TILE_PICTURE_SIZE) / 2',
      );
      expect(source).toContain(
        'const TILE_PICTURE_RADIUS = TILE_INNER_RADIUS - TILE_PICTURE_MARGIN',
      );
      expect(source).toContain('borderRadius: TILE_PICTURE_RADIUS');
      expect(source).toContain("overflow: 'hidden'");
      // The old treatment cropped the picture against the bezel itself.
      expect(source).not.toContain('borderRadius: TILE_INNER_RADIUS,');
    }
  });
});
