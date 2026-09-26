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
    Path: host('Path'),
  };
});

import { TrayGlyph } from './TrayGlyph';
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

describe('TrayGlyph', () => {
  it('draws the outline tray with the same even stroke as MembersGlyph', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(TrayGlyph, { size: 16, color: '#83838d', testID: 'tray-glyph' }),
      );
    });
    const svg = renderer.root.findByType('Svg' as never);
    expect(svg.props.width).toBe(16);
    expect(svg.props.viewBox).toBe('0 0 24 24');
    expect(svg.props.testID).toBe('tray-glyph');
    expect(svg.props.accessibilityElementsHidden).toBe(true);
    const [box, lip] = renderer.root.findAllByType('Path' as never);
    expect(box!.props.fill).toBe('none');
    for (const stroke of [box!, lip!]) {
      expect(stroke.props.stroke).toBe('#83838d');
      expect(stroke.props.strokeWidth).toBe(chromeStrokeWidth(16));
    }
    expect(chromeStrokeWidth(16)).toBe(MEMBERS_GLYPH_STROKE_WIDTH);
  });

  it('defaults to the brand mark at the shared 24 view size', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(TrayGlyph));
    });
    expect(renderer.root.findByType('Svg' as never).props.width).toBe(24);
    expect(renderer.root.findAllByType('Path' as never)[0]!.props.stroke).toBe(brand.mark);
  });

  it('fills the box and cuts the lip out of it in the surface colour when selected', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        React.createElement(TrayGlyph, { color: '#b08a4a', cutColor: '#14091a', filled: true }),
      );
    });
    const [box, lip] = renderer.root.findAllByType('Path' as never);
    expect(box!.props.fill).toBe('#b08a4a');
    expect(lip!.props.stroke).toBe('#14091a');
  });
});
