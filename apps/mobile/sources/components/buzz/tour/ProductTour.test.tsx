import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({ seen: [] as string[] | null, available: true }));
const back = vi.hoisted(() => ({ handlers: [] as Array<() => boolean> }));
const rect = vi.hoisted(() => ({ value: { x: 16, y: 120, width: 358, height: 64 } }));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://server.test' }),
}));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: {
    fetch: vi.fn(async (url: string, options: { body: string }) => {
      if (!server.available) return { ok: false, status: 503 };
      const { tip } = JSON.parse(options.body) as { tip?: string };
      if (url.endsWith('/updateProductTour')) {
        if (tip === 'replay') server.seen = [];
        else if (server.seen && tip && !server.seen.includes(tip)) server.seen.push(tip);
      }
      return {
        ok: true,
        json: async () => ({
          version: 2,
          seenTips: server.seen ?? ['swipe', 'cornerMark', 'squire'],
        }),
      };
    }),
  },
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) =>
    ReactModule.forwardRef((props: any, ref) =>
      ReactModule.createElement(name, { ...props, ref }, props.children),
    );
  return {
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    Platform: { OS: 'android', select: (options: any) => options.android ?? options.default },
    AccessibilityInfo: { setAccessibilityFocus: vi.fn() },
    findNodeHandle: () => 1,
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    BackHandler: {
      addEventListener: (_event: string, handler: () => boolean) => {
        back.handlers.push(handler);
        return { remove: () => back.handlers.splice(back.handlers.indexOf(handler), 1) };
      },
    },
  };
});
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children),
    },
    FadeIn: { duration: () => 'fade' },
    useReducedMotion: () => false,
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) =>
      factory({
        buzz: new Proxy(
          {
            space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
            type: new Proxy({}, { get: () => ({}) }),
          },
          { get: (target: any, key) => (key in target ? target[key] : '#000') },
        ),
      }),
    absoluteFillObject: {},
  },
  useUnistyles: () => ({ theme: { buzz: { accent: '#b08a4a' } } }),
}));
vi.mock('@react-navigation/core', async () => {
  const ReactModule = await import('react');
  return { NavigationContext: ReactModule.createContext(undefined) };
});
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'person-1' })),
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    OnboardingButton: (props: any) =>
      ReactModule.createElement('OnboardingButton', props, props.label),
  };
});

import { AccessibilityInfo } from 'react-native';
import { ProductTourProvider, TOUR_TIP_COPY } from './ProductTour';
import { TourTarget } from './TourTarget';
import {
  loadProductTour,
  markTourTipSeen,
  replayProductTour,
  resetProductTourCacheForTests,
} from '@/buzz/product-tour';

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

function nodeMock() {
  return {
    measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) =>
      callback(rect.value.x, rect.value.y, rect.value.width, rect.value.height),
  };
}

async function render(children: React.ReactNode): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(ProductTourProvider, null, children), {
      createNodeMock: nodeMock,
    });
  });
  // Let the identity read, the stored state and the target measure land.
  for (let i = 0; i < 4; i += 1) await act(async () => undefined);
  return renderer;
}

const byTestId = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll(
    (node: any) => node.props?.testID === testID && typeof node.type === 'string',
  );

async function press(renderer: ReactTestRenderer, testID: string) {
  await act(async () => {
    byTestId(renderer, testID)[0]!.props.onPress();
  });
  for (let i = 0; i < 3; i += 1) await act(async () => undefined);
}

function target(tip: 'swipe' | 'cornerMark' | 'squire', label = 'Row') {
  return React.createElement(TourTarget, { tip, children: React.createElement(label) });
}

describe('the first-sight tips', () => {
  beforeEach(() => {
    server.seen = [];
    server.available = true;
    resetProductTourCacheForTests();
    back.handlers.length = 0;
    rect.value = { x: 16, y: 120, width: 358, height: 64 };
  });

  it('shows a tip the first time its target is on screen, with no counter or overview', async () => {
    const renderer = await render(target('cornerMark'));
    const tip = byTestId(renderer, 'tour-tip-cornerMark');
    expect(tip).toHaveLength(1);
    expect(tip[0]!.props.accessibilityLabel).toBe(
      'This Room has corners Tap the mark to see them. Press and hold it to open a new corner in this Room.',
    );
    expect(byTestId(renderer, 'tour-overview')).toHaveLength(0);
    expect(byTestId(renderer, 'tour-tip-skip')).toHaveLength(0);
    const texts = renderer.root
      .findAll((node: any) => node.type === 'Text')
      .map((node: any) => node.props.children);
    expect(texts.some((text: unknown) => typeof text === 'string' && / \/ 3$/.test(text))).toBe(
      false,
    );
    expect(byTestId(renderer, 'tour-cutout')[0]!.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ left: 10, top: 114, width: 370, height: 76 }),
      ]),
    );
  });

  it('does not show a tip for an existing account or an unavailable state read', async () => {
    server.seen = null;
    const existing = await render(target('cornerMark'));
    expect(byTestId(existing, 'tour-spotlight')).toHaveLength(0);
    server.seen = [];
    server.available = false;
    const unavailable = await render(target('cornerMark'));
    expect(byTestId(unavailable, 'tour-spotlight')).toHaveLength(0);
  });

  it('aligns the cutout to a measured corner mark and hides on missing or hidden bounds', async () => {
    rect.value = { x: 344, y: 514, width: 14, height: 14 };
    const renderer = await render(target('cornerMark'));
    expect(byTestId(renderer, 'tour-cutout')[0]!.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ left: 338, top: 508, width: 26, height: 26 }),
      ]),
    );
    rect.value = { x: 344, y: 514, width: 0, height: 0 };
    await act(async () =>
      byTestId(renderer, 'tour-target-cornerMark')[0]!.props.onLayout({
        nativeEvent: { layout: {} },
      }),
    );
    for (let i = 0; i < 3; i += 1) await act(async () => undefined);
    expect(byTestId(renderer, 'tour-spotlight')).toHaveLength(0);
    rect.value = { x: 344, y: 900, width: 14, height: 14 };
    await act(async () =>
      byTestId(renderer, 'tour-target-cornerMark')[0]!.props.onLayout({
        nativeEvent: { layout: {} },
      }),
    );
    for (let i = 0; i < 3; i += 1) await act(async () => undefined);
    expect(byTestId(renderer, 'tour-spotlight')).toHaveLength(0);
  });

  it('never shows an overlay when the target cannot be measured', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(ProductTourProvider, null, target('cornerMark')), {
        createNodeMock: () => ({}),
      });
    });
    for (let i = 0; i < 4; i += 1) await act(async () => undefined);
    expect(byTestId(renderer, 'tour-spotlight')).toHaveLength(0);
  });

  it('Got it retires the tip for good, and it never comes back', async () => {
    const renderer = await render(target('swipe'));
    const done = byTestId(renderer, 'tour-tip-done')[0]!;
    expect(done.type).toBe('OnboardingButton');
    expect(done.props.label).toBe('Got it');
    await press(renderer, 'tour-tip-done');
    expect(byTestId(renderer, 'tour-tip-swipe')).toHaveLength(0);
    expect((await loadProductTour('person-1')).seenTips).toEqual(['swipe']);
    resetProductTourCacheForTests();
    const again = await render(target('swipe'));
    expect(byTestId(again, 'tour-spotlight')).toHaveLength(0);
  });

  it('carries the specified copy for all three tips', () => {
    expect(TOUR_TIP_COPY.swipe).toEqual({
      title: 'Swipe right to open a corner',
      body: "A corner is a side space for one task. Swipe a message right and it's copied into a new corner, ready to send. Swipe left to reply.",
    });
    expect(TOUR_TIP_COPY.cornerMark).toEqual({
      title: 'This Room has corners',
      body: 'Tap the mark to see them. Press and hold it to open a new corner in this Room.',
    });
    expect(TOUR_TIP_COPY.squire).toEqual({
      title: 'Trusty Squire: sign-ups and keys',
      body: 'Link Google once. After that, agents can:',
      bullets: [
        'sign up for a service for you and save its API key',
        'use saved keys to call APIs, without ever seeing the key',
        "sign in to sites with logins you've saved",
      ],
      closing: 'Showing a key to anyone needs your passkey.',
    });
  });

  it('draws the Trusty Squire bullets and passkey line', async () => {
    const renderer = await render(target('squire'));
    const texts = renderer.root
      .findAll((node: any) => node.type === 'Text')
      .map((node: any) => node.props.children);
    for (const line of [...TOUR_TIP_COPY.squire.bullets!, TOUR_TIP_COPY.squire.closing!])
      expect(texts).toContain(line);
  });

  it('shows the tips independently, in any order', async () => {
    await markTourTipSeen('person-1', 'swipe');
    const renderer = await render(
      React.createElement('Host', null, target('swipe', 'Message'), target('squire', 'Squire')),
    );
    expect(byTestId(renderer, 'tour-tip-swipe')).toHaveLength(0);
    expect(byTestId(renderer, 'tour-tip-squire')).toHaveLength(1);
  });

  it('points at the topmost target wholly on screen and tells only that one it is chosen', async () => {
    const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
      // Partly above the top edge: not wholly in view.
      above: { x: 0, y: -20, width: 390, height: 60 },
      upper: { x: 0, y: 200, width: 390, height: 60 },
      lower: { x: 0, y: 500, width: 390, height: 60 },
      // Cut off by the bottom edge (behind the composer): not the one.
      cut: { x: 0, y: 800, width: 390, height: 120 },
      below: { x: 0, y: 2000, width: 390, height: 60 },
    };
    const posed: Record<string, boolean> = {};
    const rows = Object.keys(rects).map((name) =>
      React.createElement(TourTarget, {
        key: name,
        tip: 'swipe',
        children: (active: boolean) => {
          posed[name] = active;
          return React.createElement(name);
        },
      }),
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(ProductTourProvider, null, ...rows), {
        createNodeMock: (element: any) => {
          const child = element.props?.children;
          const name = typeof child === 'object' && child ? String(child.type) : '';
          const rectFor = rects[name] ?? rect.value;
          return {
            measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) =>
              callback(rectFor.x, rectFor.y, rectFor.width, rectFor.height),
          };
        },
      });
    });
    for (let i = 0; i < 6; i += 1) await act(async () => undefined);
    expect(byTestId(renderer, 'tour-tip-swipe')).toHaveLength(1);
    expect(byTestId(renderer, 'tour-cutout')[0]!.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ top: 194 })]),
    );
    expect(posed).toEqual({ above: false, upper: true, lower: false, cut: false, below: false });
  });

  it('stops registering targets once their tip is retired', async () => {
    await markTourTipSeen('person-1', 'swipe');
    const renderer = await render(target('swipe'));
    expect(byTestId(renderer, 'tour-spotlight')).toHaveLength(0);
  });

  it('back dismisses a tip and focus lands on it', async () => {
    const renderer = await render(target('cornerMark'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(AccessibilityInfo.setAccessibilityFocus).toHaveBeenCalledWith(1);
    expect(back.handlers).toHaveLength(1);
    await act(async () => {
      expect(back.handlers[0]!()).toBe(true);
    });
    for (let i = 0; i < 3; i += 1) await act(async () => undefined);
    expect(byTestId(renderer, 'tour-tip-cornerMark')).toHaveLength(0);
    expect((await loadProductTour('person-1')).seenTips).toEqual(['cornerMark']);
  });

  it('waits for a target that has not laid out, and never draws an empty overlay', async () => {
    rect.value = { x: 0, y: 0, width: 0, height: 0 };
    const renderer = await render(target('cornerMark'));
    expect(byTestId(renderer, 'tour-spotlight')).toHaveLength(0);
    expect((await loadProductTour('person-1')).seenTips).toEqual([]);
  });

  it('hides a tip when its target unmounts and keeps it due for the next encounter', async () => {
    function Screen({ show }: { show: boolean }) {
      return show ? target('squire') : null;
    }
    const renderer = await render(React.createElement(Screen, { show: true }));
    expect(byTestId(renderer, 'tour-tip-squire')).toHaveLength(1);
    await act(async () => {
      renderer.update(
        React.createElement(
          ProductTourProvider,
          null,
          React.createElement(Screen, { show: false }),
        ),
      );
    });
    expect(byTestId(renderer, 'tour-spotlight')).toHaveLength(0);
    expect((await loadProductTour('person-1')).seenTips).toEqual([]);
  });

  it('keeps a tip while any of its targets is still mounted', async () => {
    function Screens({ second }: { second: boolean }) {
      return React.createElement(
        'Host',
        null,
        target('cornerMark', 'Sidebar'),
        second ? target('cornerMark', 'List') : null,
      );
    }
    const renderer = await render(React.createElement(Screens, { second: true }));
    expect(byTestId(renderer, 'tour-tip-cornerMark')).toHaveLength(1);
    await act(async () => {
      renderer.update(
        React.createElement(
          ProductTourProvider,
          null,
          React.createElement(Screens, { second: false }),
        ),
      );
    });
    for (let i = 0; i < 3; i += 1) await act(async () => undefined);
    expect(byTestId(renderer, 'tour-tip-cornerMark')).toHaveLength(1);
  });

  it('Replay tips brings every retired tip back', async () => {
    for (const tip of ['swipe', 'cornerMark', 'squire'] as const)
      await markTourTipSeen('person-1', tip);
    await replayProductTour('person-1');
    const renderer = await render(target('squire'));
    expect(byTestId(renderer, 'tour-tip-squire')).toHaveLength(1);
  });
});
