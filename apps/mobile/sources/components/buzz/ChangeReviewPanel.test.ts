import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  const FlatList = (props: any) =>
    ReactModule.createElement(
      'FlatList',
      props,
      props.data.map((item: unknown, index: number) =>
        ReactModule.createElement(
          ReactModule.Fragment,
          { key: props.keyExtractor(item, index) },
          props.renderItem({ item, index }),
        ),
      ),
    );
  return {
    ActivityIndicator: host('ActivityIndicator'),
    FlatList,
    Platform: {
      OS: 'android',
      select: (opts: Record<string, unknown>) =>
        opts.android ?? opts.default ?? opts.ios ?? opts.web,
    },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    BrittlePress: host('BrittlePress'),
    HullSurface: host('HullSurface'),
    PixelLoader: host('PixelLoader'),
  };
});

import { ChangeReviewPanel, withChangeReviewTimeout } from './ChangeReviewPanel';
import { darkTheme } from '@/theme';

const diffColors = darkTheme.colors.diff;

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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ChangeReviewPanel', () => {
  it('turns a stalled file manifest read into a retryable timeout', async () => {
    await expect(withChangeReviewTimeout(new Promise<never>(() => undefined), 1)).rejects.toThrow(
      'Timed out while loading file diffs.',
    );
  });

  it('renders changed files and lazy-loads the selected per-file diff', async () => {
    const transport = {
      workspaceFilesRead: vi.fn(async () => [
        { path: 'src/example.ts', status: 'modified', linesAdded: 2, linesRemoved: 1 },
        { path: 'README.md', status: 'added', linesAdded: 4, linesRemoved: 0 },
      ]),
      changedFileRead: vi.fn(async () => ({
        content: 'diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new',
      })),
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(ChangeReviewPanel, {
          transport,
          sessionId: 'change-1',
          tip: 'c'.repeat(40),
        }),
      );
    });
    await settle();

    expect(renderer.root.findByProps({ testID: 'change-review-files' })).toBeDefined();
    expect(transport.changedFileRead).not.toHaveBeenCalled();

    await act(async () => {
      renderer.root.findByProps({ testID: 'change-review-file-src/example.ts' }).props.onPress();
      await Promise.resolve();
    });
    await settle();

    expect(transport.changedFileRead).toHaveBeenCalledWith('change-1', 'src/example.ts');
    expect(renderer.root.findByProps({ testID: 'change-review-diff' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'change-review-line-2' }).props.children).toBe(
      '-old',
    );
    expect(renderer.root.findByProps({ testID: 'change-review-line-3' }).props.children).toBe(
      '+new',
    );

    // Scrollable, both axes, vertical as the OUTER/primary scroller (the
    // Android-supported nesting direction): change-review-diff-scroll is a
    // vertical ScrollView, not a FlatList trapped inside a horizontal
    // ScrollView (the shape that broke vertical drag on-device).
    const scroller = renderer.root.findByProps({ testID: 'change-review-diff-scroll' });
    expect(scroller.props.horizontal).not.toBe(true);
    expect(scroller.props.nestedScrollEnabled).toBe(true);
    expect(scroller.props.showsVerticalScrollIndicator).toBe(true);
    expect(renderer.root.findAllByType('FlatList').length).toBe(0);

    const horizontalScrollers = renderer.root
      .findAllByType('ScrollView')
      .filter((node: { props: { horizontal?: boolean } }) => node.props.horizontal === true);
    expect(horizontalScrollers.length).toBe(1);
    const innerScroller = horizontalScrollers[0];
    expect(innerScroller.props.nestedScrollEnabled).toBe(true);

    const lineStyle = Object.assign(
      {},
      ...[renderer.root.findByProps({ testID: 'change-review-line-2' }).props.style].flat(),
    );
    expect(lineStyle.width).toBe(innerScroller.props.contentContainerStyle.minWidth);

    // Parsed into visually distinct add/remove/header/context lines — never
    // identical. Diffs are a deliberate color exception to the app's
    // otherwise-grayscale Buzz UI: added lines render green, removed lines
    // render red, distinct from each other and from the neutral header line.
    const headerLine = renderer.root.findByProps({ testID: 'change-review-line-0' });
    const removedLine = renderer.root.findByProps({ testID: 'change-review-line-2' });
    const addedLine = renderer.root.findByProps({ testID: 'change-review-line-3' });
    const flatten = (instance: { props: { style: unknown } }) =>
      Object.assign({}, ...[instance.props.style].flat());
    const headerStyle = flatten(headerLine);
    const removedStyle = flatten(removedLine);
    const addedStyle = flatten(addedLine);
    expect(addedStyle.color).toBe(diffColors.addedBorder);
    expect(removedStyle.color).toBe(diffColors.removedBorder);
    expect(addedStyle.color).not.toBe(removedStyle.color);
    expect(addedStyle.backgroundColor).toBe(diffColors.addedBg);
    expect(removedStyle.backgroundColor).toBe(diffColors.removedBg);
    expect(new Set([headerStyle.backgroundColor, removedStyle.backgroundColor, addedStyle.backgroundColor]).size)
      .toBeGreaterThan(1);
  });

  it('caps rendered diff lines and shows a truncation footer for a huge diff', async () => {
    const hugePatch = Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join('\n');
    const transport = {
      workspaceFilesRead: vi.fn(async () => [
        { path: 'big.ts', status: 'modified', linesAdded: 2000, linesRemoved: 0 },
      ]),
      changedFileRead: vi.fn(async () => ({ content: hugePatch })),
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(ChangeReviewPanel, {
          transport,
          sessionId: 'change-2',
          tip: 'd'.repeat(40),
        }),
      );
    });
    await settle();

    await act(async () => {
      renderer.root.findByProps({ testID: 'change-review-file-big.ts' }).props.onPress();
      await Promise.resolve();
    });
    await settle();

    expect(renderer.root.findByProps({ testID: 'change-review-line-1499' })).toBeDefined();
    expect(() => renderer.root.findByProps({ testID: 'change-review-line-1500' })).toThrow();

    const texts = renderer.root
      .findAllByType('Text')
      .map((node: { props: { children?: unknown } }) =>
        Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children,
      );
    expect(texts).toContain('diff truncated — showing 1500 of 2000 lines');
  });

  it('shows an oversized manifest stub without requesting a missing patch', async () => {
    const transport = {
      workspaceFilesRead: vi.fn(async () => [
        {
          path: 'vendor.min.js',
          status: 'added',
          linesAdded: 1,
          linesRemoved: 0,
          patchBytes: 3_000_123,
          renderUnavailableReason: 'too-large' as const,
        },
      ]),
      changedFileRead: vi.fn(async () => null),
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(ChangeReviewPanel, {
          transport,
          sessionId: 'change-large',
          tip: 'e'.repeat(40),
        }),
      );
    });
    await settle();

    await act(async () => {
      renderer.root.findByProps({ testID: 'change-review-file-vendor.min.js' }).props.onPress();
      await Promise.resolve();
    });
    await settle();

    expect(transport.changedFileRead).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: 'change-review-too-large' })).toBeDefined();
    const texts = renderer.root
      .findAllByType('Text')
      .map((node: { props: { children?: unknown } }) =>
        Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children,
      );
    expect(texts).toContain('Diff too large to render');
    expect(texts).toContain('3.0 MB is included in this change but can’t be shown here.');
  });
});
