/**
 * The Workspace tile, and the one rule that seats a picture inside it.
 *
 * A Workspace picture is the sole photo exception in the product (`DESIGN.md`,
 * "Workspace exception"), so wherever it appears it has to look like the same
 * object: a picture in a frame, not a picture cropped by one. A border eats
 * into the curve, so the radius *inside* the bezel is the tile radius LESS the
 * border width. The picture is then centred in that inner box, and its own
 * radius is the inner radius LESS the margin of slab around it.
 *
 * Derived that way the picture's curve is concentric with the bezel's inner
 * curve: the gap between picture and brass is the same width at the corners as
 * it is along the flats, at every tile size. Seat the picture at any other
 * radius and the corners either pinch shut or the bezel crops the picture.
 *
 * Every surface that wears the picture names its tile here and asks for the
 * same derivation, so the rail, the room-list header plate, the Workspace
 * settings tile and the person's Settings identity tile cannot drift apart.
 * The identity tile is its own named constant — a human mark must not read
 * through a `WORKSPACE_` name. Coverage: `workspace-tile.test.ts` (the rule)
 * and the browser proofs that measure what each surface paints.
 */

export type WorkspaceTile = {
  /** The tile's full painted box, bezel included. */
  readonly size: number;
  /** The bezel's outer radius. */
  readonly radius: number;
  /** The bezel itself, which eats into that radius. */
  readonly borderWidth: number;
  /** The picture seated inside it. */
  readonly pictureSize: number;
};

export type WorkspacePictureSeat = {
  /** The radius inside the bezel: the tile radius less the border. */
  readonly innerRadius: number;
  /** The slab of tile left showing on every side of the picture. */
  readonly margin: number;
  readonly pictureSize: number;
  /** The picture's own radius, concentric with the bezel's inner curve. */
  readonly pictureRadius: number;
};

export function workspacePictureSeat(tile: WorkspaceTile): WorkspacePictureSeat {
  const innerRadius = tile.radius - tile.borderWidth;
  const margin = (tile.size - tile.borderWidth * 2 - tile.pictureSize) / 2;
  return {
    innerRadius,
    margin,
    pictureSize: tile.pictureSize,
    pictureRadius: innerRadius - margin,
  };
}

/** The reference tile: the desktop rail's, worn identically by the mobile
 *  Workspace drawer. Every other Workspace tile is this one rescaled. */
export const WORKSPACE_RAIL_TILE: WorkspaceTile = {
  size: 48,
  radius: 14,
  borderWidth: 2,
  pictureSize: 34,
};

/** The room-list header plate: the rail tile scaled to sit beside the
 *  Workspace name in the header (radius 14 × 34/48 ≈ 8). */
export const WORKSPACE_HEADER_PLATE: WorkspaceTile = {
  size: 34,
  radius: 8,
  borderWidth: 2,
  pictureSize: 26,
};

/** The Workspace settings tile: the same treatment at page scale, where the
 *  picture is also the control that changes it. */
export const WORKSPACE_SETTINGS_TILE: WorkspaceTile = {
  size: 76,
  radius: 20,
  borderWidth: 2,
  pictureSize: 64,
};

/** The person's Settings identity tile: the same geometry as the Workspace
 *  settings tile, named for a human mark so it does not read through a
 *  `WORKSPACE_` constant. */
export const IDENTITY_SETTINGS_TILE: WorkspaceTile = {
  size: 76,
  radius: 20,
  borderWidth: 2,
  pictureSize: 64,
};
