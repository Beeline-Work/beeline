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
    Line: host('Line'),
  };
});

import { CORNER_META_SIZE, CORNER_STATUS_SIZE, CornerGlyph } from './CornerGlyph';
import { chromeStrokeWidth, MEMBERS_GLYPH_STROKE_WIDTH } from './MembersGlyph';
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

describe('CornerGlyph', () => {
  it('draws two strokes meeting at the bottom left, holding the 16px painted arm at 28', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(CornerGlyph, { size: 28, testID: 'corner-glyph' }));
    });
    const svg = renderer.root.findByType('Svg' as never);
    expect(svg.props.testID).toBe('corner-glyph');
    expect(svg.props.viewBox).toBe('0 0 24 24');
    expect(svg.props.width).toBe(28);
    expect(svg.props.height).toBe(28);
    expect(svg.props.accessibilityElementsHidden).toBe(true);

    const extent = 15 * (16 / 28);
    expect(extent * (28 / 24)).toBeCloseTo(10, 5);
    const reach = extent / 2;
    const left = 12 - reach;
    const right = 12 + reach;
    const top = 12 - reach;
    const bottom = 12 + reach;

    const lines = renderer.root.findAllByType('Line' as never);
    expect(lines).toHaveLength(2);
    const [upright, across] = lines;
    expect(upright.props.x1).toBeCloseTo(left, 5);
    expect(upright.props.x2).toBeCloseTo(left, 5);
    expect(upright.props.y1).toBeCloseTo(top, 5);
    expect(upright.props.y2).toBeCloseTo(bottom, 5);
    expect(across.props.x1).toBeCloseTo(left, 5);
    expect(across.props.x2).toBeCloseTo(right, 5);
    expect(across.props.y1).toBeCloseTo(bottom, 5);
    expect(across.props.y2).toBeCloseTo(bottom, 5);
    expect(across.props.stroke).toBe(brand.mark);
    expect(across.props.strokeWidth).toBe(chromeStrokeWidth(28));
    expect(chromeStrokeWidth(28) * (28 / 24)).toBeCloseTo(
      MEMBERS_GLYPH_STROKE_WIDTH * (16 / 24),
      5,
    );

    act(() => {
      renderer = create(React.createElement(CornerGlyph, { size: 16 }));
    });
    const at16 = renderer.root.findAllByType('Line' as never)[0]!;
    expect(at16.props.x1).toBe(4.5);
    expect(at16.props.y2).toBe(19.5);
  });

  it('keeps the inline sizes on the meta and status lines', () => {
    expect(CORNER_META_SIZE).toBe(13);
    expect(CORNER_STATUS_SIZE).toBe(11);
  });
});
