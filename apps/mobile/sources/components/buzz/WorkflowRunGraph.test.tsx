import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkflowContract, WorkflowRunDetailView } from '@beeline/api-contract/phone';

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
  return { default: host('Svg'), Circle: host('Circle'), Path: host('Path') };
});
vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    HullLivePulse: (props: any) => ReactModule.createElement('HullLivePulse', props, props.children),
  };
});
vi.mock('react-native-unistyles', async () => {
  const { typeRoles, space } = await import('@/buzz/groknight');
  return {
    StyleSheet: {
      hairlineWidth: 1,
      create: (factory: (theme: unknown) => unknown) =>
        factory({
          buzz: {
            type: typeRoles,
            space,
            accent: '#b08a4a',
            borderStrong: '#3b3048',
            bgBase: '#14091A',
            textMuted: '#83838d',
            textPrimary: '#f0f0f3',
            ledgerQuiet: '#90909B',
            ledgerGhost: '#6c6c76',
          },
        }),
    },
  };
});

import { WorkflowRunGraph } from './WorkflowRunGraph';

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

const contract = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../../docs/workflows/feedback-triage.json'), 'utf8'),
) as WorkflowContract;
const candy = { id: 'b'.repeat(64), name: 'Candy', kind: 'agent' as const };
const detail: WorkflowRunDetailView = {
  run: {
    runId: 'r'.repeat(64),
    workflowSlug: 'feedback-triage',
    description: contract.description,
    roomId: 'corner-1',
    roomName: 'Issues triage',
    parentRoomId: 'room-1',
    state: 'approve',
    status: 'live',
    holder: candy,
    viewerHolds: true,
    startedAt: 1_790_000_000,
    updatedAt: 1_790_000_120,
    earlierRunCount: 6,
  },
  contract,
  history: [
    { toState: 'notify', actor: candy, at: 1_790_000_000 },
    { fromState: 'notify', outcome: 'notified', toState: 'pull', actor: candy, at: 1_790_000_060 },
    { fromState: 'pull', outcome: 'ranked', toState: 'approve', actor: candy, at: 1_790_000_120 },
  ],
  roleHolders: { triager: candy },
};

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

const textOf = (node: any): string =>
  (Array.isArray(node.props.children) ? node.props.children : [node.props.children])
    .map((child: any) => (typeof child === 'string' ? child : child?.props ? textOf(child) : ''))
    .join('');

describe('WorkflowRunGraph', () => {
  it('draws one circle per row, brass on the path taken, and only circles', () => {
    const renderer = render(<WorkflowRunGraph detail={detail} onOpenRoom={() => undefined} />);
    const circles = renderer.root.findAllByType('Circle' as never);
    expect(circles).toHaveLength(7);
    expect(circles.map((circle: any) => circle.props.fill)).toEqual([
      '#b08a4a',
      '#b08a4a',
      '#14091A',
      '#b08a4a',
      '#14091A',
      '#14091A',
      '#14091A',
    ]);
    // The current step is the larger brass dot under a breathing halo.
    expect(circles[3]!.props.r).toBe(4.5);
    const halo = renderer.root.findByType('HullLivePulse' as never);
    expect(halo.findByProps({ testID: 'workflow-run-graph-current-halo' })).toBeDefined();
    const brassPaths = renderer.root
      .findAllByType('Path' as never)
      .filter((p: any) => p.props.stroke === '#b08a4a');
    expect(brassPaths).toHaveLength(2);
    for (const shape of ['Rect', 'Polygon', 'Line']) expect(renderer.root.findAllByType(shape as never)).toHaveLength(0);
  });

  it('names each state with one meta line, and Open → takes the current step to its corner', () => {
    const onOpenRoom = vi.fn();
    const renderer = render(<WorkflowRunGraph detail={detail} onOpenRoom={onOpenRoom} />);
    const meta = (key: string) =>
      textOf(renderer.root.findByProps({ testID: `workflow-run-graph-row-${key}-meta` }));
    expect(meta('notify')).toBe('Candy · notified');
    expect(meta('pull')).toBe('Candy · ranked');
    expect(meta('approve')).toBe('Waiting on you');
    expect(meta('done@1')).toBe('Nothing new · Done');
    expect(meta('done@3')).toBe('Skip · Done');
    expect(meta('dispatch')).toBe('Candy');
    const current = renderer.root.findByProps({ testID: 'workflow-run-graph-row-approve' });
    const title = current.findAllByType('Text' as never)[0]!;
    expect(title.props.style[0].fontFamily).toBe('SpaceGrotesk-SemiBold');
    const open = renderer.root.findByProps({ testID: 'workflow-run-graph-row-approve-open' });
    expect(textOf(open.findByType('Text' as never))).toBe('Open →');
    act(() => open.props.onPress());
    expect(onOpenRoom).toHaveBeenCalledTimes(1);
    // Only the current row carries a control.
    expect(renderer.root.findAllByType('Pressable' as never)).toHaveLength(1);
  });
});
