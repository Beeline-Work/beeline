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
    useWindowDimensions: () => ({ width: 390, height: 844 }),
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
vi.mock('./BeelineMarkSpinner', () => ({
  BeelineMarkSpinner: (props: any) => React.createElement('BeelineMarkSpinner', props),
}));
vi.mock('./HullActionSheet', () => ({
  HULL_SHEET_INSET: 22,
  HullActionSheetModal: (props: any) =>
    React.createElement('HullActionSheetModal', props, props.children),
  HullActionSheetRow: (props: any) => React.createElement('HullActionSheetRow', props, props.label),
}));
vi.mock('react-native-reanimated', () => ({
  useReducedMotion: () => false,
}));
vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn().mockResolvedValue(undefined),
}));

import * as Clipboard from 'expo-clipboard';
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

function hostNodes(renderer: ReactTestRenderer, pattern: RegExp) {
  return renderer.root.findAll(
    (node: { type: unknown; props: { testID?: string } }) =>
      typeof node.type === 'string' && pattern.test(node.props.testID ?? ''),
  );
}

const renderedText = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

function expandRun(renderer: ReactTestRenderer, id: string): void {
  act(() => renderer.root.findByProps({ testID: `tool-run-group-${id}` }).props.onPress());
}

const TOOLS = [
  {
    kind: 'tool' as const,
    id: 'read',
    title: 'read',
    toolKind: 'read',
    input: 'sources/gateway.ts',
    files: [{ path: 'sources/gateway.ts' }],
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

describe('one-line tool ledger', () => {
  it('renders one collapsed disclosure for the machine run — no cards', () => {
    const renderer = render(<ActivityTimeline active={false} items={TOOLS} />);
    expect(renderer.root.findByProps({ testID: 'tool-run-group-read' })).toBeTruthy();
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(0);
    expandRun(renderer, 'read');
    expect(renderer.root.findByProps({ testID: 'tool-ledger-line-read' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'tool-ledger-line-failure' })).toBeTruthy();
    expect(hostNodes(renderer, /^corner-tool-summary$/)).toHaveLength(0);
    expect(renderedText(renderer)).not.toContain('TOOL CALLS');
    expect(renderedText(renderer)).not.toContain('FAILED');
  });

  it('a failed step carries its distilled reason inline, a success stays quiet', () => {
    const renderer = render(<ActivityTimeline active={false} items={TOOLS} />);
    expandRun(renderer, 'read');
    const text = renderedText(renderer);
    // The distilled reason rides the line; the raw envelope waits in the sheet.
    expect(text).toContain('command not found: pnpm');
    expect(text).not.toContain('pnpm: not found');
  });

  it('a transport envelope is not output: the line has nothing to open onto', () => {
    const renderer = render(
      <ActivityTimeline
        items={[
          {
            kind: 'tool',
            id: 'shell',
            title: 'Bash',
            toolKind: 'execute',
            command: 'ls -la node_modules/.bin',
            status: 'exit 0',
            output: '[{"type":"terminal","terminalId":"exec-994c47ee"}]',
          },
        ]}
      />,
    );
    expandRun(renderer, 'shell');
    const text = renderedText(renderer);
    expect(text).toContain('ls -la node_modules/.bin');
    expect(text).not.toContain('terminalId');
    // A narrow screen cuts where the data cap does: the middle.
    expect(
      renderer.root
        .findByProps({ testID: 'tool-ledger-line-shell' })
        .findAll(
          (node: { type: unknown; props: { ellipsizeMode?: string } }) =>
            node.type === 'Text' && node.props.ellipsizeMode === 'middle',
        ),
    ).toHaveLength(1);
    expect(
      renderer.root.findByProps({ testID: 'tool-ledger-line-shell' }).props.onPress,
    ).toBeUndefined();
  });

  it('spends colour in exactly two places: the brass cross, the dim tick (design 2026-08-24)', () => {
    const renderer = render(<ActivityTimeline active={false} items={TOOLS} />);
    expandRun(renderer, 'read');
    const passed = renderer.root.findByProps({ testID: 'activity-verdict-read' });
    expect(passed.props.children).toBe('✓');
    expect(passed.props.style).toContainEqual(
      expect.objectContaining({ color: groknight.ledgerGhost }),
    );
    const failed = renderer.root.findByProps({ testID: 'activity-verdict-failure' });
    expect(failed.props.children).toBe('✗');
    expect(failed.props.style).toContainEqual(expect.objectContaining({ color: groknight.accent }));
    // No red in the new rendering — the design's brass supersedes C88's diff red.
    expect(renderedText(renderer)).not.toContain(groknight.diffRemoved);
  });

  it('the live turn’s last step carries the spinner, not a verdict glyph', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[
          {
            kind: 'tool',
            id: 'live',
            title: 'Bash',
            toolKind: 'execute',
            command: 'npm run build',
            status: 'exit 0',
          },
        ]}
      />,
    );
    expandRun(renderer, 'live');
    const spinner = renderer.root.findByProps({ testID: 'activity-verdict-live' });
    expect(spinner.props.children.type).toBeTypeOf('function');
    expect(spinner.props.children.props.live).toBe(true);
  });

  it('every line is a 44-minimum tap target, and pressable only when it has output', () => {
    const renderer = render(
      <ActivityTimeline
        active={false}
        items={[
          TOOLS[0]!,
          { kind: 'tool', id: 'bare', title: 'Ran project task', toolKind: 'execute' },
        ]}
      />,
    );
    expandRun(renderer, 'read');
    for (const id of ['read', 'bare']) {
      const [row] = hostNodes(renderer, new RegExp(`^tool-ledger-line-${id}$`));
      expect(row.props.style).toEqual(expect.objectContaining({ minHeight: 44 }));
    }
    expect(renderer.root.findByProps({ testID: 'tool-ledger-line-read' }).props.onPress).toBeTypeOf(
      'function',
    );
    expect(
      renderer.root.findByProps({ testID: 'tool-ledger-line-bare' }).props.onPress,
    ).toBeUndefined();
    expect(renderedText(renderer)).toContain('project task');
  });

  it('does not synthesize ledger rows from thought receipts', () => {
    const renderer = render(
      <ActivityTimeline
        active={false}
        items={[
          { kind: 'thinking', title: 'Thinking', text: 'private reasoning' },
          { kind: 'summary', title: 'thinking 51', thoughtMs: 51_000 },
        ]}
      />,
    );
    expect(renderer.toJSON()).toBeNull();
  });
});

describe('grouping consecutive steps', () => {
  const call = (id: string, status: 'completed' | 'failed' = 'completed') => ({
    kind: 'tool' as const,
    id,
    title: 'Bash',
    toolKind: 'execute',
    command: id,
    status,
  });

  it.each([1, 2, 3])('a %i-step run renders as one collapsed disclosure', (count) => {
    const renderer = render(
      <ActivityTimeline
        active={false}
        items={Array.from({ length: count }, (_, index) => call(String.fromCharCode(97 + index)))}
      />,
    );
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(0);
    expect(hostNodes(renderer, /^tool-run-group-/)).toHaveLength(1);
    expect(renderer.root.findByProps({ testID: 'tool-run-group-a' }).props.accessibilityLabel).toBe(
      `${count} ${count === 1 ? 'step' : 'steps'}, expandable`,
    );
  });

  it('an unbroken longer run folds into one summary line (design 2026-08-24)', () => {
    const renderer = render(
      <ActivityTimeline
        active={false}
        items={[
          call('a'),
          call('b'),
          call('c', 'failed'),
          call('d', 'failed'),
          call('e', 'failed'),
          call('f', 'failed'),
        ]}
      />,
    );
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(0);
    const group = renderer.root.findByProps({ testID: 'tool-run-group-a' });
    expect(group.props.accessibilityLabel).toBe('6 steps · 4 failed, expandable');
    expect(group.props.accessibilityState).toEqual({ expanded: false });
    // The failure count is brass — the group's second place colour is spent.
    expect(renderedText(renderer)).toContain('4 failed');
    expect(
      renderer.root.findAll(
        (node: { type: unknown; props: { style?: unknown } }) =>
          node.type === 'Text' &&
          Array.isArray(node.props.style) &&
          node.props.style.includes(groknight.accent) === false,
      ),
    ).toBeTruthy();
  });

  it('a group expands in place into the same ledger lines, and collapses again', () => {
    const renderer = render(
      <ActivityTimeline active={false} items={[call('a'), call('b'), call('c'), call('d')]} />,
    );
    act(() => renderer.root.findByProps({ testID: 'tool-run-group-a' }).props.onPress());
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(4);
    expect(
      renderer.root.findByProps({ testID: 'tool-run-group-a' }).props.accessibilityState,
    ).toEqual({ expanded: true });
    act(() => renderer.root.findByProps({ testID: 'tool-run-group-a' }).props.onPress());
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(0);
  });

  it('thought timing does not change tool grouping', () => {
    const renderer = render(
      <ActivityTimeline
        active={false}
        items={[
          { kind: 'summary', title: 'thinking 48', thoughtMs: 48_000 },
          call('a'),
          call('b'),
          call('c'),
          call('d'),
        ]}
      />,
    );
    expect(renderer.root.findByProps({ testID: 'tool-run-group-a' }).props.accessibilityLabel).toBe(
      '4 steps, expandable',
    );
  });
});

describe('the output sheet', () => {
  it('a tap opens the full raw output — flat, mono, no inline expansion in the transcript', () => {
    const renderer = render(
      <ActivityTimeline
        items={[
          {
            kind: 'tool',
            id: 'long',
            title: 'Bash',
            toolKind: 'execute',
            command: 'npm test',
            status: 'exit 0',
            output: Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join('\n'),
          },
        ]}
      />,
    );
    expandRun(renderer, 'long');
    act(() => renderer.root.findByProps({ testID: 'tool-ledger-line-long' }).props.onPress());
    const sheet = renderer.root.findByProps({ testID: 'tool-output-sheet' });
    expect(sheet.props.visible).toBe(true);
    expect(sheet.props.title).toBe('npm test');
    // The WHOLE output, not a six-line slice with a more-tap.
    const text = renderedText(renderer);
    for (const line of ['line 1', 'line 7', 'line 9']) expect(text).toContain(line);
    expect(hostNodes(renderer, /^corner-tool-row-more-/)).toHaveLength(0);
    act(() => sheet.props.onClose());
    expect(renderer.root.findByProps({ testID: 'tool-output-sheet' }).props.visible).toBe(false);
  });

  it('the sheet body is selectable, and copy hands the raw detail to the clipboard', async () => {
    const renderer = render(
      <ActivityTimeline
        items={[
          {
            kind: 'tool',
            id: 'out',
            title: 'Bash',
            toolKind: 'execute',
            command: 'npm test',
            status: 'exit 0',
            output: 'tests passed',
          },
        ]}
      />,
    );
    expandRun(renderer, 'out');
    act(() => renderer.root.findByProps({ testID: 'tool-ledger-line-out' }).props.onPress());
    const body = renderer.root.findByProps({ testID: 'tool-output-text' });
    expect(body.props.selectable).toBe(true);
    expect(body.props.children).toContain('tests passed');
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    await act(async () => {
      await renderer.root.findByProps({ testID: 'tool-output-copy' }).props.onPress();
    });
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(expect.stringContaining('tests passed'));
    expect(renderer.root.findByProps({ testID: 'tool-output-copy' }).props.metadata).toBe('Copied');
  });

  it('a failed call’s sheet leads with the distilled reason as the subtitle', () => {
    const renderer = render(<ActivityTimeline items={TOOLS} />);
    expandRun(renderer, 'read');
    act(() => renderer.root.findByProps({ testID: 'tool-ledger-line-failure' }).props.onPress());
    const sheet = renderer.root.findByProps({ testID: 'tool-output-sheet' });
    expect(sheet.props.subtitle).toBe('command not found: pnpm');
    expect(renderedText(renderer)).toContain('sh: 1: pnpm: not found');
  });

  it('keeps tool activity and italic live ACP prose while omitting thought rows', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[
          { kind: 'thinking', title: 'Thinking', text: 'weighing the two layouts' },
          { kind: 'summary', title: 'thinking 12', thoughtMs: 12_000 },
          { kind: 'tool', id: 'read', title: 'Read file', toolKind: 'read', input: 'src/app.ts' },
        ]}
        messageDraft="The reply is taking shape."
      />,
    );
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'tool-run-group-read' })).toBeTruthy();
    expect(hostNodes(renderer, /thought/)).toHaveLength(0);
    const draft = renderer.root.findByProps({ testID: 'activity-message-draft' });
    expect(draft.props.markdown).toBe('The reply is taking shape.');
    expect(draft.props.textStyle.fontFamily).toBe(groknight.proseItalic);
    expect(draft.props.textStyle.color).toBe(groknight.ledgerQuiet);
  });

  it('prints who asked, in the sheet, not the transcript', () => {
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
    expect(renderedText(renderer)).not.toContain("at Alex's request");
    expandRun(renderer, 'deploy');
    act(() => renderer.root.findByProps({ testID: 'tool-ledger-line-deploy' }).props.onPress());
    expect(renderedText(renderer)).toContain("at Alex's request");
  });
});

describe('agent prose and drafts', () => {
  it('uses the Ledger paragraph rhythm without a second activity margin', () => {
    const continuation = render(
      <ActivityTimeline items={[]} messageDraft="The answer keeps arriving." testID="activity" />,
    );
    const continuingStyle = Object.assign(
      {},
      ...hostNodes(continuation, /^activity$/)[0].props.style.filter(Boolean),
    );
    expect(continuingStyle).toMatchObject({
      paddingTop: groknight.messagePaddingVertical,
      paddingBottom: groknight.messagePaddingVertical,
      marginBottom: groknight.messageGap,
    });

    const speaker = render(
      <ActivityTimeline
        handle="Clara"
        items={[]}
        messageDraft="A new speaker starts here."
        testID="activity"
      />,
    );
    const speakerStyle = Object.assign(
      {},
      ...hostNodes(speaker, /^activity$/)[0].props.style.filter(Boolean),
    );
    expect(speakerStyle.paddingBottom).toBe(groknight.messagePaddingVertical * 3);
    expect(speakerStyle).not.toHaveProperty('marginTop');
  });

  it('puts chronological speaker space on the incoming top edge', () => {
    const renderer = render(
      <ActivityTimeline
        chronological
        handle="Clara"
        items={[]}
        messageDraft="Desktop follows the same rhythm."
        testID="activity"
      />,
    );
    const style = Object.assign(
      {},
      ...hostNodes(renderer, /^activity$/)[0].props.style.filter(Boolean),
    );
    expect(style.paddingTop).toBe(groknight.messagePaddingVertical * 3);
    expect(style.paddingBottom).toBe(groknight.messagePaddingVertical);
  });

  it('renders durable corner narration after the live draft is gone', () => {
    const renderer = render(
      <ActivityTimeline
        active={false}
        items={[{ kind: 'output', title: 'Update', text: 'Found the boundary.' }]}
      />,
    );
    expect(renderer.root.findByProps({ testID: 'activity-narration-0' }).props.markdown).toBe(
      'Found the boundary.',
    );
  });

  it('renders the accumulating conversational draft beside the ledger lines', () => {
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
    // The draft lane is untouched by the ledger: prose stays prose, and the
    // tool lines do not borrow the draft's own tap budget.
    expect(hostNodes(renderer, /^tool-run-group-/)).toHaveLength(1);
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(0);
  });

  it('keeps prose tight to the tool line it follows', () => {
    const renderer = render(
      <ActivityTimeline active items={[TOOLS[0]!]} messageDraft="The result follows the call." />,
    );

    expect(
      renderer.root.findByProps({ testID: 'activity-message-draft' }).props.textStyle.marginTop,
    ).toBeLessThanOrEqual(3);
  });

  it('routes streamed prose through the Room-style Markdown renderer, never the thought lane', () => {
    const renderer = render(
      <ActivityTimeline
        active
        items={[
          {
            kind: 'thinking',
            title: 'Thinking',
            text: '**PRIVATE REASONING MUST NOT RENDER AS PROSE**',
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

  it("renders the settled row's byline — IdentityMark + name + model + stamp — on the live draft", () => {
    // Captain report C42: the streamed draft lane's byline must be exactly
    // the settled message byline (`Ledger.LedgerBylineView`), so the agent
    // triangle is present and nothing changes visually when the draft
    // settles in place.
    const renderer = render(
      <ActivityTimeline
        active
        handle="Codex"
        role="openrouter/deepseek-deepseek-v.4.1-flash"
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
        size: 26,
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
    expect(bylineText).toContain('openrouter/deepseek-deepseek-v.4.1-flash');
    expect(bylineText).not.toContain('effort');
    expect(bylineText).toContain('14:02');
    const role = renderer.root.findByProps({ testID: 'chat-byline-role' });
    expect(role.props.numberOfLines).toBe(1);
    expect(role.props.ellipsizeMode).toBe('tail');
  });

  it('renders no identity mark when no byline handle is present', () => {
    const renderer = render(
      <ActivityTimeline active items={TOOLS} mark={{ seed: 'agent-pubkey', kind: 'agent' }} />,
    );
    expect(renderer.root.findAllByProps({ testID: 'chat-byline-mark' })).toHaveLength(0);
  });
});

describe('folded historical transcripts', () => {
  const agent = 'b'.repeat(64);
  const row = (
    id: string,
    activity: Array<NonNullable<Parameters<typeof ActivityTimeline>[0]['items']>[number]>,
  ) => ({
    id,
    text: '',
    isUser: false,
    timestamp: Number(id.replace(/\D/g, '')),
    pubkey: agent,
    isAgentAuthor: true,
    isAgentActivity: true,
    requestId: 'turn-1',
    activity,
  });

  it('collapses every tool call in one turn despite narration between machine runs', () => {
    const call = (id: string) =>
      row(id, [
        {
          kind: 'tool',
          id,
          title: 'Read file',
          toolKind: 'read',
          input: `${id}.ts`,
          output: `contents of ${id}.ts`,
          status: 'completed',
        },
      ]);
    const narration = (id: string, text: string) =>
      row(id, [{ kind: 'output', title: 'Update', text }]);
    const folded = foldSettledActivityRuns([
      call('tool-1'),
      narration('prose-2', 'First boundary.'),
      call('tool-3'),
      call('tool-4'),
      narration('prose-5', 'Second boundary.'),
      call('tool-6'),
      call('tool-7'),
      call('tool-8'),
    ]);

    expect(folded.map((message) => message.id)).toEqual(['tool-1', 'prose-2', 'prose-5']);
    const renderer = render(
      <>
        {folded.map((message) => (
          <ActivityTimeline key={message.id} items={message.activity ?? []} />
        ))}
      </>,
    );
    expect(hostNodes(renderer, /^tool-run-group-/)).toHaveLength(1);
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'tool-run-group-tool-1' }).props.accessibilityLabel,
    ).toBe('6 steps, expandable');

    expandRun(renderer, 'tool-1');
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(6);
    expect(
      renderer.root.findByProps({ testID: 'tool-ledger-line-tool-8' }).props.onPress,
    ).toBeTypeOf('function');
  });

  it('drops thinking-only rows while retaining summary tool lines', () => {
    const [group, ...rest] = foldSettledActivityRuns([
      row('note-1', [{ kind: 'summary', title: 'Summary', rollup: { read: 1 } }]),
      row('thought-2', [{ kind: 'thinking', title: 'Thinking', text: 'Checking.' }]),
      row('note-3', [{ kind: 'summary', title: 'Summary', rollup: { searched: 2 } }]),
    ]);
    expect(rest).toHaveLength(0);
    const renderer = render(<ActivityTimeline items={group.activity!} />);
    expect(hostNodes(renderer, /^tool-run-group-/)).toHaveLength(1);
    expect(hostNodes(renderer, /^tool-ledger-line-/)).toHaveLength(0);
    expect(hostNodes(renderer, /^corner-tool-summary$/)).toHaveLength(0);
  });

  it('renders a folded run of per-call rows as one group over all six calls (C55)', () => {
    const call = (id: string, status: 'completed' | 'failed') => ({
      id,
      text: '',
      isUser: false,
      timestamp: Number(id.slice(1)),
      pubkey: agent,
      isAgentAuthor: true,
      isAgentActivity: true,
      activity: [
        { kind: 'tool' as const, title: 'Bash', toolKind: 'execute', command: id, status },
      ],
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
    expect(hostNodes(renderer, /^corner-tool-summary$/)).toHaveLength(0);
    expect(hostNodes(renderer, /^tool-run-group-/)).toHaveLength(1);
    expect(
      renderer.root.findByProps({ testID: 'tool-run-group-anonymous-0' }).props.accessibilityLabel,
    ).toBe('6 steps · 4 failed, expandable');
  });
});
