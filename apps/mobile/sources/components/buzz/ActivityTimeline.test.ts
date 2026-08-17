import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('./MonoHull', () => ({ HullActivityTip: () => null }));

import { ActivityTimeline } from './ActivityTimeline';

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

function renderedText(renderer: ReactTestRenderer): string {
  const strings: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in (node as Record<string, unknown>)) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return strings.join(' ');
}

const NOISY_TURN = [
  {
    kind: 'output' as const,
    title: 'Output',
    text: 'Rewriting the callback so the retry state survives a reload.',
  },
  {
    kind: 'tool' as const,
    id: 'tool-1',
    title: 'execute',
    command: 'npm test -- --run',
    output: 'FAIL\n'.repeat(400),
    status: 'completed',
  },
  {
    kind: 'tool' as const,
    id: 'tool-2',
    title: 'edit',
    files: [{ path: 'sources/auth/oidc.ts', status: 'modified', diff: '+ retry()' }],
    status: 'completed',
  },
];

describe('corner tool activity', () => {
  it('collapses a whole turn of tool output to one expandable line', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));

    expect(renderer.root.findByProps({ testID: 'activity-turn-summary' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'activity-secondary-view' })).toHaveLength(0);

    const collapsed = renderedText(renderer);
    // No wall of output, no per-tool rows, no agent prose dumped above the line.
    expect(collapsed).not.toContain('FAIL');
    expect(collapsed).not.toContain('npm test');
    expect(collapsed).not.toContain('Rewriting the callback');
    expect(collapsed).not.toContain('sources/auth/oidc.ts');

    // ...and the one line stays one line.
    const summary = renderer.root.findByProps({ testID: 'activity-turn-summary' });
    expect(summary.findAllByType('Text')[0].props.numberOfLines).toBe(1);
    expect(collapsed).toContain('Edited 1 file');
  });

  it('reveals the tool detail only when the reader opens the line', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));

    act(() => renderer.root.findByProps({ testID: 'activity-turn-summary' }).props.onPress());

    expect(renderer.root.findByProps({ testID: 'activity-secondary-view' })).toBeTruthy();
    const expanded = renderedText(renderer);
    expect(expanded).toContain('Rewriting the callback');
    expect(expanded).toContain('sources/auth/oidc.ts');
  });

  it('gives the collapsed line no box of its own', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: NOISY_TURN }));
    const summary = renderer.root.findByProps({ testID: 'activity-turn-summary' });
    expect(summary.props.style).not.toHaveProperty('borderWidth');
    expect(summary.props.style).not.toHaveProperty('borderRadius');
    expect(summary.props.style).not.toHaveProperty('backgroundColor');
  });

  it('renders nothing at all for a turn with no actions and no notes', () => {
    const renderer = render(React.createElement(ActivityTimeline, { items: [] }));
    expect(renderer.toJSON()).toBeNull();
  });
});
