import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'bzi_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const IDENTITY = { publicKey: 'person-1', secretKey: new Uint8Array(32) };

const HttpError = vi.hoisted(
  () =>
    class RoomViewHttpError extends Error {
      readonly status: number;
      readonly code: string;
      constructor(status: number, code: string) {
        super(`Room view request failed (${status} ${code})`);
        this.name = 'RoomViewHttpError';
        this.status = status;
        this.code = code;
      }
    },
);
const controls = vi.hoisted(() => ({
  invite: vi.fn(),
  workspaces: vi.fn(),
  redeemInvite: vi.fn(),
  saveActiveCommunityId: vi.fn(),
  createBuzzClient: vi.fn(),
  runtimeConfig: vi.fn(),
  replace: vi.fn(),
  enterWorkspaceRoom: vi.fn(),
  savePendingInvite: vi.fn(),
  clearPendingInvite: vi.fn(),
  offerProductTour: vi.fn(),
  identity: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) => factory({ buzz: new Proxy({}, { get: () => '#000' }) }),
  },
  useUnistyles: () => ({ theme: { buzz: { dim: '#000' } } }),
}));
vi.mock('expo-router', () => ({
  router: { back: vi.fn(), push: vi.fn(), replace: controls.replace },
  useLocalSearchParams: () => ({ token: TOKEN }),
}));
vi.mock('expo-linking', () => ({ useURL: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://server.example'),
  loadBuzzIdentity: controls.identity,
}));
vi.mock('@/buzz/enter-workspace', () => ({ enterWorkspaceRoom: controls.enterWorkspaceRoom }));
vi.mock('@/buzz/pending-invite', () => ({
  savePendingInvite: controls.savePendingInvite,
  clearPendingInvite: controls.clearPendingInvite,
}));
vi.mock('@/buzz/product-tour', () => ({ offerProductTour: controls.offerProductTour }));
vi.mock('@/buzz/vocabulary', () => ({ WORKSPACE_LABEL: 'Workspace' }));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return { BrassButton: (props: any) => ReactModule.createElement('BrassButton', props) };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/buzz/community-invite', () => ({
  parseCommunityInviteToken: () => TOKEN,
  resolveCommunityInviteRelayUrl: () => 'https://server.example',
}));
vi.mock('@/buzz/community-storage', () => ({
  saveActiveCommunityId: controls.saveActiveCommunityId,
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: controls.runtimeConfig,
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    invite = controls.invite;
    workspaces = controls.workspaces;
  },
  RoomViewHttpError: HttpError,
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: controls.redeemInvite,
}));
vi.mock('@/buzz/room-view-presentation', () => ({ workspaceRailItem: (value: any) => value }));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  return {
    BuzzCommunityShell: (props: any) =>
      ReactModule.createElement('BuzzCommunityShell', props, props.children),
  };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@beeline/buzz-client', () => ({ createBuzzClient: controls.createBuzzClient }));

import CommunityInviteJoin from './[token]';

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

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(CommunityInviteJoin));
  });
  return renderer;
}

function text(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node: any) => node.type === 'Text')
    .map((node: any) =>
      ([] as unknown[])
        .concat(node.props.children)
        .filter((part) => typeof part === 'string')
        .join(''),
    )
    .join('\n');
}

describe('CommunityInviteJoin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.identity.mockResolvedValue(IDENTITY);
    controls.runtimeConfig.mockReturnValue({ monolithEnabled: false });
    controls.invite.mockResolvedValue({
      name: 'Builders',
      expiresAt: 2_000_000_000,
      inviter: { name: 'Mara Reyes', handle: 'mara', role: 'owner' },
      memberCount: 8,
      agentCount: 4,
    });
    controls.redeemInvite.mockResolvedValue({
      joined: true,
      workspaceId: 'workspace-1',
      roomId: 'general-1',
    });
    controls.saveActiveCommunityId.mockResolvedValue(undefined);
  });

  it('names the Workspace and who invited you, then joins into its first Room', async () => {
    const renderer = await render();
    expect(text(renderer)).toContain('Join Builders');
    expect(text(renderer)).toContain(
      'Mara Reyes invited you to a workspace with 8 people and 4 agents.',
    );
    expect(text(renderer)).toContain('@mara · Workspace owner');
    // Resolving the invite spends the copy parked through sign-in.
    expect(controls.clearPendingInvite).toHaveBeenCalled();

    await act(async () => {
      await renderer.root.findByProps({ testID: 'confirm-community-join' }).props.onPress();
    });

    expect(controls.redeemInvite).toHaveBeenCalledWith('redeemInvite', { token: TOKEN });
    expect(controls.saveActiveCommunityId).toHaveBeenCalledWith('person-1', 'workspace-1');
    expect(controls.offerProductTour).toHaveBeenCalledWith('person-1');
    expect(controls.enterWorkspaceRoom).toHaveBeenCalledWith('workspace-1', 'general-1');
    expect(controls.runtimeConfig).not.toHaveBeenCalled();
    expect(controls.createBuzzClient).not.toHaveBeenCalled();
  });

  it('keeps the invite through sign-in when nobody is signed in yet', async () => {
    controls.identity.mockResolvedValue(null);
    await render();
    expect(controls.savePendingInvite).toHaveBeenCalledWith(TOKEN);
    expect(controls.replace).toHaveBeenCalledWith('/beeline/onboarding');
    expect(controls.invite).not.toHaveBeenCalled();
  });

  it('leaves a resurfaced invite immediately when this identity already accepted it', async () => {
    controls.invite.mockResolvedValue({ name: 'Builders', joinedWorkspaceId: 'workspace-1' });
    await render();
    expect(controls.redeemInvite).not.toHaveBeenCalled();
    expect(controls.saveActiveCommunityId).toHaveBeenCalledWith('person-1', 'workspace-1');
    expect(controls.enterWorkspaceRoom).toHaveBeenCalledWith('workspace-1', null);
  });

  it('shows its own repair state for a dead invite, with a way to the choice', async () => {
    controls.invite.mockRejectedValue(new HttpError(404, 'invite not found'));
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: 'invite-unavailable' }).length).toBeGreaterThan(
      0,
    );
    expect(text(renderer)).toContain('This invite doesn’t work anymore');
    expect(controls.clearPendingInvite).toHaveBeenCalled();
    await act(async () => {
      await renderer.root.findByProps({ testID: 'invite-other-way' }).props.onPress();
    });
    expect(controls.replace).toHaveBeenCalledWith('/beeline/community');
  });

  it('keeps a parked invite when the server could not be reached, and retries it', async () => {
    controls.invite.mockRejectedValueOnce(new HttpError(0, 'timeout'));
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: 'invite-unreachable' }).length).toBeGreaterThan(
      0,
    );
    expect(text(renderer)).toContain('Couldn’t reach Beeline');
    expect(renderer.root.findAllByProps({ testID: 'invite-unavailable' })).toHaveLength(0);
    expect(controls.clearPendingInvite).not.toHaveBeenCalled();

    await act(async () => {
      renderer.root.findByProps({ testID: 'invite-retry' }).props.onPress();
    });
    for (let i = 0; i < 3; i += 1) await act(async () => undefined);
    expect(controls.invite).toHaveBeenCalledTimes(2);
    expect(text(renderer)).toContain('Join Builders');
    expect(controls.clearPendingInvite).toHaveBeenCalled();
  });

  it('sends "This isn’t my invite" to the choice screen without joining', async () => {
    const renderer = await render();
    await act(async () => {
      await renderer.root.findByProps({ testID: 'invite-not-mine' }).props.onPress();
    });
    expect(controls.replace).toHaveBeenCalledWith('/beeline/community');
    expect(controls.redeemInvite).not.toHaveBeenCalled();
  });

  it('spends the parked invite when an unreachable invite is declined', async () => {
    controls.invite.mockRejectedValue(new HttpError(503, 'request_failed'));
    const renderer = await render();
    expect(controls.clearPendingInvite).not.toHaveBeenCalled();
    await act(async () => {
      await renderer.root.findByProps({ testID: 'invite-other-way' }).props.onPress();
    });
    // Without this the deck's bootstrap would route them straight back here.
    expect(controls.clearPendingInvite).toHaveBeenCalled();
    expect(controls.replace).toHaveBeenCalledWith('/beeline/community');
  });

  it('starts only one redemption when acceptance is pressed repeatedly', async () => {
    let finishRedemption!: (value: { workspaceId: string }) => void;
    controls.redeemInvite.mockReturnValue(
      new Promise((resolve) => {
        finishRedemption = resolve;
      }),
    );
    const renderer = await render();
    const button = renderer.root.findByProps({ testID: 'confirm-community-join' });

    act(() => {
      button.props.onPress();
      button.props.onPress();
    });
    expect(controls.redeemInvite).toHaveBeenCalledOnce();

    await act(async () => {
      finishRedemption({ workspaceId: 'workspace-1' });
    });
  });
});
