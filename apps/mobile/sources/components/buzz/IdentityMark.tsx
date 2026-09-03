import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { G, Rect } from 'react-native-svg';
import {
  CYPHER_MIN_SIZE,
  identityKindLabel,
  identityMarkGeometry,
  identityPalette,
  type CypherCell,
  type IdentityKind,
  type IdentityPalette,
} from '@/buzz/identity-mark';
import { resolveFace } from '@/buzz/faces';
import { PERSON_PLATE, agentFaceLayers, personFaceLayers } from '@/buzz/faces/face-tile';
import { WORKSPACE_PICTURES_ENABLED } from '@/buzz/photo-overrides';
import { HullLivePulse } from './MonoHull';
import { useUnistyles } from 'react-native-unistyles';

type IdentityMarkBaseProps = {
  /** The identity's stable seed: a pubkey for an agent or a person, the
   *  community id for a Workspace. Same seed, same mark, forever. */
  seed: string;
  size?: number;
  /** Workspace-rail selection: the mark's own heavier frame (`DESIGN.md`,
   *  "Index rows" — selection reads three redundant ways, none a box). */
  selected?: boolean;
  name?: string;
  avatarUrl?: string;
  testID?: string;
};

type FaceProps = {
  /** The creature this identity chose (`RoomViewIdentity.face`). Absent or
   *  unknown → `defaultFaceForSeed(seed)`, so every reader draws the same one. */
  face?: string;
};

// Gold means ONE thing product-wide: a live agent. The discriminated union is
// that rule enforced at the type level — no human or Workspace mark can carry
// `alive`, so a future boolean pass cannot redefine gold without a type error.
export type AgentIdentityMarkProps = IdentityMarkBaseProps &
  FaceProps & {
    kind: 'agent';
    /** An agent working right now. Draws the gold ring; never touches colour. */
    alive?: boolean;
  };
export type HumanIdentityMarkProps = IdentityMarkBaseProps & FaceProps & { kind: 'human' };
export type WorkspaceIdentityMarkProps = IdentityMarkBaseProps & {
  kind: Exclude<IdentityKind, 'agent' | 'human'>;
};
export type NonAgentIdentityMarkProps = HumanIdentityMarkProps | WorkspaceIdentityMarkProps;
export type IdentityMarkProps = AgentIdentityMarkProps | NonAgentIdentityMarkProps;

// ── The face tile ────────────────────────────────────────────────────────────
//
// People and agents are Speakeasy's twelve creatures (`buzz/faces`). The tile
// is a square plate at the house radius; the plate's polarity is the class:
// a coloured creature on ink is a person, an ink creature on colour is an
// agent. The gold alive ring is drawn around the plate.

/** The one box radius in the product (`groknight.radius`). */
const FACE_PLATE_RADIUS = 3;
/** How far outside the plate the alive ring sits, in px. */
const ALIVE_RING_PAD = 4;

// ── The Workspace plate ──────────────────────────────────────────────────────

const SQUARE_INSET = 12;
const SQUARE_SIDE = 100 - SQUARE_INSET * 2;

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

function cellFill(cell: CypherCell, palette: IdentityPalette): string {
  // Hollow already has a deep field, where these pixels merge exactly as they
  // did before the fill axis. Painting them explicitly preserves that same
  // deep-tone cypher when the solid or half field behind it becomes lighter.
  if (cell.tone === 'void') return palette.deep;
  return cell.tone === 'bright' ? palette.bright : palette.mid;
}

function WorkspacePlate({
  seed,
  size,
  selected,
}: {
  seed: string;
  size: number;
  selected: boolean;
}): React.ReactElement {
  const { palette, fillState, cells, rotation } = identityMarkGeometry(seed, 'workspace');
  // Below the cypher floor the colour and the silhouette *are* the identity,
  // so the mark goes solid rather than muddy.
  const detailed = size >= CYPHER_MIN_SIZE;
  // The fill axis needs a coarse field, not another small detail. Solid and
  // hollow use the full silhouette; half overlays its left half. Below the
  // cypher floor the mark keeps the existing solid-size fallback.
  const visibleFillState = detailed ? fillState : 'solid';
  const bodyFill = visibleFillState === 'solid' ? palette.mid : palette.deep;
  const frameStroke = selected ? palette.bright : detailed ? palette.mid : palette.bright;
  const frameWidth = selected ? 6 : 3.5;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Rect
        x={SQUARE_INSET}
        y={SQUARE_INSET}
        width={SQUARE_SIDE}
        height={SQUARE_SIDE}
        fill={bodyFill}
      />
      {visibleFillState === 'half' && (
        <Rect
          x={SQUARE_INSET}
          y={SQUARE_INSET}
          width={SQUARE_SIDE / 2}
          height={SQUARE_SIDE}
          fill={palette.mid}
        />
      )}
      <Rect
        x={SQUARE_INSET}
        y={SQUARE_INSET}
        width={SQUARE_SIDE}
        height={SQUARE_SIDE}
        fill="none"
        stroke={frameStroke}
        strokeWidth={frameWidth}
        strokeLinejoin="miter"
      />
      {detailed && (
        <G rotation={rotation * 90} origin="50, 50">
          {cells.map((cell, index) => {
            const fill = cellFill(cell, palette);
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
    </Svg>
  );
}

/**
 * The one identity mark in the product. Every avatar, handle mark, presence
 * dot, rail tile and corner top-bar renders this — there is no per-surface
 * variant, because "the amber fox" has to mean the same person on every
 * screen or the face is not a memory hook at all.
 *
 * Memoized for the same reason the marks it replaces were: it is rendered once
 * per transcript row inside a `renderItem` that is recreated on every presence
 * tick, and rebuilding a creature per row per tick is exactly the work that
 * froze the transcript. Every prop is a primitive, so a shallow compare bails
 * correctly.
 */
export const IdentityMark = React.memo(function IdentityMark(props: IdentityMarkProps) {
  const { seed, kind, size = 40, selected = false, name, avatarUrl, testID } = props;
  // Defensive, not just typed: even a value smuggled past the union at runtime
  // (an untyped caller, a stale bundle) can only ever light gold on an agent.
  const alive = props.kind === 'agent' ? Boolean(props.alive) : false;
  const live = kind === 'agent' && alive;
  const { theme } = useUnistyles();
  const groknight = theme.buzz;
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  // Workspace pictures are the sole photo exception. Human and agent relay
  // photos stay inert even when an untyped/stale caller supplies avatarUrl.
  const showRelayAvatar =
    WORKSPACE_PICTURES_ENABLED &&
    kind === 'workspace' &&
    Boolean(avatarUrl && failedAvatar !== avatarUrl);

  useEffect(() => setFailedAvatar(null), [avatarUrl]);

  const label = `${name ?? identityKindLabel(kind)}, ${identityKindLabel(kind)}${live ? ', working' : ''}`;

  if (kind === 'workspace') {
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
          <WorkspacePlate seed={seed} size={size} selected={selected} />
        )}
      </View>
    );
  }

  const face = resolveFace(props.face, seed);
  const palette = identityPalette(seed, kind);
  const mode = groknight.dark ? 'dark' : 'light';
  // Plate polarity IS the class read: ink plate under a coloured person, hue
  // plate under an ink agent.
  const plate = kind === 'agent' ? palette.mid : PERSON_PLATE[mode];
  const ringSide = size + ALIVE_RING_PAD * 2;

  return (
    <View
      accessibilityLabel={label}
      style={[styles.frame, { width: size, height: size }]}
      testID={testID}
    >
      <View
        style={[styles.plate, { width: size, height: size, backgroundColor: plate }]}
        testID="identity-face-plate"
      >
        <Svg width={size} height={size} viewBox="0 0 100 100">
          {kind === 'agent' ? agentFaceLayers(face) : personFaceLayers(face, palette.mid, mode)}
        </Svg>
      </View>

      {/*
        Gold means one thing product-wide: an agent is alive. It is drawn
        *around* the plate, never on the creature or its colour, so it can
        never be confused with the identity underneath — who you are and what
        you are doing stay two separate reads. It breathes on the shared live
        clock, and is mounted only when something is genuinely live, so a
        quiet row pays for no animation at all.
      */}
      {live && (
        <HullLivePulse style={styles.aliveRing}>
          <Svg width={ringSide} height={ringSide} viewBox={`0 0 ${ringSide} ${ringSide}`}>
            <Rect
              x={2}
              y={2}
              width={ringSide - 4}
              height={ringSide - 4}
              rx={FACE_PLATE_RADIUS + 2}
              fill="none"
              stroke={groknight.accent}
              strokeWidth={4}
              opacity={0.14}
            />
            <Rect
              x={2}
              y={2}
              width={ringSide - 4}
              height={ringSide - 4}
              rx={FACE_PLATE_RADIUS + 2}
              fill="none"
              stroke={groknight.accent}
              strokeWidth={1.5}
            />
          </Svg>
        </HullLivePulse>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  // No border, no fill, no radius on the frame itself: for a Workspace the
  // plate's own silhouette is the shape; for a face the tile plate below is
  // the one box, at the house radius.
  frame: { alignItems: 'center', justifyContent: 'center' },
  plate: { borderRadius: FACE_PLATE_RADIUS, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  aliveRing: {
    position: 'absolute',
    left: -ALIVE_RING_PAD,
    top: -ALIVE_RING_PAD,
    right: -ALIVE_RING_PAD,
    bottom: -ALIVE_RING_PAD,
  },
});
