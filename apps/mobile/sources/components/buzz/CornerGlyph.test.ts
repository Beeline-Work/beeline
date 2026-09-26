import { readFileSync } from 'node:fs';
import path from 'node:path';
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

import {
  CORNER_EXTENT,
  CORNER_META_SIZE,
  CORNER_STATUS_SIZE,
  CORNER_THICKNESS,
  CornerGlyph,
} from './CornerGlyph';
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
  it('fills the slashed-frame polygon at the named extent and board-pick thickness', () => {
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

    expect(CORNER_EXTENT).toBe(15);
    expect(CORNER_THICKNESS).toBe(4.5);

    const outer = (24 - CORNER_EXTENT) / 2;
    const far = 24 - outer;
    const polygons = renderer.root.findAllByType('Polygon' as never);
    expect(polygons).toHaveLength(1);
    expect(brand.mark).toBe('#E5A645');
    expect(polygons[0]!.props.fill).toBe(brand.mark);
    expect(polygons[0]!.props.stroke).toBeUndefined();
    expect(polygons[0]!.props.strokeWidth).toBeUndefined();
    expect(polygons[0]!.props.points).toBe(
      [
        `${outer} ${outer}`,
        `${outer} ${far}`,
        `${far} ${far}`,
        `${far - CORNER_THICKNESS} ${far - CORNER_THICKNESS}`,
        `${outer + CORNER_THICKNESS} ${far - CORNER_THICKNESS}`,
        `${outer + CORNER_THICKNESS} ${outer + CORNER_THICKNESS}`,
      ].join(' '),
    );
  });

  it('keeps the inline sizes on the meta and status lines', () => {
    expect(CORNER_META_SIZE).toBe(13);
    expect(CORNER_STATUS_SIZE).toBe(11);
  });

  it('uses theme brass in the Room header and keeps the default at inline mounts', () => {
    const roots = path.resolve(__dirname, '../..');
    const headerSource = readFileSync(
      path.join(roots, 'app/(app)/beeline/chat/_chat-surface.tsx'),
      'utf8',
    );
    const headerMounts = [...headerSource.matchAll(/<CornerGlyph\b[^>]*\/?>/g)].map(
      (match) => match[0],
    );
    expect(headerMounts).toContainEqual(
      expect.stringContaining('color={styles.roomCornersGlyph.color}'),
    );
    expect(headerSource).toContain('roomCornersGlyph: { color: groknight.accent }');

    const inlineSites = [
      'app/(app)/beeline/tray.tsx',
      'components/buzz/WritePermissionOutcome.tsx',
    ];
    for (const site of inlineSites) {
      const source = readFileSync(path.join(roots, site), 'utf8');
      const mounts = [...source.matchAll(/<CornerGlyph\b[^>]*\/?>/g)].map((match) => match[0]);
      expect(mounts.length, `${site} mounts CornerGlyph`).toBeGreaterThan(0);
      for (const mount of mounts) {
        expect(mount, `${site} restains CornerGlyph`).not.toContain('color=');
      }
    }
  });
});
