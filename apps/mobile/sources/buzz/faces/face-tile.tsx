/**
 * How a face becomes a tile — the two class treatments, composed exactly as
 * Speakeasy's `AvatarRenderer` composes its marks.
 *
 *  - A PERSON is a coloured creature on an ink plate: Speakeasy's drawing with
 *    BRASS swapped for the identity's signature hue, BONE and INK kept, and
 *    the contrast edge layer drawn BEHIND it (dark plate → BONE edge on INK
 *    shapes; light plate → INK edge on BONE shapes).
 *  - An AGENT is the same creature inverted: figure entirely INK on a plate
 *    filled with the agent's signature hue, the two eyes replaced by one BONE
 *    lens band. No edge layer is needed — ink on a coloured plate always
 *    contrasts.
 *
 * `components/buzz/IdentityMark.tsx` wraps these in the plate and the alive
 * ring; nothing else in the product draws a face.
 */

import React from 'react';
import { G } from 'react-native-svg';
import { BONE, FACES, INK, type FaceId } from './animals';
import { recolorEdge } from './edge';

export type FaceMode = 'dark' | 'light';

/** The person plate per theme mode — the approved contact sheet's grounds:
 *  a shade under the obsidian canvas, and the light cream. */
export const PERSON_PLATE: Record<FaceMode, string> = { dark: '#0f0a13', light: '#F5EEE2' };

/** The edge layer's colours per mode: (vanishing tone → contrast tone). */
export const EDGE_COLORS: Record<FaceMode, { target: string; edge: string }> = {
  dark: { target: INK, edge: BONE },
  light: { target: BONE, edge: INK },
};

/** A person's creature: hue-for-brass figure over its contrast edge layer. */
export function personFaceLayers(face: FaceId, hue: string, mode: FaceMode): React.ReactElement {
  const figure = FACES[face]({ palette: { brass: hue, bone: BONE, ink: INK }, eyes: 'drawn' });
  const { target, edge } = EDGE_COLORS[mode];
  return (
    <>
      <G testID="face-edge">{recolorEdge(figure, edge, target)}</G>
      <G testID="face-figure">{figure}</G>
    </>
  );
}

/** An agent's creature: all-ink figure with the lens band; the caller paints
 *  the plate in the agent's hue. */
export function agentFaceLayers(face: FaceId): React.ReactElement {
  return (
    <G testID="face-figure">
      {FACES[face]({ palette: { brass: INK, bone: INK, ink: INK }, eyes: 'lens' })}
    </G>
  );
}
