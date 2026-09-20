import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    default: host('Svg'),
    Circle: host('Circle'),
    Polygon: host('Polygon'),
  };
});

import { MEMBERS_GLYPH_STROKE_WIDTH, MembersGlyph } from './MembersGlyph';
import { ROOM_GLYPH_STROKE_WIDTH } from './RoomGlyph';
import brand from '@/buzz/brand.json';

const originalConsoleError = console.error;

function polygonVertices(points: string): Array<{ x: number; y: number }> {
  const nums = points
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  const vertices: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    vertices.push({ x: nums[i]!, y: nums[i + 1]! });
  }
  return vertices;
}

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

describe('MembersGlyph', () => {
  it('matches RoomGlyph’s mark contract: 24 viewBox, brand default, stroke-only, heavier chrome stroke', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(MembersGlyph, { testID: 'members-glyph' }));
    });
    const svg = renderer.root.findByType('Svg' as never);
    expect(svg.props.testID).toBe('members-glyph');
    expect(svg.props.viewBox).toBe('0 0 24 24');
    expect(svg.props.width).toBe(24);
    expect(svg.props.height).toBe(24);
    expect(svg.props.accessibilityElementsHidden).toBe(true);
    expect(svg.props.focusable).toBe(false);
    expect(MEMBERS_GLYPH_STROKE_WIDTH).toBeGreaterThan(ROOM_GLYPH_STROKE_WIDTH);
    expect(MEMBERS_GLYPH_STROKE_WIDTH).toBe(1.75);

    const circle = renderer.root.findByType('Circle' as never);
    const body = renderer.root.findByType('Polygon' as never);
    expect(circle.props.fill).toBe('none');
    expect(circle.props.stroke).toBe(brand.mark);
    expect(circle.props.strokeWidth).toBe(MEMBERS_GLYPH_STROKE_WIDTH);
    expect(body.props.fill).toBe('none');
    expect(body.props.stroke).toBe(brand.mark);
    expect(body.props.strokeWidth).toBe(MEMBERS_GLYPH_STROKE_WIDTH);
  });

  it('draws a right-isosceles body: equal legs from the apex, 90° at the apex', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(MembersGlyph, { testID: 'members-glyph' }));
    });
    const circle = renderer.root.findByType('Circle' as never);
    const body = renderer.root.findByType('Polygon' as never);
    const cx = Number(circle.props.cx);
    const cy = Number(circle.props.cy);
    const r = Number(circle.props.r);
    const vertices = polygonVertices(String(body.props.points));
    expect(vertices).toHaveLength(3);

    const maxY = Math.max(...vertices.map((vertex) => vertex.y));
    const base = vertices.filter((vertex) => vertex.y === maxY);
    const apexes = vertices.filter((vertex) => vertex.y !== maxY);
    expect(base).toHaveLength(2);
    expect(apexes).toHaveLength(1);
    const apex = apexes[0]!;
    const left = base[0]!.x < base[1]!.x ? base[0]! : base[1]!;
    const right = base[0]!.x < base[1]!.x ? base[1]! : base[0]!;

    const leftLeg = Math.hypot(apex.x - left.x, apex.y - left.y);
    const rightLeg = Math.hypot(apex.x - right.x, apex.y - right.y);
    expect(leftLeg).toBeCloseTo(rightLeg, 5);
    expect(leftLeg).toBeGreaterThan(0);

    const vLeftX = left.x - apex.x;
    const vLeftY = left.y - apex.y;
    const vRightX = right.x - apex.x;
    const vRightY = right.y - apex.y;
    expect(vLeftX * vRightX + vLeftY * vRightY).toBeCloseTo(0, 5);

    expect(cx).toBeCloseTo(12);
    const apexDistance = Math.hypot(apex.x - cx, apex.y - cy);
    expect(apexDistance).toBeCloseTo(r, 5);
    expect(right.x).toBeGreaterThan(left.x);
  });

  it('accepts the 16px chrome size the Room-list and desktop heading actually use', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(MembersGlyph, { size: 16, color: '#83838d' }));
    });
    const svg = renderer.root.findByType('Svg' as never);
    expect(svg.props.width).toBe(16);
    expect(svg.props.height).toBe(16);
    expect(renderer.root.findByType('Circle' as never).props.stroke).toBe('#83838d');
  });
});
