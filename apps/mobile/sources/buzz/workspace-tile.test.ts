import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_HEADER_PLATE,
  WORKSPACE_RAIL_TILE,
  WORKSPACE_SETTINGS_TILE,
  workspacePictureSeat,
  type WorkspaceTile,
} from './workspace-tile';

const TILES: Array<[string, WorkspaceTile]> = [
  ['rail tile', WORKSPACE_RAIL_TILE],
  ['room-list header plate', WORKSPACE_HEADER_PLATE],
  ['settings tile', WORKSPACE_SETTINGS_TILE],
];

describe('the Workspace picture seat', () => {
  it('derives the rail tile the rails have always drawn', () => {
    // 34px picture centred in the 44px box inside a 2px bezel leaves 5px of
    // slab on every side, and 12 - 5 = 7 is the picture's own radius.
    expect(workspacePictureSeat(WORKSPACE_RAIL_TILE)).toEqual({
      innerRadius: 12,
      margin: 5,
      pictureSize: 34,
      pictureRadius: 7,
    });
  });

  it.each(TILES)('leaves an even slab of %s showing round the picture', (_name, tile) => {
    const seat = workspacePictureSeat(tile);
    expect(seat.margin).toBeGreaterThan(0);
    expect(seat.pictureSize + (seat.margin + tile.borderWidth) * 2).toBe(tile.size);
  });

  it.each(TILES)('keeps the %s picture curve concentric with the bezel', (_name, tile) => {
    const seat = workspacePictureSeat(tile);
    // Concentric means one centre: the bezel's inner curve is `innerRadius`
    // from a point `borderWidth + innerRadius` inside the tile's corner, and
    // the picture's curve has to be struck from that very point — which is
    // what `innerRadius - margin` buys. Anywhere else and the gap between
    // picture and brass differs at the corner from the gap along the flats.
    const bezelCurveCentre = tile.borderWidth + seat.innerRadius;
    const pictureCurveCentre = tile.borderWidth + seat.margin + seat.pictureRadius;
    expect(pictureCurveCentre).toBe(bezelCurveCentre);
    // The gap is therefore the slab itself, corners included.
    expect(seat.innerRadius - seat.pictureRadius).toBe(seat.margin);
  });

  it.each(TILES)('rounds the %s picture without pinching or cropping it', (_name, tile) => {
    const seat = workspacePictureSeat(tile);
    // A radius at or past the inner radius means the bezel is doing the
    // rounding — the picture gets cropped against the brass. A negative one
    // means the corners have run out of room entirely.
    expect(seat.pictureRadius).toBeGreaterThan(0);
    expect(seat.pictureRadius).toBeLessThan(seat.innerRadius);
  });

  it('wears one brass bezel weight at every size', () => {
    // The tiles are drawn at three sizes, but the bezel is the same 2px hairline
    // of brass on all of them — which is why the seat has to be derived per
    // tile rather than scaled: the border eats a fixed amount of each curve.
    for (const [, tile] of TILES) {
      expect(tile.borderWidth).toBe(WORKSPACE_RAIL_TILE.borderWidth);
    }
  });
});
