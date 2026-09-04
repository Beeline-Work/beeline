import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    default: host('Svg'),
    Circle: host('Circle'),
    Ellipse: host('Ellipse'),
    G: host('G'),
    Line: host('Line'),
    Path: host('Path'),
    Polygon: host('Polygon'),
    Rect: host('Rect'),
  };
});

import { BONE, BRASS, FACES, FACE_IDS, INK, type FaceId } from './animals';
import { EDGE_GROW, recolorEdge } from './edge';
import { PERSON_PLATE, agentFaceLayers, personFaceLayers, type FaceMode } from './face-tile';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

function render(children: React.ReactNode): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement('Svg', null, children));
  });
  return renderer;
}

type Node = { type: unknown; props: Record<string, any>; parent: Node | null };

/** Host nodes carrying a testID (the mock's composite wrapper carries it too). */
function hosts(root: { findAll: (predicate: (node: Node) => boolean) => Node[] }, testID: string): Node[] {
  return root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
}

/** Every painted leaf (fill or stroke) under a node. */
function paints(root: { findAll: (predicate: (node: Node) => boolean) => Node[] }): Node[] {
  return root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      node.type !== 'Svg' &&
      node.type !== 'G' &&
      ((node.props.fill !== undefined && node.props.fill !== 'none') ||
        (node.props.stroke !== undefined && node.props.stroke !== 'none')),
  );
}

const HUE = '#8FA4C8';

/**
 * The shape that IS each creature's outer silhouette, and the tone Speakeasy
 * painted it in. Fox, octopus and stag are brass-bodied (hue-bodied here), so
 * no theme ever needs to edge them; bone bodies vanish on a light plate, ink
 * bodies on a dark one. The geometry strings are the port's own path data, so
 * a test failure here means either the art or the edge rule drifted.
 */
const SILHOUETTE: Record<FaceId, { tone: 'brass' | 'bone' | 'ink'; geometry: string }> = {
  fox: { tone: 'brass', geometry: 'M20,28 L80,28 L74,62 L50,88 L26,62 Z' },
  owl: { tone: 'bone', geometry: 'owl-face-disk' },
  pigeon: { tone: 'ink', geometry: 'pigeon-body' },
  hare: { tone: 'bone', geometry: 'hare-head' },
  stag: { tone: 'brass', geometry: 'M30,30 L70,30 L66,68 L50,88 L34,68 Z' },
  whale: {
    tone: 'ink',
    geometry:
      'M10,55 Q15,38 40,38 Q70,38 78,52 L94,42 L88,58 L94,68 L78,60 Q70,72 40,72 Q15,72 10,55 Z',
  },
  moth: { tone: 'bone', geometry: 'M50,52 L20,52 L28,76 L50,68 Z' },
  octopus: {
    tone: 'brass',
    geometry: 'M22,42 Q22,18 50,18 Q78,18 78,42 L78,58 Q78,62 74,62 L26,62 Q22,62 22,58 Z',
  },
  heron: { tone: 'bone', geometry: 'heron-body' },
  bear: { tone: 'ink', geometry: 'bear-head' },
  cat: { tone: 'ink', geometry: 'cat-head' },
  bat: { tone: 'ink', geometry: 'M50,46 L20,30 L8,42 L18,46 L8,54 L24,58 L50,52 Z' },
};

/** Ellipse silhouettes are matched by centre + radii rather than a `d`. */
const ELLIPSES: Record<string, { cx: number; cy: number; rx: number; ry: number }> = {
  'owl-face-disk': { cx: 50, cy: 46, rx: 30, ry: 26 },
  'pigeon-body': { cx: 42, cy: 52, rx: 30, ry: 24 },
  'hare-head': { cx: 50, cy: 60, rx: 28, ry: 26 },
  'heron-body': { cx: 60, cy: 72, rx: 22, ry: 14 },
  'bear-head': { cx: 50, cy: 56, rx: 32, ry: 30 },
  'cat-head': { cx: 50, cy: 56, rx: 34, ry: 30 },
};

function isSilhouette(node: Node, geometry: string): boolean {
  const ellipse = ELLIPSES[geometry];
  if (ellipse) {
    return (
      node.type === 'Ellipse' &&
      node.props.cx === ellipse.cx &&
      node.props.cy === ellipse.cy &&
      node.props.rx === ellipse.rx &&
      node.props.ry === ellipse.ry
    );
  }
  return node.props.d === geometry;
}

describe('the twelve are Speakeasy’s drawings, recoloured', () => {
  it('draws every creature, and swaps only BRASS for the identity hue', () => {
    for (const face of FACE_IDS) {
      const renderer = render(FACES[face]({ palette: { brass: HUE, bone: BONE, ink: INK } }));
      const inks = new Set(
        paints(renderer.root).flatMap((node) => [node.props.fill, node.props.stroke]),
      );
      inks.delete(undefined);
      inks.delete('none');
      expect(inks.has(BRASS), `${face} still paints Speakeasy's raw brass`).toBe(false);
      expect(inks.has(HUE), `${face} carries no signature hue`).toBe(true);
      expect(
        [...inks].every((ink) => [HUE, BONE, INK].includes(ink as string)),
        `${face} paints outside hue/bone/ink`,
      ).toBe(true);
    }
  });
});

describe('the edge layer is Speakeasy’s, ported exactly', () => {
  it('grows a matching fill by EDGE_GROW in the contrast colour and drops everything else', () => {
    expect(EDGE_GROW).toBe(3);
    const tree = React.createElement(
      'G',
      null,
      React.createElement('Path', { d: 'body', fill: INK }),
      React.createElement('Path', { d: 'stroked', stroke: INK, strokeWidth: 2, fill: 'none' }),
      React.createElement('Path', { d: 'hue', fill: HUE }),
      React.createElement('Path', { d: 'bone', fill: BONE }),
    );
    const edged = render(recolorEdge(tree, BONE, INK));
    const nodes = edged.root.findAllByType('Path');
    expect(nodes.map((node: Node) => node.props.d)).toEqual(['body', 'stroked']);
    expect(nodes[0]!.props).toMatchObject({ fill: BONE, stroke: BONE, strokeWidth: 3 });
    expect(nodes[1]!.props).toMatchObject({ stroke: BONE, strokeWidth: 5 });
  });

  it.each([
    ['dark' as FaceMode, ['bear', 'cat', 'bat', 'whale', 'pigeon'] as FaceId[], BONE],
    ['light' as FaceMode, ['hare', 'heron', 'moth', 'owl'] as FaceId[], INK],
  ])('on a %s plate, edges the bodies that would vanish into it', (mode, faces, edge) => {
    for (const face of faces) {
      const renderer = render(personFaceLayers(face, HUE, mode));
      const edgeLayer = renderer.root.findByProps({ testID: 'face-edge' });
      const body = paints(edgeLayer).filter((node) => isSilhouette(node, SILHOUETTE[face].geometry));
      expect(body, `${face} body is not edged on ${mode}`).toHaveLength(1);
      expect(body[0]!.props.stroke).toBe(edge);
      expect(body[0]!.props.strokeWidth).toBe(EDGE_GROW);
      // The edge layer is drawn BEHIND the figure: first child, then the real mark.
      const svg = renderer.root.findByType('Svg');
      expect(svg.children.map((child: any) => child.props.testID)).toEqual([
        'face-edge',
        'face-figure',
      ]);
    }
  });

  it.each([
    ['dark' as FaceMode, ['hare', 'heron', 'moth', 'owl'] as FaceId[]],
    ['light' as FaceMode, ['bear', 'cat', 'bat', 'whale', 'pigeon'] as FaceId[]],
  ])('on a %s plate, leaves the already-contrasting bodies alone', (mode, faces) => {
    for (const face of faces) {
      const edgeLayer = render(personFaceLayers(face, HUE, mode)).root.findByProps({
        testID: 'face-edge',
      });
      const body = paints(edgeLayer).filter((node) => isSilhouette(node, SILHOUETTE[face].geometry));
      expect(body, `${face} body wrongly edged on ${mode}`).toHaveLength(0);
    }
  });

  it('never edges the hue-bodied fox, octopus and stag in either mode', () => {
    for (const face of ['fox', 'octopus', 'stag'] as FaceId[]) {
      for (const mode of ['dark', 'light'] as FaceMode[]) {
        const edgeLayer = render(personFaceLayers(face, HUE, mode)).root.findByProps({
          testID: 'face-edge',
        });
        expect(
          paints(edgeLayer).some((node) => isSilhouette(node, SILHOUETTE[face].geometry)),
          `${face} body edged on ${mode}`,
        ).toBe(false);
        // The hue itself is never in the edge layer at all.
        expect(paints(edgeLayer).some((node) => node.props.fill === HUE)).toBe(false);
      }
    }
  });

  it('paints the person plate a shade under the canvas on dark and cream on light', () => {
    expect(PERSON_PLATE).toEqual({ dark: '#0f0a13', light: '#F5EEE2' });
  });
});

describe('an agent is the same creature, with the hue moved to the plate', () => {
  it('draws every creature whole, in bone and ink, and never repeats the hue', () => {
    for (const face of FACE_IDS) {
      const figure = render(agentFaceLayers(face)).root.findByProps({ testID: 'face-figure' });
      const painted = paints(figure);
      expect(painted.length, `${face} figure is empty`).toBeGreaterThan(0);
      const tones = new Set(painted.flatMap((node) => [node.props.fill, node.props.stroke]));
      tones.delete(undefined);
      tones.delete('none');
      expect([...tones].sort(), `${face} paints outside bone/ink`).toEqual([INK, BONE].sort());
    }
  });

  it('draws the identical shapes a person does — eyes included, no lens band', () => {
    const geometry = (renderer: ReactTestRenderer) =>
      paints(renderer.root.findByProps({ testID: 'face-figure' }))
        .map(
          (node) =>
            `${String(node.type)}:${node.props.d ?? ''}:${node.props.points ?? ''}:${node.props.cx ?? ''},${node.props.cy ?? ''}:${node.props.r ?? node.props.rx ?? ''}`,
        )
        .join('|');
    for (const face of FACE_IDS) {
      const agent = render(agentFaceLayers(face));
      expect(hosts(agent.root, 'face-lens-band'), `${face} still wears a lens band`).toHaveLength(0);
      expect(geometry(agent), `${face} is not the person's drawing`).toBe(
        geometry(render(personFaceLayers(face, HUE, 'dark'))),
      );
    }
  });

  it('edges the bone figure for the light hue plate it stands on', () => {
    // The agent plate is the identity's own mid hue (`identityPalette`,
    // lightness ≈0.62), so the vanishing tone is BONE in either theme.
    const edgeLayer = render(agentFaceLayers('hare')).root.findByProps({ testID: 'face-edge' });
    const body = paints(edgeLayer).filter((node) => isSilhouette(node, SILHOUETTE.hare.geometry));
    expect(body).toHaveLength(1);
    expect(body[0]!.props.stroke).toBe(INK);
    expect(body[0]!.props.strokeWidth).toBe(EDGE_GROW);
  });
});
