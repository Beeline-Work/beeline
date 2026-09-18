import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const phoneOperation = vi.hoisted(() => vi.fn());
const modalConfirm = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    FlatList: (props: any) =>
      ReactModule.createElement(
        'FlatList',
        props,
        props.ListHeaderComponent,
        ...(props.data ?? []).map((item: any, index: number) =>
          ReactModule.createElement(
            ReactModule.Fragment,
            { key: props.keyExtractor(item, index) },
            props.renderItem({ item, index }),
          ),
        ),
        props.ListFooterComponent,
      ),
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Platform: { OS: 'web' },
    Pressable: host('Pressable'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

const theme = vi.hoisted(() => ({
  colors: {
    groupped: { background: '#14091a' },
    divider: '#333',
    text: '#fff',
    textSecondary: '#aaa',
    textLink: '#b08a4a',
    surface: '#190e21',
  },
  buzz: {
    accent: '#b08a4a',
    radius: 3,
    type: { hero: {}, body: {}, bodyStrong: {}, meta: {}, machine: {}, sectionHead: {} },
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) => (typeof factory === 'function' ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/TurnProgressLine', async () => {
  const ReactModule = await import('react');
  return { TurnProgressLine: (props: any) => ReactModule.createElement('TurnProgressLine', props) };
});
vi.mock('@/components/buzz/ConversationComposer', async () => {
  const ReactModule = await import('react');
  return {
    COMPOSER_SINGLE_LINE_INPUT_HEIGHT: 26,
    COMPOSER_MAX_INPUT_HEIGHT: 115,
    ConversationComposer: (props: any) => ReactModule.createElement('ConversationComposer', props),
  };
});
vi.mock('@/components/buzz/HullActionSheet', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullActionSheetCancel: host('HullActionSheetCancel'),
    HullActionSheetModal: host('HullActionSheetModal'),
    HullActionSheetRow: host('HullActionSheetRow'),
  };
});
vi.mock('@/components/buzz/Ledger', async () => {
  const ReactModule = await import('react');
  return {
    LedgerRoomUpdate: (props: any) => ReactModule.createElement('LedgerRoomUpdate', props),
    LedgerSystemLine: (props: any) => ReactModule.createElement('LedgerSystemLine', props),
  };
});
vi.mock('@/app/(app)/beeline/chat/RoomMessageVariants', async () => {
  const ReactModule = await import('react');
  return {
    DaemonFactCard: (props: any) => ReactModule.createElement('DaemonFactCard', props),
    GitHubEventCard: (props: any) => ReactModule.createElement('GitHubEventCard', props),
    OrdinaryLedgerMessage: (props: any) =>
      ReactModule.createElement('OrdinaryLedgerMessage', props),
  };
});
vi.mock('@/components/buzz/DesktopArtifactPane', async () => {
  const ReactModule = await import('react');
  return {
    DesktopArtifactPane: (props: any) => ReactModule.createElement('DesktopArtifactPane', props),
  };
});
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: vi.fn() }));
vi.mock('@/sync/transport', () => ({ BuzzRigTransport: class {} }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/modal', () => ({ Modal: { confirm: modalConfirm } }));
vi.mock('@/buzz/desktop-workbench-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/buzz/desktop-workbench-state')>()),
  loadDesktopPaneWidth: vi.fn(async () => 400),
  saveDesktopPaneWidth: vi.fn(async () => undefined),
}));

import {
  clearDesktopArtifactPane,
  openArtifactInDesktopWorkPane,
} from '@/buzz/desktop-artifact-pane';
import { DesktopRoomInspector } from './DesktopRoomInspector';

const agent = {
  pubkey: 'agent-1',
  kind: 'agent' as const,
  name: 'Codex',
  handle: 'codex',
  face: 'fox',
};
const person = {
  pubkey: 'person-1',
  kind: 'human' as const,
  name: 'Avery',
  handle: 'avery',
  face: 'moth',
};
const corners = [
  {
    corner: {
      id: 'working',
      workspaceId: 'workspace',
      name: 'Fix fixture',
      about: 'Repair the complete boundary fixture without truncating this objective.',
      archived: false,
      createdAt: 1,
      updatedAt: 2,
    },
    lifecycle: { lifecycle: 'active', checks: 'unknown' },
    state: 'working',
    stateAt: 2,
    agent,
  },
  {
    corner: {
      id: 'review',
      workspaceId: 'workspace',
      name: 'Fast postflop',
      about: 'Finish the production vector core and parity tests.',
      archived: false,
      createdAt: 1,
      updatedAt: 3,
    },
    lifecycle: { lifecycle: 'in-review', checks: 'passing' },
    state: 'review',
    stateAt: 3,
    agent,
  },
  {
    corner: {
      id: 'done',
      workspaceId: 'workspace',
      name: 'Done work',
      about: 'Already landed.',
      archived: true,
      createdAt: 1,
      updatedAt: 4,
    },
    lifecycle: { lifecycle: 'done', checks: 'passing' },
    state: 'archived',
    stateAt: 4,
    agent,
  },
] as any;

function room() {
  return {
    room: {
      id: 'room',
      workspaceId: 'workspace',
      name: 'CloverGTO',
      archived: false,
      createdAt: 1,
      updatedAt: 4,
      reviewerAgentId: agent.pubkey,
    },
    members: [
      { identity: person, role: 'owner' },
      { identity: agent, role: 'member' },
    ],
    messages: [],
    latestAgentTurns: [],
    corners,
    viewer: { identity: person, role: 'owner', permissions: { send: true, manage: true } },
    repositoryResolution: 'none',
    watchFilters: [],
  } as any;
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    room: room(),
    client: null,
    selectedCornerId: null,
    onSelectCorner: vi.fn(),
    onOpenInMain: vi.fn(),
    onClose: vi.fn(),
    onNewCorner: vi.fn(),
    onOpenRoster: vi.fn(),
    ...overrides,
  } as React.ComponentProps<typeof DesktopRoomInspector>;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  phoneOperation.mockReset();
  modalConfirm.mockReset();
});

function render(options = props()): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<DesktopRoomInspector {...options} />);
  });
  return tree;
}

function text(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType('Text' as any)
    .flatMap((node: any) => node.props.children)
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('DesktopRoomInspector work pane', () => {
  it('renders the multi-corner overview with full objectives and one concluded row', () => {
    const tree = render();
    const copy = text(tree);
    expect(copy).toContain(
      'Repair the complete boundary fixture without truncating this objective.',
    );
    expect(copy).toContain('review ›');
    expect(copy).toContain('archived · 1');
    expect(copy).toContain('1 people · 1 agents');
    expect(copy).toContain('@codex');
    expect(copy).not.toMatch(/BRANCH|CHECKS|PR #/);
  });

  it('marks the corner the viewer opened with gold ME text, not an identity bubble', () => {
    const ownRoom = room();
    ownRoom.corners = [{ ...corners[0], agent: person }, corners[1]];
    const tree = render(props({ room: ownRoom }));
    const meMark = tree.root.findByProps({ testID: 'desktop-work-corner-me-working' });
    expect(meMark.props.children).toBe('ME');
    const ownRow = tree.root.findByProps({ testID: 'desktop-work-corner-working' });
    expect(ownRow.findAllByType('IdentityMark' as any)).toHaveLength(0);
    const otherRow = tree.root.findByProps({ testID: 'desktop-work-corner-review' });
    const otherSeeds = otherRow
      .findAllByType('IdentityMark' as any)
      .map((node: any) => node.props.seed);
    expect(otherSeeds).toContain(agent.pubkey);
  });

  it('shows only corner titles beneath the parent Room in the overview', () => {
    const prefixedRoom = room();
    prefixedRoom.corners = [
      {
        ...corners[0],
        corner: { ...corners[0].corner, name: '#CloverGTO/Fix fixture' },
      },
    ];
    const copy = text(render(props({ room: prefixedRoom })));
    expect(copy).toContain('Fix fixture');
    expect(copy).not.toContain('#CloverGTO/Fix fixture');
  });

  it('presents an artifact opened while the pane was away, so the press never lands silently', async () => {
    clearDesktopArtifactPane();
    const attachment = {
      id: 'artifact-1',
      name: 'board.html',
      mimeType: 'text/html',
      size: 12,
      url: '/v1/media/artifact-1',
    } as any;
    // The press landed while the pane was dismissed: only the module event fired.
    openArtifactInDesktopWorkPane({ attachment, authorHandle: 'goosy' });
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<DesktopRoomInspector {...props()} />);
    });
    // The pane comes back showing the artifact, not the silent overview.
    const panes = tree.root.findAllByType('DesktopArtifactPane' as any);
    expect(panes).toHaveLength(1);
    expect(panes[0]!.props.attachment).toBe(attachment);
    expect(panes[0]!.props.authorHandle).toBe('goosy');
    // Closing hands the pane back to its overview.
    await act(async () => {
      panes[0]!.props.onClose();
    });
    expect(tree.root.findAllByType('DesktopArtifactPane' as any)).toHaveLength(0);
    expect(text(tree)).toContain('CORNERS');
    clearDesktopArtifactPane();
  });

  it('renders dispatchable workflows and confirms the name and default branch before running', async () => {
    phoneOperation
      .mockResolvedValueOnce({
        defaultBranch: 'main',
        workflows: [
          {
            name: 'Release',
            lastRunAt: Math.floor(Date.now() / 1000) - 300,
            conclusion: 'success',
          },
          {
            name: 'Nightly',
            lastRunAt: Math.floor(Date.now() / 1000) - 3600,
            conclusion: 'failure',
          },
        ],
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ defaultBranch: 'main', workflows: [] });
    modalConfirm.mockResolvedValueOnce(true);
    const repositoryRoom = {
      ...room(),
      repositoryResolution: 'repository',
      repository: { fullName: 'acme/beeline', defaultBranch: 'main' },
    } as any;
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<DesktopRoomInspector {...props({ room: repositoryRoom })} />);
    });

    expect(text(tree)).toContain('WORKFLOWS');
    expect(text(tree)).toContain('Release');
    expect(text(tree)).toContain('success');
    expect(text(tree)).toContain('Run ›');
    await act(async () => {
      tree.root.findByProps({ testID: 'desktop-work-workflow-Release' }).props.onPress();
    });
    expect(modalConfirm).toHaveBeenCalledWith('Run Release?', 'Run Release on main?', {
      cancelText: 'Cancel',
      confirmText: 'Run',
    });
    expect(phoneOperation).toHaveBeenNthCalledWith(2, 'dispatchRoomWorkflow', {
      roomId: 'room',
      workflowName: 'Release',
    });
  });

  it.each(['member', 'owner', 'admin'] as const)(
    'shares corner stop authority for a %s',
    async (role) => {
      const detail = {
        ...room(),
        room: corners[0].corner,
        viewer: { ...room().viewer, role },
        latestAgentTurns: [
          {
            agentPubkey: agent.pubkey,
            requestId: 'turn-1',
            requestedBy: 'another-person',
            status: 'working',
            createdAt: Date.now() / 1000,
          },
        ],
      };
      const client = { room: vi.fn(async () => detail) } as any;
      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = create(<DesktopRoomInspector {...props({ client, selectedCornerId: 'working' })} />);
      });
      const composer = tree.root.findByType('ConversationComposer' as any);
      const progress = tree.root.findByType('TurnProgressLine' as any);
      expect(Boolean(composer.props.onStop)).toBe(role !== 'member');
      expect(Boolean(progress.props.onStop)).toBe(role !== 'member');
      if (role !== 'member') {
        await act(async () => {
          await composer.props.onStop();
        });
        expect(phoneOperation).toHaveBeenCalledWith('cancelAgentTurn', {
          roomId: 'working',
          requestId: 'turn-1',
          agentId: agent.pubkey,
        });
      }
      act(() => tree.unmount());
    },
  );

  it('opens a corner cockpit with exactly the open-in-main and close header controls', async () => {
    const onOpenInMain = vi.fn();
    const onClose = vi.fn();
    const detail = {
      ...room(),
      room: corners[0].corner,
      parent: room().room,
      messages: [
        { id: 'm1', text: 'Working on it.', createdAt: 5, author: agent, presentation: 'message' },
      ],
    } as any;
    const client = { room: vi.fn(async () => detail) } as any;
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <DesktopRoomInspector
          {...props({ client, selectedCornerId: 'working', onOpenInMain, onClose })}
        />,
      );
    });
    expect(tree.root.findByProps({ testID: 'desktop-work-cockpit' })).toBeTruthy();
    expect(text(tree)).toContain(
      'Repair the complete boundary fixture without truncating this objective.',
    );
    expect(tree.root.findByProps({ testID: 'desktop-work-corner-transcript' })).toBeTruthy();
    expect(tree.root.findByType('ConversationComposer' as any).props.placeholder).toBeUndefined();
    const header = tree.root.findByProps({ testID: 'desktop-work-cockpit-header' });
    const buttons = header.findAllByType('Pressable' as any);
    expect(buttons.map((button: any) => button.props.accessibilityLabel)).toEqual([
      'Open in the main pane',
      'Close work pane',
    ]);
    expect(header.findAllByType('span' as any).map((tooltip: any) => tooltip.props.title)).toEqual([
      'Open in the main pane',
      'Close work pane',
    ]);
    act(() => buttons[0].props.onPress());
    act(() => buttons[1].props.onPress());
    expect(onOpenInMain).toHaveBeenCalledWith('working');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(() => tree.root.findByProps({ accessibilityLabel: 'Back to work overview' })).toThrow();
  });
});
