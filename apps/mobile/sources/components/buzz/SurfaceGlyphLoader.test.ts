import * as React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { beelineThemes } from '@/buzz/groknight';
import { MARK_CELL, SURFACE_GLYPH_SIZE, ribbon } from '@/buzz/beeline-glyph';

type LoadingTreatment = 'glyph' | 'exception';
type LoadingSurface = {
  id: string;
  file: string;
  treatment: LoadingTreatment;
  reason?: string;
};

/**
 * Every normal-use loading surface and its treatment. A leftover on the old
 * four-dot PixelLoader must land here as an explicit exception — never silently.
 * Paths are relative to `apps/mobile/sources`.
 */
const LOADING_SURFACES: readonly LoadingSurface[] = [
  { id: 'thinking', file: 'components/buzz/TurnProgressLine.tsx', treatment: 'glyph' },
  { id: 'activity-working', file: 'components/buzz/ActivityTimeline.tsx', treatment: 'glyph' },
  { id: 'room-corner-entry', file: 'app/(app)/beeline/chat/_chat-surface.tsx', treatment: 'glyph' },
  { id: 'room-deck', file: 'components/buzz/RoomDeckLoadingView.tsx', treatment: 'glyph' },
  { id: 'changes-list', file: 'app/(app)/beeline/corners/[roomId].tsx', treatment: 'glyph' },
  { id: 'members', file: 'app/(app)/beeline/members.tsx', treatment: 'glyph' },
  {
    id: 'workspace-settings',
    file: 'app/(app)/beeline/settings/workspace.tsx',
    treatment: 'glyph',
  },
  { id: 'community', file: 'app/(app)/beeline/community.tsx', treatment: 'glyph' },
  { id: 'schedules', file: 'app/(app)/beeline/settings/schedules.tsx', treatment: 'glyph' },
  { id: 'workbench', file: 'app/(app)/beeline/settings/workbench.tsx', treatment: 'glyph' },
  {
    id: 'workbench-connect',
    file: 'app/(app)/beeline/settings/workbench/connect.tsx',
    treatment: 'glyph',
  },
  { id: 'wallet', file: 'app/(app)/beeline/settings/workbench/wallet.tsx', treatment: 'glyph' },
  { id: 'tray', file: 'app/(app)/beeline/tray.tsx', treatment: 'glyph' },
  { id: 'member-picker', file: 'components/buzz/MemberPickerSheet.tsx', treatment: 'glyph' },
  {
    id: 'forward-picker',
    file: 'components/buzz/ForwardMessagePickerSheet.tsx',
    treatment: 'glyph',
  },
  { id: 'desktop-sidebar', file: 'components/SidebarView.tsx', treatment: 'glyph' },
  { id: 'desktop-inspector', file: 'components/DesktopRoomInspector.tsx', treatment: 'glyph' },
  { id: 'invite-join', file: 'app/(app)/join/[token].tsx', treatment: 'glyph' },
  { id: 'review-signin', file: 'app/(app)/review/[secret].tsx', treatment: 'glyph' },
  {
    id: 'button-busy',
    file: 'components/buzz/MonoHull.tsx',
    treatment: 'exception',
    reason:
      'MonoButton/BrassButton compact busy sits on a labeled 44pt control; a release-loop glyph would crowd the plate and flash on sub-100ms submits.',
  },
  {
    id: 'ota-check-busy',
    file: 'app/(app)/beeline/settings/identity.tsx',
    treatment: 'exception',
    reason:
      'Trailing Settings-row busy while a version check returns; same compact-control case as a button, not a page load gate.',
  },
  {
    id: 'history-line',
    file: 'app/(app)/beeline/chat/_chat-surface.tsx',
    treatment: 'exception',
    reason:
      '"Loading earlier messages…" is an inscribed transcript history row, not a load gate. A painting glyph would interrupt the ledger.',
  },
  {
    id: 'artifact-preview',
    file: 'components/buzz/ArtifactCard.tsx',
    treatment: 'exception',
    reason:
      'Content-shaped preview placeholder; cache hits resolve in well under 100ms and a paint loop would flash.',
  },
  {
    id: 'artifact-viewer',
    file: 'components/buzz/ArtifactViewer.tsx',
    treatment: 'exception',
    reason:
      'Content-shaped viewer placeholder while preview bytes or the native module resolve; same flash risk as the card.',
  },
  {
    id: 'desktop-artifact',
    file: 'components/buzz/DesktopArtifactPane.tsx',
    treatment: 'exception',
    reason: 'Shares the artifact viewer placeholder; not a Room/Corner load gate.',
  },
  {
    id: 'webview-signin',
    file: 'app/(app)/beeline/settings/workbench/connect-signin.tsx',
    treatment: 'exception',
    reason: 'Native WebView document chrome, not a Beeline surface load gate.',
  },
  {
    id: 'legacy-round-button',
    file: 'components/RoundButton.tsx',
    treatment: 'exception',
    reason: 'Vendored Happy control busy indicator; not a Beeline load gate.',
  },
  {
    id: 'legacy-item',
    file: 'components/Item.tsx',
    treatment: 'exception',
    reason: 'Vendored Happy list-item busy indicator; not a Beeline load gate.',
  },
];

function loadingSurfaceGlyphFiles(): readonly string[] {
  return [
    ...new Set(
      LOADING_SURFACES.filter((surface) => surface.treatment === 'glyph').map(
        (surface) => surface.file,
      ),
    ),
  ];
}

function loadingSurfaceExceptionFiles(): readonly string[] {
  return [
    ...new Set(
      LOADING_SURFACES.filter((surface) => surface.treatment === 'exception').map(
        (surface) => surface.file,
      ),
    ),
  ];
}

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Path: host('Path'), G: host('G') };
});

const motion = vi.hoisted(() => ({
  reducedMotion: false,
  repeats: [] as Array<{ count: unknown; reverse: unknown }>,
}));

const themeRef = vi.hoisted(() => ({
  current: { buzz: { dark: true } },
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: themeRef.current }),
  StyleSheet: {
    hairlineWidth: 1,
    create: (definition: unknown) =>
      typeof definition === 'function'
        ? (definition as (value: typeof themeRef.current) => unknown)(themeRef.current)
        : definition,
  },
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: any) => ReactModule.createElement('AnimatedView', props),
      createAnimatedComponent: () => (props: any) =>
        ReactModule.createElement('AnimatedPath', props),
    },
    Easing: {
      cubic: 'cubic',
      inOut: (fn: unknown) => fn,
      linear: 'linear',
      out: (fn: unknown) => fn,
    },
    ReduceMotion: { System: 'system' },
    cancelAnimation: vi.fn(),
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    useAnimatedProps: (factory: () => unknown) => factory(),
    useReducedMotion: () => motion.reducedMotion,
    useSharedValue: (value: number) => ({ value }),
    withDelay: (_ms: number, value: unknown) => value,
    withRepeat: (value: unknown, count: unknown, reverse: unknown) => {
      motion.repeats.push({ count, reverse });
      return value;
    },
    withSequence: (...steps: unknown[]) => steps,
    withTiming: (value: number) => value,
  };
});

import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';

const originalConsoleError = console.error;
const SOURCES_ROOT = path.resolve(__dirname, '../..');

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

beforeEach(() => {
  themeRef.current = { buzz: beelineThemes.obsidian };
});

afterEach(() => {
  motion.reducedMotion = false;
  motion.repeats = [];
  themeRef.current = { buzz: beelineThemes.obsidian };
});

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function dots(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('View').filter((node) => {
    const style = node.props.style;
    const resolved = Array.isArray(style) ? Object.assign({}, ...style) : style;
    return resolved?.width === 5 || resolved?.width === 7;
  });
}

const GLYPH_MARKERS = ['SurfaceGlyphLoader', 'BeelineGlyphPaint', 'BeelineMarkSpinner'] as const;

function walkSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) return walkSourceFiles(full);
    if (!/\.(ts|tsx)$/.test(name)) return [];
    if (/\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

function pixelLoaderCallSites(): string[] {
  return walkSourceFiles(SOURCES_ROOT)
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /<PixelLoader\b/.test(source);
    })
    .map((file) => path.relative(SOURCES_ROOT, file).replaceAll('\\', '/'));
}

describe('SurfaceGlyphLoader', () => {
  it('paints the release-loop glyph at the surface size, never dots', () => {
    const renderer = render(React.createElement(SurfaceGlyphLoader));
    const screen = renderer.root.findByProps({ testID: 'surface-glyph-loader' });
    expect(screen.props.accessibilityRole).toBe('progressbar');
    expect(renderer.root.findByType('Svg').props.width).toBe(SURFACE_GLYPH_SIZE);
    expect(renderer.root.findByType('AnimatedPath').props.d).toBe(ribbon.path);
    expect(motion.repeats[0]?.reverse).toBe(false);
    expect(dots(renderer)).toHaveLength(0);
  });

  it('keeps compact loaders on the thinking cell so inline gates match the thinking line', () => {
    const renderer = render(React.createElement(SurfaceGlyphLoader, { compact: true }));
    expect(renderer.root.findByType('Svg').props.width).toBe(MARK_CELL);
    expect(dots(renderer)).toHaveLength(0);
  });
});

describe('Room loading boundary', () => {
  it('paints only after the native splash hands off to a loading Room deck', async () => {
    const { RoomDeckLoadingView } = await import('./RoomDeckLoadingView');
    const deck = render(React.createElement(RoomDeckLoadingView));
    expect(deck.root.findByProps({ testID: 'rooms-loader-gate' })).toBeTruthy();
    expect(deck.root.findByProps({ testID: 'rooms-loader' })).toBeTruthy();
    expect(deck.root.findAllByType('Svg')).toHaveLength(1);
  });
});

describe('normal-use loading surfaces', () => {
  it('records a reason for every surface that stays off the glyph', () => {
    for (const surface of LOADING_SURFACES) {
      if (surface.treatment === 'exception') {
        expect(surface.reason?.trim().length, surface.id).toBeGreaterThan(10);
      } else {
        expect(surface.reason, surface.id).toBeUndefined();
      }
    }
  });

  it('keeps every glyph surface on the painting mark, not PixelLoader', () => {
    for (const file of loadingSurfaceGlyphFiles()) {
      const source = readFileSync(path.join(SOURCES_ROOT, file), 'utf8');
      expect(
        GLYPH_MARKERS.some((marker) => source.includes(marker)),
        `${file} is a glyph load gate but mounts none of ${GLYPH_MARKERS.join(', ')}`,
      ).toBe(true);
      expect(source, `${file} still mounts PixelLoader`).not.toMatch(/<PixelLoader\b/);
    }
  });

  it('refuses a newly found PixelLoader load gate without a recorded exception', () => {
    const allowed = new Set(loadingSurfaceExceptionFiles());
    for (const file of pixelLoaderCallSites()) {
      expect(
        allowed.has(file),
        `${file} still mounts PixelLoader without a recorded exception`,
      ).toBe(true);
    }
  });
});
