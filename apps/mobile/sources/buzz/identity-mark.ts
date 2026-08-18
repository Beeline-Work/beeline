/**
 * The identity-mark system: one deterministic mark per identity, built from
 * four independent axes so that recognising someone never depends on reading
 * a name.
 *
 *   1. SHAPE reports the *type*, instantly and pre-verbally.
 *        △ agent (angular, engineered)  ○ human (organic)  ▢ workspace (structural)
 *   2. COLOUR is the *memory* hook — "beebee is the amber one". One curated,
 *      well-separated, low-saturation palette, assigned deterministically.
 *   3. The CYPHER interior is the *uniqueness* tiebreak: a coarse hashed
 *      primitive grid, nine cells, drawn in tones of the signature colour.
 *   4. A gold RING means *alive* — an agent working right now. It is drawn
 *      outside the silhouette and never touches the identity colour, so
 *      "who this is" and "what it is doing" stay two separate reads.
 *
 * Everything here is pure and free of React Native, so the whole system is
 * unit-testable without a renderer. `components/buzz/IdentityMark.tsx` is the
 * single component that draws it.
 */

export type IdentityKind = 'agent' | 'human' | 'workspace';

/** A cell of the cypher grid. `void` is not drawn — the mark's own deep tone
 *  shows through, so a void reads as shadow rather than as a hole in the slab. */
export type CypherTone = 'void' | 'mid' | 'bright';

/** Speakeasy's primitive vocabulary, used by the workspace square only: a
 *  machined plate, not a QR code. Adopted from `RoomMark.tsx`'s 3×3 approach. */
export type CypherPrimitive = 'block' | 'slot-h' | 'slot-v' | 'cut';

export type CypherCell = {
  tone: CypherTone;
  primitive: CypherPrimitive;
};

export type IdentityPalette = {
  /** The signature colour itself — what the eye remembers. */
  mid: string;
  /** One luminance step up; the lit facets of the cypher. */
  bright: string;
  /** The mark's body, and what a `void` cell shows. Same hue, far down. */
  deep: string;
  /** Which curated hue this identity landed on. Exposed for tests and docs. */
  hueIndex: number;
  /** The hue in degrees, after the kind's temperament shift. */
  hue: number;
};

export type IdentityMarkGeometry = {
  kind: IdentityKind;
  palette: IdentityPalette;
  cells: CypherCell[];
  /** Quarter-turn steps applied to the cypher, so two identities sharing a
   *  hue and a similar cell run still resolve apart. */
  rotation: number;
};

/**
 * FNV-1a 32-bit — the same hash speakeasy's `RoomMark` uses, chosen for the
 * same reason: stable across runs and platforms, no crypto guarantees needed,
 * good dispersion over a small primitive space.
 */
export function fnv1a32(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * A 32-bit hash is 32 bits, and the mark needs more than that (nine cells ×
 * two axes, plus hue, tone and rotation). `mulberry32` turns the seed into an
 * arbitrarily long deterministic stream so no axis has to share bits with
 * another — two identities that collide on hue are still independently
 * re-rolled on every cell.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sixteen hue anchors — ember, terracotta, amber, olive, moss, fern, jade, sea,
 * teal, steel, dusk, indigo, iris, orchid, plum, rose — spread around the whole
 * wheel with a hard 20° floor between neighbours, and nudged off the zones that
 * die on a near-black slab (pure yellow, pure blue).
 *
 * This is the entire reason the palette is curated rather than hashed: a raw
 * `hash % 360` hue clusters, and three identities in one list came out as three
 * near-identical purples. Here, two identities are either the *same* signature
 * or at least ~19° apart after the temperament shift below — there is no such
 * thing as "almost the same colour" in this system.
 *
 * The array is deliberately stored in a scrambled order rather than in hue
 * order, so even a seed distribution that correlates adjacent indices cannot
 * produce adjacent hues.
 */
const HUE_WHEEL = [8, 162, 310, 116, 264, 70, 224, 28, 184, 340, 140, 286, 92, 244, 48, 204] as const;

/**
 * The kind's temperament. Agents run warmer and a step more saturated; humans
 * run cooler and greyer — a quiet second reading of the same type the shape
 * already states outright. Workspaces run most neutral of all: they are
 * structure, and structure should not compete with the people inside it.
 *
 * The hue blend is small on purpose. At 14% toward a pole the sixteen anchors
 * still land ~19° apart, so the whole agent set feels warm without any two
 * agents converging.
 */
const TEMPERAMENT: Record<
  IdentityKind,
  { pole: number; blend: number; saturation: number; lightness: number }
> = {
  agent: { pole: 40, blend: 0.14, saturation: 0.42, lightness: 0.62 },
  human: { pole: 214, blend: 0.14, saturation: 0.24, lightness: 0.6 },
  workspace: { pole: 214, blend: 0.06, saturation: 0.15, lightness: 0.58 },
};

/** Blend a hue toward a pole along the shorter arc. */
function blendHue(hue: number, pole: number, amount: number): number {
  const delta = (((pole - hue + 540) % 360) - 180) * amount;
  return (hue + delta + 360) % 360;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] = (
    [
      [chroma, second, 0],
      [second, chroma, 0],
      [0, chroma, second],
      [0, second, chroma],
      [second, 0, chroma],
      [chroma, 0, second],
    ] as const
  )[Math.floor(sector) % 6]!;
  const match = lightness - chroma / 2;
  const channel = (value: number) =>
    Math.round(Math.min(255, Math.max(0, (value + match) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * The signature colour for one identity. Deterministic, and stable forever for
 * a given seed — a pubkey for a person or an agent, a community id for a
 * Workspace.
 */
export function identityPalette(seed: string, kind: IdentityKind): IdentityPalette {
  const random = mulberry32(fnv1a32(`${kind}:${seed}`));
  const hueIndex = Math.floor(random() * HUE_WHEEL.length) % HUE_WHEEL.length;
  const temperament = TEMPERAMENT[kind];
  const hue = blendHue(HUE_WHEEL[hueIndex]!, temperament.pole, temperament.blend);
  // One of three luminance registers, so two identities that do land on the
  // same hue still separate at a glance without a second hue being invented.
  const register = Math.floor(random() * 3);
  const lightness = temperament.lightness + (register - 1) * 0.06;
  return {
    hueIndex,
    hue,
    mid: hslToHex(hue, temperament.saturation, lightness),
    bright: hslToHex(hue, temperament.saturation * 0.92, Math.min(0.82, lightness + 0.15)),
    // Deep enough to sit quietly on the slab, saturated enough that a mark
    // full of voids still reads as *its* colour rather than as grey.
    deep: hslToHex(hue, temperament.saturation * 0.78, 0.15),
  };
}

/** Nine cells for every shape — the triangular mesh, the radial rings, and the
 *  3×3 plate all carry the same amount of information, so no type is a weaker
 *  tiebreak than another. Deliberately coarse: it must survive 24px. */
export const CYPHER_CELLS = 9;

const PRIMITIVES: readonly CypherPrimitive[] = ['block', 'slot-h', 'slot-v', 'cut'];

export function identityMarkGeometry(seed: string, kind: IdentityKind): IdentityMarkGeometry {
  const palette = identityPalette(seed, kind);
  // A separate stream from the palette's, so hue and interior are independent:
  // two identities on the same hue get unrelated cypher grids.
  const random = mulberry32(fnv1a32(`${kind}:cypher:${seed}`));
  const cells: CypherCell[] = [];
  for (let index = 0; index < CYPHER_CELLS; index += 1) {
    const roll = random();
    // ~28% void, ~46% mid, ~26% bright: enough shadow for texture, enough
    // fill that the mark never looks half-drawn.
    const tone: CypherTone = roll < 0.28 ? 'void' : roll < 0.74 ? 'mid' : 'bright';
    cells.push({ tone, primitive: PRIMITIVES[Math.floor(random() * PRIMITIVES.length)]! });
  }
  return { kind, palette, cells, rotation: Math.floor(random() * 4) };
}

/**
 * Below this the cypher is dropped and the mark renders as a solid signature
 * shape. That is not a degradation: at transcript-handle and presence-dot
 * sizes the colour and silhouette *are* the identity, and nine cells of
 * ~4px would only mud them.
 */
export const CYPHER_MIN_SIZE = 24;

export function identityKindLabel(kind: IdentityKind): string {
  return kind === 'agent' ? 'agent' : kind === 'human' ? 'person' : 'workspace';
}
