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
