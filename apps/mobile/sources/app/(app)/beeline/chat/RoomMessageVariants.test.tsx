import * as React from 'react';
import { readFileSync } from 'node:fs';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversationIdentityByPubkey,
  type ChatDisplayMessage,
} from '@/buzz/room-view-presentation';
import { selectComposerAckPresentation } from '@/buzz/room-indicators';
import { resetProvisionalDrafts } from '@/buzz/draft-settle';
import { ALIVE_RING_PAD } from '@/buzz/identity-mark';
import { Platform } from 'react-native';

const ledgerEntryRender = vi.hoisted(() => vi.fn());
const conversationSource = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(
      name,
      props,
      typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
    );
  return {
    Image: host('Image'),
    Linking: { openURL: vi.fn(async () => undefined) },
    Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('react-native-gesture-handler', async () => {
  const ReactModule = await import('react');
  return {
    Swipeable: (props: any) => ReactModule.createElement('Swipeable', props, props.children),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (factory: () => unknown) => factory() },
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/buzz/chat-attachment', () => ({
  attachmentOpenUrl: (attachment: { url: string }) => attachment.url,
  formatAttachmentSize: (size: number) => `${size} B`,
}));
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/ActivityTimeline', async () => {
  const ReactModule = await import('react');
  return { ActivityTimeline: (props: any) => ReactModule.createElement('ActivityTimeline', props) };
});
vi.mock('@/components/buzz/WritePermissionOutcome', async () => {
  const ReactModule = await import('react');
  return {
    WritePermissionOutcome: (props: any) =>
      ReactModule.createElement('WritePermissionOutcome', props),
  };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    HullSurface: (props: any) => ReactModule.createElement('HullSurface', props, props.children),
    MonoButton: (props: any) => ReactModule.createElement('MonoButton', props),
    NewMessageMaterialize: (props: any) =>
      ReactModule.createElement('NewMessageMaterialize', props, props.children),
  };
});
vi.mock('@/components/buzz/Ledger', async () => {
  const ReactModule = await import('react');
  return {
    LedgerEntry: (props: any) => {
      ledgerEntryRender(props);
      return ReactModule.createElement('LedgerEntry', props);
    },
    LedgerGhostLine: (props: any) => ReactModule.createElement('LedgerGhostLine', props),
    LedgerSteer: (props: any) => ReactModule.createElement('LedgerSteer', props),
  };
});

import {
  GitHubEventCard,
  DaemonFactCard,
  GrantRequestCard,
  OrdinaryLedgerMessage,
  TargetBranchProposalCard,
  WritePermissionCard,
  type OrdinaryLedgerMessageProps,
} from './RoomMessageVariants';

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
beforeEach(() => {
  ledgerEntryRender.mockClear();
  resetProvisionalDrafts();
});

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

function message(overrides: Partial<ChatDisplayMessage>): ChatDisplayMessage {
  return { id: 'message', text: 'hello', isUser: false, timestamp: 1, ...overrides };
}

describe('Room message variant components', () => {
  it('keeps Room and corner conversations on one composer, mention, and transcript component path', () => {
    expect(conversationSource.match(/testID="chat-input"/g)).toHaveLength(1);
    expect(conversationSource.match(/<AttachmentPickerSheet/g)).toHaveLength(1);
    expect(conversationSource.match(/<OrdinaryLedgerMessage/g)).toHaveLength(1);
    expect(conversationSource.match(/testID="mention-suggestions"/g)).toHaveLength(1);
    expect(conversationSource).toContain(
      'inputSelection.start === inputSelection.end\n        ? activeMentionAtCursor',
    );
    expect(conversationSource).not.toContain(
      '!parentChannelId && inputSelection.start === inputSelection.end',
    );
    expect(conversationSource).not.toMatch(
      /parentChannelId\s*\?\s*undefined\s*:\s*\(selectedMentionedAgent/,
    );
  });

  it('shows write actions only to the permitted audience and routes an allowed corner action', () => {
    const onDecision = vi.fn();
    const onOpenCorner = vi.fn();
    const pending = message({
      writePermission: {
        permissionId: 'permission',
        requestId: 'request',
        agentPubkey: 'agent',
        requesterPubkey: 'requester',
        tool: 'edit_file',
        repository: 'owner/repo',
        status: 'pending',
      },
    });
    const owner = render(
      <WritePermissionCard
        message={pending}
        viewerIsAgent={false}
        viewerPubkey="owner"
        viewerRole="owner"
        actionId={null}
        onDecision={onDecision}
        onOpenCorner={onOpenCorner}
      />,
    );
    const buttons = owner.root.findAllByType('MonoButton');
    expect(buttons.map((button: { props: { label: string } }) => button.props.label)).toEqual([
      'Deny',
      'Open edit corner',
    ]);
    act(() => buttons[1]!.props.onPress());
    expect(onDecision).toHaveBeenCalledWith(pending, 'allow');

    const outsider = render(
      <WritePermissionCard
        message={pending}
        viewerIsAgent={false}
        viewerPubkey="other"
        viewerRole="member"
        actionId={null}
        onDecision={onDecision}
        onOpenCorner={onOpenCorner}
      />,
    );
    expect(outsider.root.findAllByType('MonoButton')).toHaveLength(0);
    expect(outsider.root.findByProps({ testID: 'corner-approval-audience-wait' })).toBeDefined();

    const allowed = render(
      <WritePermissionCard
        message={message({
          writePermission: {
            ...pending.writePermission!,
            status: 'allowed',
            subchannelId: 'corner',
          },
        })}
        viewerIsAgent={false}
        viewerPubkey="owner"
        viewerRole="owner"
        actionId={null}
        onDecision={onDecision}
        onOpenCorner={onOpenCorner}
      />,
    );
    act(() => allowed.root.findByType('WritePermissionOutcome').props.onOpen());
    expect(onOpenCorner).toHaveBeenCalledWith('corner');
  });

  it('renders target-branch applied, owner-confirm, and denied states', () => {
    const proposal = message({
      targetBranchProposal: { proposalId: 'proposal', from: 'main', to: 'release' },
    });
    const onConfirm = vi.fn();
    const owner = render(
      <TargetBranchProposalCard
        message={proposal}
        viewerIsAgent={false}
        viewerRole="owner"
        actionId={null}
        notice={null}
        onConfirm={onConfirm}
      />,
    );
    act(() => owner.root.findByProps({ testID: 'target-branch-confirm' }).props.onPress());
    expect(onConfirm).toHaveBeenCalledWith(proposal);
    expect(
      render(
        <TargetBranchProposalCard
          message={proposal}
          currentTargetBranch="release"
          viewerIsAgent={false}
          viewerRole="owner"
          actionId={null}
          notice={null}
          onConfirm={onConfirm}
        />,
      ).root.findByProps({ testID: 'target-branch-applied' }),
    ).toBeDefined();
    expect(
      render(
        <TargetBranchProposalCard
          message={proposal}
          viewerIsAgent={false}
          viewerRole="admin"
          actionId={null}
          notice="Waiting"
          onConfirm={onConfirm}
        />,
      ).root.findByProps({ testID: 'target-branch-denied' }),
    ).toBeDefined();
  });

  it('dispatches GitHub pull-request and issue cards through the explicit URL callback', () => {
    const onOpenUrl = vi.fn();
    for (const githubEvent of [
      {
        type: 'pull-request' as const,
        action: 'merged' as const,
        actor: 'Ada',
        title: 'Ship it',
        url: 'https://github.test/pr',
      },
      {
        type: 'issue' as const,
        action: 'opened' as const,
        actor: 'Lin',
        title: 'Bug',
        url: 'https://github.test/issue',
      },
    ]) {
      const renderer = render(
        <GitHubEventCard message={message({ githubEvent })} onOpenUrl={onOpenUrl} />,
      );
      act(() => renderer.root.findByType('Pressable').props.onPress());
      expect(onOpenUrl).toHaveBeenLastCalledWith(githubEvent.url);
    }
  });

  it('renders a landed corner as a summary card with its full objective and tappable PR', () => {
    const onOpenCorner = vi.fn();
    const onOpenUrl = vi.fn();
    const renderer = render(
      <DaemonFactCard
        message={message({
          authorIdentity: {
            pubkey: 'agent',
            kind: 'agent',
            name: 'Beebee',
          },
          daemonFact: {
            type: 'corner-complete',
            cornerId: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
            objective:
              'Ship fact cards with archived transcript access and preserve the entire objective instead of truncating it into a ledger line',
            outcome: 'landed',
            pullRequest: {
              number: 42,
              title: 'Ship the archived transcript card',
              url: 'https://github.com/acme/beeline/pull/42',
            },
            subgoals: [{ step: 'Open the archived transcript', status: 'completed' }],
          },
        })}
        onOpenCorner={onOpenCorner}
        onOpenUrl={onOpenUrl}
      />,
    );
    act(() =>
      renderer.root.findByProps({ testID: 'corner-summary-card-primary-action' }).props.onPress(),
    );
    expect(onOpenUrl).toHaveBeenCalledWith('https://github.com/acme/beeline/pull/42');
    act(() =>
      renderer.root.findByProps({ testID: 'corner-summary-card-secondary-action' }).props.onPress(),
    );
    expect(onOpenCorner).toHaveBeenCalledWith('80a5a6f1-fb5a-493b-93eb-f3db33f696e6');
    expect(renderer.root.findAllByType('HullSurface')).toHaveLength(1);
    expect(renderer.root.findByProps({ testID: 'corner-summary-card' })).toBeDefined();
    // A legacy card carries no name, so the title is the first three words of
    // its objective; the body still carries the objective whole (C89).
    expect(JSON.stringify(renderer.toJSON())).toContain('MERGED · Ship fact cards');
    expect(JSON.stringify(renderer.toJSON())).toContain('MERGED · Beebee');
    expect(JSON.stringify(renderer.toJSON())).toContain(
      'Ship fact cards with archived transcript access and preserve the entire objective instead of truncating it into a ledger line',
    );
    expect(JSON.stringify(renderer.toJSON())).toContain(
      'VIEW PR: Ship the archived transcript card ↗',
    );
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Open the archived transcript');
  });

  it('titles the corner-open card with the name and keeps the objective as its body', () => {
    const onOpenCorner = vi.fn();
    const renderer = render(
      <DaemonFactCard
        message={message({
          daemonFact: {
            type: 'corner-open',
            cornerId: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
            name: 'flaky auth',
            objective: 'Fix the flaky auth test so the suite stops failing at random',
          },
        })}
        onOpenCorner={onOpenCorner}
        onOpenUrl={() => undefined}
      />,
    );
    const card = renderer.root.findByProps({
      testID: 'daemon-fact-card-corner-open-primary-action',
    });
    const texts = renderer.root
      .findAllByType('Text')
      .map((node: ReactTestInstance) => node.props.children);
    expect(texts).toContain('flaky auth');
    expect(texts).toContain('Fix the flaky auth test so the suite stops failing at random');
    act(() => card.props.onPress());
    expect(onOpenCorner).toHaveBeenCalledWith('80a5a6f1-fb5a-493b-93eb-f3db33f696e6');
  });

  it('names the agent that OPENED the corner, never one that owns it', () => {
    // Any member agent can be addressed in a corner and carry its branch on,
    // so the card records who started the work rather than who holds it.
    const renderer = render(
      <DaemonFactCard
        message={message({
          daemonFact: {
            type: 'corner-open',
            cornerId: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
            name: 'flaky auth',
            objective: 'Fix the flaky auth test',
          },
          authorIdentity: { kind: 'agent', name: 'Beebee', pubkey: 'b'.repeat(64) },
        })}
        onOpenCorner={() => undefined}
        onOpenUrl={() => undefined}
      />,
    );
    const texts = renderer.root
      .findAllByType('Text')
      .map((node: ReactTestInstance) => node.props.children);
    expect(texts).toContain('OPENED BY Beebee\nFix the flaky auth test');
  });

  it('titles a legacy corner-open card by the first three words of its objective', () => {
    const renderer = render(
      <DaemonFactCard
        message={message({
          daemonFact: {
            type: 'corner-open',
            cornerId: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
            objective: 'Fix the flaky auth test so the suite stops failing at random',
          },
        })}
        onOpenCorner={() => undefined}
        onOpenUrl={() => undefined}
      />,
    );
    const texts = renderer.root
      .findAllByType('Text')
      .map((node: ReactTestInstance) => node.props.children);
    expect(texts).toContain('Fix the flaky');
    expect(texts).toContain('Fix the flaky auth test so the suite stops failing at random');
  });

  it('memoizes ordinary rows across unrelated working changes and updates the affected speaker', () => {
    const ordinary = message({ id: 'agent-message', pubkey: 'agent', isAgentAuthor: true });
    const stable = {
      message: ordinary,
      agent: { pubkey: 'agent', displayName: 'Codex' },
      participantsHydrated: true,
      viewerPubkey: 'viewer',
      continued: false,
      participantHandles: [],
      channelIndex: { rooms: [], corners: [] },
      deliveryFailed: false,
      onChannelReference: vi.fn(),
      onReply: vi.fn(),
      onCopy: vi.fn(),
      onRetry: vi.fn(),
      onDismiss: vi.fn(),
    } satisfies Omit<OrdinaryLedgerMessageProps, 'speakerWorking'>;
    const renderer = render(<OrdinaryLedgerMessage {...stable} speakerWorking={false} />);
    expect(ledgerEntryRender).toHaveBeenCalledTimes(1);
    act(() => renderer.update(<OrdinaryLedgerMessage {...stable} speakerWorking={false} />));
    expect(ledgerEntryRender).toHaveBeenCalledTimes(1);
    act(() => renderer.update(<OrdinaryLedgerMessage {...stable} speakerWorking />));
    expect(ledgerEntryRender).toHaveBeenCalledTimes(2);
    expect(ledgerEntryRender.mock.lastCall?.[0].byline.mark.alive).toBe(true);
  });

  it('keeps the whole byline tile, alive ring included, inside the swipe clip box for both kinds', () => {
    // C70: on device the row lives in gesture-handler's Swipeable, whose
    // container is `overflow: 'hidden'` at the row's content edge — exactly
    // where the tile sits — so a live agent's ring lost its left edge. The
    // clip box is outset by the ring gutter and the children padded back by
    // the same amount: the copy column does not move, and the tile's painted
    // bounds (box − ALIVE_RING_PAD) start at or after the clip edge.
    const previous = Platform.OS;
    (Platform as { OS: string }).OS = 'android';
    try {
      const speakers = [
        { message: message({ id: 'a', pubkey: 'agent', isAgentAuthor: true }), working: true },
        { message: message({ id: 'h', pubkey: 'ada', isUser: false }), working: false },
      ];
      for (const speaker of speakers) {
        const renderer = render(
          <OrdinaryLedgerMessage
            message={speaker.message}
            agent={speaker.working ? { pubkey: 'agent', displayName: 'Codex' } : undefined}
            personName={speaker.working ? undefined : 'Ada'}
            participantsHydrated
            viewerPubkey="viewer"
            speakerWorking={speaker.working}
            continued={false}
            participantHandles={[]}
            channelIndex={{ rooms: [], corners: [] }}
            deliveryFailed={false}
            onChannelReference={vi.fn()}
            onReply={vi.fn()}
            onCopy={vi.fn()}
            onRetry={vi.fn()}
            onDismiss={vi.fn()}
          />,
        );
        const swipe = renderer.root.findByType('Swipeable');
        const flat = (style: unknown) =>
          Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, number>;
        const clip = flat(swipe.props.containerStyle);
        const children = flat(swipe.props.childrenContainerStyle);
        const clipLeft = clip.marginHorizontal ?? clip.marginLeft ?? 0;
        const tileLeft = clipLeft + (children.paddingHorizontal ?? children.paddingLeft ?? 0);
        // The copy column stays exactly where the row's content edge was.
        expect(tileLeft).toBe(0);
        // The ring's leftmost paint lands inside the clip box.
        expect(tileLeft - ALIVE_RING_PAD).toBeGreaterThanOrEqual(clipLeft);
        const byline = ledgerEntryRender.mock.lastCall?.[0].byline;
        expect(byline.mark.kind).toBe(speaker.working ? 'agent' : 'human');
        if (speaker.working) expect(byline.mark.alive).toBe(true);
      }
    } finally {
      (Platform as { OS: string }).OS = previous;
    }
  });

  // Attachment bytes are swept 24 hours after upload; the message that carried
  // them is kept. The row says what is gone instead of hanging on a dead URL.
  it('renders an expired attachment as a named placeholder, not an image or a link', () => {
    const cards = (expired: boolean) => {
      ledgerEntryRender.mockClear();
      render(
        <OrdinaryLedgerMessage
          message={message({
            id: 'with-file',
            pubkey: 'ada',
            attachments: [
              {
                url: 'https://server.example/v1/media/11111111-1111-4111-8111-111111111111',
                thumbnailUrl: 'https://server.example/v1/media/thumb',
                name: 'receipt.png',
                mimeType: 'image/png',
                size: 13,
                ...(expired ? { expired: true } : {}),
              },
            ],
          })}
          personName="Ada"
          participantsHydrated
          viewerPubkey="viewer"
          speakerWorking={false}
          continued={false}
          participantHandles={[]}
          channelIndex={{ rooms: [], corners: [] }}
          deliveryFailed={false}
          onChannelReference={vi.fn()}
          onReply={vi.fn()}
          onCopy={vi.fn()}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      return render(
        React.createElement(React.Fragment, null, ledgerEntryRender.mock.lastCall?.[0].attachments),
      );
    };

    const live = cards(false);
    expect(live.root.findAllByProps({ testID: 'chat-attachment-receipt.png' })).not.toHaveLength(0);
    expect(live.root.findAllByType('Image')).not.toHaveLength(0);

    const gone = cards(true);
    // No live card, no thumbnail request, no open affordance.
    expect(gone.root.findAllByProps({ testID: 'chat-attachment-receipt.png' })).toHaveLength(0);
    expect(gone.root.findAllByType('Image')).toHaveLength(0);
    expect(gone.root.findAllByProps({ accessibilityRole: 'link' })).toHaveLength(0);
    const placeholder = gone.root.findByProps({
      testID: 'chat-attachment-expired-receipt.png',
    });
    expect(placeholder.props.accessibilityLabel).toBe('Expired attachment receipt.png');
    const text = placeholder
      .findAllByType('Text')
      .map((node: ReactTestInstance) => node.props.children)
      .flat(Infinity)
      .join('');
    // The name survives, and so does the metadata the message still holds.
    expect(text).toContain('receipt.png');
    expect(text).toContain('EXPIRED');
    expect(text).toContain('IMAGE/PNG');
  });

  it("gives the live draft lane the settled row's identity mark", () => {
    // Captain report C42: while the agent streams, the draft row's byline is
    // the same byline component as a settled agent message — IdentityMark
    // (same seed/kind/alive axes) + name — so nothing changes on settle.
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({
          id: 'draft-1',
          pubkey: 'agent',
          isAgentAuthor: true,
          isAgentActivity: true,
          isAgentDraft: true,
          isAgentLiveTurn: true,
          agentMessageDraft: 'Working…',
        })}
        agent={{ pubkey: 'agent', displayName: 'CODEX' }}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const timeline = renderer.root.findByType('ActivityTimeline');
    expect(timeline.props.handle).toBe('CODEX');
    // The settled byline mark for the same speaker is {seed, kind:'agent',
    // alive:true}; the draft lane must carry exactly that mark.
    expect(timeline.props.mark).toEqual({ seed: 'agent', kind: 'agent', alive: true });
  });

  it('wears the agent’s assigned creature on both the settled byline and the live lane', () => {
    // An agent's animal comes with its name and its soul from the server. A
    // row that knows the agent only through the roster still has it, and the
    // streaming lane is the same speaker — so neither may fall back to the
    // key's hashed default while the other shows the real one.
    const props = {
      participantsHydrated: true,
      viewerPubkey: 'viewer',
      speakerWorking: true,
      continued: false,
      participantHandles: [],
      channelIndex: { rooms: [], corners: [] },
      deliveryFailed: false,
      onChannelReference: vi.fn(),
      onReply: vi.fn(),
      onCopy: vi.fn(),
      onRetry: vi.fn(),
      onDismiss: vi.fn(),
    };
    render(
      <OrdinaryLedgerMessage
        {...props}
        message={message({ id: 'settled', pubkey: 'agent', isAgentAuthor: true })}
        agent={{ pubkey: 'agent', displayName: 'Foxy', face: 'fox' }}
      />,
    );
    expect(ledgerEntryRender.mock.lastCall?.[0].byline.mark).toMatchObject({ face: 'fox' });

    const live = render(
      <OrdinaryLedgerMessage
        {...props}
        message={message({
          id: 'live',
          pubkey: 'agent',
          isAgentAuthor: true,
          isAgentActivity: true,
          isAgentLiveTurn: true,
          agentMessageDraft: 'Working…',
        })}
        agent={{ pubkey: 'agent', displayName: 'Foxy', face: 'fox' }}
      />,
    );
    expect(live.root.findByType('ActivityTimeline').props.mark).toMatchObject({ face: 'fox' });

    // The row's own server identity wins over the roster copy.
    render(
      <OrdinaryLedgerMessage
        {...props}
        message={message({
          id: 'indexed',
          pubkey: 'agent',
          isAgentAuthor: true,
          authorIdentity: { pubkey: 'agent', kind: 'agent', name: 'Foxy', face: 'owl' },
        })}
        agent={{ pubkey: 'agent', displayName: 'Foxy', face: 'fox' }}
      />,
    );
    expect(ledgerEntryRender.mock.lastCall?.[0].byline.mark).toMatchObject({ face: 'owl' });
  });

  it('hands the streamed words to the reply that settles them, exactly once (C98)', () => {
    const rowProps = {
      agent: { pubkey: 'agent', displayName: 'CODEX' },
      participantsHydrated: true,
      viewerPubkey: 'viewer',
      speakerWorking: false,
      continued: false,
      participantHandles: [],
      channelIndex: { rooms: [], corners: [] },
      deliveryFailed: false,
      onChannelReference: vi.fn(),
      onReply: vi.fn(),
      onCopy: vi.fn(),
      onRetry: vi.fn(),
      onDismiss: vi.fn(),
    } as const;
    const reply = message({
      id: 'durable-1',
      pubkey: 'agent',
      isAgentAuthor: true,
      requestId: 'request-9',
      text: 'The answer is 42.',
    });

    render(
      <OrdinaryLedgerMessage
        {...rowProps}
        message={message({
          id: 'live-turn:agent:request-9',
          pubkey: 'agent',
          isAgentAuthor: true,
          isAgentActivity: true,
          isAgentDraft: true,
          isAgentLiveTurn: true,
          agentMessageDraft: 'The answer is 4',
        })}
      />,
    );
    render(<OrdinaryLedgerMessage {...rowProps} message={reply} />);
    expect(ledgerEntryRender.mock.calls.at(-1)?.[0].settleFrom).toBe('The answer is 4');

    // Spent: a remount of the same settled row snaps nothing and replays nothing.
    render(<OrdinaryLedgerMessage {...rowProps} message={reply} />);
    expect(ledgerEntryRender.mock.calls.at(-1)?.[0].settleFrom).toBeUndefined();
  });

  it('uses the current server author label and shared mention renderer over stale roster data', () => {
    const agentPubkey = 'agent';
    const currentIdentityMessage = message({
      id: 'current-identity',
      text: '@codex has the latest result',
      pubkey: agentPubkey,
      isAgentAuthor: true,
      authorIdentity: { pubkey: agentPubkey, kind: 'agent', name: 'CODEX', handle: 'codex' },
      mentionPubkeys: [agentPubkey],
    });
    render(
      <OrdinaryLedgerMessage
        message={currentIdentityMessage}
        agent={{ pubkey: agentPubkey, displayName: 'Arlo' }}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking
        continued={false}
        participantHandles={[{ pubkey: agentPubkey, handle: 'codex' }]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(ledgerEntryRender.mock.lastCall?.[0]).toMatchObject({
      byline: { name: 'CODEX' },
      mentionHandles: ['codex'],
    });
    expect(
      selectComposerAckPresentation({
        isCorner: true,
        agentsOffline: false,
        activeTurnPubkey: agentPubkey,
        now: 1,
        conversationIdentities: conversationIdentityByPubkey([], [currentIdentityMessage]),
      }),
    ).toEqual({ label: 'CODEX thinking…' });
  });
  it('renders the grant card with ALWAYS / ONCE / NO only for the owner or a manager, and settles each line into its outcome', () => {
    const onDecision = vi.fn();
    const owner = { pubkey: 'owner', kind: 'human' as const, name: 'Charles' };
    const requester = { pubkey: 'alex', kind: 'human' as const, name: 'Alex' };
    const pending = message({
      grantRequest: {
        agent: { pubkey: 'agent', kind: 'agent', name: 'Terra' },
        owner,
        requester,
        grants: [
          {
            grantId: 'g-1',
            kind: 'command',
            target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
            reason: 'to publish the preview build',
            status: 'pending',
            requestedBy: requester,
            roomId: '22222222-2222-4222-8222-222222222222',
            createdAt: 1,
            auto: false,
          },
          {
            grantId: 'g-2',
            kind: 'host',
            target: 'api.fly.io',
            reason: 'to reach the Fly API',
            status: 'pending',
            requestedBy: requester,
            roomId: '22222222-2222-4222-8222-222222222222',
            createdAt: 1,
            auto: false,
          },
        ],
      },
    });
    const ownerView = render(
      <GrantRequestCard
        message={pending}
        viewerIsAgent={false}
        viewerPubkey="owner"
        viewerRole="member"
        actionId={null}
        onDecision={onDecision}
      />,
    );
    expect(
      ownerView.root.findByProps({ testID: 'grant-request-title' }).props.children.join(''),
    ).toBe('Terra asks Charles');
    expect(ownerView.root.findByProps({ testID: 'grant-g-1-ask' }).props.children).toBe(
      'run fly deploy -a beeline-preview --with FLY_TOKEN',
    );
    expect(ownerView.root.findByProps({ testID: 'grant-g-2-ask' }).props.children).toBe(
      'reach api.fly.io',
    );
    const buttons = ownerView.root.findAllByType('MonoButton');
    expect(buttons.map((button: { props: { label: string } }) => button.props.label)).toEqual([
      'ALWAYS',
      'ONCE',
      'NO',
      'ALWAYS',
      'ONCE',
      'NO',
    ]);
    act(() => ownerView.root.findByProps({ testID: 'grant-g-1-once' }).props.onPress());
    expect(onDecision).toHaveBeenCalledWith('g-1', 'once');
    act(() => ownerView.root.findByProps({ testID: 'grant-g-2-deny' }).props.onPress());
    expect(onDecision).toHaveBeenCalledWith('g-2', 'deny');

    // A workspace manager who is not the owner decides too.
    const manager = render(
      <GrantRequestCard
        message={pending}
        viewerIsAgent={false}
        viewerPubkey="someone-else"
        viewerRole="admin"
        actionId={null}
        onDecision={onDecision}
      />,
    );
    expect(manager.root.findAllByType('MonoButton')).toHaveLength(6);

    // A plain member (the requester included) sees the ask and waits for the owner.
    const outsider = render(
      <GrantRequestCard
        message={pending}
        viewerIsAgent={false}
        viewerPubkey="alex"
        viewerRole="member"
        actionId={null}
        onDecision={onDecision}
      />,
    );
    expect(outsider.root.findAllByType('MonoButton')).toHaveLength(0);
    expect(outsider.root.findByProps({ testID: 'grant-g-1-waiting' }).props.children.join('')).toBe(
      'WAITING FOR CHARLES',
    );

    // After the taps the card settles in place: no buttons, one inscribed outcome per line.
    const settled = render(
      <GrantRequestCard
        message={message({
          grantRequest: {
            ...pending.grantRequest!,
            grants: [
              {
                ...pending.grantRequest!.grants[0]!,
                status: 'once',
                decidedBy: owner,
                decidedAt: 1_756_900_060,
              },
              {
                ...pending.grantRequest!.grants[1]!,
                status: 'denied',
                decidedBy: owner,
                decidedAt: 1_756_900_061,
              },
            ],
          },
        })}
        viewerIsAgent={false}
        viewerPubkey="owner"
        viewerRole="owner"
        actionId={null}
        onDecision={onDecision}
      />,
    );
    expect(settled.root.findAllByType('MonoButton')).toHaveLength(0);
    expect(settled.root.findByProps({ testID: 'grant-request-settled' })).toBeDefined();
    const outcomes = settled.root.findAllByType('WritePermissionOutcome');
    expect(
      outcomes.map((outcome: { props: { label: string; status: string } }) => [
        outcome.props.status,
        outcome.props.label,
      ]),
    ).toEqual([
      ['allowed', expect.stringMatching(/^Charles allowed once · /)],
      ['denied', expect.stringMatching(/^Charles declined · /)],
    ]);
  });

  it('shows the script an interpreter grant will run, because the command line does not (C94)', () => {
    const owner = { pubkey: 'owner', kind: 'human' as const, name: 'Charles' };
    const script = 'import os\nos.remove("/tmp/x")\n';
    const card = render(
      <GrantRequestCard
        message={message({
          grantRequest: {
            agent: { pubkey: 'agent', kind: 'agent', name: 'Goosy' },
            owner,
            requester: owner,
            grants: [
              {
                grantId: 'g-1',
                kind: 'command',
                target: 'python3 fix_serve_prod.py',
                reason: 'to fix the serve script',
                status: 'pending',
                requestedBy: owner,
                roomId: '22222222-2222-4222-8222-222222222222',
                createdAt: 1,
                auto: false,
                script: {
                  path: 'fix_serve_prod.py',
                  sha256: 'a'.repeat(64),
                  bytes: script.length,
                  contents: script,
                },
              },
            ],
          },
        })}
        viewerIsAgent={false}
        viewerPubkey="owner"
        viewerRole="owner"
        actionId={null}
        onDecision={vi.fn()}
      />,
    );
    const body = card.root.findByProps({ testID: 'grant-g-1-script' });
    const texts = body.findAllByType('Text').map((node: { props: { children: unknown } }) => node.props.children);
    expect(texts).toContain('fix_serve_prod.py');
    expect(texts).toContain(script);
  });

  it('draws no script block for a grant that has none', () => {
    const owner = { pubkey: 'owner', kind: 'human' as const, name: 'Charles' };
    const card = render(
      <GrantRequestCard
        message={message({
          grantRequest: {
            agent: { pubkey: 'agent', kind: 'agent', name: 'Goosy' },
            owner,
            requester: owner,
            grants: [
              {
                grantId: 'g-2',
                kind: 'command',
                target: 'npm test',
                reason: 'to run the suite',
                status: 'pending',
                requestedBy: owner,
                roomId: '22222222-2222-4222-8222-222222222222',
                createdAt: 1,
                auto: false,
              },
            ],
          },
        })}
        viewerIsAgent={false}
        viewerPubkey="owner"
        viewerRole="owner"
        actionId={null}
        onDecision={vi.fn()}
      />,
    );
    expect(card.root.findAllByProps({ testID: 'grant-g-2-script' })).toHaveLength(0);
  });
});
