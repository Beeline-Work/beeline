import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  operation: vi.fn(),
  enterWorkspaceRoom: vi.fn(),
  offerProductTour: vi.fn(),
  saveActiveCommunityId: vi.fn(),
  setString: vi.fn(async () => undefined),
  share: vi.fn(async () => undefined),
  pick: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    Share: { share: controls.share },
  };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) =>
      factory({
        buzz: new Proxy(
          {
            space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
            type: new Proxy({}, { get: () => ({}) }),
          },
          { get: (target: any, key) => (key in target ? target[key] : '#000') },
        ),
      }),
  },
  useUnistyles: () => ({
    theme: { buzz: { chrome: '#888', textDisabled: '#666', space: { xxl: 48 } } },
  }),
}));
vi.mock('expo-router', () => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => true },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: controls.setString }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://server.example'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'person-1' })),
}));
vi.mock('@/buzz/avatar-upload', () => ({ pickAndUploadAvatar: controls.pick }));
vi.mock('@/buzz/community-invite', () => ({
  buildCommunityInviteUrl: (token: string) => `https://usebeeline.app/join/${token}`,
  resolveCommunityInvitePublicOrigin: () => 'https://usebeeline.app',
}));
vi.mock('@/buzz/community-storage', () => ({
  saveActiveCommunityId: controls.saveActiveCommunityId,
}));
vi.mock('@/buzz/enter-workspace', () => ({ enterWorkspaceRoom: controls.enterWorkspaceRoom }));
vi.mock('@/buzz/faces', () => ({ defaultFaceForSeed: () => 'owl' }));
vi.mock('@/buzz/person-name', () => ({ savePreferredPersonName: vi.fn(async () => undefined) }));
vi.mock('@/buzz/product-tour', () => ({ offerProductTour: controls.offerProductTour }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({}) }));
vi.mock('@/buzz/vocabulary', () => ({ WORKSPACE_LABEL: 'Workspace' }));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    BrassButton: (props: any) => ReactModule.createElement('BrassButton', props),
    MonoButton: (props: any) => ReactModule.createElement('MonoButton', props),
  };
});
vi.mock('@/components/buzz/FaceGrid', async () => {
  const ReactModule = await import('react');
  return { FaceGrid: (props: any) => ReactModule.createElement('FaceGrid', props) };
});
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('@/components/buzz/ChevronGlyph', () => ({
  CHEVRON_BACK_SIZE: 18,
  ChevronGlyph: () => null,
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = async () => ({});
  },
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: controls.operation,
}));

import CreateWorkspace from './create-workspace';

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const WORKSPACE = '11111111-2222-4333-8444-555555555555';

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(CreateWorkspace));
  });
  await act(async () => undefined);
  return renderer;
}
const find = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll(
    (node: any) => node.props?.testID === testID && typeof node.type === 'string',
  );
async function press(renderer: ReactTestRenderer, testID: string) {
  await act(async () => {
    await find(renderer, testID)[0]!.props.onPress();
  });
}
async function type(renderer: ReactTestRenderer, testID: string, text: string) {
  await act(async () => find(renderer, testID)[0]!.props.onChangeText(text));
}

describe('creating a Workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.operation.mockImplementation(async (name: string) => {
      if (name === 'getManagedIdentity')
        return { personId: 'person-1', name: 'Jordan', face: 'fox' };
      if (name === 'createWorkspace') return { id: WORKSPACE, roomId: 'general-1' };
      if (name === 'createInvite') return { token: 'inv_x', expiresAt: 1 };
      if (name === 'createAgentPairingCode') return { code: 'AAAA-BBBB', expiresAt: 1 };
      return undefined;
    });
  });

  it('walks name/picture → name/face → crew, then lands in #general with the tour offered', async () => {
    const renderer = await render();
    expect(find(renderer, 'create-step-workspace')).toHaveLength(1);
    await type(renderer, 'create-workspace-name', 'Northstar Lab');
    await press(renderer, 'create-continue');
    await vi.waitFor(() =>
      expect(controls.operation).toHaveBeenCalledWith('createWorkspace', {
        workspaceId: WORKSPACE,
        name: 'Northstar Lab',
      }),
    );
    expect(controls.saveActiveCommunityId).toHaveBeenCalledWith('person-1', WORKSPACE);

    // Step 2 starts from the name and face already on record.
    expect(find(renderer, 'create-person-name')[0]!.props.value).toBe('Jordan');
    const grid = renderer.root.findAll((node: any) => node.type === 'FaceGrid')[0]!;
    expect(grid.props.selected).toBe('fox');
    await act(async () => grid.props.onSelect('owl'));
    await type(renderer, 'create-person-name', 'Jordan Lee');
    await press(renderer, 'create-continue');
    await vi.waitFor(() =>
      expect(controls.operation).toHaveBeenCalledWith('updatePersonProfile', {
        name: 'Jordan Lee',
      }),
    );
    expect(controls.operation).toHaveBeenCalledWith('updateIdentityFace', { faceId: 'owl' });

    expect(find(renderer, 'create-step-crew')).toHaveLength(1);
    await press(renderer, 'create-invite');
    await vi.waitFor(() =>
      expect(controls.setString).toHaveBeenCalledWith('https://usebeeline.app/join/inv_x'),
    );
    await press(renderer, 'create-agent');
    await vi.waitFor(() =>
      expect(controls.setString).toHaveBeenCalledWith('npx usebeeline connect AAAA-BBBB'),
    );

    await press(renderer, 'create-finish');
    await vi.waitFor(() => expect(controls.offerProductTour).toHaveBeenCalledWith('person-1'));
    expect(controls.enterWorkspaceRoom).toHaveBeenCalledWith(WORKSPACE, 'general-1');
  });

  it('retries a failed create under the same id, so it can never make two', async () => {
    let calls = 0;
    controls.operation.mockImplementation(async (name: string, input: any) => {
      if (name === 'getManagedIdentity') return { personId: 'person-1', name: 'Jordan' };
      if (name === 'createWorkspace') {
        calls += 1;
        if (calls === 1) throw new Error('network');
        return { id: input.workspaceId, roomId: 'general-1' };
      }
      return undefined;
    });
    const renderer = await render();
    await type(renderer, 'create-workspace-name', 'Crew');
    await press(renderer, 'create-continue');
    await vi.waitFor(() => expect(find(renderer, 'create-error')).toHaveLength(1));
    await press(renderer, 'create-continue');
    const ids = controls.operation.mock.calls
      .filter(([name]) => name === 'createWorkspace')
      .map(([, input]) => input.workspaceId);
    expect(ids).toEqual([WORKSPACE, WORKSPACE]);
    expect(find(renderer, 'create-step-profile')).toHaveLength(1);
  });

  it('writes a name corrected after step 1 was already confirmed', async () => {
    const renderer = await render();
    await type(renderer, 'create-workspace-name', 'Northsatr Lab');
    await press(renderer, 'create-continue');
    await vi.waitFor(() => expect(find(renderer, 'create-step-profile')).toHaveLength(1));
    await press(renderer, 'create-back');
    await type(renderer, 'create-workspace-name', 'Northstar Lab');
    await press(renderer, 'create-continue');
    await vi.waitFor(() =>
      expect(controls.operation).toHaveBeenCalledWith('updateWorkspace', {
        workspaceId: WORKSPACE,
        name: 'Northstar Lab',
      }),
    );
    expect(find(renderer, 'create-step-profile')).toHaveLength(1);
  });

  it('leaves the name alone when step 1 is confirmed again unchanged', async () => {
    const renderer = await render();
    await type(renderer, 'create-workspace-name', 'Crew');
    await press(renderer, 'create-continue');
    await vi.waitFor(() => expect(find(renderer, 'create-step-profile')).toHaveLength(1));
    await press(renderer, 'create-back');
    await press(renderer, 'create-continue');
    expect(controls.operation).not.toHaveBeenCalledWith('updateWorkspace', expect.anything());
  });

  it('never blocks setup on a picture that fails to save', async () => {
    controls.pick.mockResolvedValue('https://server.example/v1/media/pic');
    controls.operation.mockImplementation(async (name: string) => {
      if (name === 'getManagedIdentity') return { personId: 'person-1', name: 'Jordan' };
      if (name === 'createWorkspace') return { id: WORKSPACE, roomId: 'general-1' };
      if (name === 'updateWorkspace') throw new Error('avatar rejected');
      return undefined;
    });
    const renderer = await render();
    await press(renderer, 'create-workspace-picture');
    await type(renderer, 'create-workspace-name', 'Crew');
    await press(renderer, 'create-continue');
    await vi.waitFor(() =>
      expect(controls.operation).toHaveBeenCalledWith('updateWorkspace', {
        workspaceId: WORKSPACE,
        avatar: 'https://server.example/v1/media/pic',
      }),
    );
    expect(find(renderer, 'create-step-profile')).toHaveLength(1);
    expect(find(renderer, 'create-notice')).toHaveLength(1);
  });

  it('lets the crew step be skipped entirely', async () => {
    const renderer = await render();
    await type(renderer, 'create-workspace-name', 'Crew');
    await press(renderer, 'create-continue');
    await press(renderer, 'create-continue');
    // Nothing changed on step 2, so nothing is rewritten.
    expect(controls.operation).not.toHaveBeenCalledWith('updatePersonProfile', expect.anything());
    await press(renderer, 'create-skip');
    await vi.waitFor(() =>
      expect(controls.operation).not.toHaveBeenCalledWith('createInvite', expect.anything()),
    );
    expect(controls.enterWorkspaceRoom).toHaveBeenCalledWith(WORKSPACE, 'general-1');
  });
});
