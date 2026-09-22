import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn() }));
const roomRead = vi.hoisted(() => vi.fn());
const historyRead = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => ({
    roomId: 'room-7',
    messageId: 'agent-json',
    blockIndex: '0',
  }),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer' })),
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    room = roomRead;
    history = historyRead;
  },
}));
vi.mock('@/components/buzz/ArtifactViewer', async () => {
  const ReactModule = await import('react');
  return {
    ArtifactViewerScreen: (props: Record<string, unknown>) =>
      ReactModule.createElement('ArtifactViewerScreen', props),
  };
});

import ArtifactViewerRoute from './artifact-viewer';

// Reproduction agent-json-reader: open a long, raw JSON reply from an agent.
// The transcript painted a JSON fence, but the reader reparsed the unfenced
// stored body and showed “The code block could not be loaded.”

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  navigation.back.mockReset();
  historyRead.mockReset();
  roomRead.mockReset();
});

describe('artifact viewer route', () => {
  it('opens a multiline agent JSON message and navigates Back from its full-page reader', async () => {
    const json = [
      '{',
      '  "result": {',
      '    "status": "ok",',
      '    "items": [',
      '      1,',
      '      2',
      '    ]',
      '  }',
      '}',
    ].join('\n');
    roomRead.mockResolvedValue({
      messages: [
        {
          id: 'agent-json',
          text: json,
          author: { pubkey: 'agent', kind: 'agent', name: 'Agent' },
          createdAt: 1,
          presentation: 'message',
        },
      ],
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ArtifactViewerRoute />);
    });
    await act(async () => undefined);

    const reader = renderer.root.findByType('ArtifactViewerScreen' as never);
    expect(reader.props.document).toMatchObject({
      type: 'code',
      title: 'json',
      language: 'json',
      code: json,
    });
    expect(historyRead).not.toHaveBeenCalled();

    act(() => reader.props.onClose());
    expect(navigation.back).toHaveBeenCalledOnce();
  });
});
