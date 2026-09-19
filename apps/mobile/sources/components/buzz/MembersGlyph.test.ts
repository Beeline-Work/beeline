import * as React from 'react';
import { readFileSync } from 'node:fs';
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

const source = readFileSync(new URL('./MembersGlyph.tsx', import.meta.url), 'utf8');

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

describe('MembersGlyph', () => {
  it('matches RoomGlyph’s mark contract: 24 viewBox, brand default, stroke-only', () => {
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
    expect(MEMBERS_GLYPH_STROKE_WIDTH).toBe(ROOM_GLYPH_STROKE_WIDTH);

    const circle = renderer.root.findByType('Circle' as never);
    const body = renderer.root.findByType('Polygon' as never);
    expect(circle.props.fill).toBe('none');
    expect(circle.props.stroke).toBe(brand.mark);
    expect(circle.props.strokeWidth).toBe(MEMBERS_GLYPH_STROKE_WIDTH);
    expect(body.props.fill).toBe('none');
    expect(body.props.stroke).toBe(brand.mark);
    expect(body.props.strokeWidth).toBe(MEMBERS_GLYPH_STROKE_WIDTH);
    expect(source).not.toMatch(/fill=\{?['"](?!none)/);
  });

  it('puts the triangle apex on the head, slightly left, so the right edge is the long side', () => {
    const cx = Number(source.match(/cx="([^"]+)"/)?.[1]);
    const cy = Number(source.match(/cy="([^"]+)"/)?.[1]);
    const r = Number(source.match(/\br="([^"]+)"/)?.[1]);
    const points = source.match(/points="([^"]+)"/)?.[1].split(/\s+/).map(Number) ?? [];
    const [apexX, apexY, rightX, rightY, leftX, leftY] = points;
    expect(cx).toBeCloseTo(12);
    expect(apexX).toBeLessThan(cx);
    const apexDistance = Math.hypot(apexX - cx, apexY - cy);
    expect(apexDistance).toBeCloseTo(r, 1);
    const leftLen = Math.hypot(apexX - leftX, apexY - leftY);
    const rightLen = Math.hypot(apexX - rightX, apexY - rightY);
    expect(rightLen).toBeGreaterThan(leftLen);
    expect(rightY).toBe(leftY);
    expect(rightX).toBeGreaterThan(leftX);
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
