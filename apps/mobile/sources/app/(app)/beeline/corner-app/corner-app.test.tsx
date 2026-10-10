import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
  roomRead: vi.fn(),
  publish: vi.fn(),
  alert: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString() { return undefined; }
    set() {}
    delete() {}
    getAllKeys() { return []; }
  },
}));
vi.mock('@beeline/buzz-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@beeline/buzz-client')>()),
  // Fixtures carry only the corner-app fields this route reads.
  isRoomView: (value: unknown) => Boolean(value) && typeof value === 'object',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({
  router: { back: vi.fn() },
  useLocalSearchParams: () => ({ roomId: 'corner-a', slug: 'ledger' }),
}));
vi.mock('@/modal', () => ({ Modal: { alert: app.alert } }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer', secretKey: new Uint8Array(32) })),
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  phoneOperationFailureReason: (reason: unknown) =>
    reason instanceof TypeError ? "Couldn't reach Beeline." : String(reason),
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    room() {
      return app.roomRead();
    }
  },
}));
vi.mock('@/sync/transport/monolith-rig-transport', () => ({
  MonolithRigTransport: class {
    async composeMessage() {
      return { id: 'event' };
    }
    publishPreparedMessage() {
      return app.publish();
    }
  },
}));

import CornerAppRoute from './[slug]';
import { isRoomView } from '@beeline/buzz-client';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';

const roomAddress = surfaceAddress('https://relay.test', 'viewer', '/room/corner-a');
const ledger = (title: string) => ({
  cornerApps: [{ slug: 'ledger', title, authorId: 'agent-a', blocks: [] }],
});

function text(node: any): string {
  return node.children
    .map((child: any) => (typeof child === 'string' ? child : text(child)))
    .join('');
}

async function mount(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(CornerAppRoute));
  });
  return renderer;
}

beforeEach(() => {
  mobileSurfaceCache.clear();
  app.roomRead.mockReset();
  app.publish.mockReset();
  app.alert.mockReset();
});

describe('Corner App screen failures', () => {
  it('says the app could not load when the Room read fails, instead of a blank screen', async () => {
    app.roomRead.mockRejectedValue(new TypeError('Network request failed'));
    const renderer = await mount();
    expect(text(renderer.root)).toContain("Could not load this app. Couldn't reach Beeline.");
  });

  it('names a failed send and stays on the app', async () => {
    app.roomRead.mockResolvedValue({
      cornerApps: [
        {
          slug: 'ledger',
          title: 'Ledger',
          authorId: 'agent-a',
          blocks: [{ kind: 'action', label: 'Reconcile', prompt: 'reconcile now' }],
        },
      ],
    });
    app.publish.mockRejectedValue(new TypeError('Network request failed'));
    const renderer = await mount();
    const screen = renderer.root.find((node: any) => node.props?.onAction);
    await act(async () => {
      screen.props.onAction('reconcile now');
    });
    await vi.waitFor(() =>
      expect(app.alert).toHaveBeenCalledWith('Could not send', "Couldn't reach Beeline."),
    );
  });
});

describe('Corner App definition source', () => {
  it('reads the live Room surface the chat writes and follows its updates without a Room read', async () => {
    mobileSurfaceCache.publish(roomAddress, ledger('Ledger v1') as never, isRoomView);
    const renderer = await mount();
    const screen = () => renderer.root.find((node: any) => node.props?.onBack && 'app' in node.props);
    expect(screen().props.app.title).toBe('Ledger v1');
    await act(async () => {
      mobileSurfaceCache.publish(roomAddress, ledger('Ledger v2') as never, isRoomView);
    });
    expect(screen().props.app.title).toBe('Ledger v2');
    expect(app.roomRead).not.toHaveBeenCalled();
  });

  it('falls back to one Room read when the surface has no entry and shares it with the chat', async () => {
    app.roomRead.mockResolvedValue(ledger('Ledger'));
    const renderer = await mount();
    const screen = renderer.root.find((node: any) => node.props?.onBack && 'app' in node.props);
    expect(screen.props.app.title).toBe('Ledger');
    expect(app.roomRead).toHaveBeenCalledTimes(1);
    expect(mobileSurfaceCache.peek(roomAddress, isRoomView)).toEqual(ledger('Ledger'));
  });
});
