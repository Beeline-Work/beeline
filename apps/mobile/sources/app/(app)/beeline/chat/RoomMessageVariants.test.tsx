
vi.mock('@/components/buzz/ArtifactMedia', async () => {
  const R = await import('react');
  return { ArtifactImage: (props: Record<string, unknown>) => R.createElement('Image', props) };
});
vi.mock('@/auth/signin-funnel', () => ({ funnelOnboarding: vi.fn(async () => undefined) }));
import { observeArtifactRows, setArtifactViewportActive } from '@/buzz/artifact-viewport';

import { ledgerStamp } from '@/buzz/relative-time';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';
vi.mock('@expo/vector-icons', async () => {
  const R = await import('react');
  return { Ionicons: (props: any) => R.createElement('Ionicons', props) };
});
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'Light' },
  impactAsync: async () => undefined,
}));
vi.mock('react-native-keyboard-controller', async () => {
  const R = await import('react');
  return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) };
});
import * as React from 'react';
import { readFileSync } from 'node:fs';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversationIdentityByPubkey,
  type ChatDisplayMessage,
} from '@/buzz/room-view-presentation';
import {
  archiveActionPresentation,
  liveCardPresentation,
  useRoomMessageRenderItem,
} from '@/buzz/room-message-cell';
import { selectComposerAckPresentation } from '@/buzz/room-indicators';
import { formatForwardedMessage } from '@/buzz/message-forward';
import { beginReplyTarget } from '@/buzz/message-reply';
import { resetProvisionalDrafts } from '@/buzz/draft-settle';
import { ALIVE_RING_PAD } from '@/buzz/identity-mark';
import { beelineThemes } from '@/buzz/groknight';
import { Platform } from 'react-native';
import { openArtifactViewer } from '@/components/buzz/ArtifactCard';
import { openComputerSessionViewer } from '@/components/buzz/ComputerSession';
import { publishViewerConversation, removeViewerConversation } from '@/buzz/viewer-conversation';

const swipeMotion = vi.hoisted(() => ({ close: vi.fn(), reset: vi.fn() }));
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

// Test renderer has no document body; browser regression covers the real portal.
vi.mock('@/components/buzz/DesktopWorkspacePortal', () => ({
  DesktopWorkspacePortal: ({ children }: { children: React.ReactNode }) => children,
}));

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
        stopAnimation: vi.fn(),
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
    StyleSheet: {
      flatten: (style: any): any =>
        Array.isArray(style)
          ? Object.assign(
              {},
              ...style.map((part: any) =>
                Array.isArray(part) ? Object.assign({}, ...part) : part,
              ),
            )
          : style,
    },
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
    TextInput: host('TextInput'),
    View: host('View'),
  };
});

vi.mock('@/components/buzz/TranscriptSwipeable', async () => {
  const ReactModule = await import('react');
  return {
    default: ReactModule.forwardRef((props: any, ref: any) => {
      ReactModule.useImperativeHandle(ref, () => swipeMotion);
      return ReactModule.createElement('Swipeable', props, props.children);
    }),
  };
});

vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  const theme = {
    buzz:
      process.env.BEELINE_OUTBOX_TEST_THEME === 'bone'
        ? beelineThemes.bone
        : beelineThemes.obsidian,
  };
  return {
    StyleSheet: {
      create: (
        factory: (value: {
          buzz: typeof beelineThemes.obsidian | typeof beelineThemes.bone;
        }) => unknown,
      ) => factory(theme),
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
  return {
    ArtifactCard: (props: any) => ReactModule.createElement('ArtifactCard', props),
    openArtifactViewer: vi.fn(),
  };
});
vi.mock('@/components/buzz/ComputerSession', () => ({ openComputerSessionViewer: vi.fn() }));
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
vi.mock('@/components/buzz/CornerGlyph', async () => {
  const ReactModule = await import('react');
  return {
    CORNER_META_SIZE: 13,
    CornerGlyph: (props: any) => ReactModule.createElement('CornerGlyph', props),
  };
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
    NewMessageMaterialize: (props: any) =>
      ReactModule.createElement('NewMessageMaterialize', props, props.children),
  };
});
vi.mock('@/components/buzz/Button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: any) => ReactModule.createElement('Button', props, props.children) };
});
vi.mock('@/components/buzz/Ledger', async () => {
  const ReactModule = await import('react');
  return {
    LedgerEntry: (props: any) => {
      ledgerEntryRender(props);
      return ReactModule.createElement('LedgerEntry', props);
    },
    LedgerGhostLine: (props: any) => ReactModule.createElement('LedgerGhostLine', props),
    LedgerUntaggedHint: (props: any) => ReactModule.createElement('LedgerUntaggedHint', props),
    LedgerSystemLine: (props: any) => ReactModule.createElement('LedgerSystemLine', props),
    LedgerSteer: (props: any) => ReactModule.createElement('LedgerSteer', props),
    withLedgerDayCaption: (node: unknown, label: string | null) =>
      label
        ? ReactModule.createElement('day-caption-wrap', { label }, node as React.ReactNode)
        : node,
  };
});

import {
  GitHubEventCard,
  NotificationLifecycleCard,
  DaemonFactCard,
  GrantRequestCard,
  SquireApprovalCard,
  ConnectorOfferCard,
  AppSignInCard,
  ConnectorReceiptCard,
  ChoiceCard,
  agentBylineLabel,
  agentCommandTranscriptMessage,
  OrdinaryLedgerMessage,
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
  return {
    id: 'message',
    text: 'hello',
    isUser: false,
    timestamp: 1,
    ...(overrides.agentCommand
      ? {}
      : {
          reference: {
            channelId: 'room-proof',
            eventId: overrides.id ?? 'message',
            rootId: overrides.id ?? 'message',
          },
        }),
    ...overrides,
  };
}

describe('Event disclosure v2', () => {
  it('starts collapsed, expands every event, opens its destinations and collapses again', () => {
    const onOpenCorner = vi.fn();
    const onOpenUrl = vi.fn();
    const item = message({
      notificationLifecycleRun: {
        subline: '',
        items: [
          {
            id: 'merge',
            title: 'Readable transcript',
            state: 'Merged',
            kind: 'pull-request',
            kindLine: 'PR #42',
            cornerId: 'corner-42',
            url: 'https://github.com/acme/repo/pull/42',
            actor: 'ruby',
            updatedBy: 'merge',
          },
          {
            id: 'issue',
            title: 'Issue title',
            state: 'Filed',
            kind: 'issue',
            kindLine: 'Issue #5',
            url: 'https://github.com/acme/repo/issues/5',
            actor: 'ruby',
            updatedBy: 'issue',
          },
        ],
      },
    });
    const renderer = render(
      <NotificationLifecycleCard
        message={item}
        onOpenCorner={onOpenCorner}
        onOpenUrl={onOpenUrl}
      />,
    );
    const toggle = () => renderer.root.findByProps({ testID: 'notification-run-expand-message' });
    expect(toggle().props.accessibilityState).toEqual({ expanded: false });
    expect(toggle().props.accessibilityLabel).toBe('1 PR merged · 1 issue filed');
    expect(renderer.root.findAllByProps({ testID: 'notification-run-cell-merge' })).toHaveLength(0);
    act(() => toggle().props.onPress());
    expect(toggle().props.accessibilityState).toEqual({ expanded: true });
    act(() =>
      renderer.root.findByProps({ testID: 'notification-run-cell-corner-merge' }).props.onPress(),
    );
    act(() =>
      renderer.root.findByProps({ testID: 'notification-run-cell-url-merge' }).props.onPress(),
    );
    act(() =>
      renderer.root.findByProps({ testID: 'notification-run-cell-url-issue' }).props.onPress(),
    );
    expect(onOpenCorner).toHaveBeenCalledWith('corner-42');
    expect(onOpenUrl.mock.calls).toEqual([['https://github.com/acme/repo/issues/5']]);
    expect(onOpenCorner).toHaveBeenCalledTimes(2);
    act(() => toggle().props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'notification-run-cell-merge' })).toHaveLength(0);
  });
});

describe('Workbench identities', () => {
  it('describes a standing Wallet grant without an end date', () => {
    const renderer = render(
      <WalletCards message={message({ walletDelegation: { standing: true } })} stamp="12:00" />,
    );
    const subline = renderer.root.findByProps({ testID: 'wallet-delegation-subline' });
    expect(subline.props.children).toBe('Stands until revoked');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Until ');
  });
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



describe('Connector receipt cards', () => {
  const receiptMessage = (text: string): ChatDisplayMessage =>
    message({ id: 'connector-receipt', text });

  const renderReceipt = (text: string, systemAuthor = false) => {
    const row = receiptMessage(text);
    if (systemAuthor) {
      row.pubkey = SYSTEM_IDENTITY_PUBKEY;
      row.authorIdentity = { pubkey: SYSTEM_IDENTITY_PUBKEY, kind: 'human', name: 'System' };
    }
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

  it('preserves a working receipt card beside the System author fallback', () => {
    const renderer = renderReceipt('Deployment finished.\nreceipt: Vercel · deploy', true);
    expect(renderer.root.findByProps({ testID: 'connector-receipt-card' })).toBeDefined();
    expect(renderer.root.findByType('LedgerSystemLine' as never).props.text).toBe(
      'Deployment finished.',
    );
  });

  it('uses the connector identity logo in its receipt card', () => {
    const row = receiptMessage('receipt: Vercel · deploy · via Trusty Squire on squire-box');
    row.authorIdentity = {
      pubkey: 'squire-id',
      kind: 'human',
      name: 'Trusty Squire',
      avatar: 'https://api.example.test/v1/connectors/logo/trusty-squire.svg',
    };
    const renderer = render(
      <ConnectorReceiptCard
        receipt={{
          connection: 'Vercel',
          operation: 'deploy',
          helper: 'squire-box',
        }}
        identity={row.authorIdentity}
      />,
    );
    expect(renderer.root.findByProps({ testID: 'connector-receipt-logo' }).props.avatarUrl).toBe(
      row.authorIdentity.avatar,
    );
  });

  it('renders an ordinary message with no receipt line untouched', () => {
    const renderer = renderReceipt('Just a normal ledger entry.');
    expect(renderer.root.findAllByProps({ testID: 'connector-receipt-card' })).toHaveLength(0);
    expect(ledgerEntryRender.mock.lastCall?.[0].bodyText).toBe('Just a normal ledger entry.');
  });
});

it.each([true, false])(
  'SEND-PAINT-1: new message entrance is disabled for the sender (%s)',
  (isUser) => {
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({ id: 'new-message', text: 'Hello Room', isNew: true, isUser })}
        participantsHydrated
        viewerPubkey="viewer"
        deliveryFailed={false}
        speakerWorking={false}
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        onChannelReference={vi.fn()}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(renderer.root.findByType('NewMessageMaterialize' as any).props.enabled).toBe(!isUser);
  },
);

describe('private untagged message hint', () => {
  it.each([
    ['sender', 'viewer', true, false, undefined, 1],
    ['second account', 'observer', true, false, undefined, 0],
    ['history without local send', 'viewer', false, false, undefined, 0],
    ['failed send', 'viewer', true, true, undefined, 0],
    ['agent author', 'viewer', true, false, 'agent', 0],
  ] as const)('%s', (_, viewerPubkey, untaggedHint, deliveryFailed, kind, count) => {
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({
          id: 'local-send',
          text: 'Hello Room',
          isUser: true,
          pubkey: 'viewer',
          ...(kind ? { authorIdentity: { pubkey: 'viewer', kind, name: 'Agent' } } : {}),
        })}
        participantsHydrated
        viewerPubkey={viewerPubkey}
        speakerWorking={false}
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        untaggedHint={untaggedHint}
        deliveryFailed={deliveryFailed}
        onChannelReference={vi.fn()}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(renderer.root.findAllByType('LedgerUntaggedHint' as any)).toHaveLength(count);
  });
});

it('links a corner-local PR notice to the current corner when the note has no corner field', () => {
  const onOpenCorner = vi.fn();
  const item = message({
    notificationLifecycleRun: {
      subline: '',
      items: [
        {
          id: 'local-pr',
          title: 'Change',
          kind: 'pull-request',
          kindLine: 'PR #42',
          state: 'PR opened',
          actor: 'ruby',
          updatedBy: 'local-pr',
          url: 'https://github.com/acme/repo/pull/42',
        },
      ],
    },
  });
  const renderer = render(
    <NotificationLifecycleCard
      message={item}
      cornerId="current-corner"
      onOpenCorner={onOpenCorner}
      onOpenUrl={() => undefined}
    />,
  );
  expect(renderer.root.findAllByProps({ testID: 'notification-run-expand-message' })).toHaveLength(
    0,
  );
  act(() =>
    renderer.root.findByProps({ testID: 'notification-run-cell-corner-local-pr' }).props.onPress(),
  );
  expect(onOpenCorner).toHaveBeenCalledWith('current-corner');
});

it('opens a corner check from its whole row without a corner link back to the same corner', () => {
  const onOpenCorner = vi.fn();
  const onOpenUrl = vi.fn();
  const checks = ['PROMPT CASES', 'README PARITY'].map((title, index) => ({
    id: `check-${index}`,
    title,
    kind: 'check' as const,
    kindLine: 'Check',
    state: index ? 'Checks running' : 'Checks passed',
    actor: 'github',
    updatedBy: `check-${index}`,
    url: `https://github.com/acme/repo/commit/${'b'.repeat(40)}/checks`,
    ...(index ? { cornerId: 'current-corner' } : {}),
  }));
  const item = message({ notificationLifecycleRun: { subline: '', items: checks } });
  const renderer = render(
    <NotificationLifecycleCard
      message={item}
      cornerId="current-corner"
      onOpenCorner={onOpenCorner}
      onOpenUrl={onOpenUrl}
    />,
  );
  act(() =>
    renderer.root.findByProps({ testID: 'notification-run-expand-message' }).props.onPress(),
  );
  const words = JSON.stringify(renderer.toJSON());
  expect(words).not.toContain('Corner →');
  expect(words).not.toContain('Check →');
  expect(
    renderer.root.findAll((node: any) =>
      String(node.props.testID).startsWith('notification-run-cell-corner-'),
    ),
  ).toHaveLength(0);
  act(() =>
    renderer.root.findByProps({ testID: 'notification-run-cell-url-check-1' }).props.onPress(),
  );
  expect(onOpenUrl).toHaveBeenCalledWith(checks[1].url);
  expect(onOpenCorner).not.toHaveBeenCalled();
});

it('opens a standalone corner PR event in its corner', () => {
  const onOpenCorner = vi.fn(),
    onOpenUrl = vi.fn();
  const renderer = render(
    <GitHubEventCard
      message={message({
        githubEvent: {
          type: 'pull-request',
          action: 'merged',
          actor: 'ruby',
          title: 'Work',
          url: 'https://github.com/acme/repo/pull/42',
          cornerId: 'corner-42',
        },
      })}
      onOpenCorner={onOpenCorner}
      onOpenUrl={onOpenUrl}
    />,
  );
  act(() =>
    renderer.root.findByProps({ testID: 'notification-run-cell-url-message' }).props.onPress(),
  );
  expect(onOpenCorner).toHaveBeenCalledWith('corner-42');
  expect(onOpenUrl).not.toHaveBeenCalled();
});

describe('Reproduction R2 rendered outbox path', () => {
  it('renders an offline send exactly like a sent message, then the one-off offline state, and sends once after reconnect', async () => {
    vi.useFakeTimers();
    const { MessageOutbox } = await import('@/buzz/message-outbox');
    const e = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: 9,
      sig: '',
      content: 'Start with the server PR',
      tags: [
        ['h', 'room-proof'],
        ['monolith-attachments', '[]'],
        ['monolith-mentions', '[]'],
      ],
    };
    const send = vi.fn(async () => ({ messageId: e.id }));
    const owner = new MessageOutbox({
      load: async () => [],
      save: async () => undefined,
      send,
      rejection: () => undefined,
    });
    await owner.enqueue(e, {
      id: e.id,
      text: e.content,
      createdAt: 1,
      author: { pubkey: e.pubkey, kind: 'human', name: 'Kai' },
      presentation: 'message',
    });
    const props = {
      message: message({ id: e.id, text: e.content, isUser: true, pubkey: e.pubkey }),
      participantsHydrated: true,
      viewerPubkey: e.pubkey,
      speakerWorking: false,
      continued: false,
      participantHandles: [],
      channelIndex: { rooms: [], corners: [] },
      deliveryFailed: false,
      onChannelReference: vi.fn(),
      onReply: vi.fn(),
      onCopy: vi.fn(),
      onDismiss: vi.fn(),
    } satisfies OrdinaryLedgerMessageProps;
    const sent = JSON.stringify(render(<OrdinaryLedgerMessage {...props} />).toJSON());
    expect(owner.state(e.id)?.kind).toBe('sending');
    const renderer = render(<OrdinaryLedgerMessage {...props} sendState={owner.state(e.id)} />);
    const text = (value: any): string =>
      Array.isArray(value)
        ? value.map(text).join('')
        : typeof value === 'string'
          ? value
          : value?.props
            ? text(value.props.children)
            : '';
    expect(
      renderer.root.findAll((node: any) => String(node.props.testID).startsWith('outbox-')),
    ).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Sending');
    // Same tree, same text style as a message the server already stored.
    expect(JSON.stringify(renderer.toJSON())).toBe(sent);
    expect(send).not.toHaveBeenCalled();
    console.log('R2 rendered while offline: same as sent; no Sending line; no popup; no Retry');
    await vi.advanceTimersByTimeAsync(120_000);
    act(() => renderer.update(<OrdinaryLedgerMessage {...props} sendState={owner.state(e.id)} />));
    expect(
      renderer.root.findAllByType('Text' as never).map((node: any) => text(node.props.children)),
    ).toContain('Not sent yet · no connection');
    expect(renderer.root.findAllByProps({ label: 'Retry' })).toHaveLength(0);
    console.log('R2 rendered after offline cutoff: Not sent yet · no connection; Dismiss');
    await owner.connectionChanged(true);
    act(() => renderer.update(<OrdinaryLedgerMessage {...props} sendState={owner.state(e.id)} />));
    expect(
      renderer.root.findAll((node: any) => String(node.props.testID).startsWith('outbox-')),
    ).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toBe(sent);
    expect(send).toHaveBeenCalledTimes(1);
    expect(modal.alert).not.toHaveBeenCalled();
    console.log('R2 rendered after reconnect: sent; status removed; one publication');
    owner.dispose();
  });

  it('renders the server refusal and only Dismiss', () => {
    const renderer = render(
      <OrdinaryLedgerMessage
        message={message({ id: 'refused', text: 'Start with the server PR', isUser: true })}
        participantsHydrated
        viewerPubkey="viewer"
        speakerWorking={false}
        continued={false}
        participantHandles={[]}
        channelIndex={{ rooms: [], corners: [] }}
        deliveryFailed
        sendState={{ kind: 'refused', text: 'Not sent · The relay did not allow this message.' }}
        onChannelReference={vi.fn()}
        onReply={vi.fn()}
        onCopy={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const banner = renderer.root.findByProps({ testID: 'outbox-delivery-failed-refused' });
    expect(banner.props.title).toBe('Not sent · The relay did not allow this message.');
    expect(renderer.root.findAllByProps({ label: 'Retry' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ label: 'Dismiss' }).length).toBeGreaterThan(0);
    expect(modal.alert).not.toHaveBeenCalled();
    console.log(
      'R2 rendered refusal: Not sent · The relay did not allow this message.; Dismiss; no Retry; no popup',
    );
  });
});
