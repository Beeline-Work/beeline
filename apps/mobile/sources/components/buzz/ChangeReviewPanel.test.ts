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

    // Scrollable, both axes: horizontal ScrollView (isolated from the parent
    // transcript list on Android via nestedScrollEnabled) wrapping a vertical
    // FlatList that is itself nestedScrollEnabled.
    const scroller = renderer.root.findByProps({ testID: 'change-review-diff-scroll' });
    expect(scroller.props.horizontal).toBe(true);
    expect(scroller.props.nestedScrollEnabled).toBe(true);
    const diffList = renderer.root.findByType('FlatList');
    expect(diffList.props.nestedScrollEnabled).toBe(true);
    const flattenedListStyle = Object.assign({}, ...[diffList.props.style].flat());
    expect(flattenedListStyle.width).toBe(scroller.props.contentContainerStyle.minWidth);

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
});
