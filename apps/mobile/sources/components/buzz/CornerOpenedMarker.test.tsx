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
  return { default: host('Svg'), Polygon: host('Polygon'), Polyline: host('Polyline') };
});
vi.mock('./Ledger', () => ({ LEDGER_MARGINALIA_WIDTH: 36 }));

import { CORNER_BRANCH_POINTS, CornerBranchGlyph } from './CornerBranchGlyph';
import { CORNER_EXTENT } from './CornerGlyph';
import { CornerOpenedMarker, CornerOpenedMarkers } from './CornerOpenedMarker';
import brand from '@/buzz/brand.json';
import { foldPrLifecycleRuns } from '@/buzz/pr-lifecycle';
import { anchorCornerMarkers } from '@/buzz/corner-markers';

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
  const flatten = (value: any): string =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : Array.isArray(value)
        ? value.map(flatten).join('')
        : flatten(value?.props?.children ?? []);
  return renderer.root
    .findAll((node: any) => {
      if (node.type !== 'Text') return false;
      for (let parent = node.parent; parent; parent = parent.parent)
        if (parent.type === 'Text') return false;
      return true;
    })
    .map((node: any) => flatten(node.props.children))
    .join('')
    .replace(/\u00a0/g, ' ');
}

const pressable = (renderer: ReactTestRenderer) =>
  renderer.root.find((node: any) => node.type === 'Pressable' && node.props.testID === 'marker');

describe('CornerOpenedMarker', () => {
  it('names the corner the message opened and opens it on tap', () => {
    const onOpen = vi.fn();
    const renderer = render(
      <CornerOpenedMarker title="quiet amber corner" onOpen={onOpen} testID="marker" />,
    );
    const target = pressable(renderer);
    expect(target.props.accessibilityRole).toBe('link');
    expect(target.props.accessibilityLabel).toBe('Open corner quiet amber corner');
    expect(textOf(renderer)).toBe('Opened quiet amber corner');
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
    expect(textOf(renderer)).toBe('Closed quiet amber corner');
    act(() => pressable(renderer).props.onPress());
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

describe('anchored corner runs', () => {
  it.each([1, 2, 4])('uses the repository disclosure for %i markers', (count) => {
    const onOpenCorner = vi.fn();
    const message = {
      id: 'source',
      cornerMarkers: Array.from({ length: count }, (_, index) => ({
        id: `event-${index}`,
        daemonFact: {
          type: 'corner-open',
          cornerId: `corner-${index}`,
          name: `name-${index}`,
          objective: '',
        },
      })),
    } as unknown as import('@/buzz/room-view-presentation').ChatDisplayMessage;
    const renderer = render(
      <CornerOpenedMarkers
        message={message}
        onOpenCorner={onOpenCorner}
        onOpenUrl={() => undefined}
      />,
    );
    const host = (id: string) =>
      renderer.root.findAll(
        (node: any) => typeof node.type === 'string' && node.props.testID === id,
      )[0];
    if (count === 1) {
      expect(host('notification-run-expand-source')).toBeUndefined();
      expect(textOf(renderer)).toBe('Opened name-0');
    } else {
      expect(textOf(renderer)).toBe(`${count} corners opened`);
      expect(host('corner-opened-marker-corner-0')).toBeUndefined();
      act(() => host('notification-run-expand-source').props.onPress());
      expect(host('notification-run-expand-source').props.accessibilityState.expanded).toBe(true);
      act(() =>
        renderer.update(
          <CornerOpenedMarkers
            message={{ ...message }}
            onOpenCorner={onOpenCorner}
            onOpenUrl={() => undefined}
          />,
        ),
      );
      expect(host('corner-opened-marker-corner-0')).toBeTruthy();
      if (count === 4) {
        expect(host('corner-opened-marker-corner-2')).toBeUndefined();
        expect(textOf(renderer)).toContain('2 more');
        act(() => host('notification-run-more-source').props.onPress());
        expect(host('corner-opened-marker-corner-3')).toBeTruthy();
      }
    }
    act(() => host(`corner-opened-marker-corner-${count - 1}`).props.onPress());
    expect(onOpenCorner).toHaveBeenCalledWith(`corner-${count - 1}`);
    act(() => renderer.unmount());
  });
});

it.each(['Room', 'DM', 'corner'])(
  'updates one %s call-site row through review, merge and close',
  () => {
    const onOpenCorner = vi.fn(),
      onOpenUrl = vi.fn();
    const source = { id: 'request', text: 'Please build this', timestamp: 1, isUser: true };
    const marker = {
      id: 'same-marker',
      text: '',
      timestamp: 2,
      isUser: false,
      daemonFact: {
        type: 'corner-open' as const,
        sourceMessageId: source.id,
        cornerId: 'destination',
        name: '2832/steps-row-line',
        objective: '',
      },
    };
    const paint = (fact = marker.daemonFact) => {
      const rows = foldPrLifecycleRuns(
        anchorCornerMarkers([{ ...source }, { ...marker, daemonFact: fact }]),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].cornerMarkers).toHaveLength(1);
      return (
        <CornerOpenedMarkers message={rows[0]} onOpenCorner={onOpenCorner} onOpenUrl={onOpenUrl} />
      );
    };
    const renderer = render(paint());
    expect(textOf(renderer)).toBe('Opened 2832/steps-row-line');
    // A PR exists during review, but neither the verb nor the number changes.
    act(() =>
      renderer.update(
        paint({
          ...marker.daemonFact,
          pullRequest: { number: 2832, url: 'https://github.com/Beeline-Work/beeline/pull/2832' },
        } as any),
      ),
    );
    expect(textOf(renderer)).toBe('Opened 2832/steps-row-line');
    const target = () =>
      renderer.root.find(
        (node: any) =>
          node.type === 'Pressable' && node.props.testID === 'corner-opened-marker-destination',
      );
    const originalTarget = target();
    act(() =>
      renderer.update(
        paint({
          ...marker.daemonFact,
          type: 'corner-complete',
          outcome: 'landed',
          pullRequest: { number: 2832, url: 'https://github.com/Beeline-Work/beeline/pull/2832' },
        } as any),
      ),
    );
    expect(textOf(renderer)).toBe('Merged 2832/steps-row-line PR 2832');
    expect(target()).toBe(originalTarget);
    const link = renderer.root.find(
      (node: any) => node.type === 'Text' && node.props.accessibilityLabel === 'Open PR 2832',
    );
    const event = { stopPropagation: vi.fn() };
    act(() => link.props.onPress(event));
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onOpenUrl).toHaveBeenCalledWith('https://github.com/Beeline-Work/beeline/pull/2832');
    expect(onOpenCorner).not.toHaveBeenCalled();
    act(() => target().props.onPress());
    expect(onOpenCorner).toHaveBeenCalledWith('destination');
    act(() =>
      renderer.update(
        paint({ ...marker.daemonFact, type: 'corner-complete', outcome: 'abandoned' } as any),
      ),
    );
    expect(textOf(renderer)).toBe('Closed 2832/steps-row-line');
    expect(target()).toBe(originalTarget);
    act(() => target().props.onPress());
    expect(onOpenCorner).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  },
);
