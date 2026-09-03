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

vi.mock('./MonoHull', () => ({
  PixelLoader: (props: any) => React.createElement('PixelLoader', props),
}));
vi.mock('./MonoMarkdown', () => ({
  MonoMarkdown: (props: any) => React.createElement('MonoMarkdown', props, props.markdown),
}));
vi.mock('./IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
}));
vi.mock('react-native-reanimated', () => ({
  useReducedMotion: () => false,
}));

import { groknight } from '@/buzz/groknight';
import { ActivityTimeline } from './ActivityTimeline';
import { foldSettledActivityRuns } from '@/buzz/room-view-presentation';

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

const TOOLS = [
  {
    kind: 'tool' as const,
    id: 'read',
    title: 'read',
    toolKind: 'read',
    input: 'sources/gateway.ts',
    status: 'completed',
  },
  {
    kind: 'tool' as const,
    id: 'failure',
    title: 'certification gate',
    toolKind: 'execute',
    command: 'pnpm fast-gate',
    output: 'sh: 1: pnpm: not found',
    status: 'failed',
  },
];

describe('live streaming turn', () => {
  it('renders a folded run of per-call rows as one chevron over all six calls (C55)', () => {
    const agent = 'b'.repeat(64);
    const call = (id: string, status: 'completed' | 'failed') => ({
      id,
      text: '',
      isUser: false,
      timestamp: Number(id.slice(1)),
      pubkey: agent,
      isAgentAuthor: true,
      isAgentActivity: true,
      activity: [{ kind: 'tool' as const, title: 'Bash', toolKind: 'execute', command: id, status }],
    });
    const [group, ...rest] = foldSettledActivityRuns([
      call('t1', 'completed'),
      call('t2', 'completed'),
      call('t3', 'failed'),
      call('t4', 'failed'),
      call('t5', 'failed'),
      call('t6', 'failed'),
    ]);
    expect(rest).toHaveLength(0);
    const renderer = render(<ActivityTimeline active={false} items={group.activity!} />);
    const hostNodes = (pattern: RegExp) =>
      renderer.root.findAll(
        (node: { type: unknown; props: { testID?: string } }) =>
          typeof node.type === 'string' && pattern.test(node.props.testID ?? ''),
      );
    // One collapsed note, one chevron.
    expect(hostNodes(/^corner-tool-summary$/)).toHaveLength(1);
    const summary = renderer.root.findByProps({ testID: 'corner-tool-summary' });
    expect(summary.props.children[0].props.children).toBe('6 TOOL CALLS · 4 FAILED');
    expect(hostNodes(/^corner-tool-row-anonymous-\d+$/)).toHaveLength(0);
    act(() => summary.props.onPress());
    expect(hostNodes(/^corner-tool-row-anonymous-\d+$/)).toHaveLength(6);
  });

  it('keeps settled tool rows collapsed and expandable after the turn completes (#804)', () => {
    const renderer = render(<ActivityTimeline active={false} items={TOOLS} />);
    // Collapsed by default: one compact activity row, no individual calls.
    expect(renderer.root.findByProps({ testID: 'corner-tool-summary' }).props.children[0].props.children).toBe(
      '2 TOOL CALLS · 1 FAILED',
    );
    expect(renderer.root.findAllByProps({ testID: 'corner-tool-row-read' })).toHaveLength(0);
    expect(
      renderer.root.findAll((node: { props: { testID?: string } }) =>
        node.props.testID?.startsWith('corner-tool-row-detail-'),
      ),
    ).toHaveLength(0);
    act(() => renderer.root.findByProps({ testID: 'corner-tool-summary' }).props.onPress());
    expect(renderer.root.findByProps({ testID: 'corner-tool-row-read' })).toBeTruthy();
    const row = renderer.root.findByProps({ testID: 'corner-tool-row-read' });
    act(() => row.props.onPress());
    expect(
      new Set(
        renderer.root
          .findAll((node: { props: { testID?: string } }) =>
            node.props.testID?.startsWith('corner-tool-row-detail-'),
          )
          .map((node: { props: { testID?: string } }) => node.props.testID),
      ).size,
    ).toBe(1);
  });

  it('renders nothing when the lane holds neither tool rows nor a draft', () => {
    expect(
      render(<ActivityTimeline active={false} items={[{ kind: 'output', title: 'Done', text: 'Done' }]} />)
        .toJSON(),
    ).toBeNull();
  });

  it('renders one collapsed row per tool and the accumulating conversational draft', () => {
    const renderer = render(
      <ActivityTimeline
        active
        handle="Clara"
        items={TOOLS}
        messageDraft="The answer is arriving."
        stamp="now"
      />,
    );
    expect(renderer.root.findByProps({ testID: 'activity-message-draft' }).props.markdown).toBe(
      'The answer is arriving.',
    );
    expect(renderer.root.findByProps({ testID: 'corner-tool-summary' }).props.accessibilityState).toEqual({
      busy: true,
      expanded: false,
    });
    expect(renderer.root.findAllByProps({ testID: 'corner-tool-row-read' })).toHaveLength(0);
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(1);
    expect(
      renderer.root.findAll((node: { props: { testID?: string } }) =>
        node.props.testID?.startsWith('corner-tool-row-detail-'),
      ),
    ).toHaveLength(0);
  });

  it('keeps old detail-free activity rows collapsed and non-interactive', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[{ kind: 'tool', id: 'old', title: 'Ran project task', toolKind: 'execute' }]}
      />,
    );

    act(() => renderer.root.findByProps({ testID: 'corner-tool-summary' }).props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('Used tool');
    expect(renderer.root.findByProps({ testID: 'corner-tool-row-old' }).props.onPress).toBeUndefined();
    expect(
      renderer.root.findAll((node: { props: { testID?: string } }) =>
        node.props.testID?.startsWith('corner-tool-row-detail-'),
      ),
    ).toHaveLength(0);
  });

  it('keeps prose tight to the tool line it follows', () => {
    const renderer = render(
      <ActivityTimeline active items={[TOOLS[0]!]} messageDraft="The result follows the call." />,
    );

    expect(
      renderer.root.findByProps({ testID: 'activity-message-draft' }).props.textStyle.marginTop,
    ).toBeLessThanOrEqual(3);
  });

  it('routes streamed prose through the Room-style Markdown renderer', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[
          {
            kind: 'thinking',
            title: 'Thinking',
            text: '**PRIVATE REASONING MUST NOT RENDER**',
          },
        ]}
        messageDraft="**The reply is ready**"
      />,
    );

    expect(
      renderer.root
        .findAllByType('MonoMarkdown')
        .map((node: { props: { markdown: string; testID?: string } }) => ({
          markdown: node.props.markdown,
          testID: node.props.testID,
        })),
    ).toEqual([{ markdown: '**The reply is ready**', testID: 'activity-message-draft' }]);
  });

  it('labels a tool row and reveals the bounded command, result, and files on press', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[
          {
            kind: 'thinking',
            title: 'Thinking',
            text: 'PRIVATE THOUGHT SENTINEL',
          },
          {
            kind: 'tool',
            id: 'edit',
            title: 'Edit files',
            toolKind: 'edit',
            status: 'completed',
            output: 'first result line\nlast result line',
            files: [{ path: 'apps/mobile/Ledger.tsx' }],
          },
          {
            kind: 'tool',
            id: 'execute',
            title: 'Tool',
            toolKind: 'execute',
            command: 'npm test -- ActivityTimeline',
            output: 'tests passed',
            status: 'exit 0',
          },
          {
            kind: 'summary',
            title: 'read receipts',
            observed: [{ verb: 'read', target: 'Ledger.tsx', result: 'OBSERVED RESULT SENTINEL' }],
          },
        ]}
        messageDraft="Conversational answer"
      />,
    );

    act(() => renderer.root.findByProps({ testID: 'corner-tool-summary' }).props.onPress());
    act(() => renderer.root.findByProps({ testID: 'corner-tool-row-edit' }).props.onPress());
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('Conversational answer');
    expect(rendered).toContain('Used tool');
    expect(rendered).toContain('apps/mobile/Ledger.tsx');
    expect(rendered).toContain('first result line');
    expect(rendered).toContain('last result line');
    expect(rendered).not.toContain('PRIVATE THOUGHT SENTINEL');
    expect(rendered).not.toContain('OBSERVED RESULT SENTINEL');
    expect(renderer.root.findByProps({ testID: 'corner-tool-row-detail-edit' })).toBeTruthy();
    expect(
      renderer.root.findByProps({ testID: 'corner-tool-row-edit' }).props.accessibilityState,
    ).toEqual({ busy: false, expanded: true });
  });

  it('keeps the terse failure verdict in the one-line mechanism row', () => {
    const renderer = render(<ActivityTimeline active items={TOOLS} />);
    act(() => renderer.root.findByProps({ testID: 'corner-tool-summary' }).props.onPress());
    const verdict = renderer.root.findByProps({ testID: 'activity-verdict-failure' });
    expect(verdict.props.children).toBe('×');
    expect(verdict.props.style).toContainEqual(
      expect.objectContaining({ color: groknight.accent }),
    );
  });

  it('renders the settled row\'s byline — IdentityMark + name + kind + stamp — on the live draft', () => {
    // Captain report C42: the streamed draft lane's byline must be exactly
    // the settled message byline (`Ledger.LedgerBylineView`), so the agent
    // triangle is present and nothing changes visually when the draft
    // settles in place.
    const renderer = render(
      <ActivityTimeline
        active
        handle="Codex"
        stamp="14:02"
        items={[{ kind: 'tool', id: 'edit', title: 'Edit files', toolKind: 'edit' }]}
        messageDraft="Working on it now."
        mark={{ seed: 'agent-pubkey', kind: 'agent', alive: true }}
      />,
    );
    const mark = renderer.root.findByProps({ testID: 'chat-byline-mark' });
    expect(mark.props).toEqual(
      expect.objectContaining({
        seed: 'agent-pubkey',
        kind: 'agent',
        alive: true,
        size: 17,
      }),
    );
    const byline = mark.parent.parent;
    const textStrings: string[] = [];
    const collect = (node: any) => {
      if (typeof node === 'string') textStrings.push(node);
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === 'object' && node.props)
        React.Children.forEach(node.props.children, collect);
    };
    byline.findAll((node: any) => node.type === 'Text').forEach(collect);
    const bylineText = textStrings.join('');
    expect(bylineText).toContain('Codex');
    expect(bylineText).toContain('agent');
    expect(bylineText).toContain('14:02');
  });

  it('renders no identity mark when no byline handle is present', () => {
    const renderer = render(
      <ActivityTimeline active items={TOOLS} mark={{ seed: 'agent-pubkey', kind: 'agent' }} />,
    );
    expect(renderer.root.findAllByProps({ testID: 'chat-byline-mark' })).toHaveLength(0);
  });
  it('prints who asked, in quiet text, inside the expanded tool row', () => {
    const renderer = render(
      <ActivityTimeline
        items={[
          {
            kind: 'tool',
            id: 'deploy',
            title: 'ran fly deploy -a preview under grant g-1 · asked by Alex',
            toolKind: 'execute',
            command: 'fly deploy -a preview',
            output: 'deployed',
            status: 'exit 0',
            requestedBy: { pubkey: 'b'.repeat(64), name: 'Alex' },
          },
        ]}
      />,
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain("at Alex's request");
    act(() => renderer.root.findByProps({ testID: 'corner-tool-summary' }).props.onPress());
    act(() => renderer.root.findByProps({ testID: 'corner-tool-row-deploy' }).props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain("at Alex's request");
  });

});
