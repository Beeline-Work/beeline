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

/** A promise that never settles — the shape of a call on a dead/slow network. */
function hangs<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (e: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Every relay read hangs forever unless a test explicitly overrides it. This
 * is the whole point of the guard: if any UI slice starts depending on a call
 * it does not need, its handler stops firing here and the test fails.
 */
function hangingClient(overrides: Partial<RoomEntryClient> = {}): RoomEntryClient {
  return {
    getChannelMetadata: hangs,
    listMembers: hangs,
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
    ...overrides,
  };
}

function handlers(): RoomEntryHandlers & { [K in keyof RoomEntryHandlers]: ReturnType<typeof vi.fn> } {
  return {
    onCommunities: vi.fn(),
    onViewerIsAgent: vi.fn(),
    onChannelRole: vi.fn(),
    onRoomName: vi.fn(),
    onParentChannelId: vi.fn(),
    onDirectMessage: vi.fn(),
    onWorkspaceId: vi.fn(),
    onMembers: vi.fn(),
    onRoster: vi.fn(),
    onTranscriptSynced: vi.fn(),
    onArchived: vi.fn(),
    onMergeTarget: vi.fn(),
    onCornerStatus: vi.fn(),
    onStepFailed: vi.fn(),
  } as never;
}

const emptySync: RoomTranscriptSync = { entry: { messages: [{}] }, archiveChannel: false };

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

/** Let every already-resolved microtask chain drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('enter-room hydration never blocks the foreground', () => {
  it('starts every independent read without awaiting any of them first', () => {
    const listMembers = vi.fn(hangs<never>);
    const getChannelMetadata = vi.fn(hangs<never>);
    const listCommunities = vi.fn(hangs<never>);
    const getParentChannelId = vi.fn(hangs<never>);
    const { installLiveDelivery, revalidateTranscript } = start(
      hangingClient({ listMembers, getChannelMetadata, listCommunities }),
      hangingTransport({ getParentChannelId }),
    );

    // Synchronously after the call: everything is already in flight. Nothing
    // is sequenced behind a prior round-trip.
    expect(listMembers).toHaveBeenCalledWith(CHANNEL);
    expect(getChannelMetadata).toHaveBeenCalledWith(CHANNEL);
    expect(listCommunities).toHaveBeenCalled();
    expect(getParentChannelId).toHaveBeenCalledWith(CHANNEL);
    expect(revalidateTranscript).toHaveBeenCalled();
    // The live subscription is the one call that only needs the parent link.
    expect(installLiveDelivery).not.toHaveBeenCalled();
  });

  it('publishes the roster while every other read is still hanging', async () => {
    const members = [{ pubkey: 'a' }, { pubkey: 'b' }] as never;
    const { sink } = start(
      hangingClient({ listMembers: () => Promise.resolve(members) }),
      hangingTransport(),
    );

    await settle();
    expect(sink.onMembers).toHaveBeenCalledWith(members);
  });

  it('publishes the Room name while every other read is still hanging', async () => {
    const { sink } = start(
      hangingClient({ getChannelMetadata: () => Promise.resolve({ name: '  Deck  ' }) }),
      hangingTransport(),
    );

    await settle();
    expect(sink.onRoomName).toHaveBeenCalledWith('Deck');
  });

  it('never gates a UI read on the live-subscription handshake', async () => {
    // The WebSocket connect + NIP-42 AUTH behind installLiveDelivery has a
    // 15s timeout. It used to be awaited before any other read even started.
    const installLiveDelivery = vi.fn(() => hangs<void>());
    const { sink } = start(
      hangingClient({
        listMembers: () => Promise.resolve([] as never),
        getChannelMetadata: () => Promise.resolve({ name: 'Deck' }),
        getChannelRole: () => Promise.resolve('member' as never),
        isAgentIdentity: () => Promise.resolve(false),
        listCommunities: () => Promise.resolve([] as never),
      }),
      hangingTransport({
        getParentChannelId: () => Promise.resolve(null),
        isChannelArchived: () => Promise.resolve(true),
      }),
      { installLiveDelivery, revalidateTranscript: () => Promise.resolve(emptySync) },
    );

    await settle();
    expect(installLiveDelivery).toHaveBeenCalledWith({ parentChannelId: null });
    // …and everything a person can see landed anyway.
    expect(sink.onMembers).toHaveBeenCalled();
    expect(sink.onRoomName).toHaveBeenCalledWith('Deck');
    expect(sink.onChannelRole).toHaveBeenCalledWith('member');
    expect(sink.onViewerIsAgent).toHaveBeenCalledWith(false);
    expect(sink.onCommunities).toHaveBeenCalled();
    expect(sink.onArchived).toHaveBeenCalled();
    expect(sink.onTranscriptSynced).toHaveBeenCalled();
  });

  it('does not let one failing read suppress the others', async () => {
    const { sink } = start(
      hangingClient({
        listMembers: () => Promise.reject(new Error('relay 502')),
        getChannelMetadata: () => Promise.resolve({ name: 'Deck' }),
      }),
      hangingTransport(),
    );

    await settle();
    expect(sink.onStepFailed).toHaveBeenCalledWith('members', expect.any(Error));
    expect(sink.onRoomName).toHaveBeenCalledWith('Deck');
  });

  it('resolves a corner Workspace through its parent without blocking the roster of a Room', async () => {
    const listAgents = vi.fn(() => Promise.resolve([{ pubkey: 'agent-1' }] as never));
    const communityMembers = vi.fn(() =>
      Promise.resolve([
        { pubkey: 'agent-1', role: 'member' },
        { pubkey: VIEWER, role: 'admin' },
      ] as never),
    );
    const { sink } = start(
      hangingClient({
        getChannelCommunityId: (id) => Promise.resolve(id === CHANNEL ? null : 'workspace-1'),
        listAgents,
        communityMembers,
        listPersonProfiles: () => Promise.resolve([] as never),
      }),
      hangingTransport({ getParentChannelId: () => Promise.resolve('parent-room') }),
    );

    await settle();
    expect(sink.onParentChannelId).toHaveBeenCalledWith('parent-room');
    expect(sink.onWorkspaceId).toHaveBeenCalledWith('workspace-1');
    expect(listAgents).toHaveBeenCalledWith('workspace-1');
    expect(sink.onRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: 'workspace-1',
        canManageWorkspace: true,
        people: [{ pubkey: VIEWER, role: 'admin' }],
      }),
    );
  });

  it('hands every response to afterInteractions so projection lands after the transition', async () => {
    const queued: (() => void)[] = [];
    const { sink } = start(
      hangingClient({ listMembers: () => Promise.resolve([] as never) }),
      hangingTransport(),
      { afterInteractions: (run) => queued.push(run) },
    );

    await settle();
    // Held, not applied: the navigation transition still owns the frame.
    expect(sink.onMembers).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
    queued.forEach((run) => run());
    expect(sink.onMembers).toHaveBeenCalled();
  });

  it('applies nothing once the screen has been cancelled', async () => {
    const members = deferred<never>();
    let cancelled = false;
    const sink = handlers();
    void hydrateRoomEntry(
      {
        channelId: CHANNEL,
        viewerPubkey: VIEWER,
        client: hangingClient({ listMembers: () => members.promise }),
        transport: hangingTransport(),
        installLiveDelivery: () => hangs<void>(),
        revalidateTranscript: () => hangs<RoomTranscriptSync>(),
        isCancelled: () => cancelled,
      },
      sink,
      'ROOM',
    );

    cancelled = true;
    members.resolve([] as never);
    await settle();
    expect(sink.onMembers).not.toHaveBeenCalled();
  });

  it('retries an empty first transcript off the critical path, not in front of it', async () => {
    const revalidateTranscript = vi
      .fn<() => Promise<RoomTranscriptSync>>()
      .mockResolvedValueOnce({ entry: { messages: [] }, archiveChannel: false })
      .mockResolvedValue({ entry: { messages: [{}] }, archiveChannel: false });
    const { sink } = start(
      hangingClient({ getChannelMetadata: () => Promise.resolve({ name: 'Deck' }) }),
      hangingTransport(),
      { revalidateTranscript, emptyTranscriptRetryMs: 1 },
    );

    await settle();
    // The Room name did not wait for the retry timer.
    expect(sink.onRoomName).toHaveBeenCalledWith('Deck');
    expect(revalidateTranscript).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(revalidateTranscript).toHaveBeenCalledTimes(2);
    expect(sink.onTranscriptSynced).toHaveBeenCalledTimes(2);
  });

  it('closes the push-visible gap once live delivery is genuinely established', async () => {
    // Live delivery is no longer installed before the history read, so an
    // event published between the two would be missed. Readiness triggers one
    // cheap delta read instead of holding the first read back.
    const install = deferred<void>();
    const revalidateTranscript = vi.fn(() => Promise.resolve(emptySync));
    const { sink } = start(
      hangingClient(),
      hangingTransport({ getParentChannelId: () => Promise.resolve(null) }),
      { installLiveDelivery: () => install.promise, revalidateTranscript },
    );

    await settle();
    expect(revalidateTranscript).toHaveBeenCalledTimes(1);

    install.resolve();
    await settle();
    expect(revalidateTranscript).toHaveBeenCalledTimes(2);
    expect(sink.onTranscriptSynced).toHaveBeenCalledTimes(2);
  });
});
