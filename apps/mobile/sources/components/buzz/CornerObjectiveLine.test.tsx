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
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Polygon: host('Polygon') };
});
vi.mock('react-native-unistyles', async () => {
  const { typeRoles } = await import('@/buzz/groknight');
  return {
    StyleSheet: {
      hairlineWidth: 1,
      create: (factory: (theme: unknown) => unknown) =>
        factory({
          buzz: {
            humanRail: '#b08a4a',
            accent: '#c49a52',
            textSecondary: '#c9c9d1',
            textPrimary: '#f0f0f3',
            proseRegular: 'SpaceGrotesk-Regular',
            type: typeRoles,
          },
        }),
    },
  };
});

import type { WorkflowRunSummaryView } from '@beeline/api-contract/phone';
import { readRoomView } from '@beeline/api-contract/phone';
import { workflowRunHref } from '@/buzz/workflow-run-copy';
import { CornerObjectiveLine } from './CornerObjectiveLine';

const RUN: WorkflowRunSummaryView = {
  runId: 'r'.repeat(64),
  workflowSlug: 'feedback-triage',
  description: 'Daily feedback sweep',
  roomId: 'corner-1',
  roomName: 'Issues triage',
  parentRoomId: 'room-1',
  state: 'approve',
  status: 'live',
  holder: { id: 'b'.repeat(64), name: 'Candy', kind: 'agent' },
  viewerHolds: true,
  startedAt: 1,
  updatedAt: 2,
  earlierRunCount: 0,
};

const flatText = (node: any): string =>
  (Array.isArray(node.props.children) ? node.props.children : [node.props.children])
    .map((child: any) => (typeof child === 'string' ? child : child?.props ? flatText(child) : ''))
    .join('');

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

describe('CornerObjectiveLine', () => {
  it('inscribes the full objective as prose on a brass rail — no clamp, box, or control', () => {
    const objective =
      'Restore the complete corner objective across every line so a long but valid request remains readable in its entirety.';
    const renderer = render(<CornerObjectiveLine objective={objective} />);
    const copy = renderer.root.findByProps({ testID: 'corner-objective-line-copy' });
    expect(copy.props.children).toBe(objective);
    expect(copy.props.style.color).toBe('#c9c9d1');
    expect(copy.props.style.fontFamily).toBe('SpaceGrotesk-Regular');
    expect(copy.props.numberOfLines).toBeUndefined();
    expect(copy.props.ellipsizeMode).toBeUndefined();

    const line = renderer.root.findByProps({ testID: 'corner-objective-line' });
    expect(line.props.style.borderWidth).toBeUndefined();
    expect(line.props.style.backgroundColor).toBeUndefined();
    const rail = renderer.root
      .findAllByType('View' as any)
      .find((node: any) => node.props.style?.backgroundColor === '#b08a4a');
    expect(rail).toBeDefined();
    expect(rail.props.style.width).toBe(2);

    expect(
      renderer.root
        .findAllByProps({ accessibilityRole: 'button' })
        .filter((node: any) => typeof node.type === 'string'),
    ).toHaveLength(0);
    expect(renderer.root.findAllByType('Pressable' as any)).toHaveLength(0);
  });

  it('renders nothing rather than a placeholder when there is no objective', () => {
    expect(render(<CornerObjectiveLine />).toJSON()).toBeNull();
    expect(render(<CornerObjectiveLine objective="   " />).toJSON()).toBeNull();
  });

  it('keeps the current brief behind Read brief beside the compact workflow', () => {
    const onOpenBrief = vi.fn();
    const view = readRoomView({
      room: { id: '11111111-1111-4111-8111-111111111111', name: 'Saved brief' },
      messages: [],
      cornerBrief: { revision: 2, spec: '## Intent\n\n> Make the request readable', attachments: [] },
    });
    const brief = view?.cornerBrief;
    const renderer = render(
      <CornerObjectiveLine objective="Ship it"
        onOpenBrief={brief ? () => onOpenBrief(brief) : undefined} onOpenWorkflow={() => undefined} workflow={RUN} />,
    );
    expect(renderer.root.findAllByType('Text' as any).map(flatText)).not.toContain('Make the request readable');
    const link = renderer.root
      .findAllByType('Pressable' as any)
      .find((node: any) => node.props.testID === 'corner-objective-line-brief');
    expect(link.props.accessibilityRole).toBe('link');
    expect(link.props.accessibilityLabel).toBe('Read brief');
    const style = link.props.style({ pressed: false }).find(Boolean);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(link.findByType('Text' as any).props.children).toBe('Read brief');
    expect(link.findByType('Text' as any).props.style.color).toBe('#c49a52');
    const actions = renderer.root.findAllByType('View' as any)
      .find((view: any) => view.props.style?.flexWrap === 'wrap');
    expect(actions?.findAllByType('Pressable' as any)).toHaveLength(2);
    act(() => link.props.onPress());
    expect(onOpenBrief).toHaveBeenCalledTimes(1);
    expect(onOpenBrief).toHaveBeenCalledWith(view?.cornerBrief);

    expect(
      render(<CornerObjectiveLine objective="Ship it" />).root.findAllByType('Pressable' as any),
    ).toHaveLength(0);
  });


  it('R12k: shows workflow errors inline and retries from the objective line', () => {
    const retry = vi.fn();
    const renderer = render(<CornerObjectiveLine objective="Ship it" workflowError="offline" onRetryWorkflow={retry} />);
    expect(flatText(renderer.root.findByProps({ testID: 'corner-objective-line-workflow-error' }))).toContain('offline');
    act(() => renderer.root.findByProps({ testID: 'corner-objective-line-workflow-retry' }).props.onPress());
    expect(retry).toHaveBeenCalledTimes(1);
    console.log('R12k Demonstrated: objective line shows offline inline; Retry invokes the workflow read retry.');
  });

  it('shows the objective once and keeps the brief behind Read brief', () => {
    const objective =
      'Assess false agent stalls during long release polling and propose liveness and timeout behavior that preserves healthy turns.';
    const onOpenBrief = vi.fn();
    const renderer = render(<CornerObjectiveLine objective={objective} onOpenBrief={onOpenBrief} />);
    expect(renderer.root.findAllByType('Text' as any).map(flatText)).toEqual([objective, 'Read brief']);

    act(() => {
      renderer.update(
        <CornerObjectiveLine objective="Propose a stall timeout" onOpenBrief={onOpenBrief} />,
      );
    });
    expect(renderer.root.findAllByType('Text' as any).map(flatText))
      .toEqual(['Propose a stall timeout', 'Read brief']);
  });

  it('names a live workflow run under the objective and opens its run page', () => {
    const onOpenWorkflow = vi.fn();
    const renderer = render(
      <CornerObjectiveLine objective="Run the sweep" onOpenWorkflow={onOpenWorkflow} workflow={RUN} />,
    );
    const line = renderer.root
      .findAllByType('Pressable' as any)
      .find((node: any) => node.props.testID === 'corner-objective-line-workflow');
    expect(line.props.accessibilityRole).toBe('link');
    expect(line.props.style({ pressed: false })[0].minHeight).toBe(44);
    expect(line.findAllByType('Polygon' as any)).toHaveLength(1);
    expect(flatText(line.findByProps({ testID: 'corner-objective-line-workflow-copy' }))).toBe('Approve');
    act(() => line.props.onPress());
    expect(onOpenWorkflow).toHaveBeenCalledTimes(1);
    expect(workflowRunHref(RUN)).toEqual({
      pathname: '/beeline/workflow-run',
      params: { roomId: 'corner-1', runId: RUN.runId },
    });
  });

  it('names the holder when the step is not the viewer’s, and hides the line once the run ends', () => {
    const renderer = render(
      <CornerObjectiveLine
        objective="Run the sweep"
        onOpenWorkflow={() => undefined}
        workflow={{ ...RUN, viewerHolds: false, state: 'dispatch' }}
      />,
    );
    expect(flatText(renderer.root.findByProps({ testID: 'corner-objective-line-workflow-copy' })))
      .toBe('Dispatch');
    const ended = render(
      <CornerObjectiveLine
        objective="Run the sweep"
        onOpenWorkflow={() => undefined}
        workflow={{ ...RUN, status: 'done', state: 'done' }}
      />,
    );
    expect(ended.root.findAllByProps({ testID: 'corner-objective-line-workflow' })).toHaveLength(0);
    expect(render(<CornerObjectiveLine workflow={{ ...RUN, status: 'done' }} onOpenWorkflow={() => undefined} />).toJSON()).toBeNull();
  });
});
