import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  operation: vi.fn(),
  enterWorkspaceRoom: vi.fn(),
  saveActiveCommunityId: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
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
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'person-1' })),
}));
vi.mock('@/buzz/community-storage', () => ({
  saveActiveCommunityId: controls.saveActiveCommunityId,
}));
vi.mock('@/buzz/enter-workspace', () => ({ enterWorkspaceRoom: controls.enterWorkspaceRoom }));
vi.mock('@/buzz/vocabulary', () => ({ WORKSPACE_LABEL: 'Workspace' }));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/components/buzz/Button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: any) => ReactModule.createElement('Button', props, props.children) };
});
vi.mock('@/components/buzz/ChevronGlyph', () => ({
  CHEVRON_BACK_SIZE: 18,
  ChevronGlyph: () => null,
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
      if (name === 'createWorkspace') return { id: WORKSPACE, roomId: 'general-1' };
      return undefined;
    });
  });

  it('is one step — Name your Workspace — and Create Workspace lands in #general', async () => {
    const renderer = await render();
    expect(find(renderer, 'create-step-workspace')).toHaveLength(1);
    const texts = renderer.root
      .findAll((node: any) => node.type === 'Text')
      .map((node: any) => node.props.children);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Name your Workspace',
        'Your team, company, or project. Change it in Settings.',
        'Workspace name',
      ]),
    );
    // No step counter, progress bar, picture prompt, invite or agent command.
    for (const gone of [
      'create-progress',
      'create-workspace-picture',
      'create-step-profile',
      'create-step-crew',
      'create-invite',
      'create-agent',
    ])
      expect(find(renderer, gone)).toHaveLength(0);
    expect(texts.some((text: unknown) => typeof text === 'string' && /of 3/.test(text))).toBe(
      false,
    );
    const button = find(renderer, 'create-continue')[0]!;
    expect(button.type).toBe('Button');
    expect(button.props.label).toBe('Create Workspace');

    await type(renderer, 'create-workspace-name', 'Northstar Lab');
    await press(renderer, 'create-continue');
    await vi.waitFor(() =>
      expect(controls.enterWorkspaceRoom).toHaveBeenCalledWith(WORKSPACE, 'general-1'),
    );
    expect(controls.operation).toHaveBeenCalledWith('createWorkspace', {
      workspaceId: WORKSPACE,
      name: 'Northstar Lab',
    });
    expect(controls.saveActiveCommunityId).toHaveBeenCalledWith('person-1', WORKSPACE);
    // The Workspace step never touches the person's name or face.
    expect(controls.operation).not.toHaveBeenCalledWith('updatePersonProfile', expect.anything());
    expect(controls.operation).not.toHaveBeenCalledWith('updateIdentityFace', expect.anything());
  });

  it('retries a failed create under the same id, so it can never make two', async () => {
    let calls = 0;
    controls.operation.mockImplementation(async (name: string, input: any) => {
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
    expect(controls.enterWorkspaceRoom).toHaveBeenCalledWith(WORKSPACE, 'general-1');
  });

  it('writes a name corrected after a create whose response never arrived', async () => {
    let calls = 0;
    controls.operation.mockImplementation(async (name: string, input: any) => {
      if (name === 'createWorkspace') {
        calls += 1;
        // The server committed the first insert; only the answer was lost.
        if (calls === 1) throw new Error('timeout');
        return { id: input.workspaceId, roomId: 'general-1' };
      }
      return undefined;
    });
    const renderer = await render();
    await type(renderer, 'create-workspace-name', 'Alpha');
    await press(renderer, 'create-continue');
    await vi.waitFor(() => expect(find(renderer, 'create-error')).toHaveLength(1));
    await type(renderer, 'create-workspace-name', 'Alpha Labs');
    await press(renderer, 'create-continue');
    await vi.waitFor(() =>
      expect(controls.operation).toHaveBeenCalledWith('updateWorkspace', {
        workspaceId: WORKSPACE,
        name: 'Alpha Labs',
      }),
    );
    expect(controls.enterWorkspaceRoom).toHaveBeenCalledWith(WORKSPACE, 'general-1');
  });
});
