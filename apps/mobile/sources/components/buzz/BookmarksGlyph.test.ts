import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    default: host('Svg'),
    Polygon: host('Polygon'),
  };
});

import { BookmarksGlyph } from './BookmarksGlyph';
import { MEMBERS_GLYPH_STROKE_WIDTH } from './MembersGlyph';
import brand from '@/buzz/brand.json';

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

describe('BookmarksGlyph', () => {
  it('draws the outline bookmark with the same even stroke as MembersGlyph', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(BookmarksGlyph, {
          size: 16,
          color: '#83838d',
          testID: 'workspace-bookmarks-glyph',
        }),
      );
    });
    const svg = renderer.root.findByType('Svg' as never);
    expect(svg.props.width).toBe(16);
    expect(svg.props.height).toBe(16);
    expect(svg.props.viewBox).toBe('0 0 24 24');
    expect(svg.props.testID).toBe('workspace-bookmarks-glyph');
    expect(svg.props.accessibilityElementsHidden).toBe(true);

    const outline = renderer.root.findByType('Polygon' as never);
    expect(outline.props.fill).toBe('none');
    expect(outline.props.stroke).toBe('#83838d');
    expect(outline.props.strokeWidth).toBe(MEMBERS_GLYPH_STROKE_WIDTH);
    expect(outline.props.strokeLinejoin).toBe('round');
  });

  it('defaults to the brand mark at the shared 24 view size', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(BookmarksGlyph));
    });
    const svg = renderer.root.findByType('Svg' as never);
    const outline = renderer.root.findByType('Polygon' as never);
    expect(svg.props.width).toBe(24);
    expect(svg.props.height).toBe(24);
    expect(outline.props.stroke).toBe(brand.mark);
  });
});
