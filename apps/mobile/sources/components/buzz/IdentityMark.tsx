import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path, Polygon, Rect } from 'react-native-svg';
import {
  CYPHER_MIN_SIZE,
  identityKindLabel,
  identityMarkGeometry,
  type CypherCell,
  type IdentityKind,
  type IdentityPalette,
} from '@/buzz/identity-mark';
import { groknight } from '@/buzz/groknight';
import { HullLivePulse } from './MonoHull';

type IdentityMarkProps = {
  /** The identity's stable seed: a pubkey for an agent or a person, the
   *  community id for a Workspace. Same seed, same mark, forever. */
  seed: string;
  kind: IdentityKind;
  size?: number;
  /** An agent working right now. Draws the gold ring; never touches colour. */
  alive?: boolean;
  /** Workspace-rail selection: the mark's own heavier frame (`DESIGN.md`,
   *  "Index rows" — selection reads three redundant ways, none a box). */
  selected?: boolean;
  name?: string;
  avatarUrl?: string;
  testID?: string;
};

// ── The three silhouettes, in one 0–100 viewBox ──────────────────────────────
//
// Every shape is drawn inside the same box at the same optical weight, so a
// list of mixed types reads as one system rather than three sizes. The gold
// alive ring is a concentric offset of the mark's *own* silhouette — a circle
// halo around a triangle would blunt exactly the shape read the system is
// built on.

const TRIANGLE_APEX_Y = 17.1;
const TRIANGLE_BASE_Y = 82.9;
const TRIANGLE_CENTROID_Y = (TRIANGLE_APEX_Y + TRIANGLE_BASE_Y * 2) / 3;
const TRIANGLE = `50,${TRIANGLE_APEX_Y} 88,${TRIANGLE_BASE_Y} 12,${TRIANGLE_BASE_Y}`;
const TRIANGLE_RING = '50,6.1 97.5,88.4 2.5,88.4';

const CIRCLE_RADIUS = 38;
const CIRCLE_RING_RADIUS = 45.5;

const SQUARE_INSET = 12;
const SQUARE_SIDE = 100 - SQUARE_INSET * 2;
const SQUARE_RING_INSET = 2.5;

/** Scale a point about the triangle's centroid — how the mesh is inset. */
function triangleScaled(scale: number): { apexY: number; baseY: number; left: number; right: number } {
  const at = (value: number, center: number) => center + (value - center) * scale;
  return {
    apexY: at(TRIANGLE_APEX_Y, TRIANGLE_CENTROID_Y),
    baseY: at(TRIANGLE_BASE_Y, TRIANGLE_CENTROID_Y),
    left: at(12, 50),
    right: at(88, 50),
  };
}

/**
 * The agent cypher: a triangular mesh, three rows deep — 6 upward and 3
 * downward cells. Nine, like the other two shapes, so no type carries less
 * uniqueness than another.
 */
function triangleMeshCells(): string[] {
  const { apexY, baseY, left, right } = triangleScaled(0.72);
  const rowHeight = (baseY - apexY) / 3;
  const lattice = (row: number, index: number): [number, number] => {
    const y = apexY + rowHeight * row;
    if (row === 0) return [50, y];
    const rowLeft = 50 + (left - 50) * (row / 3);
    const rowRight = 50 + (right - 50) * (row / 3);
    return [rowLeft + ((rowRight - rowLeft) * index) / row, y];
  };
  // Each cell shrinks about its own centre so the grid reads as *cells*. Left
  // edge-to-edge, two adjacent same-tone cells merge into one blob and the
  // cypher stops being a cypher.
  const cell = (...corners: Array<[number, number]>) => {
    const cx = corners.reduce((sum, [x]) => sum + x, 0) / corners.length;
    const cy = corners.reduce((sum, [, y]) => sum + y, 0) / corners.length;
    return corners
      .map(([x, y]) =>
        `${(cx + (x - cx) * 0.82).toFixed(1)},${(cy + (y - cy) * 0.82).toFixed(1)}`,
      )
      .join(' ');
  };
  const cells: string[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let index = 0; index <= row; index += 1) {
      cells.push(cell(lattice(row, index), lattice(row + 1, index), lattice(row + 1, index + 1)));
    }
    for (let index = 0; index < row; index += 1) {
      cells.push(cell(lattice(row, index), lattice(row, index + 1), lattice(row + 1, index + 1)));
    }
  }
  return cells;
}

const TRIANGLE_MESH = triangleMeshCells();

/**
 * The human cypher: radial rings × sectors — 3 inner wedges inside 6 outer
 * ones. Concentric where the agent's is faceted, so the two interiors stay
 * distinguishable even out of the corner of the eye.
 */
function radialCells(): string[] {
  const polar = (radius: number, degrees: number) => {
    const radians = ((degrees - 90) * Math.PI) / 180;
    return `${(50 + radius * Math.cos(radians)).toFixed(2)},${(50 + radius * Math.sin(radians)).toFixed(2)}`;
  };
  // Same reason as the mesh above: every cell is cut back from its neighbours
  // so the rings and sectors stay countable instead of fusing into a disc.
  const core = 14;
  const gapDegrees = 5;
  const inner = 17.5;
  const outer = 30;
  const cells = Array.from({ length: 3 }, (_, index) => {
    const from = index * 120 + gapDegrees;
    const to = (index + 1) * 120 - gapDegrees;
    return `M 50,50 L ${polar(core, from)} A ${core} ${core} 0 0 1 ${polar(core, to)} Z`;
  });
  for (let index = 0; index < 6; index += 1) {
    const from = index * 60 + gapDegrees;
    const to = (index + 1) * 60 - gapDegrees;
    cells.push(
      `M ${polar(inner, from)} L ${polar(outer, from)} A ${outer} ${outer} 0 0 1 ${polar(outer, to)} L ${polar(inner, to)} A ${inner} ${inner} 0 0 0 ${polar(inner, from)} Z`,
    );
  }
  return cells;
}

const RADIAL_MESH = radialCells();

/** The workspace cypher: speakeasy's 3×3 primitive plate — block, slot, cut,
 *  void — in our tones. A machined plate, never a QR code. */
const PLATE_ORIGIN = 22;
const PLATE_CELL = 56 / 3;

function plateRects(cell: CypherCell, index: number): Array<[number, number, number, number]> {
  const x = PLATE_ORIGIN + (index % 3) * PLATE_CELL;
  const y = PLATE_ORIGIN + Math.floor(index / 3) * PLATE_CELL;
  const inset = 1.6;
  const span = PLATE_CELL - inset * 2;
  switch (cell.primitive) {
    case 'slot-h':
      return [[x + inset, y + PLATE_CELL / 2 - PLATE_CELL / 6, span, PLATE_CELL / 3]];
    case 'slot-v':
      return [[x + PLATE_CELL / 2 - PLATE_CELL / 6, y + inset, PLATE_CELL / 3, span]];
    case 'cut':
      return [
        [x + inset, y + inset, span, PLATE_CELL / 3 - 1.4],
        [x + inset, y + PLATE_CELL / 2 + 1.4, span, PLATE_CELL / 3 - 1.4],
      ];
    default:
      return [[x + inset, y + inset, span, span]];
  }
}

function cellFill(cell: CypherCell, palette: IdentityPalette): string | null {
  if (cell.tone === 'void') return null;
  return cell.tone === 'bright' ? palette.bright : palette.mid;
}

/**
 * The one identity mark in the product. Every avatar, handle mark, presence
 * dot, rail tile and corner top-bar renders this — there is no per-surface
 * variant, because "the amber triangle" has to mean the same agent on every
 * screen or the colour is not a memory hook at all.
 *
 * Memoized for the same reason the marks it replaces were: it is rendered once
 * per transcript row inside a `renderItem` that is recreated on every presence
 * tick, and rebuilding nine SVG cells per row per tick is exactly the work
 * that froze the transcript. Every prop is a primitive, so a shallow compare
 * bails correctly.
 */
export const IdentityMark = React.memo(function IdentityMark({
  seed,
  kind,
  size = 40,
  alive = false,
  selected = false,
  name,
  avatarUrl,
  testID,
}: IdentityMarkProps) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showRelayAvatar =
    groknight.photoIdentityMarksEnabled && Boolean(avatarUrl && failedAvatar !== avatarUrl);
  const { palette, cells, rotation } = identityMarkGeometry(seed, kind);
  // Below the cypher floor the colour and the silhouette *are* the identity,
  // so the mark goes solid rather than muddy.
  const detailed = size >= CYPHER_MIN_SIZE;
  const bodyFill = detailed ? palette.deep : palette.mid;
  const frameStroke = selected ? palette.bright : detailed ? palette.mid : palette.bright;
  const frameWidth = selected ? 6 : 3.5;

  useEffect(() => setFailedAvatar(null), [avatarUrl]);

  const label = `${name ?? identityKindLabel(kind)}, ${identityKindLabel(kind)}${alive ? ', working' : ''}`;

  return (
    <View
      accessibilityLabel={label}
      style={[styles.frame, { width: size, height: size }]}
      testID={testID}
    >
      {showRelayAvatar ? (
        <Image
          onError={() => setFailedAvatar(avatarUrl ?? null)}
          resizeMode="cover"
          source={{ uri: avatarUrl! }}
          style={styles.image}
        />
      ) : (
        <Svg width={size} height={size} viewBox="0 0 100 100">
          {kind === 'agent' && (
            <>
              <Polygon
                points={TRIANGLE}
                fill={bodyFill}
                stroke={frameStroke}
                strokeWidth={frameWidth}
                strokeLinejoin="miter"
              />
              {detailed && (
                <G rotation={rotation * 120} origin={`50, ${TRIANGLE_CENTROID_Y}`}>
                  {TRIANGLE_MESH.map((points, index) => {
                    const fill = cellFill(cells[index]!, palette);
                    return fill ? <Polygon key={points} points={points} fill={fill} /> : null;
                  })}
                </G>
              )}
            </>
          )}

          {kind === 'human' && (
            <>
              <Circle
                cx="50"
                cy="50"
                r={CIRCLE_RADIUS}
                fill={bodyFill}
                stroke={frameStroke}
                strokeWidth={frameWidth}
              />
              {detailed && (
                <G rotation={rotation * 30} origin="50, 50">
                  {RADIAL_MESH.map((d, index) => {
                    const fill = cellFill(cells[index]!, palette);
                    return fill ? <Path key={d} d={d} fill={fill} /> : null;
                  })}
                </G>
              )}
            </>
          )}

          {kind === 'workspace' && (
            <>
              <Rect
                x={SQUARE_INSET}
                y={SQUARE_INSET}
                width={SQUARE_SIDE}
                height={SQUARE_SIDE}
                fill={bodyFill}
                stroke={frameStroke}
                strokeWidth={frameWidth}
                strokeLinejoin="miter"
              />
              {detailed && (
                <G rotation={rotation * 90} origin="50, 50">
                  {cells.map((cell, index) => {
                    const fill = cellFill(cell, palette);
                    if (!fill) return null;
                    return plateRects(cell, index).map(([x, y, width, height]) => (
                      <Rect
                        key={`${index}-${x}-${y}`}
                        x={x}
                        y={y}
                        width={width}
                        height={height}
                        fill={fill}
                      />
                    ));
                  })}
                </G>
              )}
            </>
          )}
        </Svg>
      )}

      {/*
        Gold means one thing product-wide: an agent is alive. It is drawn
        *outside* the silhouette, in the mark's own shape, so it can never be
        confused with the identity colour underneath — who you are and what
        you are doing stay two separate reads. It breathes on the shared live
        clock, and is mounted only when something is genuinely live, so a
        quiet row pays for no animation at all.
      */}
      {alive && (
        <HullLivePulse style={styles.aliveRing}>
          <Svg width={size} height={size} viewBox="0 0 100 100">
            {kind === 'agent' && (
              <>
                <Polygon points={TRIANGLE_RING} fill="none" stroke={groknight.accent} strokeWidth={8} opacity={0.14} />
                <Polygon points={TRIANGLE_RING} fill="none" stroke={groknight.accent} strokeWidth={3} strokeLinejoin="miter" />
              </>
            )}
            {kind === 'human' && (
              <>
                <Circle cx="50" cy="50" r={CIRCLE_RING_RADIUS} fill="none" stroke={groknight.accent} strokeWidth={8} opacity={0.14} />
                <Circle cx="50" cy="50" r={CIRCLE_RING_RADIUS} fill="none" stroke={groknight.accent} strokeWidth={3} />
              </>
            )}
            {kind === 'workspace' && (
              <>
                <Rect
                  x={SQUARE_RING_INSET}
                  y={SQUARE_RING_INSET}
                  width={100 - SQUARE_RING_INSET * 2}
                  height={100 - SQUARE_RING_INSET * 2}
                  fill="none"
                  stroke={groknight.accent}
                  strokeWidth={8}
                  opacity={0.14}
                />
                <Rect
                  x={SQUARE_RING_INSET}
                  y={SQUARE_RING_INSET}
                  width={100 - SQUARE_RING_INSET * 2}
                  height={100 - SQUARE_RING_INSET * 2}
                  fill="none"
                  stroke={groknight.accent}
                  strokeWidth={3}
                  strokeLinejoin="miter"
                />
              </>
            )}
          </Svg>
        </HullLivePulse>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  // No border, no fill, no radius: the mark's own silhouette is the shape,
  // and a box around an avatar is exactly what DESIGN.md retires.
  frame: { alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  aliveRing: { ...StyleSheet.absoluteFillObject },
});
