import * as React from 'react';
import { readFileSync } from 'node:fs';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversationIdentityByPubkey,
  type ChatDisplayMessage,
} from '@/buzz/room-view-presentation';
import { selectComposerAckPresentation } from '@/buzz/room-indicators';
import { resetProvisionalDrafts } from '@/buzz/draft-settle';
import { ALIVE_RING_PAD } from '@/buzz/identity-mark';
import { Platform } from 'react-native';

const ledgerEntryRender = vi.hoisted(() => vi.fn());
const modal = vi.hoisted(() => ({ alert: vi.fn(), show: vi.fn() }));
const pictureActions = vi.hoisted(() => ({ showPictureActions: vi.fn() }));
const desktopArtifactPane = vi.hoisted(() => ({ openArtifactInDesktopWorkPane: vi.fn() }));
const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
const conversationSource = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
const composerSource = readFileSync(
  new URL('../../../../components/buzz/ConversationComposer.tsx', import.meta.url),
  'utf8',
);

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(
      name,
      props,
      typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
    );
  const animatedValues = new Map<string, { value: number }>();
  const Animated = {
    Value: vi.fn((initial: number) => {
      const id = `${Math.random()}`;
      const state = { value: initial };
      animatedValues.set(id, state);
      return {
        _id: id,
        _state: state,
        interpolate: vi.fn(() => ({
          _inputRange: [] as number[],
          _outputRange: [] as string[],
        })),
        setValue: vi.fn((v: number) => {
          state.value = v;
        }),
      };
    }),
    timing: vi.fn(() => ({
      start: vi.fn((callback?: () => void) => {
        callback?.();
      }),
    })),
    Text: host('Animated.Text'),
    View: host('Animated.View'),
  };
  return {
    Animated,
    AppState: {
      currentState: 'active',
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appStateListeners.add(listener);
        return { remove: () => appStateListeners.delete(listener) };
      },
    },
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

vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  const theme = { buzz: beelineThemes.obsidian };
  return {
    StyleSheet: {
      create: (factory: (theme: { buzz: typeof beelineThemes.obsidian }) => unknown) =>
        factory(theme),
    },
    useUnistyles: () => ({ theme }),
  };
});
vi.mock('@/modal', () => ({ Modal: modal }));
vi.mock('@/buzz/picture-actions', () => pictureActions);
vi.mock('@/buzz/desktop-artifact-pane', () => desktopArtifactPane);
vi.mock('@/buzz/chat-attachment', () => ({
  attachmentOpenUrl: (attachment: { url: string }) => attachment.url,
  formatAttachmentSize: (size: number) => `${size} B`,
}));

const openExternal = vi.hoisted(() => ({ openExternalUrl: vi.fn(async () => undefined) }));
vi.mock('@/utils/open-external-url', () => openExternal);
vi.mock('@/components/buzz/ArtifactCard', async () => {
  const ReactModule = await import('react');
  return { ArtifactCard: (props: any) => ReactModule.createElement('ArtifactCard', props) };
});
vi.mock('@/components/buzz/ArtifactViewer', async () => {
  const ReactModule = await import('react');
  return {
    ArtifactViewerScreen: (props: any) => ReactModule.createElement('ArtifactViewerScreen', props),
  };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/MessageReactionRoster', async () => {
  const ReactModule = await import('react');
  return {
    MessageReactionRoster: (props: any) =>
      ReactModule.createElement('MessageReactionRoster', props),
  };
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
    LedgerSystemLine: (props: any) => ReactModule.createElement('LedgerSystemLine', props),
    LedgerSteer: (props: any) => ReactModule.createElement('LedgerSteer', props),
  };
});

import {
  GitHubEventCard,
  DaemonFactCard,
  NotificationLifecycleCard,
  GrantRequestCard,
  ConnectorOfferCard,
  ChoiceCard,
  agentBylineLabel,
  OrdinaryLedgerMessage,
  RelayHandOff,
  TargetBranchProposalCard,
  WritePermissionCard,
  WalletCards,
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
  modal.alert.mockClear();
  modal.show.mockClear();
  pictureActions.showPictureActions.mockClear();
  desktopArtifactPane.openArtifactInDesktopWorkPane.mockClear();
  openExternal.openExternalUrl.mockClear();
  resetProvisionalDrafts();
});

const mountedRenderers: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => mountedRenderers.splice(0).forEach((renderer) => renderer.unmount()));
  vi.useRealTimers();
});

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
    mountedRenderers.push(renderer);
  });
  return renderer;
}

function message(overrides: Partial<ChatDisplayMessage>): ChatDisplayMessage {
  return { id: 'message', text: 'hello', isUser: false, timestamp: 1, ...overrides };
}

describe('Workbench identities', () => {
  it('uses the indexed Wallet identity and connector logo on wallet cards', () => {
    const renderer = render(
      <WalletCards
        message={message({
          authorIdentity: {
            pubkey: 'wallet-id',
            kind: 'human',
            name: 'Wallet',
            handle: 'wallet',
            avatar: 'https://api.example.test/v1/connectors/logo/wallet.svg',
          },
          walletDelegation: { expiresAt: 1_800_000_000, ttlHours: 24 },
        })}
        stamp="12:00"
      />,
    );
    const mark = renderer.root.findByType('IdentityMark' as never);
    expect(mark.props).toMatchObject({
      seed: 'wallet-id',
      name: 'Wallet',
      avatarUrl: 'https://api.example.test/v1/connectors/logo/wallet.svg',
    });
  });
});

describe('Room message variant components', () => {
  it('replaces the AGENT label with the model, falling back when no model is known', () => {
    expect(agentBylineLabel('  openrouter/deepseek-deepseek-v.4.1-flash  ')).toBe(
      'openrouter/deepseek-deepseek-v.4.1-flash',
    );
    expect(agentBylineLabel()).toBe('AGENT');
    expect(agentBylineLabel('   ')).toBe('AGENT');
  });

  it('keeps Room and corner conversations on one composer, mention, and transcript component path', () => {
    expect(conversationSource.match(/<ConversationComposer/g)).toHaveLength(1);
    expect(composerSource).toContain('testID={`${testIDPrefix}-input`}');
    expect(conversationSource.match(/<AttachmentPickerSheet/g)).toHaveLength(1);
    expect(conversationSource.match(/<OrdinaryLedgerMessage/g)).toHaveLength(1);
    expect(conversationSource).toContain('<ChoiceCard');
    expect(conversationSource).toContain('<ConnectorOfferCard');
    expect(conversationSource.match(/testID="mention-suggestions"/g)).toHaveLength(1);
    expect(conversationSource).toContain('agentModel={item.agentModel}');
    // The byline renders the model stamped at generation time; the roster
    // lookup is retired so old rows keep their own turn's model (or none).
    expect(conversationSource).not.toContain('workspaceAgentModelByPubkey');
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
    expect(JSON.stringify(owner.toJSON())).toContain('Deny');
    expect(JSON.stringify(owner.toJSON())).toContain('Allow');
    act(() => owner.root.findByProps({ testID: 'write-permission-allow' }).props.onPress());
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
    expect(outsider.root.findAllByProps({ testID: 'write-permission-allow' })).toHaveLength(0);
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
    act(() => allowed.root.findByProps({ testID: 'write-permission-open-corner' }).props.onPress());
    expect(onOpenCorner).toHaveBeenCalledWith('corner');
  });

  it('renders target-branch applied, manager-confirm, and denied states', () => {
    const proposal = message({
      targetBranchProposal: { proposalId: 'proposal', from: 'main', to: 'release' },
    });
    const onConfirm = vi.fn();
    const owner = render(
      <TargetBranchProposalCard
        message={proposal}
        canManageWorkspace
        viewerIsAgent={false}
        actionId={null}
        notice={null}
        onConfirm={onConfirm}
      />,
    );
    act(() => owner.root.findByProps({ testID: 'target-branch-confirm' }).props.onPress());
    expect(onConfirm).toHaveBeenCalledWith(proposal);
    expect(
      JSON.stringify(
        render(
          <TargetBranchProposalCard
            message={proposal}
            currentTargetBranch="release"
            canManageWorkspace
            viewerIsAgent={false}
            actionId={null}
            notice={null}
            onConfirm={onConfirm}
          />,
        ).toJSON(),
      ),
    ).toContain('confirmed');
    expect(
      JSON.stringify(
        render(
          <TargetBranchProposalCard
            message={proposal}
            canManageWorkspace={false}
            viewerIsAgent={false}
            actionId={null}
            notice="Waiting"
            onConfirm={onConfirm}
          />,
        ).toJSON(),
      ),
    ).toContain('workspace manager only');
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
      act(() =>
        renderer.root
          .findByProps({
            testID: `github-event-card-${githubEvent.type}-${githubEvent.action}-primary-action`,
          })
          .props.onPress(),
      );
      expect(onOpenUrl).toHaveBeenLastCalledWith(githubEvent.url);
    }
  });

  it('renders nothing for a repository card kind this build does not know', () => {
    for (const type of ['deployment', 'ci'] as const) {
      const renderer = render(
        <GitHubEventCard
          message={message({
            githubEvent: {
              type,
              action: type === 'ci' ? 'failed' : 'succeeded',
              actor: 'octocat',
              title: type === 'ci' ? 'Beeline CI check suite' : 'Deployed to production',
              url: 'https://github.test/runs/9',
            },
          })}
          onOpenUrl={vi.fn()}
        />,
      );
      expect(renderer.toJSON()).toBeNull();
    }
  });

  it('renders one cell per PR with header summary, accordion, and per-cell navigation', () => {
    const onOpenCorner = vi.fn();
    const onOpenUrl = vi.fn();
    const items = [
      {
        id: 'corner',
        title: 'Duplicate draft settle',
        state: 'Merged' as const,
        kindLine: 'corner · PR #1126',
        cornerId: 'corner-1126',
        objective: 'Ship the accordion PR card design',
        actor: 'hoots',
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `pr-${index}`,
        title: `Change ${index}`,
        state: index === 3 ? ('Checks failed' as const) : ('Merged' as const),
        kindLine: `PR #${1130 + index}`,
        ...(index === 3
          ? { danger: true, url: `https://github.test/pr/${1130 + index}` as const }
          : {}),
      })),
    ];
    const renderer = render(
      <NotificationLifecycleCard
        message={message({
          notificationLifecycleRun: {
            headline: '4 merged, 1 failed',
            subline: 'by @sol, @octocat · 09:41 – 10:28',
            items,
          },
        })}
        onOpenCorner={onOpenCorner}
        onOpenUrl={onOpenUrl}
      />,
    );
    // (b) header summary counts unique PRs per state
    const json = () => JSON.stringify(renderer.toJSON());
    expect(json()).toContain('PR · 1 failed, 4 merged');
    expect(
      renderer.root.findByProps({ testID: 'notification-run-head-message' }).props.style,
    ).toMatchObject({ paddingVertical: 8 });

    // First item (most recently updated) is the presented cell
    expect(renderer.root.findByProps({ testID: 'notification-run-cell-corner' })).toBeDefined();
    // Presented cell has objective and author
    expect(json()).toContain('Ship the accordion PR card design');
    expect(json()).toContain('hoots');

    // (e) single-PR check: with 5 items, strip says "4 more ▾"
    expect(json()).toContain('4 more ▾');
    expect(json()).not.toContain('less ▴');

    // Navigation callbacks work for the initial presented cell: Corner → (has cornerId)
    act(() =>
      renderer.root.findByProps({ testID: 'notification-run-cell-corner-corner' }).props.onPress(),
    );
    expect(onOpenCorner).toHaveBeenCalledWith('corner-1126');

    // Tap expand strip to see contracted cells
    act(() =>
      renderer.root.findByProps({ testID: 'notification-run-expand-message' }).props.onPress(),
    );
    expect(json()).toContain('less ▴');
    expect(json()).not.toContain('4 more ▾');

    // (c) tapping a contracted cell presents it and contracts the previous
    const contractedPressed = renderer.root.findByProps({
      testID: 'notification-run-contracted-pr-3',
    });
    act(() => contractedPressed.props.onPress());
    // The previously presented cell is now contracted; pr-3 is presented
    expect(renderer.root.findByProps({ testID: 'notification-run-cell-pr-3' })).toBeDefined();

    // View ↗ for the new presented cell (pr-3 has url, no cornerId)
    act(() =>
      renderer.root.findByProps({ testID: 'notification-run-cell-url-pr-3' }).props.onPress(),
    );
    expect(onOpenUrl).toHaveBeenCalledWith('https://github.test/pr/1133');
  });

  it('renders a single issue on the lifecycle card, not a GitHubEventCard', () => {
    const renderer = render(
      <NotificationLifecycleCard
        message={message({
          notificationLifecycleRun: {
            headline: 'Issue 1 opened',
            subline: 'by @lin · 09:41 – 09:41',
            items: [
              {
                id: 'issue-1',
                title: 'Handle narrow screens',
                state: 'Opened',
                kindLine: 'issue',
                kind: 'issue',
                url: 'https://github.test/issues/17',
                actor: 'lin',
              },
            ],
          },
        })}
        onOpenCorner={() => undefined}
        onOpenUrl={vi.fn()}
      />,
    );
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Issue · 1 opened');
    expect(json).not.toContain('PR ·');
    expect(renderer.root.findByProps({ testID: 'notification-run-cell-issue-1' })).toBeDefined();
    expect(json).not.toContain(' more ▾');
  });

  it('renders an all-green check batch as one accordion card with header summary', () => {
    const renderer = render(
      <NotificationLifecycleCard
        message={message({
          notificationLifecycleRun: {
            headline: 'Check 2 passed',
            subline: '11:07 – 11:07',
            items: [
              {
                id: 'build',
                title: 'Build',
                state: 'Checks passed',
                kindLine: 'check',
                kind: 'check',
              },
              {
                id: 'lint',
                title: 'Lint',
                state: 'Checks passed',
                kindLine: 'check',
                kind: 'check',
              },
            ],
          },
        })}
        onOpenCorner={() => undefined}
        onOpenUrl={() => undefined}
      />,
    );
    const json = () => JSON.stringify(renderer.toJSON());
    expect(json()).toContain('Check · 2 passed');
    // The first item (Build) is the presented cell
    expect(renderer.root.findByProps({ testID: 'notification-run-cell-build' })).toBeDefined();
    // With 2 items, the expand strip shows "1 more ▾"
    expect(json()).toContain('1 more ▾');
    // Tap to expand and see Lint
    act(() =>
      renderer.root.findByProps({ testID: 'notification-run-expand-message' }).props.onPress(),
    );
    expect(renderer.root.findByProps({ testID: 'notification-run-contracted-lint' })).toBeDefined();
  });

  it('presents the most recently updated check item by recency order with header summary', () => {
    const renderer = render(
      <NotificationLifecycleCard
        message={message({
          notificationLifecycleRun: {
            headline: 'Check 2 passed, 1 failed',
            subline: '11:07 – 11:08',
            items: [
              {
                id: 'build',
                title: 'Build',
                state: 'Checks passed',
                kindLine: 'check',
                kind: 'check',
              },
              {
                id: 'lint',
                title: 'Lint',
                state: 'Checks failed',
                kindLine: 'check',
                kind: 'check',
                danger: true,
              },
              {
                id: 'test',
                title: 'Test',
                state: 'Checks passed',
                kindLine: 'check',
                kind: 'check',
              },
            ],
          },
        })}
        onOpenCorner={() => undefined}
        onOpenUrl={() => undefined}
      />,
    );
    const json = JSON.stringify(renderer.toJSON());
    // Header counts unique PRs per state: 1 failed, 2 passed
    expect(json).toContain('Check · 1 failed, 2 passed');
    // First item (Build) is presented, not folded away
    expect(json).toContain('Build');
    // Lint (Checks failed) is contracted, visible after expand
    expect(json).not.toContain('Lint');
    expect(json).not.toContain('Test');
  });

  it('makes the internal corner action primary and the external PR action secondary', () => {
    const onOpenCorner = vi.fn();
    const onOpenUrl = vi.fn();
    const renderer = render(
      <DaemonFactCard
        message={message({
          authorIdentity: {
            pubkey: 'agent',
            kind: 'agent',
            name: 'Beebee',
            handle: 'beebee',
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
    const primaryAction = renderer.root.findByProps({
      testID: 'corner-summary-card-primary-action',
    });
    expect(primaryAction.props.accessibilityLabel).toBe('Corner →');
    act(() => primaryAction.props.onPress());
    expect(onOpenCorner).toHaveBeenCalledWith('80a5a6f1-fb5a-493b-93eb-f3db33f696e6');
    const secondaryAction = renderer.root.findByProps({
      testID: 'corner-summary-card-secondary-action',
    });
    expect(secondaryAction.props.accessibilityLabel).toBe('View ↗');
    act(() => secondaryAction.props.onPress());
    expect(onOpenUrl).toHaveBeenCalledWith('https://github.com/acme/beeline/pull/42');
    expect(renderer.root.findAllByType('HullSurface')).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'corner-summary-card' })).toBeDefined();
    // A legacy card carries no name, so the title is the first three words of
    // its objective; the body still carries the objective whole (C89).
    expect(JSON.stringify(renderer.toJSON())).toContain('PR 1 merged');
    // The landed card names the corner AUTHOR, not the Room reviewer — the
    // reviewer is a per-Room setting, so it carries no per-card information.
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('corner · by ');
    expect(json).toContain('@beebee');
    expect(json).not.toContain('@echo');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Awaiting @echo');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Approved by @echo');
    expect(JSON.stringify(renderer.toJSON())).toContain('Ship fact cards');
    expect(JSON.stringify(renderer.toJSON())).toContain('View ↗');
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

  it.each([
    { type: 'corner-complete' as const, outcome: 'abandoned' as const },
    { type: 'worktree-cleaned' as const, outcome: undefined },
  ])('keeps a $type corner navigable after it closes without a pull request', (fact) => {
    const onOpenCorner = vi.fn();
    const renderer = render(
      <DaemonFactCard
        message={message({
          daemonFact: {
            type: fact.type,
            cornerId: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
            name: 'flaky auth',
            objective: 'Fix the flaky auth test',
            outcome: fact.outcome,
          },
        })}
        onOpenCorner={onOpenCorner}
        onOpenUrl={() => undefined}
      />,
    );
    expect(JSON.stringify(renderer.toJSON())).toContain('closed');
    const action = renderer.root.findByProps({
      testID: `daemon-fact-card-${fact.type}-primary-action`,
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('Corner →');
    act(() => action.props.onPress());
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
    expect(JSON.stringify(renderer.toJSON())).toContain('corner · opened by ');
    expect(JSON.stringify(renderer.toJSON())).toContain('@Beebee');
    expect(texts).toContain('Fix the flaky auth test');
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

  it('shows copy, reply, react, and forward actions on desktop', () => {
    const onReply = vi.fn();
    const onCopy = vi.fn();
    const onReact = vi.fn();
    const onForward = vi.fn();
    const row = message({ id: 'desktop-reply' });
    const renderer = render(
      <OrdinaryLedgerMessage
        message={row}
        desktopLayout
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onReply={onReply}
        onCopy={onCopy}
        onReact={onReact}
        onForward={onForward}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const copy = renderer.root.findByProps({ testID: 'copy-button-desktop-reply' });
    expect(copy.props.accessibilityLabel).toBe('Copy message text');
    act(() => copy.props.onPress());
    expect(onCopy).toHaveBeenCalledWith(row.text);

    const reply = renderer.root.findByProps({ testID: 'reply-button-desktop-reply' });
    expect(reply.props.accessibilityLabel).toBe('Reply to message');
    act(() => reply.props.onPress());
    expect(onReply).toHaveBeenCalledWith(row);

    const react = renderer.root.findByProps({ testID: 'react-button-desktop-reply' });
    expect(react.props.accessibilityLabel).toBe('React to message');
    act(() => react.props.onPress());
    const laugh = renderer.root.findByProps({ testID: 'reaction-choice-desktop-reply-😂' });
    act(() => laugh.props.onPress());
    expect(onReact).toHaveBeenCalledWith(row, '😂');

    const forward = renderer.root.findByProps({ testID: 'forward-button-desktop-reply' });
    expect(forward.props.accessibilityLabel).toBe('Forward message');
    act(() => forward.props.onPress());
    expect(onForward).toHaveBeenCalledWith(row);
  });

  it('shows the original poster beside the source Room on a forwarded message', () => {
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({
          id: 'forwarded',
          text: '> ship it\n\nFORWARDED FROM #general · @alice',
        })}
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

    expect(renderer.root.findByProps({ testID: 'forward-caption-forwarded' }).props.children).toBe(
      'FORWARDED FROM #general · @alice',
    );
    expect(ledgerEntryRender.mock.lastCall?.[0].bodyText).toBe('> ship it');
  });

  it('renders reaction chips on mobile and toggles the viewer reaction', () => {
    const onReact = vi.fn();
    const row = message({
      id: 'reacted',
      reactions: [
        {
          emoji: '👍',
          count: 2,
          reacted: true,
          members: [
            { pubkey: 'one', kind: 'human', name: 'One' },
            { pubkey: 'two', kind: 'agent', name: 'Two' },
          ],
        },
      ],
    });
    const renderer = render(
      <OrdinaryLedgerMessage
        message={row}
        desktopLayout={false}
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
        onReact={onReact}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const chip = renderer.root.findByType('MessageReactionRoster' as any);
    expect(chip.props.reaction.reacted).toBe(true);
    act(() => chip.props.onReact());
    expect(onReact).toHaveBeenCalledWith(row, '👍');
  });

  it.each([
    ['mobile', false],
    ['desktop', true],
  ] as const)(
    'centers reaction chips in the existing message gap on %s',
    (_surface, desktopLayout) => {
      const row = message({
        id: `reaction-spacing-${_surface}`,
        reactions: [{ emoji: '👍', count: 1, reacted: false }],
      });
      const renderer = render(
        <OrdinaryLedgerMessage
          message={row}
          desktopLayout={desktopLayout}
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
          onReact={vi.fn()}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );

      const reactionChips = renderer.root.findByProps({ testID: `reaction-chips-${row.id}` });
      expect(reactionChips.props.style).toMatchObject({ marginTop: 3, marginBottom: 3 });
      expect(reactionChips.props.style.marginTop + reactionChips.props.style.marginBottom).toBe(6);
    },
  );

  it('uses the phone swipe interaction on compact web', () => {
    const onReply = vi.fn();
    const row = message({ id: 'compact-web-reply' });
    const renderer = render(
      <OrdinaryLedgerMessage
        message={row}
        desktopLayout={false}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onReply={onReply}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const swipeable = renderer.root.findByType('Swipeable');
    act(() => swipeable.props.onSwipeableOpen('right'));
    expect(onReply).toHaveBeenCalledWith(row);
    expect(renderer.root.findAllByProps({ testID: 'reply-button-compact-web-reply' })).toHaveLength(
      0,
    );
  });

  it('adds Open and Cancel to an exact agent corner proposal without replacing reply swipe', () => {
    const onDecision = vi.fn();
    const onReply = vi.fn();
    const proposal = message({
      id: 'corner-proposal',
      text: 'Proposed corner: Faster reads — Bound query latency under load',
      pubkey: 'agent-sol',
      isAgentAuthor: true,
    });
    const renderer = render(
      <OrdinaryLedgerMessage
        message={proposal}
        agent={{ pubkey: 'agent-sol', displayName: 'Sol' }}
        desktopLayout={false}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onCornerProposalDecision={onDecision}
        onReply={onReply}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    act(() =>
      renderer.root.findByProps({ testID: 'corner-proposal-open-corner-proposal' }).props.onPress(),
    );
    expect(onDecision).toHaveBeenCalledWith(proposal, 'open');
    act(() =>
      renderer.root
        .findByProps({ testID: 'corner-proposal-cancel-corner-proposal' })
        .props.onPress(),
    );
    expect(onDecision).toHaveBeenCalledWith(proposal, 'cancel');

    const swipe = renderer.root.findByProps({ testID: 'swipe-reply-corner-proposal' });
    act(() => swipe.props.onSwipeableOpen('right'));
    expect(onReply).toHaveBeenCalledWith(proposal);
  });

  it('does not add corner actions to an agent message that only quotes the proposal syntax', () => {
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({
          id: 'quoted-proposal',
          text: 'Try replying with “Proposed corner: Faster reads — Bound latency”.',
          pubkey: 'agent-sol',
          isAgentAuthor: true,
        })}
        agent={{ pubkey: 'agent-sol', displayName: 'Sol' }}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onCornerProposalDecision={vi.fn()}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      renderer.root.findAllByProps({ testID: 'corner-proposal-actions-quoted-proposal' }),
    ).toHaveLength(0);
  });

  it('uses the same reply swipe for corner narration and tool-call activity', () => {
    const onNarrationReply = vi.fn();
    const narration = message({
      id: 'corner-narration',
      text: '',
      pubkey: 'agent-sol',
      isAgentAuthor: true,
      isAgentActivity: true,
      requestId: 'turn-sol',
      activity: [{ kind: 'output', title: 'Output', text: 'The deploy needs one more check.' }],
    });
    const tool = message({
      id: 'corner-tool',
      text: '',
      pubkey: 'agent-sol',
      isAgentAuthor: true,
      isAgentActivity: true,
      requestId: 'turn-sol',
      activity: [{ kind: 'tool', title: 'Run tests', command: 'npm test', status: 'completed' }],
    });
    const props = {
      desktopLayout: false,
      participantsHydrated: true,
      viewerPubkey: 'viewer',
      speakerWorking: false,
      continued: false,
      participantHandles: [],
      channelIndex: { rooms: [], corners: [] },
      deliveryFailed: false,
      onChannelReference: vi.fn(),
      onCopy: vi.fn(),
      onRetry: vi.fn(),
      onDismiss: vi.fn(),
    } as const;
    const narrationRow = render(
      <OrdinaryLedgerMessage {...props} message={narration} onReply={onNarrationReply} />,
    );
    const narrationSwipe = narrationRow.root.findByProps({
      testID: 'swipe-reply-corner-narration',
    });
    act(() => narrationSwipe.props.onSwipeableOpen('right'));
    expect(onNarrationReply).toHaveBeenCalledWith(narration);

    const onToolReply = vi.fn();
    const toolRow = render(
      <OrdinaryLedgerMessage {...props} message={tool} onReply={onToolReply} />,
    );
    const toolSwipe = toolRow.root.findByProps({ testID: 'swipe-reply-corner-tool' });
    act(() => toolSwipe.props.onSwipeableOpen('right'));
    expect(onToolReply).toHaveBeenCalledWith(tool);
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

  it('opens a live image attachment in the full-screen artifact viewer on mobile', () => {
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
    const card = render(
      React.createElement(React.Fragment, null, ledgerEntryRender.mock.lastCall?.[0].attachments),
    );
    const open = card.root.findByProps({ testID: 'chat-attachment-receipt.png' });
    expect(open.props.accessibilityRole).toBe('button');
    const longPressEvent = { stopPropagation: vi.fn() };
    act(() => open.props.onLongPress(longPressEvent));
    expect(longPressEvent.stopPropagation).toHaveBeenCalled();
    expect(pictureActions.showPictureActions).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'receipt.png' }),
    );
    act(() => open.props.onPress());
    expect(modal.show).toHaveBeenCalledWith({
      component: expect.any(Function),
      props: {
        attachment: expect.objectContaining({
          name: 'receipt.png',
          mimeType: 'image/png',
        }),
      },
      placement: 'fill',
    });
    expect(openExternal.openExternalUrl).not.toHaveBeenCalled();
  });

  it('opens a desktop picture message in the work pane and exposes its context menu', () => {
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
            },
          ],
        })}
        personName="Ada"
        desktopLayout
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
    const card = render(
      React.createElement(React.Fragment, null, ledgerEntryRender.mock.lastCall?.[0].attachments),
    );
    const open = card.root.findByProps({ testID: 'chat-attachment-receipt.png' });
    expect(open.props.accessibilityRole).toBe('button');
    const contextEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    act(() => open.props.onContextMenu(contextEvent));
    expect(contextEvent.preventDefault).toHaveBeenCalled();
    expect(contextEvent.stopPropagation).toHaveBeenCalled();
    expect(pictureActions.showPictureActions).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'receipt.png' }),
    );
    act(() => open.props.onPress());
    expect(desktopArtifactPane.openArtifactInDesktopWorkPane).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: expect.objectContaining({ name: 'receipt.png' }),
      }),
    );
    expect(openExternal.openExternalUrl).not.toHaveBeenCalled();
    expect(modal.show).not.toHaveBeenCalled();
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

  it('never lifts a live draft into settled narration (C108 duplicate)', () => {
    const props = {
      agent: { pubkey: 'agent', displayName: 'ECHO' },
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
    // Reported twice from a phone: one unfinished sentence printed twice under
    // one byline, the upright copy reading as the agent's answer. A row with no
    // activity of its own has its `text` lifted into an `output` item, and
    // `buildTurnActivity` renders an `output` as narration — the settled tier —
    // while the same words also went out through `messageDraft`.
    const draft = render(
      <OrdinaryLedgerMessage
        {...props}
        message={message({
          id: 'live-turn:agent:request-9',
          pubkey: 'agent',
          isAgentAuthor: true,
          isAgentActivity: true,
          isAgentDraft: true,
          isAgentLiveTurn: true,
          text: 'Codex gets the review request when the',
          agentMessageDraft: 'Codex gets the review request when the',
        })}
      />,
    );
    const lane = draft.root.findByType('ActivityTimeline').props;
    expect(lane.items).toEqual([]);
    expect(lane.messageDraft).toBe('Codex gets the review request when the');

    // An ordinary settled activity row still shows its prose.
    const settled = render(
      <OrdinaryLedgerMessage
        {...props}
        message={message({
          id: 'corner-output',
          pubkey: 'agent',
          isAgentAuthor: true,
          isAgentActivity: true,
          text: 'The fix is ready.',
        })}
      />,
    );
    expect(settled.root.findByType('ActivityTimeline').props.items).toEqual([
      { kind: 'output', title: 'Output', text: 'The fix is ready.' },
    ]);
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
        activeTurnPubkey: agentPubkey,
        now: 1,
        conversationIdentities: conversationIdentityByPubkey([], [currentIdentityMessage]),
      }),
    ).toEqual({ label: 'CODEX thinking…' });
  });

  it('renders an announcements-only System message full-width without an avatar or reply gesture', () => {
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({
          authorIdentity: {
            pubkey: 's'.repeat(64),
            kind: 'human',
            name: 'System',
            handle: 'system',
          },
          pubkey: 's'.repeat(64),
          text: 'Beeline release v1.2.3 is out!',
        })}
        announcementFeed
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

    expect(renderer.root.findAllByProps({ testID: 'swipe-reply-message' })).toHaveLength(0);
    expect(ledgerEntryRender).toHaveBeenCalledWith(
      expect.objectContaining({
        byline: expect.objectContaining({ name: 'System' }),
        luminous: false,
        typewriter: false,
      }),
    );
    expect(ledgerEntryRender.mock.calls[0]?.[0].byline.mark).toBeUndefined();
  });

  it('keeps an agent avatar and name byline on a consecutive message', () => {
    const consecutive = message({
      id: 'lumen-second-message',
      text: 'Yeah, exactly-we gotta open a corner before touching the repo...',
      pubkey: 'agent-lumen',
      isAgentAuthor: true,
      authorIdentity: {
        pubkey: 'agent-lumen',
        kind: 'agent',
        name: 'Lumen',
        handle: 'lumen',
        face: 'owl',
      },
    });

    render(
      <OrdinaryLedgerMessage
        message={consecutive}
        agent={{ pubkey: 'agent-lumen', displayName: 'Lumen' }}
        agentModel="  openrouter/deepseek-deepseek-v.4.1-flash  "
        continued
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        participantHandles={[{ pubkey: 'agent-lumen', handle: 'lumen' }]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(ledgerEntryRender.mock.lastCall?.[0].byline).toMatchObject({
      name: 'Lumen',
      role: 'openrouter/deepseek-deepseek-v.4.1-flash',
      mark: { seed: 'agent-lumen', kind: 'agent', face: 'owl' },
    });
  });

  it('keeps a human continuation compact', () => {
    render(
      <OrdinaryLedgerMessage
        message={message({ id: 'ada-second-message', pubkey: 'ada', timestamp: 2 })}
        immediatelyPrecedingMessage={message({
          id: 'ada-first-message',
          pubkey: 'ada',
          timestamp: 1,
        })}
        continued
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
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

    expect(ledgerEntryRender.mock.lastCall?.[0].byline).toBeUndefined();
  });

  it.each([false, true])('dates the first byline with preceding notice: %s', (afterNotice) => {
    const thu1658 = Math.floor(new Date(2026, 8, 17, 16, 58).getTime() / 1000);
    const thu1702 = Math.floor(new Date(2026, 8, 17, 17, 2).getTime() / 1000);
    const first = render(
      <OrdinaryLedgerMessage
        message={message({ id: 'thu-first', isUser: true, timestamp: thu1658 })}
        firstBylineOfDay
        immediatelyPrecedingMessage={
          afterNotice
            ? message({ id: 'notice', timestamp: thu1658 - 60, isSystemNotice: true })
            : undefined
        }
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={true}
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
    expect(first.root.findByType('LedgerSteer' as never).props.byline.stamp).toBe('17 SEP 16:58');
    expect(first.root.findByType('LedgerSteer' as never).props.precededByDayCaption).toBe(
      !afterNotice,
    );

    const later = render(
      <OrdinaryLedgerMessage
        firstBylineOfDay={false}
        message={message({ id: 'thu-later', isUser: true, timestamp: thu1702 })}
        immediatelyPrecedingMessage={message({
          id: 'intervening-notice',
          isSystemNotice: true,
          isUser: true,
          timestamp: thu1658,
        })}
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
    expect(later.root.findByType('LedgerSteer' as never).props.byline.stamp).toBe('17 SEP 17:02');
    expect(later.root.findByType('LedgerSteer' as never).props.precededByDayCaption).toBe(false);
  });

  it.each([
    ['midnight', false],
    ['midnight', true],
    ['resume', false],
    ['resume', true],
  ] as const)('refreshes the first byline on %s (desktop: %s)', (trigger, desktopLayout) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 19, 23, 59, 59));
    const timestamp = new Date(2026, 8, 19, 20, 46).getTime() / 1000;
    const row = (id: string, firstBylineOfDay: boolean) =>
      render(
        <OrdinaryLedgerMessage
          message={message({ id, isUser: true, timestamp })}
          firstBylineOfDay={firstBylineOfDay}
          desktopLayout={desktopLayout}
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
    const first = row('first', true);
    const later = row('later', false);
    const stamp = (tree: ReactTestRenderer) =>
      tree.root.findByType('LedgerSteer' as never).props.byline.stamp;
    expect(stamp(first)).toBe('20:46');
    expect(stamp(later)).toBe('20:46');
    expect(vi.getTimerCount()).toBe(2);
    if (trigger === 'midnight') {
      act(() => vi.advanceTimersByTime(1000));
    } else {
      act(() => appStateListeners.forEach((listener) => listener('background')));
      expect(vi.getTimerCount()).toBe(0);
      vi.setSystemTime(new Date(2026, 8, 20, 8));
      act(() => appStateListeners.forEach((listener) => listener('active')));
    }
    expect(stamp(first)).toBe('19 SEP 20:46');
    expect(stamp(later)).toBe('19 SEP 20:46');
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      first.unmount();
      later.unmount();
    });
    expect(appStateListeners.size).toBe(0);
  });

  it('keeps today’s first byline on the clock', () => {
    const now = Date.now();
    const today = Math.floor(now / 1000) - 120;
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({ id: 'today-first', isUser: true, timestamp: today })}
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
    const stamp = renderer.root.findByType('LedgerSteer' as never).props.byline.stamp as string;
    expect(stamp).toMatch(/^[0-2]\d:[0-5]\d$/);
    expect(stamp).not.toMatch(/SEP|JAN|TODAY|YESTERDAY/i);
  });

  it('renders a complete agent JSON object as a fenced JSON block', () => {
    const json = '{\n    "answer": {\n        "value": 42\n    }\n}';
    render(
      <OrdinaryLedgerMessage
        message={message({
          id: 'agent-json',
          text: json,
          pubkey: 'agent',
          isAgentAuthor: true,
        })}
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

    expect(ledgerEntryRender.mock.lastCall?.[0].bodyText).toBe(`\`\`\`json\n${json}\n\`\`\``);
  });

  it('does not change a human-authored JSON object', () => {
    const json = '{"answer":42}';
    render(
      <OrdinaryLedgerMessage
        message={message({ id: 'human-json', text: json, pubkey: 'human' })}
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

    expect(ledgerEntryRender.mock.lastCall?.[0].bodyText).toBe(json);
  });

  it('highlights every person an agent tagged, exactly as it does a human-authored tag', () => {
    const rowProps = {
      agent: { pubkey: 'agent', displayName: 'GREETER' },
      participantsHydrated: true,
      viewerPubkey: 'viewer',
      speakerWorking: false,
      continued: false,
      participantHandles: [
        { pubkey: 'captain', handle: 'lunchboxfortwo' },
        { pubkey: 'peer', handle: 'bananaman614305' },
      ],
      channelIndex: { rooms: [], corners: [] },
      deliveryFailed: false,
      onChannelReference: vi.fn(),
      onReply: vi.fn(),
      onCopy: vi.fn(),
      onRetry: vi.fn(),
      onDismiss: vi.fn(),
    } as const;
    const text = '@lunchboxfortwo here is where things stand.\n@bananaman614305 you are up next.';

    render(
      <OrdinaryLedgerMessage
        {...rowProps}
        message={message({
          id: 'agent-tags-two',
          text,
          pubkey: 'agent',
          isAgentAuthor: true,
          mentionPubkeys: ['captain', 'peer'],
        })}
      />,
    );
    const agentAuthored = ledgerEntryRender.mock.lastCall?.[0].mentionHandles;

    render(
      <OrdinaryLedgerMessage
        {...rowProps}
        message={message({
          id: 'human-tags-two',
          text,
          pubkey: 'scribe',
          mentionPubkeys: ['captain', 'peer'],
        })}
      />,
    );

    // The renderer reads the server-derived tag list and nothing about the
    // author, so a tag an
    // agent wrote is highlighted exactly like one a person wrote — and BOTH
    // tags survive, which is the whole point of dropping the server's
    // one-human-mention cap.
    expect(agentAuthored).toEqual(['lunchboxfortwo', 'bananaman614305']);
    expect(ledgerEntryRender.mock.lastCall?.[0].mentionHandles).toEqual(agentAuthored);
  });

  it('highlights a literal @channel token by its own reserved handle, sent as one tag never expanded into names', () => {
    render(
      <OrdinaryLedgerMessage
        message={message({
          text: '@channel heads up, ship is live',
          pubkey: 'speaker',
          // The server tags every human it expands to; the SENT TEXT still
          // carries the single literal token, never the expanded names.
          mentionPubkeys: ['bee-id', 'carl-id'],
        })}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[
          { pubkey: 'bee-id', handle: 'bee' },
          { pubkey: 'carl-id', handle: 'carl' },
        ]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onMention={vi.fn()}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(ledgerEntryRender.mock.lastCall?.[0].mentionHandles).toEqual(
      expect.arrayContaining(['bee', 'carl', 'channel']),
    );
  });

  it('maps a pressed resolved mention back to the tagged member identity', () => {
    const onMention = vi.fn();
    render(
      <OrdinaryLedgerMessage
        message={message({
          text: 'Ask @BeeBee for the result',
          pubkey: 'speaker',
          mentionPubkeys: ['member-id'],
        })}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[{ pubkey: 'member-id', handle: 'beebee' }]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onMention={onMention}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    act(() => ledgerEntryRender.mock.lastCall?.[0].onMention('beebee'));
    expect(onMention).toHaveBeenCalledWith('member-id');
  });

  it('highlights the viewing member while leaving their self-mention inert', () => {
    const onMention = vi.fn();
    render(
      <OrdinaryLedgerMessage
        message={message({
          text: 'Note to @viewer',
          pubkey: 'speaker',
          mentionPubkeys: ['viewer'],
        })}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[{ pubkey: 'viewer', handle: 'viewer' }]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onMention={onMention}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(ledgerEntryRender.mock.lastCall?.[0].mentionHandles).toEqual(['viewer']);
    act(() => ledgerEntryRender.mock.lastCall?.[0].onMention('viewer'));
    expect(onMention).not.toHaveBeenCalled();
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
    expect(JSON.stringify(ownerView.toJSON())).toContain('asks you');
    expect(ownerView.root.findByProps({ testID: 'grant-g-1-ask' }).props.children).toBe(
      'run fly deploy -a beeline-preview --with FLY_TOKEN · to publish the preview build',
    );
    expect(ownerView.root.findByProps({ testID: 'grant-g-2-ask' }).props.children).toBe(
      'reach api.fly.io · to reach the Fly API',
    );
    expect(JSON.stringify(ownerView.toJSON())).toContain('No');
    expect(JSON.stringify(ownerView.toJSON())).toContain('Once');
    expect(JSON.stringify(ownerView.toJSON())).toContain('Always');
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
    expect(manager.root.findByProps({ testID: 'grant-g-1-always' })).toBeDefined();
    expect(manager.root.findByProps({ testID: 'grant-g-2-always' })).toBeDefined();

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
    expect(outsider.root.findAllByProps({ testID: 'grant-g-1-always' })).toHaveLength(0);
    expect(JSON.stringify(outsider.toJSON())).toContain('waiting for @Charles');

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
    expect(settled.root.findAllByProps({ testID: 'grant-g-1-always' })).toHaveLength(0);
    expect(settled.root.findByProps({ testID: 'grant-request-settled' })).toBeDefined();
    expect(settled.root.findByProps({ testID: 'grant-g-1-outcome' }).props.children).toBe(
      'allowed once',
    );
    expect(settled.root.findByProps({ testID: 'grant-g-2-outcome' }).props.children).toBe('denied');
  });

  describe('connector-offer card (R5)', () => {
    const agent = { pubkey: 'otter', kind: 'agent' as const, name: 'Otter', handle: 'otter' };
    const zeke = { pubkey: 'zeke', kind: 'human' as const, name: 'Zeke', handle: 'zeke' };
    const consequence =
      'This changes your Workbench. Once it is added, I can provision keys into its vault and use them from there — still no raw key in chat.';
    const pending = message({
      connectorOffer: {
        offerId: 'offer-1',
        agent,
        addressee: zeke,
        connectorType: 'trusty-squire',
        connectorName: 'Trusty Squire',
        reason: 'to provision the 1inch API key into its vault',
        consequence,
        helper: { machineId: 'machine-otter', name: 'Otter' },
        status: 'pending',
        createdAt: 1,
      },
    });

    it('asks the question once, states consequence + boundary in one server-owned line, and offers ONE affirmative action to the addressee', () => {
      const onAccept = vi.fn();
      const card = render(
        <ConnectorOfferCard
          message={pending}
          viewerIsAgent={false}
          viewerPubkey="zeke"
          viewerRole="member"
          actionId={null}
          onAccept={onAccept}
          onOpenWorkbench={vi.fn()}
        />,
      );
      const json = JSON.stringify(card.toJSON());
      expect(card.root.findByProps({ testID: 'connector-offer-pending' })).toBeDefined();
      expect(json).toContain('Add Trusty Squire as a tool?');
      // ONE subtitle: the server-owned consequence + boundary, including the
      // agent's reason. Not a second line of agent prose.
      expect(card.root.findByProps({ testID: 'connector-offer-offer-1-line' }).props.children).toBe(
        consequence,
      );
      expect(json).toContain('still no raw key in chat');
      expect(json).not.toContain('to provision the 1inch API key into its vault');
      // One action, with the check glyph; no menu, no second button.
      const accept = card.root.findByProps({ testID: 'connector-offer-offer-1-accept' });
      expect(accept.props.accessibilityLabel).toBe('✓ Add Trusty Squire');
      const actionLabels = card.root
        .findAllByType('Pressable')
        .filter((node: ReactTestInstance) => node.props.accessibilityLabel !== undefined)
        .map((node: ReactTestInstance) => node.props.accessibilityLabel);
      expect(actionLabels).toEqual(['✓ Add Trusty Squire']);
      expect(
        card.root.findAllByProps({ testID: 'connector-offer-offer-1-workbench' }),
      ).toHaveLength(0);
      act(() => accept.props.onPress());
      expect(onAccept).toHaveBeenCalledWith('offer-1', 'trusty-squire');
    });

    it('keeps an in-progress ceremony resumable without claiming the tool was added', () => {
      const onContinue = vi.fn();
      const connecting = render(
        <ConnectorOfferCard
          message={message({
            connectorOffer: {
              ...pending.connectorOffer!,
              status: 'connecting',
              acceptedBy: zeke,
              acceptedAt: 1_756_900_030,
              connectorId: 'connector-row-1',
            },
          })}
          viewerIsAgent={false}
          viewerPubkey="zeke"
          viewerRole="member"
          actionId={null}
          onAccept={vi.fn()}
          onContinue={onContinue}
          onOpenWorkbench={vi.fn()}
        />,
      );
      expect(connecting.root.findByProps({ testID: 'connector-offer-connecting' })).toBeDefined();
      expect(
        connecting.root.findByProps({ testID: 'connector-offer-offer-1-connecting' }).props
          .children,
      ).toBe('connecting for @zeke');
      expect(
        connecting.root.findAllByProps({ testID: 'connector-offer-offer-1-accept' }),
      ).toHaveLength(0);
      const resume = connecting.root.findByProps({
        testID: 'connector-offer-offer-1-continue',
      });
      act(() => resume.props.onPress());
      expect(onContinue).toHaveBeenCalledWith('offer-1', 'trusty-squire', 'connector-row-1');
    });

    it('lets a Workspace manager who is not the addressee accept (Q4)', () => {
      const card = render(
        <ConnectorOfferCard
          message={pending}
          viewerIsAgent={false}
          viewerPubkey="mara"
          viewerRole="admin"
          actionId={null}
          onAccept={vi.fn()}
          onOpenWorkbench={vi.fn()}
        />,
      );
      expect(card.root.findByProps({ testID: 'connector-offer-offer-1-accept' })).toBeDefined();
    });

    it('gives a bystander no action and names who it waits for; an agent viewer never acts', () => {
      const bystander = render(
        <ConnectorOfferCard
          message={pending}
          viewerIsAgent={false}
          viewerPubkey="bystander"
          viewerRole="member"
          actionId={null}
          onAccept={vi.fn()}
          onOpenWorkbench={vi.fn()}
        />,
      );
      expect(
        bystander.root.findAllByProps({ testID: 'connector-offer-offer-1-accept' }),
      ).toHaveLength(0);
      expect(
        bystander.root.findByProps({ testID: 'connector-offer-offer-1-waiting' }).props.children,
      ).toBe('waiting for @zeke');

      const agentViewer = render(
        <ConnectorOfferCard
          message={pending}
          viewerIsAgent
          viewerPubkey="zeke"
          viewerRole="owner"
          actionId={null}
          onAccept={vi.fn()}
          onOpenWorkbench={vi.fn()}
        />,
      );
      expect(
        agentViewer.root.findAllByProps({ testID: 'connector-offer-offer-1-accept' }),
      ).toHaveLength(0);
    });

    it('settles in place naming WHO acted, with the Manage in Workbench door and no action left', () => {
      const onOpenWorkbench = vi.fn();
      const mara = { pubkey: 'mara', kind: 'human' as const, name: 'Mara', handle: 'mara' };
      const settled = render(
        <ConnectorOfferCard
          message={message({
            connectorOffer: {
              ...pending.connectorOffer!,
              status: 'accepted',
              acceptedBy: mara,
              acceptedAt: 1_756_900_060,
              connectorId: 'connector-row-1',
            },
          })}
          viewerIsAgent={false}
          viewerPubkey="zeke"
          viewerRole="member"
          actionId={null}
          onAccept={vi.fn()}
          onOpenWorkbench={onOpenWorkbench}
        />,
      );
      expect(settled.root.findByProps({ testID: 'connector-offer-settled' })).toBeDefined();
      expect(
        settled.root.findAllByProps({ testID: 'connector-offer-offer-1-accept' }),
      ).toHaveLength(0);
      // The record names the actor — a manager, not the addressee — because a
      // Room has many possible tappers where the reference product had one.
      const outcome = settled.root.findByProps({ testID: 'connector-offer-offer-1-outcome' }).props
        .children as string;
      expect(outcome).toMatch(/^added by @mara · \d{1,2}:\d{2}/);
      const door = settled.root.findByProps({ testID: 'connector-offer-offer-1-workbench' });
      expect(door.props.accessibilityRole).toBe('link');
      act(() => door.props.onPress());
      expect(onOpenWorkbench).toHaveBeenCalledTimes(1);
    });

    it('is mounted by the one Room renderItem branch beside the grant card, with the accept operation and Workbench door wired', () => {
      expect(conversationSource).toContain('if (item.connectorOffer) {');
      expect(conversationSource).toContain(
        "monolithPhoneOperation('acceptConnectorOffer', { offerId })",
      );
      expect(conversationSource).toContain('openConnectorOfferCeremony');
      expect(conversationSource).toContain("pathname: '/beeline/settings/workbench'");
    });
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
    const texts = body
      .findAllByType('Text')
      .map((node: { props: { children: unknown } }) => node.props.children);
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

  it('paints choice options as plates with Skip in the footer, never TranscriptCard rows', () => {
    const onAnswer = vi.fn();
    const onSkip = vi.fn();
    const open = message({
      choice: {
        choiceId: 'c-1',
        mode: 'question',
        status: 'open',
        agent: { pubkey: 'agent', kind: 'agent', name: 'Foxy' },
        prompt: 'How do you want to push the desk past this?',
        constraint: 'CDP AgentKit needs JWT signing.',
        options: [
          {
            optionId: 'A',
            letter: 'A',
            label: 'Kraken paper',
            consequence: 'Works with plugin auth',
          },
          {
            optionId: 'B',
            letter: 'B',
            label: 'Keep waiting',
            consequence: 'Blocked on CDP JWT',
            costly: true,
          },
        ],
        electorate: ['human'],
        votedCount: 0,
        electorateCount: 1,
        responses: [],
      },
    });
    const renderer = render(
      <ChoiceCard
        message={open}
        viewerIsAgent={false}
        viewerPubkey="human"
        actionId={null}
        onAnswer={onAnswer}
        onSkip={onSkip}
      />,
    );
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('How do you want to push the desk past this?');
    expect(json).toContain('Kraken paper');
    expect(json).toContain('Skip');
    expect(renderer.root.findAllByProps({ testID: 'transcript-card-row-A' })).toHaveLength(0);
    act(() => renderer.root.findByProps({ testID: 'transcript-card-choice-A' }).props.onPress());
    expect(onAnswer).toHaveBeenCalledWith('c-1', 'A');
    act(() => renderer.root.findByProps({ testID: 'choice-c-1-skip' }).props.onPress());
    expect(onSkip).toHaveBeenCalledWith('c-1');
  });

  it('shows a still tally wash on a closed poll and no Skip', () => {
    const renderer = render(
      <ChoiceCard
        message={message({
          choice: {
            choiceId: 'c-2',
            mode: 'poll',
            status: 'closed',
            agent: { pubkey: 'agent', kind: 'agent', name: 'Foxy' },
            prompt: 'Which paper API?',
            options: [
              {
                optionId: 'A',
                letter: 'A',
                label: 'Kraken paper',
                consequence: 'Works with plugin auth',
                votes: 2,
                share: 1,
                leader: true,
              },
              {
                optionId: 'B',
                letter: 'B',
                label: 'Keep waiting',
                consequence: 'Blocked on CDP JWT',
                votes: 1,
                share: 0.5,
              },
            ],
            electorate: ['human', 'member'],
            votedCount: 3,
            electorateCount: 4,
            responses: [
              { identityId: 'human', optionId: 'A' },
              { identityId: 'member', optionId: 'B' },
            ],
            outcome: 'winner',
            footer: 'closed · 3 of 4 voted',
          },
        })}
        viewerIsAgent={false}
        viewerPubkey="human"
        actionId={null}
        onAnswer={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('closed · 3 of 4 voted');
    expect(json).not.toContain('Skip');
    expect(
      renderer.root.findByProps({ testID: 'transcript-card-choice-wash-A' }).props.style,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ width: '100%' })]));
    expect(
      renderer.root.findByProps({ testID: 'transcript-card-choice-wash-B' }).props.style,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ width: '50%' })]));
    expect(
      renderer.root.findByProps({ testID: 'transcript-card-choice-count-A' }).props.children,
    ).toBe(2);
  });

  it('opens the message actions sheet on long press while retaining tap dismissal', () => {
    // The row's long press is the message actions sheet — reactions, copy,
    // reply, forward — which deliberately claims what native text selection
    // once held here; Copy on the sheet is the way to the full text now.
    // The compact row still observes touch end for composer dismissal.
    const onTapOutsideComposer = vi.fn();
    const onCopy = vi.fn();
    const onMessageActions = vi.fn();
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({ id: 'tapped', text: 'a settled line' })}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onTapOutsideComposer={onTapOutsideComposer}
        onReply={vi.fn()}
        onCopy={onCopy}
        onMessageActions={onMessageActions}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const row = renderer.root.findByProps({ testID: 'copy-message-tapped' });
    expect(row.props.onTouchEnd).toBeTypeOf('function');
    expect(row.props.onLongPress).toBeTypeOf('function');
    act(() => row.props.onTouchEnd());
    expect(onTapOutsideComposer).toHaveBeenCalledTimes(1);
    act(() => row.props.onLongPress());
    expect(onMessageActions).toHaveBeenCalledTimes(1);
    expect(onMessageActions.mock.calls[0][0].id).toBe('tapped');
    expect(onCopy).not.toHaveBeenCalled();
  });

  it('keeps the desktop long press as the copy shortcut', () => {
    const onCopy = vi.fn();
    const onMessageActions = vi.fn();
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({ id: 'dsk', text: 'a settled line' })}
        desktopLayout
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed={false}
        onChannelReference={vi.fn()}
        onReply={vi.fn()}
        onCopy={onCopy}
        onMessageActions={onMessageActions}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const row = renderer.root.findByProps({ testID: 'copy-message-dsk' });
    act(() => row.props.onLongPress());
    expect(onCopy).toHaveBeenCalledWith('a settled line');
    expect(onMessageActions).not.toHaveBeenCalled();
  });
});

describe('relay hand-offs', () => {
  it.each(['down', 'up'] as const)(
    'renders %s without a speaker bubble, collapsed with an in-place toggle',
    (direction) => {
      const renderer = render(
        <RelayHandOff
          message={message({
            text: 'Long relay',
            isUser: true,
            isAgentAuthor: true,
            pubkey: 'sol',
            authorIdentity: { pubkey: 'sol', kind: 'agent', name: 'Sol', handle: 'sol' },
            relay: {
              direction,
              fromRoomId: 'room',
              toRoomId: 'corner',
              cornerId: 'corner',
              fromName: 'beeline',
              received: true,
            },
          })}
        />,
      );
      expect(ledgerEntryRender).not.toHaveBeenCalled();
      expect(JSON.stringify(renderer.toJSON())).toContain(
        direction === 'down' ? 'FROM #beeline' : 'FROM THE CORNER · beeline',
      );
      expect(renderer.root.findByProps({ testID: 'relay-text-message' }).props.numberOfLines).toBe(
        2,
      );
      expect(renderer.root.findAllByProps({ testID: 'relay-toggle-message' })).toHaveLength(0);
      act(() =>
        renderer.root
          .findByProps({ testID: 'relay-measure-message' })
          .props.onTextLayout({ nativeEvent: { lines: [{}, {}, {}] } }),
      );
      act(() => renderer.root.findByProps({ testID: 'relay-toggle-message' }).props.onPress());
      expect(
        renderer.root.findByProps({ testID: 'relay-text-message' }).props.numberOfLines,
      ).toBeUndefined();
      act(() => renderer.root.findByProps({ testID: 'relay-toggle-message' }).props.onPress());
      expect(renderer.root.findByProps({ testID: 'relay-text-message' }).props.numberOfLines).toBe(
        2,
      );
      act(() =>
        renderer.root
          .findByProps({ testID: 'relay-measure-message' })
          .props.onTextLayout({ nativeEvent: { lines: [{}] } }),
      );
      expect(renderer.root.findAllByProps({ testID: 'relay-toggle-message' })).toHaveLength(0);
    },
  );
});

describe('Connector receipt cards', () => {
  const receiptMessage = (text: string): ChatDisplayMessage =>
    message({ id: 'connector-receipt', text });

  const renderReceipt = (text: string) => {
    const row = receiptMessage(text);
    return render(
      <OrdinaryLedgerMessage
        message={row}
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
        onReact={vi.fn()}
        onForward={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
  };

  it('renders a receipt DM from a connector identity as prose plus the receipt card', () => {
    const renderer = renderReceipt(
      'Vercel deploy finished.\n' +
        'receipt: Vercel · deploy · via Trusty Squire on squire-box · grant hoots · 2 calls · 2.1 kB',
    );
    const card = renderer.root.findByProps({ testID: 'connector-receipt-card' });
    expect(card).toBeDefined();
    const summary = (
      renderer.root.findAllByProps({ testID: 'connector-receipt-summary' })[0] as any
    ).props.children as string;
    expect(summary).toBe('Vercel · deploy · squire-box · grant hoots · 2 calls · 2.1 kB');
    // The receipt line itself never double-prints as ledger prose.
    const ledgerProps = ledgerEntryRender.mock.lastCall?.[0];
    expect(ledgerProps.bodyText).toBe('Vercel deploy finished.');
  });

  it('renders an ordinary message with no receipt line untouched', () => {
    const renderer = renderReceipt('Just a normal ledger entry.');
    expect(renderer.root.findAllByProps({ testID: 'connector-receipt-card' })).toHaveLength(0);
    expect(ledgerEntryRender.mock.lastCall?.[0].bodyText).toBe('Just a normal ledger entry.');
  });
});
