import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const phoneOperation = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  router: navigation,
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ communityId: 'workspace-1' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await import('react');
  return { Ionicons: (props: any) => ReactModule.createElement('Icon', props) };
});
vi.mock('@/components/buzz/PageHeader', async () => {
  const ReactModule = await import('react');
  return { PageHeader: (props: any) => ReactModule.createElement('PageHeader', props) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return { MonoButton: (props: any) => ReactModule.createElement('MonoButton', props) };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});

import AgentClassesSettings from './agent-classes';

const SOL = '2'.repeat(64);
const view = {
  workspaceId: 'workspace-1',
  registry: { source: 'https://models.dev/api.json', fetchedAt: 1790719200, modelCount: 4812 },
  agents: [
    {
      agentId: SOL,
      name: 'Sol',
      handle: 'sol',
      model: 'gpt-6.1-sol',
      classes: {
        tier: 'heavy',
        unclassified: false,
        source: 'price',
        provider: 'openai',
        outputCost: 10,
        tags: [
          { tag: 'heavy', kind: 'tier', removable: false },
          { tag: 'sol', kind: 'family', removable: false },
          { tag: 'reviewer', kind: 'custom', removable: true },
        ],
      },
    },
  ],
  overrides: [{ scope: 'family', key: 'grok', tier: 'light' }],
  unclassified: [{ key: 'openrouter/gemma-4-31b-it-fabled', agentNames: ['Goosy'] }],
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  phoneOperation.mockImplementation(async (name: string) =>
    name === 'readWorkspaceAgentClasses' ? view : undefined,
  );
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(AgentClassesSettings));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

const byTestID = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll((node: any) => node.props.testID === testID && typeof node.type === 'string')[0]!;

describe('Workspace settings → Agent classes', () => {
  it('adds and removes custom tags for a Workspace admin', async () => {
    const renderer = await render();
    expect(phoneOperation).toHaveBeenCalledWith('readWorkspaceAgentClasses', {
      workspaceId: 'workspace-1',
    });
    await act(async () => byTestID(renderer, `agent-tag-input-${SOL}`).props.onChangeText('Fast'));
    await act(async () => {
      byTestID(renderer, `agent-tag-add-${SOL}`).props.onPress();
      await Promise.resolve();
    });
    expect(phoneOperation).toHaveBeenCalledWith('setAgentCustomTag', {
      workspaceId: 'workspace-1',
      agentId: SOL,
      tag: 'Fast',
      present: true,
    });
    await act(async () => {
      byTestID(renderer, 'agent-tag-remove-reviewer').props.onPress();
      await Promise.resolve();
    });
    expect(phoneOperation).toHaveBeenCalledWith('setAgentCustomTag', {
      workspaceId: 'workspace-1',
      agentId: SOL,
      tag: 'reviewer',
      present: false,
    });
    // Automatic tags carry no remove control.
    expect(
      renderer.root.findAll((node: any) => node.props.testID === 'agent-tag-remove-heavy'),
    ).toHaveLength(0);
  });

  it('pins, changes and clears tier overrides, and resolves an unclassified model', async () => {
    const renderer = await render();
    await act(async () => {
      byTestID(renderer, 'override-tier-family-grok-heavy').props.onPress();
      await Promise.resolve();
    });
    expect(phoneOperation).toHaveBeenCalledWith('setModelTierOverride', {
      workspaceId: 'workspace-1',
      scope: 'family',
      key: 'grok',
      tier: 'heavy',
    });
    await act(async () => {
      byTestID(renderer, 'override-remove-family-grok').props.onPress();
      await Promise.resolve();
    });
    expect(phoneOperation).toHaveBeenCalledWith('setModelTierOverride', {
      workspaceId: 'workspace-1',
      scope: 'family',
      key: 'grok',
      tier: null,
    });
    await act(async () =>
      byTestID(renderer, 'unclassified-pin-openrouter/gemma-4-31b-it-fabled').props.onPress(),
    );
    expect(byTestID(renderer, 'override-pin-key').props.value).toBe(
      'openrouter/gemma-4-31b-it-fabled',
    );
    await act(async () => byTestID(renderer, 'override-pin-tier-light').props.onPress());
    await act(async () => {
      byTestID(renderer, 'override-pin-save').props.onPress();
      await Promise.resolve();
    });
    expect(phoneOperation).toHaveBeenCalledWith('setModelTierOverride', {
      workspaceId: 'workspace-1',
      scope: 'model',
      key: 'openrouter/gemma-4-31b-it-fabled',
      tier: 'light',
    });
  });

  it('shows the admin gate when the server refuses the read', async () => {
    phoneOperation.mockRejectedValue(new Error('workspace manager required'));
    const renderer = await render();
    expect(byTestID(renderer, 'agent-classes-denied')).toBeTruthy();
  });
});
