import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';

const ledgerEntryRender = vi.hoisted(() => vi.fn());

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
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('react-native-gesture-handler', async () => {
  const ReactModule = await import('react');
  return { Swipeable: (props: any) => ReactModule.createElement('Swipeable', props, props.children) };
});

vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (factory: () => unknown) => factory() } }));
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
  return { WritePermissionOutcome: (props: any) => ReactModule.createElement('WritePermissionOutcome', props) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    HullSurface: (props: any) => ReactModule.createElement('HullSurface', props, props.children),
    MonoButton: (props: any) => ReactModule.createElement('MonoButton', props),
    NewMessageMaterialize: (props: any) => ReactModule.createElement('NewMessageMaterialize', props, props.children),
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
  OrdinaryLedgerMessage,
  TargetBranchProposalCard,
  WritePermissionCard,
  type OrdinaryLedgerMessageProps,
} from './RoomMessageVariants';

const originalConsoleError = console.error;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => ledgerEntryRender.mockClear());

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
      <WritePermissionCard message={pending} viewerIsAgent={false} viewerPubkey="owner" viewerRole="owner" actionId={null} onDecision={onDecision} onOpenCorner={onOpenCorner} />,
    );
    const buttons = owner.root.findAllByType('MonoButton');
    expect(buttons.map((button: { props: { label: string } }) => button.props.label)).toEqual([
      'Deny',
      'Open edit corner',
    ]);
    act(() => buttons[1]!.props.onPress());
    expect(onDecision).toHaveBeenCalledWith(pending, 'allow');

    const outsider = render(
      <WritePermissionCard message={pending} viewerIsAgent={false} viewerPubkey="other" viewerRole="member" actionId={null} onDecision={onDecision} onOpenCorner={onOpenCorner} />,
    );
    expect(outsider.root.findAllByType('MonoButton')).toHaveLength(0);
    expect(outsider.root.findByProps({ testID: 'corner-approval-audience-wait' })).toBeDefined();

    const allowed = render(
      <WritePermissionCard message={message({ writePermission: { ...pending.writePermission!, status: 'allowed', subchannelId: 'corner' } })} viewerIsAgent={false} viewerPubkey="owner" viewerRole="owner" actionId={null} onDecision={onDecision} onOpenCorner={onOpenCorner} />,
    );
    act(() => allowed.root.findByType('WritePermissionOutcome').props.onOpen());
    expect(onOpenCorner).toHaveBeenCalledWith('corner');
  });

  it('renders target-branch applied, owner-confirm, and denied states', () => {
    const proposal = message({ targetBranchProposal: { proposalId: 'proposal', from: 'main', to: 'release' } });
    const onConfirm = vi.fn();
    const owner = render(<TargetBranchProposalCard message={proposal} viewerIsAgent={false} viewerRole="owner" actionId={null} notice={null} onConfirm={onConfirm} />);
    act(() => owner.root.findByProps({ testID: 'target-branch-confirm' }).props.onPress());
    expect(onConfirm).toHaveBeenCalledWith(proposal);
    expect(render(<TargetBranchProposalCard message={proposal} currentTargetBranch="release" viewerIsAgent={false} viewerRole="owner" actionId={null} notice={null} onConfirm={onConfirm} />).root.findByProps({ testID: 'target-branch-applied' })).toBeDefined();
    expect(render(<TargetBranchProposalCard message={proposal} viewerIsAgent={false} viewerRole="admin" actionId={null} notice="Waiting" onConfirm={onConfirm} />).root.findByProps({ testID: 'target-branch-denied' })).toBeDefined();
  });

  it('dispatches GitHub pull-request and issue cards through the explicit URL callback', () => {
    const onOpenUrl = vi.fn();
    for (const githubEvent of [
      { type: 'pull-request' as const, action: 'merged' as const, actor: 'Ada', title: 'Ship it', url: 'https://github.test/pr' },
      { type: 'issue' as const, action: 'opened' as const, actor: 'Lin', title: 'Bug', url: 'https://github.test/issue' },
    ]) {
      const renderer = render(<GitHubEventCard message={message({ githubEvent })} onOpenUrl={onOpenUrl} />);
      act(() => renderer.root.findByType('Pressable').props.onPress());
      expect(onOpenUrl).toHaveBeenLastCalledWith(githubEvent.url);
    }
  });

  it('memoizes ordinary rows across unrelated presence changes and updates the affected speaker', () => {
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
    } satisfies Omit<OrdinaryLedgerMessageProps, 'speakerOnline'>;
    const renderer = render(<OrdinaryLedgerMessage {...stable} speakerOnline={false} />);
    expect(ledgerEntryRender).toHaveBeenCalledTimes(1);
    act(() => renderer.update(<OrdinaryLedgerMessage {...stable} speakerOnline={false} />));
    expect(ledgerEntryRender).toHaveBeenCalledTimes(1);
    act(() => renderer.update(<OrdinaryLedgerMessage {...stable} speakerOnline />));
    expect(ledgerEntryRender).toHaveBeenCalledTimes(2);
    expect(ledgerEntryRender.mock.lastCall?.[0].byline.mark.alive).toBe(true);
  });
});
