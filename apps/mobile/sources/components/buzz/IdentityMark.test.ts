import { readdirSync, readFileSync } from 'node:fs';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Image: host('Image'),
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    StyleSheet: {
      create: (styles: unknown) => styles,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    },
    View: host('View'),
  };
});

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

// MonoHull (the source of the shared live clock) pulls in expo-haptics, which
// reaches expo-modules-core and its React-Native-only `__DEV__` global.
vi.mock('expo-haptics', () => ({
  impactAsync: () => undefined,
  notificationAsync: () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children),
    },
    Easing: { linear: 'linear', out: (fn: unknown) => fn, poly: (n: number) => n },
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: number) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: number) => value,
    withSequence: (value: unknown) => value,
    FadeInDown: { duration: () => ({}) },
  };
});

import { groknight } from '@/buzz/groknight';
import { BONE, FACE_IDS, INK } from '@/buzz/faces/animals';
import { defaultFaceForSeed } from '@/buzz/faces';
import { PERSON_PLATE } from '@/buzz/faces/face-tile';
import { identityPalette } from '@/buzz/identity-mark';
import { IdentityMark } from './IdentityMark';

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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const AGENT = '2222222222222222222222222222222222222222222222222222222222222222';
const HUMAN = '5555555555555555555555555555555555555555555555555555555555555555';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

/** Every fill/stroke colour the mark actually paints. */
function inks(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node: any) => typeof node.type === 'string')
    .flatMap((node: any) => [node.props.fill, node.props.stroke])
    .filter(
      (value: unknown): value is string => typeof value === 'string' && value.startsWith('#'),
    );
}

/** The figure's painted leaves, excluding the lens band. */
function figurePaints(renderer: ReactTestRenderer): any[] {
  return renderer.root
    .findByProps({ testID: 'face-figure' })
    .findAll(
      (node: any) =>
        typeof node.type === 'string' &&
        node.type !== 'G' &&
        node.props.testID !== 'face-lens-band' &&
        ((node.props.fill && node.props.fill !== 'none') ||
          (node.props.stroke && node.props.stroke !== 'none')),
    );
}

/** Host nodes carrying a testID (the SVG mock's composite wrapper carries it too). */
function hosts(renderer: ReactTestRenderer, testID: string): any[] {
  return renderer.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function plateOf(renderer: ReactTestRenderer): Record<string, any> {
  const plate = renderer.root.findByProps({ testID: 'identity-face-plate' });
  return Object.assign({}, ...(plate.props.style as Record<string, any>[]));
}

describe('a face is deterministic per seed', () => {
  it('draws the same creature for the same seed, every time', () => {
    const first = render(React.createElement(IdentityMark, { seed: HUMAN, kind: 'human', size: 40 }));
    const again = render(React.createElement(IdentityMark, { seed: HUMAN, kind: 'human', size: 40 }));
    expect(again.toJSON()).toEqual(first.toJSON());
    // ...and it is the seed's default creature, so every reader agrees.
    const chosen = render(
      React.createElement(IdentityMark, {
        seed: HUMAN,
        kind: 'human',
        size: 40,
        face: defaultFaceForSeed(HUMAN),
      }),
    );
    expect(chosen.toJSON()).toEqual(first.toJSON());
  });

  it('wears a chosen face instead, and ignores a face it does not know', () => {
    const chosen = FACE_IDS.find((id) => id !== defaultFaceForSeed(HUMAN))!;
    const bySeed = render(React.createElement(IdentityMark, { seed: HUMAN, kind: 'human', size: 40 }));
    const byChoice = render(
      React.createElement(IdentityMark, { seed: HUMAN, kind: 'human', size: 40, face: chosen }),
    );
    expect(byChoice.toJSON()).not.toEqual(bySeed.toJSON());
    const unknown = render(
      React.createElement(IdentityMark, { seed: HUMAN, kind: 'human', size: 40, face: 'dragon' }),
    );
    expect(unknown.toJSON()).toEqual(bySeed.toJSON());
  });

  it('names the type for a screen reader too, never the creature alone', () => {
    const agent = render(
      React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', name: 'beebee' }),
    );
    expect(agent.root.findAllByType('View')[0]!.props.accessibilityLabel).toBe('beebee, agent');
  });
});

describe('plate polarity is the class', () => {
  it('draws a person as a coloured creature on an ink plate, with the edge layer behind', () => {
    const person = render(React.createElement(IdentityMark, { seed: HUMAN, kind: 'human', size: 40 }));
    // The shipped themes are all dark: the person plate is the dark ground.
    expect(groknight.dark).toBe(true);
    expect(plateOf(person).backgroundColor).toBe(PERSON_PLATE.dark);
    expect(plateOf(person).borderRadius).toBe(3);
    const svg = person.root.findByType('Svg');
    expect(svg.children.map((child: any) => child.props.testID)).toEqual(['face-edge', 'face-figure']);
    // The creature carries the identity's signature hue where Speakeasy had brass.
    const palette = identityPalette(HUMAN, 'human');
    const painted = inks(person);
    expect(painted).toContain(palette.mid);
    expect(painted.every((ink) => [palette.mid, BONE, INK].includes(ink))).toBe(true);
    expect(hosts(person, 'face-lens-band')).toHaveLength(0);
  });

  it('draws an agent as an all-ink creature with one lens band on its hue plate', () => {
    const agent = render(React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 40 }));
    const palette = identityPalette(AGENT, 'agent');
    expect(plateOf(agent).backgroundColor).toBe(palette.mid);
    const band = hosts(agent, 'face-lens-band');
    expect(band).toHaveLength(1);
    expect(band[0]!.props.fill).toBe(BONE);
    for (const node of figurePaints(agent)) {
      for (const ink of [node.props.fill, node.props.stroke]) {
        if (ink && ink !== 'none') expect(ink).toBe(INK);
      }
    }
    // Ink on colour always contrasts: no edge layer.
    expect(hosts(agent, 'face-edge')).toHaveLength(0);
  });

  it('gives two identities visibly different signatures', () => {
    const first = plateOf(
      render(React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 40 })),
    ).backgroundColor;
    const second = plateOf(
      render(React.createElement(IdentityMark, { seed: HUMAN, kind: 'agent', size: 40 })),
    ).backgroundColor;
    expect(first).not.toBe(second);
  });

  it('keeps the creature at every shipped size, byline tile included', () => {
    for (const size of [26, 28, 34, 38, 40, 76]) {
      const tile = render(React.createElement(IdentityMark, { seed: HUMAN, kind: 'human', size }));
      expect(plateOf(tile).width).toBe(size);
      expect(hosts(tile, 'face-figure')).toHaveLength(1);
    }
  });
});

describe('a Workspace keeps its brass plate', () => {
  it('draws the 3×3 plate, never a creature', () => {
    const workspace = render(
      React.createElement(IdentityMark, { seed: WORKSPACE, kind: 'workspace', size: 40 }),
    );
    expect(workspace.root.findAllByType('Rect').length).toBeGreaterThan(3);
    expect(hosts(workspace, 'face-figure')).toHaveLength(0);
    expect(hosts(workspace, 'identity-face-plate')).toHaveLength(0);
    const palette = identityPalette(WORKSPACE, 'workspace');
    expect(inks(workspace).every((ink) => [palette.mid, palette.bright, palette.deep].includes(ink))).toBe(
      true,
    );
  });

  it('goes solid below the cypher floor', () => {
    const dot = render(
      React.createElement(IdentityMark, { seed: WORKSPACE, kind: 'workspace', size: 18 }),
    );
    expect(dot.root.findAllByType('G')).toHaveLength(0);
    expect(inks(dot)).toContain(identityPalette(WORKSPACE, 'workspace').mid);
  });
});

describe('gold means alive, and only alive', () => {
  it('rings a working agent around its plate and leaves an idle one alone', () => {
    const working = render(
      React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 40, alive: true }),
    );
    const ring = working.root
      .findAll((node: any) => typeof node.type === 'string')
      .filter((node: any) => node.props.stroke === groknight.accent);
    expect(ring.length).toBeGreaterThan(0);
    // The identity colour underneath is untouched: who you are and what you
    // are doing stay two separate reads.
    expect(ring.every((node: any) => node.props.fill === 'none')).toBe(true);
    expect(plateOf(working).backgroundColor).toBe(identityPalette(AGENT, 'agent').mid);
    // It breathes on the shared live clock rather than sitting there static.
    expect(working.root.findAllByType('AnimatedView')).toHaveLength(1);

    const idle = render(
      React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 40, alive: false }),
    );
    expect(inks(idle)).not.toContain(groknight.accent);
    // A quiet mark must never pay for a clock it does not use.
    expect(idle.root.findAllByType('AnimatedView')).toHaveLength(0);
  });

  it('never lets gold mean anything but a live agent', () => {
    // The discriminated union refuses `alive` on non-agent marks at the type
    // level; these render through the same escape hatch an untyped caller
    // would use, and must still stay dark.
    const human = render(
      React.createElement(IdentityMark, {
        seed: HUMAN,
        kind: 'human',
        size: 40,
        alive: true,
      } as never),
    );
    expect(inks(human)).not.toContain(groknight.accent);
    expect(human.root.findAllByType('AnimatedView')).toHaveLength(0);

    const workspace = render(
      React.createElement(IdentityMark, {
        seed: WORKSPACE,
        kind: 'workspace',
        size: 40,
        alive: true,
      } as never),
    );
    expect(inks(workspace)).not.toContain(groknight.accent);
    expect(workspace.root.findAllByType('AnimatedView')).toHaveLength(0);
  });
});

describe('one mark, everywhere', () => {
  it('is the only identity-mark component in the product', () => {
    // No per-surface reimplementation: every avatar, handle mark, rail tile,
    // presence dot and corner top-bar renders this one primitive. A second
    // `SomethingAvatar` component is exactly the drift this replaced.
    //
    // The detector must see every identity-rendering FILE NAME — including a
    // bare `Avatar.tsx` and suffixed variants (`AvatarGradient`, …) — not just
    // prefixed duplicates like `PersonAvatar`. There are no exemptions: a
    // second identity component means the product has drifted again.
    const root = new URL('../../', import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? entry.name === 'node_modules'
            ? []
            : walk(`${dir}${entry.name}/`)
          : [`${dir}${entry.name}`],
      );
    const files = walk(root);

    // Matches `Avatar.tsx`, `PersonAvatar.tsx`, `AvatarGradient.tsx`,
    // `AvatarSkia.web.tsx` — any filename carrying the word anywhere.
    const avatarFiles = files.filter((file) => /\/\w*Avatar\w*(\.\w+)?\.tsx$/.test(file));
    expect(avatarFiles).toEqual([]);
    const usesLegacyMark = files.filter(
      (file) =>
        /\.tsx$/.test(file) &&
        /<(?:Agent|Person|Workspace)Avatar\b/.test(readFileSync(file, 'utf8')),
    );
    expect(usesLegacyMark).toEqual([]);

    // The creatures are drawn in exactly one place too: no surface composes
    // `buzz/faces` on its own.
    const drawsAFace = files.filter(
      (file) =>
        /\.tsx$/.test(file) &&
        !/\.test\.tsx$/.test(file) &&
        !file.includes('/buzz/faces/') &&
        /from '@\/buzz\/faces\//.test(readFileSync(file, 'utf8')),
    );
    expect(drawsAFace.map((file) => file.slice(root.length))).toEqual([
      'components/buzz/IdentityMark.tsx',
    ]);

    // ...and every surface that draws an identity draws this one.
    const drawsAMark = files.filter(
      (file) => /\.tsx$/.test(file) && /<IdentityMark\b/.test(readFileSync(file, 'utf8')),
    );
    expect(drawsAMark.length).toBeGreaterThanOrEqual(7);
  });

  it('never lets a relay photo replace the creature', () => {
    // DESIGN.md ("Identity"): `photoIdentityMarksEnabled` ships FALSE — a
    // photo defeats the face system at once, so the gate stays off until a
    // captain decides portraits may live inside the tile.
    const renderer = render(
      React.createElement(IdentityMark, {
        seed: HUMAN,
        kind: 'human',
        avatarUrl: 'https://example.test/joy.png',
        name: 'Joy',
      }),
    );
    expect(renderer.root.findAllByType('Image')).toHaveLength(0);
    expect(hosts(renderer, 'face-figure')).toHaveLength(1);
    expect(groknight.photoIdentityMarksEnabled).toBe(false);
  });

  it('renders a Workspace picture and falls back to its generated mark', () => {
    const withPicture = render(
      React.createElement(IdentityMark, {
        seed: WORKSPACE,
        kind: 'workspace',
        avatarUrl: 'https://example.test/workspace.png',
        name: 'Hull',
      }),
    );
    expect(withPicture.root.findAllByType('Image')).toHaveLength(1);
    expect(withPicture.root.findAllByType('Rect')).toHaveLength(0);

    act(() => withPicture.root.findByType('Image').props.onError());
    expect(withPicture.root.findAllByType('Image')).toHaveLength(0);
    expect(withPicture.root.findAllByType('Rect').length).toBeGreaterThan(0);

    const withoutPicture = render(
      React.createElement(IdentityMark, { seed: WORKSPACE, kind: 'workspace', name: 'Hull' }),
    );
    expect(withoutPicture.root.findAllByType('Image')).toHaveLength(0);
    expect(withoutPicture.root.findAllByType('Rect').length).toBeGreaterThan(0);
  });

  it('keeps stored human and agent photos inert', () => {
    for (const kind of ['human', 'agent'] as const) {
      const renderer = render(
        React.createElement(IdentityMark, {
          seed: HUMAN,
          kind,
          avatarUrl: 'https://example.test/stored-photo.png',
          name: 'Joy',
        }),
      );
      expect(renderer.root.findAllByType('Image')).toHaveLength(0);
      expect(hosts(renderer, 'face-figure')).toHaveLength(1);
    }
  });

  it('does not re-render when its own props are unchanged', () => {
    // `renderItem` is recreated on every presence tick; without memoization
    // every visible row rebuilds its whole SVG for an update it has no part in.
    const original = (IdentityMark as unknown as { type: typeof IdentityMark }).type;
    const spy = vi.fn(original);
    (IdentityMark as unknown as { type: typeof IdentityMark }).type = spy as any;
    try {
      function Parent({ tick }: { tick: number }) {
        void tick;
        return React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', name: 'beebee' });
      }

      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(React.createElement(Parent, { tick: 0 }));
      });
      expect(spy).toHaveBeenCalledTimes(1);

      act(() => {
        renderer.update(React.createElement(Parent, { tick: 1 }));
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      (IdentityMark as unknown as { type: typeof IdentityMark }).type = original;
    }
  });
});
