import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
const back = vi.hoisted(() => ({ handlers: [] as Array<() => boolean> }));
const rect = vi.hoisted(() => ({ value: { x: 16, y: 120, width: 358, height: 64 } }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void storage.set(key, value)),
    removeItem: vi.fn(async (key: string) => void storage.delete(key)),
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
vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  return {
    HullModal: (props: any) =>
      props.visible ? ReactModule.createElement('HullModal', props, props.children) : null,
    HullFloatingSurface: (props: any) =>
      ReactModule.createElement('Surface', props, props.children),
  };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    PixelGateReveal: (props: any) => ReactModule.createElement('Reveal', props, props.children),
  };
});
vi.mock('@/components/buzz/RoomGlyph', () => ({ RoomGlyph: () => null }));
vi.mock('@/components/buzz/MembersGlyph', () => ({ MembersGlyph: () => null }));
vi.mock('@/components/buzz/CornerGlyph', () => ({ CornerGlyph: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import { AccessibilityInfo } from 'react-native';
import { ProductTourProvider, TOUR_OVERVIEW_CARDS } from './ProductTour';
import { ProductTourRoomCue, TourTarget } from './TourTarget';
import {
  finishProductTourOverview,
  loadProductTour,
  offerProductTour,
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

describe('the product tour', () => {
  beforeEach(() => {
    storage.clear();
    resetProductTourCacheForTests();
    back.handlers.length = 0;
    rect.value = { x: 16, y: 120, width: 358, height: 64 };
  });

  it('offers the four cards only after the first Room renders, and Skip ends it on any card', async () => {
    await offerProductTour('person-1');
    const idle = await render(React.createElement(ProductTourRoomCue, { ready: false }));
    expect(byTestId(idle, 'tour-overview')).toHaveLength(0);

    const renderer = await render(React.createElement(ProductTourRoomCue, { ready: true }));
    expect(byTestId(renderer, 'tour-card-title')[0]!.props.children).toBe(
      TOUR_OVERVIEW_CARDS[0].title,
    );
    await press(renderer, 'tour-next');
    await press(renderer, 'tour-skip');
    expect(byTestId(renderer, 'tour-overview')).toHaveLength(0);
    expect((await loadProductTour('person-1')).overview).toBe('skipped');
  });

  it('walks all four cards to completion', async () => {
    await offerProductTour('person-1');
    const renderer = await render(React.createElement(ProductTourRoomCue, { ready: true }));
    for (const card of TOUR_OVERVIEW_CARDS) {
      expect(byTestId(renderer, 'tour-card-title')[0]!.props.children).toBe(card.title);
      await press(renderer, 'tour-next');
    }
    expect((await loadProductTour('person-1')).overview).toBe('completed');
  });

  it('points at a mounted target once, and back dismisses it', async () => {
    await offerProductTour('person-1');
    await finishProductTourOverview('person-1', 'skipped');
    const renderer = await render(
      React.createElement(TourTarget, { tip: 'rooms', children: React.createElement('Row') }),
    );
    expect(byTestId(renderer, 'tour-tip-rooms')).toHaveLength(1);
    expect(byTestId(renderer, 'tour-cutout')[0]!.props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ left: 10, top: 114, width: 370, height: 76 }),
      ]),
    );
    // Screen-reader focus lands on the tip once it is on screen.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(AccessibilityInfo.setAccessibilityFocus).toHaveBeenCalledWith(1);
    expect(back.handlers).toHaveLength(1);
    await act(async () => {
      expect(back.handlers[0]!()).toBe(true);
    });
    for (let i = 0; i < 3; i += 1) await act(async () => undefined);
    expect(byTestId(renderer, 'tour-tip-rooms')).toHaveLength(0);
    expect((await loadProductTour('person-1')).seenTips).toEqual(['rooms']);
  });

  it('waits for a target that has not laid out, and never draws an empty overlay', async () => {
    await offerProductTour('person-1');
    await finishProductTourOverview('person-1', 'completed');
    rect.value = { x: 0, y: 0, width: 0, height: 0 };
    const renderer = await render(
      React.createElement(TourTarget, { tip: 'corner', children: React.createElement('Row') }),
    );
    expect(byTestId(renderer, 'tour-spotlight')).toHaveLength(0);
    expect((await loadProductTour('person-1')).seenTips).toEqual([]);
  });

  it('hides a tip when its target unmounts and keeps it due for the next encounter', async () => {
    await offerProductTour('person-1');
    await finishProductTourOverview('person-1', 'completed');
    function Screen({ show }: { show: boolean }) {
      return show
        ? React.createElement(TourTarget, {
            tip: 'workbench',
            children: React.createElement('Row'),
          })
        : null;
    }
    const renderer = await render(React.createElement(Screen, { show: true }));
    expect(byTestId(renderer, 'tour-tip-workbench')).toHaveLength(1);
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

  it('lets Skip tips retire every remaining spotlight', async () => {
    await offerProductTour('person-1');
    await finishProductTourOverview('person-1', 'completed');
    const renderer = await render(
      React.createElement(TourTarget, { tip: 'rooms', children: React.createElement('Row') }),
    );
    await press(renderer, 'tour-tip-skip');
    expect((await loadProductTour('person-1')).seenTips).toEqual(['rooms', 'corner', 'workbench']);
  });

  it('never shows a spotlight to someone who was never offered the tour', async () => {
    const renderer = await render(
      React.createElement(TourTarget, { tip: 'rooms', children: React.createElement('Row') }),
    );
    expect(byTestId(renderer, 'tour-spotlight')).toHaveLength(0);
  });
});
