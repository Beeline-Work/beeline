/**
 * How a face becomes a tile — the two class treatments, composed exactly as
 * Speakeasy's `AvatarRenderer` composes its marks. Both draw the whole
 * creature, eyes included; only where the signature hue sits changes.
 *
 *  - A PERSON is a coloured creature on an ink plate: Speakeasy's drawing with
 *    BRASS swapped for the identity's signature hue, BONE and INK kept, and
 *    the contrast edge layer drawn BEHIND it (dark plate → BONE edge on INK
 *    shapes; light plate → INK edge on BONE shapes).
 *  - An AGENT is the same creature with the hue moved out from under it: the
 *    figure takes BONE wherever the person's carries the hue, keeps INK, and
 *    stands on a plate filled with the agent's own hue. Plate polarity is
 *    still the class read — a coloured creature on ink is a person, a bone
 *    creature on colour is an agent — but the species and the eyes now
 *    survive the inversion. The agent plate is always a light hue
 *    (`identityPalette`: lightness ≈0.62), so the figure takes the LIGHT
 *    edge layer in either theme: an INK hairline under the bone shapes that
 *    would otherwise soften into the plate. Ink shapes need none.
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

/** Figure over its contrast edge layer — the one composition both classes use. */
function faceLayers(figure: React.ReactElement, mode: FaceMode): React.ReactElement {
  const { target, edge } = EDGE_COLORS[mode];
  return (
    <>
      <G testID="face-edge">{recolorEdge(figure, edge, target)}</G>
      <G testID="face-figure">{figure}</G>
    </>
  );
}

/** A person's creature: hue-for-brass figure over its contrast edge layer. */
export function personFaceLayers(face: FaceId, hue: string, mode: FaceMode): React.ReactElement {
  return faceLayers(FACES[face]({ palette: { brass: hue, bone: BONE, ink: INK } }), mode);
}

/** An agent's creature: the same drawing in bone and ink, edged for the light
 *  plate; the caller paints that plate in the agent's hue. */
export function agentFaceLayers(face: FaceId): React.ReactElement {
  return faceLayers(FACES[face]({ palette: { brass: BONE, bone: BONE, ink: INK } }), 'light');
}
