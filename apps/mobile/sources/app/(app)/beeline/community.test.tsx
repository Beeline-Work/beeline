import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = `inv_${'b'.repeat(64)}`;
const controls = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  workspaces: vi.fn(),
  params: {} as Record<string, string>,
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
    theme: { buzz: { accent: '#b08a4a', chrome: '#888', textDisabled: '#666', space: { lg: 24 } } },
  }),
}));
vi.mock('expo-router', () => ({
  router: { push: controls.push, replace: controls.replace, back: vi.fn(), canGoBack: () => true },
  useLocalSearchParams: () => controls.params,
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@beeline/buzz-client', () => ({ isWorkspaceListView: () => true }));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaces = controls.workspaces;
  },
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://server.example'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'person-1' })),
}));
vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: { read: vi.fn(async () => null), write: vi.fn(async () => undefined) },
  surfaceAddress: () => 'address',
}));
vi.mock('@/buzz/room-view-presentation', () => ({
  workspaceRailItem: (value: any) => ({ communityId: value.id, name: value.name }),
}));
vi.mock('@/buzz/vocabulary', () => ({ WORKSPACE_LABEL: 'Workspace' }));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  return {
    BuzzCommunityShell: (props: any) => ReactModule.createElement('Shell', props, props.children),
  };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return { BrassButton: (props: any) => ReactModule.createElement('BrassButton', props) };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
vi.mock('@/components/buzz/ChevronGlyph', () => ({
  CHEVRON_BACK_SIZE: 18,
  CHEVRON_ROW_SIZE: 14,
  ChevronGlyph: () => null,
}));
vi.mock('@/components/buzz/RoomGlyph', () => ({ RoomGlyph: () => null }));
vi.mock('@/components/buzz/MembersGlyph', () => ({ MembersGlyph: () => null }));

import WorkspaceChoice from './community';

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

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceChoice));
  });
  await act(async () => undefined);
  return renderer;
}
const find = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll(
    (node: any) => node.props?.testID === testID && typeof node.type === 'string',
  );

describe('the create-or-join choice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.params = {};
    controls.workspaces.mockResolvedValue({ workspaces: [], viewer: {} });
  });

  it('gives Create and Join the same weight: one card shape, one style, side by side', async () => {
    const renderer = await render();
    const [create] = find(renderer, 'choice-create');
    const [join] = find(renderer, 'choice-join');
    expect(create!.type).toBe(join!.type);
    expect(create!.props.style({ pressed: false })).toEqual(join!.props.style({ pressed: false }));
    // A person with no Workspace has nowhere to go back to.
    expect(
      renderer.root.findAll((node: any) => node.props?.accessibilityLabel === 'Back'),
    ).toHaveLength(0);
  });

  it('opens the wizard for Create', async () => {
    const renderer = await render();
    find(renderer, 'choice-create')[0]!.props.onPress();
    expect(controls.push).toHaveBeenCalledWith('/beeline/create-workspace');
  });

  it('previews a pasted invite link, and refuses something that is not one', async () => {
    const renderer = await render();
    expect(find(renderer, 'choice-join-form')).toHaveLength(0);
    await act(async () => find(renderer, 'choice-join')[0]!.props.onPress());
    await act(async () => find(renderer, 'choice-join-input')[0]!.props.onChangeText('hello'));
    await act(async () => find(renderer, 'choice-join-preview')[0]!.props.onPress());
    expect(find(renderer, 'choice-error')).toHaveLength(1);
    expect(controls.push).not.toHaveBeenCalled();

    await act(async () =>
      find(renderer, 'choice-join-input')[0]!.props.onChangeText(
        `https://usebeeline.app/join/${TOKEN}`,
      ),
    );
    await act(async () => find(renderer, 'choice-join-preview')[0]!.props.onPress());
    expect(controls.push).toHaveBeenCalledWith({
      pathname: '/join/[token]',
      params: { token: TOKEN },
    });
  });

  it('opens straight on the invite field from the deck’s Join action, with a way back', async () => {
    controls.params = { mode: 'join' };
    controls.workspaces.mockResolvedValue({ workspaces: [{ id: 'w1', name: 'Crew' }], viewer: {} });
    const renderer = await render();
    expect(find(renderer, 'choice-join-form')).toHaveLength(1);
    expect(
      renderer.root.findAll((node: any) => node.props?.accessibilityLabel === 'Back').length,
    ).toBeGreaterThan(0);
  });
});
