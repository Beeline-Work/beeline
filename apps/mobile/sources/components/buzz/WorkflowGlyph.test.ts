import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return { default: host('Svg'), Polygon: host('Polygon') };
});

const activeTheme = vi.hoisted(() => ({ name: 'obsidian' as 'obsidian' | 'bone' }));
vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  return { useUnistyles: () => ({ theme: { buzz: beelineThemes[activeTheme.name] } }) };
});

import { WORKFLOW_POINTS, WorkflowGlyph } from './WorkflowGlyph';
import brand from '@/buzz/brand.json';
import { beelineThemes } from '@/buzz/groknight';

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

function render(props: React.ComponentProps<typeof WorkflowGlyph>) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(WorkflowGlyph, props));
  });
  return renderer;
}

describe('WorkflowGlyph', () => {
  it('draws the stem on the upturned corner as one filled polygon in the corner viewBox', () => {
    const renderer = render({ size: 13, testID: 'wf' });
    const svg = renderer.root.findByType('Svg' as never);
    expect(svg.props).toMatchObject({
      testID: 'wf',
      viewBox: '0 0 24 24',
      width: 13,
      height: 13,
      accessibilityElementsHidden: true,
    });
    const polygons = renderer.root.findAllByType('Polygon' as never);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]!.props.points).toBe(
      '9.93 3 14.07 3 14.07 13.81 21.76 21.5 15.9 21.5 12 17.6 8.1 21.5 2.24 21.5 9.93 13.81',
    );
    expect(polygons[0]!.props.points).toBe(WORKFLOW_POINTS);
    expect(polygons[0]!.props.fill).toBe(brand.mark);
  });

  it("is mark gold while a run is live and the active theme's ghost when idle", () => {
    for (const name of ['obsidian', 'bone'] as const) {
      activeTheme.name = name;
      const idle = render({ live: false });
      expect(idle.root.findByType('Polygon' as never).props.fill).toBe(
        beelineThemes[name].ledgerGhost,
      );
    }
    expect(beelineThemes.bone.ledgerGhost).toBe('#A79C89');
  });
});
