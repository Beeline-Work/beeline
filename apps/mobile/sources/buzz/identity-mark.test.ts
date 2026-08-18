import { describe, expect, it } from 'vitest';
import {
  CYPHER_CELLS,
  identityMarkGeometry,
  identityPalette,
  type IdentityKind,
} from './identity-mark';

const PUBKEYS = Array.from({ length: 48 }, (_, index) =>
  index.toString(16).padStart(2, '0').repeat(32),
);

/** Shortest arc between two hues, in degrees. */
function hueDistance(a: number, b: number): number {
  return Math.abs((((a - b + 540) % 360) - 180));
}

describe('the signature colour is a memory hook', () => {
  it('gives one identity the same colour forever', () => {
    const first = identityPalette(PUBKEYS[3]!, 'agent');
    expect(identityPalette(PUBKEYS[3]!, 'agent')).toEqual(first);
    expect(identityPalette(PUBKEYS[4]!, 'agent')).not.toEqual(first);
  });

  it('spaces two identities’ hues instead of hashing them into a cluster', () => {
    // The whole point of a curated palette: a raw hash→hue put three
    // identities on three near-identical purples. Here two identities either
    // share a signature outright or sit a clearly readable distance apart —
    // there is no such thing as "almost the same colour" in this system.
    for (const kind of ['agent', 'human', 'workspace'] as IdentityKind[]) {
      for (let i = 0; i < PUBKEYS.length; i += 1) {
        for (let j = i + 1; j < PUBKEYS.length; j += 1) {
          const a = identityPalette(PUBKEYS[i]!, kind);
          const b = identityPalette(PUBKEYS[j]!, kind);
          if (a.hueIndex === b.hueIndex) continue;
          expect(hueDistance(a.hue, b.hue)).toBeGreaterThan(15);
        }
      }
    }
  });

  it('actually spends the whole palette rather than collapsing onto a few hues', () => {
    const used = new Set(PUBKEYS.map((pubkey) => identityPalette(pubkey, 'agent').hueIndex));
    expect(used.size).toBeGreaterThanOrEqual(12);
  });

  it('spreads a Workspace’s agents across the wheel instead of piling into one purple corridor', () => {
    // Four real agents in one Workspace (standing in for the reported
    // on-device roster — Joy, Beebee, Sumo, Xian) each hashed independently
    // onto one of the wheel's violet/magenta/pink anchors and all read as
    // some flavour of purple. These names are representative, not the
    // literal on-device pubkeys, but exercise the identical mechanism.
    const workspaceAgents = [
      'joy-agent-pubkey',
      'beebee-agent-pubkey',
      'sumo-agent-pubkey',
      'xian-agent-pubkey',
    ];
    const hues = workspaceAgents.map((seed) => identityPalette(seed, 'agent').hue);
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        // Comfortably past the system's general "clearly readable" bar
        // (>15°): a Workspace-sized roster must not just clear that bar, it
        // must land in visibly different hue families.
        expect(hueDistance(hues[i]!, hues[j]!)).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it('keeps the low-discriminability violet/magenta/pink corridor a minority of the wheel', () => {
    // Muted violet and magenta read as one "purple" family to most eyes even
    // spaced ~20° apart, so that corridor (240°–360°) must stay a minority
    // of the anchors an agent can land on — a prior wheel spent more than a
    // third of its anchors there, which is exactly what produced four
    // same-Workspace agents all reading as purple.
    const bigSample = Array.from({ length: 500 }, (_, index) => `agent-corridor-sample-${index}`);
    const inCorridor = bigSample
      .map((seed) => identityPalette(seed, 'agent').hue)
      .filter((hue) => hue >= 240 && hue < 360).length;
    expect(inCorridor / bigSample.length).toBeLessThan(0.3);
  });

  it('runs agents warm and saturated, people cool and grey', () => {
    // A quiet second reading of the type the shape already states outright.
    const warmth = (kind: IdentityKind) => {
      const hues = PUBKEYS.map((pubkey) => identityPalette(pubkey, kind).hue);
      return hues.filter((hue) => hue < 90 || hue > 300).length / hues.length;
    };
    expect(warmth('agent')).toBeGreaterThan(warmth('human'));

    const saturation = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [
        number,
        number,
        number,
      ];
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    for (const pubkey of PUBKEYS.slice(0, 12)) {
      const agent = saturation(identityPalette(pubkey, 'agent').mid);
      const human = saturation(identityPalette(pubkey, 'human').mid);
      const workspace = saturation(identityPalette(pubkey, 'workspace').mid);
      expect(agent).toBeGreaterThan(human);
      expect(human).toBeGreaterThan(workspace);
      // Muted, never neon: these have to sit inside the obsidian world.
      expect(agent).toBeLessThan(0.45);
    }
  });

  it('keeps the same identity distinguishable across types', () => {
    // A person and an agent that happen to share a seed must not read as the
    // same identity in a mixed list.
    expect(identityPalette(PUBKEYS[7]!, 'agent').mid).not.toBe(
      identityPalette(PUBKEYS[7]!, 'human').mid,
    );
  });
});

describe('the cypher is the uniqueness tiebreak', () => {
  it('is a coarse nine-cell grid, deterministic per identity', () => {
    const first = identityMarkGeometry(PUBKEYS[9]!, 'agent');
    expect(first.cells).toHaveLength(CYPHER_CELLS);
    expect(identityMarkGeometry(PUBKEYS[9]!, 'agent')).toEqual(first);
  });

  it('re-rolls independently of the hue, so a shared colour still resolves', () => {
    const sameHue = PUBKEYS.filter(
      (pubkey) => identityPalette(pubkey, 'agent').hueIndex === identityPalette(PUBKEYS[0]!, 'agent').hueIndex,
    );
    const signatures = new Set(
      sameHue.map((pubkey) =>
        identityMarkGeometry(pubkey, 'agent')
          .cells.map((cell) => `${cell.tone}:${cell.primitive}`)
          .join('|'),
      ),
    );
    expect(signatures.size).toBe(sameHue.length);
  });

  it('draws something in every mark rather than leaving one blank', () => {
    for (const pubkey of PUBKEYS) {
      const { cells } = identityMarkGeometry(pubkey, 'workspace');
      expect(cells.some((cell) => cell.tone !== 'void')).toBe(true);
    }
  });
});
