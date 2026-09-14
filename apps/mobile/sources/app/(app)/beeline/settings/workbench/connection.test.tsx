import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const searchParams = vi.hoisted(() => ({
  params: {
    workspaceId: 'workspace-1',
    viewerId: 'human-dani',
    ref: 'cred_vercel',
  } as Record<string, string>,
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => searchParams.params,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return {
    SettingsRow: (props: any) => ReactModule.createElement('SettingsRow', props),
  };
});

import ConnectionDetailScreen from './connection';

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
  vi.clearAllMocks();
  searchParams.params = {
    workspaceId: 'workspace-1',
    viewerId: 'human-dani',
    ref: 'cred_vercel',
  };
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(ConnectionDetailScreen));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

async function flush(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('Connection detail screen', () => {
  it('renders hosts, creator, grants with kinds and the spend cap', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'connection-detail-metadata' })).toBeDefined();
    const grants = renderer.root.findByProps({ testID: 'connection-detail-grants' });
    expect(grants.props.value).toContain('hoots (deploy, list)');
    expect(grants.props.value).toContain('terra (list)');
  });

  it('renders the Squire ledger rows', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'connection-ledger-0' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'connection-ledger-2' })).toBeDefined();
  });

  it('revokes all grants only behind an explicit confirmation', async () => {
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: 'connection-revoke-confirm' })).toHaveLength(0);
    await act(async () => {
      renderer.root.findByProps({ testID: 'connection-revoke-grants' }).props.onPress();
      await Promise.resolve();
    });
    const confirm = renderer.root.findByProps({ testID: 'connection-revoke-confirm' });
    expect(confirm).toBeDefined();
    await act(async () => {
      renderer.root.findByProps({ testID: 'connection-revoke-confirm-no' }).props.onPress();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ testID: 'connection-revoke-confirm' })).toHaveLength(0);
    await act(async () => {
      renderer.root.findByProps({ testID: 'connection-revoke-grants' }).props.onPress();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'connection-revoke-confirm-yes' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({ testID: 'connection-revoked-line' }).props.children).toBe(
      'Revoked 2 grants',
    );
  });

  it('refuses another member’s connection instead of showing it', async () => {
    searchParams.params = {
      workspaceId: 'workspace-1',
      viewerId: 'human-terra',
      ref: 'cred_vercel',
    };
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'connection-error' }).props.children).toContain(
      'another member',
    );
    expect(renderer.root.findAllByProps({ testID: 'connection-detail-metadata' })).toHaveLength(0);
  });
});
