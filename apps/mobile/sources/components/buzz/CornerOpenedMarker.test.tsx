import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Pressable: host('Pressable'), Text: host('Text'), View: host('View') };
});
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Polygon: host('Polygon') };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: (theme: unknown) => unknown) =>
      factory({
        buzz: {
          space: { xs: 4, sm: 8, md: 16 },
          type: { meta: { fontSize: 13, lineHeight: 18 } },
          proseRegular: 'IBMPlexSans-Regular',
          ledgerQuiet: '#8a8a93',
          ledgerBody: '#e8e6e3',
          accent: '#E5A645',
        },
      }),
  },
}));
vi.mock('./Ledger', () => ({ LEDGER_MARGINALIA_WIDTH: 36 }));

import { CORNER_BRANCH_POINTS, CornerBranchGlyph } from './CornerBranchGlyph';
import { CORNER_EXTENT } from './CornerGlyph';
import { CornerOpenedMarker } from './CornerOpenedMarker';
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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function textOf(renderer: ReactTestRenderer): string {
  const flatten = (node: any): string =>
    typeof node === 'string' ? node : (node?.children ?? []).map(flatten).join('');
  const lines: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node === 'string') return;
    if (node.type === 'Text') lines.push(flatten(node));
    else (node.children ?? []).forEach(walk);
  };
  walk(renderer.toJSON());
  return lines.join(' | ');
}

describe('CornerOpenedMarker', () => {
  it('names the corner the message opened and opens it on tap', () => {
    const onOpen = vi.fn();
    const renderer = render(
      <CornerOpenedMarker title="quiet amber corner" onOpen={onOpen} testID="marker" />,
    );
    const target = renderer.root.findByType('Pressable' as never);
    expect(target.props.testID).toBe('marker');
    expect(target.props.accessibilityRole).toBe('link');
    expect(target.props.accessibilityLabel).toBe('Open corner quiet amber corner');
    expect(textOf(renderer)).toBe('Corner opened · quiet amber corner | Open →');
    // The drop-down mark leads the line.
    expect(renderer.root.findAllByType(CornerBranchGlyph)).toHaveLength(1);

    act(() => target.props.onPress());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('says a closed corner closed, and still opens it', () => {
    const onOpen = vi.fn();
    const renderer = render(
      <CornerOpenedMarker title="quiet amber corner" closed onOpen={onOpen} testID="marker" />,
    );
    expect(textOf(renderer)).toBe('Corner closed · quiet amber corner | Open →');
    act(() => renderer.root.findByType('Pressable' as never).props.onPress());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('CornerBranchGlyph', () => {
  it('is one gold polygon: a diagonal-cut stem turning into an arrowhead', () => {
    const renderer = render(<CornerBranchGlyph size={13} testID="branch" />);
    const svg = renderer.root.findByType('Svg' as never);
    expect(svg.props).toMatchObject({ testID: 'branch', viewBox: '0 0 24 24', width: 13 });
    expect(svg.props.accessibilityElementsHidden).toBe(true);
    const [polygon, ...rest] = renderer.root.findAllByType('Polygon' as never);
    expect(rest).toHaveLength(0);
    expect(polygon!.props.fill).toBe(brand.mark);
    expect(polygon!.props.points).toBe(CORNER_BRANCH_POINTS);

    const points = CORNER_BRANCH_POINTS.split(' ').map(Number);
    const xs = points.filter((_, index) => index % 2 === 0);
    const ys = points.filter((_, index) => index % 2 === 1);
    // Centred in the box like the corner mark, never the same outline.
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBe(12);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBe(12);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(CORNER_EXTENT);
    // The rightmost point is the arrow's tip, level with the arm's middle.
    const tip = xs.indexOf(Math.max(...xs));
    expect(ys[tip]).toBe(16);
  });
});
