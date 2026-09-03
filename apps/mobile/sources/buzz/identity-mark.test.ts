import { describe, expect, it } from 'vitest';
import {
  CYPHER_CELLS,
  IDENTITY_FILL_STATES,
  WORKSPACE_BRASS_HUE,
  identityFillState,
  identityMarkGeometry,
  identityPalette,
  type IdentityKind,
} from './identity-mark';

const PUBKEYS = Array.from({ length: 48 }, (_, index) =>
  index.toString(16).padStart(2, '0').repeat(32),
);

/** Shortest arc between two hues, in degrees. */
function hueDistance(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
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
    // Workspaces are excluded by design: they all share the house brass.
    for (const kind of ['agent', 'human'] as IdentityKind[]) {
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

  it('runs agents warm and saturated, people cooler and greyer', () => {
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
      expect(agent).toBeGreaterThan(human);
      // Muted, never neon: these have to sit inside the obsidian world.
      expect(agent).toBeLessThan(0.45);
    }
  });

  it('renders every workspace mark in the house brass — never a per-identity hue', () => {
    // The Speakeasy treatment: a Workspace is the house itself, not someone
    // to remember, so every ▢ sits in one brass family. Per-Workspace
    // distinction rides fill + cypher + luminance register, never hue.
    for (const pubkey of PUBKEYS) {
      const palette = identityPalette(pubkey, 'workspace');
      expect(palette.hue).toBe(WORKSPACE_BRASS_HUE);
      expect(palette.hueIndex).toBe(
        identityPalette('any-other-seed-lands-same', 'workspace').hueIndex,
      );
      // Brass-family saturation: reads as metal on the obsidian ground, not
      // as the washed-out grey-tan the old neutral temperament produced.
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(palette.mid.slice(at, at + 2), 16) / 255) as [
        number,
        number,
        number,
      ];
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(0.3);
    }

    // Humans and agents keep their per-identity wheel: this change must not
    // have leaked into their palettes.
    const agentHues = new Set(PUBKEYS.map((pubkey) => identityPalette(pubkey, 'agent').hue));
    const humanHues = new Set(PUBKEYS.map((pubkey) => identityPalette(pubkey, 'human').hue));
    expect(agentHues.size).toBeGreaterThanOrEqual(10);
    expect(humanHues.size).toBeGreaterThanOrEqual(8);
    expect(agentHues.has(WORKSPACE_BRASS_HUE)).toBe(true); // 40 is a wheel anchor
    expect(humanHues.has(WORKSPACE_BRASS_HUE)).toBe(false); // humans lean cool

    // Distinct workspaces stay distinguishable without hue: fill varies.
    const fills = new Set(PUBKEYS.map((pubkey) => identityFillState(pubkey, 'workspace')));
    expect(fills.size).toBe(IDENTITY_FILL_STATES.length);
  });

  it('keeps the same identity distinguishable across types', () => {
    // A person and an agent that happen to share a seed must not read as the
    // same identity in a mixed list.
    expect(identityPalette(PUBKEYS[7]!, 'agent').mid).not.toBe(
      identityPalette(PUBKEYS[7]!, 'human').mid,
    );
  });
});

describe('the cypher is the Workspace plate’s uniqueness tiebreak', () => {
  it('is a coarse nine-cell grid, deterministic per Workspace', () => {
    const first = identityMarkGeometry(PUBKEYS[9]!, 'workspace');
    expect(first.cells).toHaveLength(CYPHER_CELLS);
    expect(identityMarkGeometry(PUBKEYS[9]!, 'workspace')).toEqual(first);
  });

  it('separates Workspaces that all share the house brass', () => {
    const signatures = new Set(
      PUBKEYS.map((pubkey) =>
        identityMarkGeometry(pubkey, 'workspace')
          .cells.map((cell) => `${cell.tone}:${cell.primitive}`)
          .join('|'),
      ),
    );
    expect(signatures.size).toBe(PUBKEYS.length);
  });

  it('draws something in every mark rather than leaving one blank', () => {
    for (const pubkey of PUBKEYS) {
      const { cells } = identityMarkGeometry(pubkey, 'workspace');
      expect(cells.some((cell) => cell.tone !== 'void')).toBe(true);
    }
  });
});

// Fill and cypher survive only on the Workspace plate: people and agents are
// Speakeasy's creatures now (`buzz/faces`), and their collision axes are the
// species and the hue.
describe('fill is the Workspace plate’s nameable collision axis', () => {
  it('gives one Workspace the same fill state forever from an independent seed stream', () => {
    const first = identityFillState(PUBKEYS[12]!, 'workspace');
    expect(identityFillState(PUBKEYS[12]!, 'workspace')).toBe(first);
    expect(IDENTITY_FILL_STATES).toContain(first);

    const used = new Set(PUBKEYS.map((pubkey) => identityFillState(pubkey, 'workspace')));
    expect(used).toEqual(new Set(IDENTITY_FILL_STATES));
  });

});
