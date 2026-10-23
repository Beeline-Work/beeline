const proofTheme = vi.hoisted(() => ({ value: 'obsidian' as 'bone' | 'obsidian' }));
vi.mock('@expo/vector-icons', async () => { const R = await import('react'); return { Ionicons: (props: any) => R.createElement('Ionicons', props) }; });
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { beelineThemes } from '@/buzz/groknight';
const ledgerEntryRender = vi.hoisted(() => vi.fn());
const modal = vi.hoisted(() => ({ alert: vi.fn(), show: vi.fn() }));
const pictureActions = vi.hoisted(() => ({ showPictureActions: vi.fn() }));
const desktopArtifactPane = vi.hoisted(() => ({ openArtifactInDesktopWorkPane: vi.fn() }));
const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
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
  return { StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style.map((part: any) => Array.isArray(part) ? Object.assign({}, ...part) : part)) : style },
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

vi.mock('react-native-gesture-handler', async () => {
  const ReactModule = await import('react');
  return {
    Swipeable: (props: any) => ReactModule.createElement('Swipeable', props, props.children),
  };
});

vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  const active = () => ({ buzz: beelineThemes[proofTheme.value] });
  return {
    StyleSheet: { create: (factory: any) => new Proxy({}, { get: (_target, key) => factory(active())[key] }) },
    useUnistyles: () => ({ theme: active() }),
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
  return { ArtifactCard: (props: any) => ReactModule.createElement('ArtifactCard', props), openArtifactViewer: vi.fn() };
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
  return { CornerGlyph: (props: any) => ReactModule.createElement('CornerGlyph', props) };
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
  };
});

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

import { approvalCases, approvalCaseElement, proofRosterAgent } from '../../../../../scripts/approval-card-cases';

describe.each(['bone', 'obsidian'] as const)('approved approval anatomy in %s', themeName => {
  it.each(approvalCases)('renders %s with its asking avatar, content, actions and active theme', name => {
    proofTheme.value = themeName;
    const view = render(approvalCaseElement(name));
    const textParts = (value: any): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(textParts) : React.isValidElement(value) ? textParts((value.props as any).children) : [];
    const texts = view.root.findAllByType('Text').flatMap((node: ReactTestInstance) => textParts(node.props.children)).join(' ');
    expect(texts).toContain('wants to');
    expect(texts).not.toContain('approval stays with');
    expect(texts).not.toContain('owner confirmation');
    if (!name.startsWith('tray')) {
      const mark = view.root.findByType('IdentityMark' as never);
      expect(mark.props.avatarUrl).toBe(proofRosterAgent.avatar);
      expect(mark.props.kind).toBe('agent');
      if (!name.endsWith('-allowed') && !name.endsWith('-denied') && !name.endsWith('-expired') && name !== 'grant-always') {
        const frame = view.root.findAllByType('View').find((node: ReactTestInstance) => {
          const style = Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean));
          return node.props.testID && style.backgroundColor === beelineThemes[themeName].bgRaised;
        });
        expect(frame).toBeDefined();
      } else if (name === 'squire-expired') expect(texts).toContain('The request to reveal a key expired');
      else if (name === 'grant-always') { expect(texts).toContain('Always'); expect(texts).toContain('Allowed by you ·'); }
      else if (name === 'grant-allowed') { expect(texts).toContain('Once'); expect(texts).toContain('Allowed by you ·'); }
      else if (name.startsWith('squire-')) {
        expect(texts).toContain(name.endsWith('-denied') ? 'Denied ·' : 'Allowed ·');
        expect(texts).not.toContain('by you');
      } else expect(texts).toContain(name.endsWith('-denied') ? 'Denied by you' : 'Allowed by you');
    } else {
      const expected = name === 'tray-write' ? ['owner/repo', 'Update README.md.']
        : name === 'tray-connector' ? ['Trusty Squire', 'Provision the API key into its vault.']
        : name === 'tray-squire' ? ['reveal a key', 'Sign in the Fly command-line tool for this deploy.']
        : ['python3 cleanup.py', 'Free disk space so the Android test build can finish.'];
      for (const value of expected) expect(texts).toContain(value);
    }
  });
});

// Old servers keep their action indices; visual order must not change the callbacks.
it('puts No first while preserving existing tray action testIDs and decisions', async () => {
  const onAction = vi.fn();
  const fixture = approvalCaseElement('tray', onAction);
  const props = fixture.props as any;
  const actions = props.item.approval.actions;
  const item = { ...props.item, approval: { ...props.item.approval, actions: [actions[1], actions[2], actions[0]] } };
  const view = render(React.cloneElement(fixture, { item, onAction }));
  const buttons = view.root.findAllByType('Button' as never).filter((node: ReactTestInstance) => node.props.testID?.startsWith('needs-you-action-'));
  expect(buttons.map((node: ReactTestInstance) => [node.props.label, node.props.testID])).toEqual([
    ['No', 'needs-you-action-tray-2'], ['Once', 'needs-you-action-tray-0'], ['Always', 'needs-you-action-tray-1'],
  ]);
  await act(async () => { await buttons[0].props.onPress({ stopPropagation() {} }); });
  expect(onAction).toHaveBeenCalledWith(item, expect.objectContaining({ decision: 'deny' }));
});

// These fixtures traverse the production phone parser and display adapter.
describe.each(['bone', 'obsidian'] as const)('parsed settled approval controls in %s', themeName => {
  it.each(['squire-allowed', 'squire-denied', 'squire-expired', 'target-denied', 'permission-allowed'] as const)('removes pending controls for %s', name => {
    proofTheme.value = themeName;
    const view = render(approvalCaseElement(name));
    const ids = view.root.findAll((node: ReactTestInstance) => typeof node.props.testID === 'string').map((node: ReactTestInstance) => node.props.testID);
    expect(ids).not.toContain('squire-approval-open');
    expect(ids).not.toContain('write-permission-allow');
    expect(ids).not.toContain('write-permission-deny');
    expect(ids).not.toContain('target-branch-confirm');
    expect(ids).not.toContain('target-branch-deny');
    expect(view.root.findAll((node: ReactTestInstance) => node.props.label === 'Review ↗')).toHaveLength(0);
  });
});
