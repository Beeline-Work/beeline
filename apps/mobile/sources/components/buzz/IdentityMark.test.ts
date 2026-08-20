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
    G: host('G'),
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
    default: { View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children) },
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
    .filter((value: unknown): value is string => typeof value === 'string' && value.startsWith('#'));
}

describe('shape reports the type', () => {
  it('draws △ for an agent, ○ for a human, ▢ for a workspace', () => {
    const agent = render(React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 40 }));
    expect(agent.root.findAllByType('Polygon').length).toBeGreaterThan(0);
    expect(agent.root.findAllByType('Circle')).toHaveLength(0);

    const human = render(React.createElement(IdentityMark, { seed: HUMAN, kind: 'human', size: 40 }));
    expect(human.root.findAllByType('Circle').length).toBeGreaterThan(0);
    expect(human.root.findAllByType('Polygon')).toHaveLength(0);

    const workspace = render(
      React.createElement(IdentityMark, { seed: WORKSPACE, kind: 'workspace', size: 40 }),
    );
    expect(workspace.root.findAllByType('Rect').length).toBeGreaterThan(0);
    expect(workspace.root.findAllByType('Circle')).toHaveLength(0);
  });

  it('names the type for a screen reader too, never shape alone', () => {
    const agent = render(
      React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', name: 'beebee' }),
    );
    expect(agent.root.findAllByType('View')[0]!.props.accessibilityLabel).toBe('beebee, agent');
  });
});

describe('colour is the memory hook', () => {
  it('paints one identity in its own signature colour, every time', () => {
    const palette = identityPalette(AGENT, 'agent');
    const painted = inks(render(React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 40 })));
    expect(painted).toContain(palette.mid);
    expect(painted.every((ink) => [palette.mid, palette.bright, palette.deep].includes(ink))).toBe(
      true,
    );
  });

  it('gives two identities visibly different signatures', () => {
    const first = new Set(inks(render(React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 40 }))));
    const second = new Set(
      inks(render(React.createElement(IdentityMark, { seed: HUMAN, kind: 'agent', size: 40 }))),
    );
    expect([...first].some((ink) => second.has(ink))).toBe(false);
  });

  it('goes solid below the cypher floor, where colour and silhouette are the identity', () => {
    const dot = render(React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 18 }));
    // Frame only — no interior grid to turn to mud at presence-dot scale.
    expect(dot.root.findAllByType('G')).toHaveLength(0);
    expect(inks(dot)).toContain(identityPalette(AGENT, 'agent').mid);
  });
});

describe('gold means alive, and only alive', () => {
  it('rings a working agent and leaves an idle one alone', () => {
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
    // It breathes on the shared live clock rather than sitting there static.
    expect(working.root.findAllByType('AnimatedView')).toHaveLength(1);

    const idle = render(
      React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 40, alive: false }),
    );
    expect(inks(idle)).not.toContain(groknight.accent);
    // A quiet mark must never pay for a clock it does not use.
    expect(idle.root.findAllByType('AnimatedView')).toHaveLength(0);
  });

  it('rings in the mark’s own silhouette, so the shape read survives', () => {
    const agent = render(
      React.createElement(IdentityMark, { seed: AGENT, kind: 'agent', size: 40, alive: true }),
    );
    expect(agent.root.findAllByType('Circle')).toHaveLength(0);

    const workspace = render(
      React.createElement(IdentityMark, { seed: WORKSPACE, kind: 'workspace', size: 40, alive: true }),
    );
    expect(workspace.root.findAllByType('Circle')).toHaveLength(0);
  });
});

describe('one mark, everywhere', () => {
  it('is the only identity-mark component in the product', () => {
    // No per-surface reimplementation: every avatar, handle mark, rail tile,
    // presence dot and corner top-bar renders this one primitive. A second
    // `SomethingAvatar` component is exactly the drift this replaced.
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

    expect(files.filter((file) => /\/[A-Z]\w*Avatar\.tsx$/.test(file))).toEqual([]);
    const usesLegacyMark = files.filter(
      (file) =>
        /\.tsx$/.test(file) &&
        /<(?:Agent|Person|Workspace)Avatar\b/.test(readFileSync(file, 'utf8')),
    );
    expect(usesLegacyMark).toEqual([]);

    // ...and every surface that draws an identity draws this one.
    const drawsAMark = files.filter(
      (file) => /\.tsx$/.test(file) && /<IdentityMark\b/.test(readFileSync(file, 'utf8')),
    );
    expect(drawsAMark.length).toBeGreaterThanOrEqual(7);
  });

  it('renders a persisted relay photo and keeps the generated mark as the fallback', () => {
    const renderer = render(
      React.createElement(IdentityMark, {
        seed: HUMAN,
        kind: 'human',
        avatarUrl: 'https://example.test/joy.png',
        name: 'Joy',
      }),
    );
    expect(renderer.root.findAllByType('Image')).toHaveLength(1);
    expect(renderer.root.findAllByType('Circle')).toHaveLength(0);
    expect(groknight.photoIdentityMarksEnabled).toBe(true);
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
