import { describe, expect, it, vi } from 'vitest';
import {
  hydrateRoomEntry,
  type RoomEntryClient,
  type RoomEntryHandlers,
  type RoomEntryTransport,
  type RoomTranscriptSync,
} from './room-entry';

const CHANNEL = 'room-1';
const VIEWER = 'viewer-pubkey';

function hangs<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hangingClient(overrides: Partial<RoomEntryClient> = {}): RoomEntryClient {
  return {
    getChannelMetadata: hangs,
    listCommunities: hangs,
    getChannelCommunityId: hangs,
    getDirectMessage: hangs,
    getChannelRole: hangs,
    isAgentIdentity: hangs,
    listAgents: hangs,
    communityMembers: hangs,
    listPersonProfiles: hangs,
    ...overrides,
  };
}

function hangingTransport(overrides: Partial<RoomEntryTransport> = {}): RoomEntryTransport {
  return {
    getParentChannelId: hangs,
    isChannelArchived: hangs,
    getSubchannelMergeTarget: hangs,
    listSubchannelLifecycle: hangs,
    cornerBriefing: hangs,
    ...overrides,
  };
}

function handlers(): RoomEntryHandlers {
  return {
    onCommunities: vi.fn(),
    onViewerIsAgent: vi.fn(),
    onChannelRole: vi.fn(),
    onRoomName: vi.fn(),
    onParentChannelId: vi.fn(),
    onDirectMessage: vi.fn(),
    onWorkspaceId: vi.fn(),
    onRoster: vi.fn(),
    onTranscriptSynced: vi.fn(),
    onArchived: vi.fn(),
    onMergeTarget: vi.fn(),
    onMergeNotReadyReason: vi.fn(),
    onCornerStatus: vi.fn(),
    onCornerBriefing: vi.fn(),
    onCornerLifecycle: vi.fn(),
    onAgents: vi.fn(),
    onStepFailed: vi.fn(),
  };
}

const emptySync: RoomTranscriptSync = { entry: { snapshot: {} }, archiveChannel: false };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function start(
  client: RoomEntryClient,
  transport: RoomEntryTransport,
  overrides: Partial<Parameters<typeof hydrateRoomEntry>[0]> = {},
) {
  const sink = handlers();
  const installLiveDelivery = vi.fn(() => hangs<void>());
  const revalidateTranscript = vi.fn(() => hangs<RoomTranscriptSync>());
  void hydrateRoomEntry(
    {
      channelId: CHANNEL,
      viewerPubkey: VIEWER,
      client,
      transport,
      installLiveDelivery,
      revalidateTranscript,
      isCancelled: () => false,
      ...overrides,
    },
    sink,
    'ROOM',
  );
  return { sink, installLiveDelivery, revalidateTranscript };
}

describe('enter-room hydration never blocks the foreground', () => {
  it('starts every independent read and the typed snapshot revalidation synchronously', () => {
    const getChannelMetadata = vi.fn(hangs<never>);
    const listCommunities = vi.fn(hangs<never>);
    const getParentChannelId = vi.fn(hangs<never>);
    const { installLiveDelivery, revalidateTranscript } = start(
      hangingClient({ getChannelMetadata, listCommunities }),
      hangingTransport({ getParentChannelId }),
    );

    expect(getChannelMetadata).toHaveBeenCalledWith(CHANNEL);
    expect(listCommunities).toHaveBeenCalled();
    expect(getParentChannelId).toHaveBeenCalledWith(CHANNEL);
    expect(revalidateTranscript).toHaveBeenCalledTimes(1);
    expect(installLiveDelivery).not.toHaveBeenCalled();
  });

  it('publishes the Room name while every unrelated read hangs', async () => {
    const { sink } = start(
      hangingClient({ getChannelMetadata: async () => ({ name: '  Deck  ' }) }),
      hangingTransport(),
    );
    await settle();
    expect(sink.onRoomName).toHaveBeenCalledWith('Deck');
  });

  it('publishes a normalized transcript without waiting for the live handshake', async () => {
    const { sink } = start(hangingClient(), hangingTransport(), {
      revalidateTranscript: async () => emptySync,
    });
    await settle();
    expect(sink.onTranscriptSynced).toHaveBeenCalledWith(emptySync);
  });

  it('closes the push-visible gap with a second snapshot revalidation', async () => {
    const install = deferred<void>();
    const revalidateTranscript = vi.fn(async () => emptySync);
    const { sink } = start(
      hangingClient(),
      hangingTransport({ getParentChannelId: async () => null }),
      { installLiveDelivery: () => install.promise, revalidateTranscript },
    );

    await settle();
    expect(revalidateTranscript).toHaveBeenCalledTimes(1);
    install.resolve();
    await settle();
    expect(revalidateTranscript).toHaveBeenCalledTimes(2);
    expect(sink.onTranscriptSynced).toHaveBeenCalledTimes(2);
  });

  it('hydrates a corner briefing and lifecycle from its typed parent link', async () => {
    const briefing = { task: 'repair parser', context: [] };
    const { sink } = start(
      hangingClient(),
      hangingTransport({
        getParentChannelId: async () => 'parent-room',
        getSubchannelMergeTarget: async () => ({ reason: 'No committed change.' }),
        listSubchannelLifecycle: async () => [],
        cornerBriefing: async () => briefing,
      }),
    );

    await settle();
    expect(sink.onParentChannelId).toHaveBeenCalledWith('parent-room');
    expect(sink.onCornerBriefing).toHaveBeenCalledWith(briefing);
    expect(sink.onCornerLifecycle).toHaveBeenCalledWith([]);
    expect(sink.onMergeNotReadyReason).toHaveBeenCalledWith('No committed change.');
  });

  it('applies nothing after cancellation', async () => {
    const metadata = deferred<{ name?: string } | null>();
    let cancelled = false;
    const sink = handlers();
    void hydrateRoomEntry(
      {
        channelId: CHANNEL,
        viewerPubkey: VIEWER,
        client: hangingClient({ getChannelMetadata: () => metadata.promise }),
        transport: hangingTransport(),
        installLiveDelivery: hangs,
        revalidateTranscript: hangs,
        isCancelled: () => cancelled,
      },
      sink,
    );

    cancelled = true;
    metadata.resolve({ name: 'Too late' });
    await settle();
    expect(sink.onRoomName).not.toHaveBeenCalled();
  });
});
