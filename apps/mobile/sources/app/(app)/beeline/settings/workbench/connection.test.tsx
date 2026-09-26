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
const safeAreaInsets = vi.hoisted(() => ({ top: 0, right: 0, bottom: 34, left: 0 }));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => searchParams.params,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeAreaInsets,
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

vi.mock('@/components/buzz/ServiceMark', async () => {
  const ReactModule = await import('react');
  return { ServiceMark: (props: any) => ReactModule.createElement('ServiceMark', props) };
});

vi.mock('@/components/buzz/StateDot', async () => {
  const ReactModule = await import('react');
  return { StateDot: (props: any) => ReactModule.createElement('StateDot', props) };
});

vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

vi.mock('@/components/buzz/PageHeader', async () => {
  const ReactModule = await import('react');
  return {
    PageHeader: (props: any) => ReactModule.createElement('PageHeader', props),
  };
});

import ConnectionDetailScreen from './connection';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import { MockWorkbenchSource, VERCEL_CONNECTION } from '@/buzz/workbench-source.mock';

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
  setWorkbenchSource(new MockWorkbenchSource());
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
  it('draws the shared page header: small Workbench over the key name', async () => {
    const renderer = await render();
    const header = renderer.root.findByProps({ testID: 'connection-header' });
    expect(header.props.eyebrow).toBe('Workbench');
    expect(header.props.title).toBe('vercel');
    expect(header.props.onBack).toBeTypeOf('function');
  });

  it('keeps the scroll content above the Android navigation inset', async () => {
    const renderer = await render();
    const screen = renderer.root.findByProps({ testID: 'connection-detail-screen' });
    expect(screen.props.style).toEqual([
      expect.objectContaining({ flex: 1 }),
      { paddingTop: 0, paddingBottom: 34 },
    ]);
  });

  it('renders service identity and the complete vault facts', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'connection-header' }).props.title).toBe('vercel');
    expect(renderer.root.findAllByProps({ testID: 'connection-key-label' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'connection-detail-metadata' })).toBeDefined();
    expect(renderer.root.findByProps({ title: 'Reference' }).props.description).toBe('cred_vercel');
    expect(renderer.root.findByProps({ title: 'Hosts' }).props.description).toBe('api.vercel.com');
    expect(renderer.root.findByProps({ title: 'Fields' }).props.description).toBe('token');
    expect(renderer.root.findByProps({ title: 'Created' }).props.value).not.toBe('not reported');
    expect(renderer.root.findByProps({ title: 'Last synced' }).props.value).not.toBe(
      'not reported',
    );
    expect(renderer.root.findByProps({ title: 'Provisioned by' }).props.value).toContain('@hoots');
  });

  it('shows a useful vault label and omits redundant ones', async () => {
    searchParams.params = {
      workspaceId: 'workspace-1',
      viewerId: 'human-dani',
      ref: 'cred_github',
    };
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'connection-key-label' }).props.children).toBe(
      'Work key',
    );
  });

  it('renders each live grant with its creation fact and reported limits', async () => {
    const renderer = await render();
    const capped = renderer.root.findByProps({ testID: 'connection-grant-hoots' });
    expect(capped.props.description).toContain('Granted');
    expect(capped.props.value).toBe('$25 cap');
    expect(renderer.root.findByProps({ testID: 'connection-grant-terra' }).props.value).toBe(
      'no limits reported',
    );
  });

  it('renders the Squire ledger rows', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'connection-ledger-0' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'connection-ledger-4' })).toBeDefined();
  });

  it('omits the Created-by row when the vault reports no provisioning fact', async () => {
    const data = new MockWorkbenchSource();
    const source = new MockWorkbenchSource();
    source.readConnectionDetail = async (input) => {
      const detail = await data.readConnectionDetail(input);
      return detail ? { ...detail, createdBy: undefined } : null;
    };
    setWorkbenchSource(source);
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'connection-detail-metadata' })).toBeDefined();
    expect(renderer.root.findAllByProps({ title: 'Provisioned by' })).toHaveLength(0);
  });

  it('calls stale metadata refreshing instead of active', async () => {
    const data = new MockWorkbenchSource();
    const source = new MockWorkbenchSource();
    source.readConnectionDetail = async (input) => {
      const detail = await data.readConnectionDetail(input);
      return detail
        ? { ...detail, connection: { ...detail.connection, state: 'active', stale: true } }
        : null;
    };
    setWorkbenchSource(source);
    const renderer = await render();
    const state = renderer.root.findByProps({ testID: 'connection-detail-state' });
    expect(state.findByType('StateDot').props.kind).toBe('pulse');
    expect(state.findByType('Text').props.children).toBe('refreshing');
  });

  it('states empty grants and activity without offering a destructive action', async () => {
    const data = new MockWorkbenchSource();
    const source = new MockWorkbenchSource();
    source.readConnectionDetail = async (input) => {
      const detail = await data.readConnectionDetail(input);
      return detail
        ? {
            ...detail,
            grants: [],
            ledger: [],
            connection: { ...detail.connection, grantCount: 0 },
          }
        : null;
    };
    setWorkbenchSource(source);
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'connection-grants-empty' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'connection-activity-empty' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'connection-management' })).toHaveLength(0);
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

  it('reopens a pending revoke as revoking and disables repeat revoke', async () => {
    const source = new MockWorkbenchSource();
    source.readConnectionDetail = async () => ({
      ...VERCEL_CONNECTION,
      grants: [
        { grantId: 'hoots', createdAt: 1, spendCapUsd: 25, revokingAt: 1_757_808_000 },
        { grantId: 'terra', createdAt: 2, revokingAt: 1_757_808_000 },
      ],
    });
    setWorkbenchSource(source);
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'connection-grant-hoots' }).props.value).toBe(
      'revoking',
    );
    expect(renderer.root.findByProps({ testID: 'connection-grant-hoots' }).props.description).toBe(
      'Revoking — waiting for the helper',
    );
    expect(renderer.root.findByProps({ testID: 'connection-revoked-line' }).props.children).toBe(
      'Revoking 2 grants — waiting for the helper',
    );
    expect(renderer.root.findAllByProps({ testID: 'connection-revoke-grants' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'connection-management' })).toHaveLength(0);
  });
});
