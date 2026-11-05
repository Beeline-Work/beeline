import { transitions, deck, viewer, chatList, room, listOf, paintedRows, roomWatch, quiet, mountDeck, fixtureScope1, fixtureScope3, fixtureScope5 } from './channels.test-support';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { RoomViewHttpError, type ChatListView } from '@beeline/buzz-client';
import BuzzChannels from './channels';
import { router } from 'expo-router';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { loadPendingInvite } from '@/buzz/pending-invite';
import { markInitialLandingResolved, suppressInitialLandingNavigation } from '@/navigation/initial-landing';
import Index from '../index';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { ConversationRow } from '@/components/buzz/ConversationRow';
import { dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';
import { applyChatListCorners } from '@/buzz/room-corner-store';

describe('Saved deck cold launch', () => {
const scope1 = fixtureScope1();


  it('starts at the saved deck with synchronous scoped rows before layout, pending invite and live reads', async () => {
    deck.pathname = '/';
    deck.holdLayouts = true;
    scope1.saveDeck();
    let releaseInvite!: (value: string | null) => void;
    deck.storedInvite = new Promise(resolve => { releaseInvite = resolve; });
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<Index />); });
      expect(paintedRows(renderer)[0].latestMessage?.text).toBe('saved before effects');
      expect(router.replace).not.toHaveBeenCalled();
      expect(loadPendingInvite).not.toHaveBeenCalled();
      expect(deck.workspaceReads).toBe(0);
      expect(deck.chatsReads).toBe(0);
      await act(async () => renderer.root.findByProps({ testID: 'room-list-idle' }).props.onLayout());
      await vi.waitFor(() => expect(loadPendingInvite).toHaveBeenCalled());
      expect(deck.chatsReads).toBe(0);
      await act(async () => releaseInvite(null));
      await vi.waitFor(() => expect(deck.chatsReads).toBe(1));
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });


  it('does not let a late pending invite overwrite a Room opened after cached paint', async () => {
    scope1.saveDeck();
    let releaseInvite!: (value: string | null) => void;
    deck.storedInvite = new Promise(resolve => { releaseInvite = resolve; });
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<BuzzChannels />); });
      await vi.waitFor(() => expect(loadPendingInvite).toHaveBeenCalled());
      await act(async () => deck.blur?.());
      await act(async () => releaseInvite('bzi_' + 'ab'.repeat(32)));
      expect(router.replace).not.toHaveBeenCalled();
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });


  it('never restores another viewer cache into the signed-in deck', async () => {
    deck.holdLayouts = true;
    scope1.saveDeck();
    vi.mocked(loadBuzzIdentity).mockResolvedValue({ publicKey: 'other-viewer', secretKey: new Uint8Array(32) });
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<BuzzChannels />); });
      expect(renderer.root.findAllByProps({ testID: 'room-list' })).toHaveLength(0);
      expect(deck.chatsReads).toBe(0);
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });


  it.each([
    ['https://usebeeline.app/join/bzi_' + 'ab'.repeat(32), '/join/[token]', 'token', 'bzi_' + 'ab'.repeat(32)],
    ['beeline://review/play-review-secret-value-0001', '/review/[secret]', 'secret', 'play-review-secret-value-0001'],
    ['beeline://review/short', '/review/[secret]', 'secret', 'short'],
  ])('keeps the explicit launch destination authoritative: %s', async (url, pathname, key, value) => {
    deck.pathname = '/'; deck.initialUrl = url; scope1.saveDeck();
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<Index />); });
      expect(router.replace).toHaveBeenCalledWith({ pathname, params: { [key]: value } });
      expect(renderer.root.findAllByProps({ testID: 'room-list' })).toHaveLength(0);
      expect(deck.chatsReads).toBe(0);
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });


  it.each([false, true])('keeps absent identity / unfinished naming in onboarding (naming=%s)', async naming => {
    deck.pathname = '/'; deck.naming = naming;
    if (!naming) vi.mocked(loadBuzzIdentity).mockResolvedValue(null);
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<Index />); });
      expect(router.replace).toHaveBeenCalledWith('/beeline/onboarding');
      expect(deck.chatsReads).toBe(0);
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });


  it('keeps unfinished naming authoritative when Back reveals an already-resolved root', async () => {
    markInitialLandingResolved();
    deck.pathname = '/'; deck.naming = true;
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<Index />); });
      expect(router.replace).toHaveBeenCalledWith('/beeline/onboarding');
      expect(deck.chatsReads).toBe(0);
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });


  it('does not overwrite a tapped push when local restoration completes late, then shows the deck on Back', async () => {
    deck.pathname = '/'; deck.holdLayouts = true; scope1.saveDeck();
    let restore!: (value: any) => void;
    vi.mocked(loadBuzzIdentity).mockImplementationOnce(() => new Promise(resolve => { restore = resolve; }));
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => { renderer = create(<Index />); });
      suppressInitialLandingNavigation();
      deck.pathname = '/beeline/chat/pushed';
      await act(async () => renderer.update(<Index />));
      await act(async () => restore({ publicKey: scope1.savedViewer, secretKey: new Uint8Array(32) }));
      expect(renderer.toJSON()).toBeNull();
      expect(router.replace).not.toHaveBeenCalled();
      deck.pathname = '/';
      await act(async () => renderer.update(<Index />));
      expect(paintedRows(renderer)[0].latestMessage?.text).toBe('saved before effects');
      expect(router.replace).not.toHaveBeenCalled();
    } finally { if (renderer) await act(async () => renderer.unmount()); }
  });
});


it('paints saved Rooms while background transitions wait, then yields live reconciliation', async () => {
  const saved = chatList({ id: 'm1', text: 'saved preview', createdAt: 10 });
  const fresh = chatList({ id: 'm2', text: 'fresh preview', createdAt: 11 });
  let reply!: (value: ChatListView) => void;
  deck.chatsResponse = new Promise<ChatListView>((resolve) => { reply = resolve; });
  const workspaces = { workspaces: [{ id: 'workspace', name: 'Work', role: 'member' as const, updatedAt: 1 }], viewer, truncated: false, watchFilters: [] };
  vi.mocked(mobileSurfaceCache.read).mockImplementation(async (address) => {
    await Promise.resolve();
    const value = String(address).includes('/workspaces') ? workspaces : String(address).includes('/workspace/:id/chats') ? saved : null;
    if (value) mobileSurfaceCache.publish(address, value, (() => true) as never);
    return value;
  });
  transitions.held = true;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(React.createElement(BuzzChannels)); });
    await vi.waitFor(() => expect(paintedRows(renderer)[0]?.latestMessage?.text).toBe('saved preview'));
    await act(async () => reply(fresh));
    expect(paintedRows(renderer)[0]?.latestMessage?.text).toBe('saved preview');
    expect(transitions.pending.length).toBeGreaterThan(0);
    await act(async () => { for (const work of transitions.pending.splice(0)) work(); });
    expect(paintedRows(renderer)[0]?.latestMessage?.text).toBe('fresh preview');
  } finally {
    transitions.held = false;
    transitions.pending = [];
    if (renderer) await act(async () => renderer.unmount());
  }
});
describe('Persisted Workspace bootstrap', () => {
  it('waits for the stored Workspace and reads its Rooms ahead of the recency-first Workspace', async () => {
    deck.deferWorkspaceSelection = true;
    const recent = { id: 'recent', name: 'Recent', role: 'member' as const, updatedAt: 100 };
    const stored = { id: 'workspace', name: 'Work', role: 'member' as const, updatedAt: 1 };
    const workspaces = { workspaces: [recent, stored], viewer, truncated: false, watchFilters: [] };
    deck.workspacesResponse = workspaces;
    vi.mocked(mobileSurfaceCache.read).mockImplementation(async (address) =>
      String(address).includes('/workspaces') ? workspaces : null,
    );
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChannels));
    });
    await vi.waitFor(() => expect(deck.workspaceSelectionListener).not.toBeNull());
    expect(deck.workspaceReads).toBe(0);
    expect(deck.chatsWorkspaces).toEqual([]);
    expect(mobileSurfaceCache.read).not.toHaveBeenCalled();
    await act(async () => deck.workspaceSelectionListener!('workspace'));
    await vi.waitFor(() => expect(deck.chatsWorkspaces).toEqual(['workspace']));
    expect(paintedRows(renderer).map((item) => item.room.id)).toEqual(['room-a']);
    expect(router.replace).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
describe('New sign-in workspace landing (SIGNUP-LANDING-1)', () => {
const scope3 = fixtureScope3();

  it('shows the shared Retry after a failed discovery and reads on Retry', async () => {
    deck.selectedWorkspace=null;deck.workspacesResponse={workspaces:[],viewer,truncated:false,watchFilters:[]};
    deck.workspaceFailures=[new RoomViewHttpError(0,'timeout')];
    let renderer!:ReactTestRenderer;
    await act(async()=>{renderer=create(React.createElement(BuzzChannels));});await quiet();
    expect(deck.workspaceReads).toBe(1);
    expect(router.replace).not.toHaveBeenCalledWith('/beeline/community');
    await act(async()=>deck.subscriptions.find(entry=>entry.filters.some((filter:any)=>filter.kinds?.includes(9000)))!.emit({monolithLive:{type:'invalidate',roomId:'',reason:'reconnect'}}));await quiet();
    expect(deck.workspaceReads).toBe(2);expect(router.replace).toHaveBeenCalledWith('/beeline/community');
    await act(async()=>renderer.unmount());
  });


  it('demonstrates the landing through the real guarded workspace socket reader', async () => {
    const { monolithSession, MonolithRequestTimeoutError } =
      await import('@/auth/monolith-session');
    const http = vi.spyOn(monolithSession, 'fetch');
    const request = deck.socketRequest
      .mockRejectedValueOnce(new MonolithRequestTimeoutError())
      .mockResolvedValueOnce({
        workspaces: [],
        viewer: { pubkey: 'a'.repeat(64), name: 'New user', kind: 'human' },
        watchFilters: [],
        truncated: false,
      });
    deck.selectedWorkspace = null;
    deck.useRealWorkspaceRead = true;
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(React.createElement(BuzzChannels));
      });
      await quiet();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      await act(async()=>deck.subscriptions.find(entry=>entry.filters.some((filter:any)=>filter.kinds?.includes(9000)))!.emit({monolithLive:{type:'invalidate',roomId:'',reason:'reconnect'}}));
      await quiet();
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.every(([operation]) => operation === 'readWorkspaces')).toBe(true);
      expect(http).not.toHaveBeenCalled();
      expect(router.replace).toHaveBeenCalledWith('/beeline/community');
      expect(renderer.root.findAllByProps({ action: 'Retry' })).toHaveLength(0);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      http.mockRestore();
    }
  });


  it('does not infer a connection error from stalled local identity restoration', async () => {
    vi.useFakeTimers();deck.selectedWorkspace=null;
    vi.mocked(loadBuzzIdentity).mockImplementationOnce(()=>new Promise(()=>{}));
    let renderer!: ReactTestRenderer;
    try {
      await act(async()=>{renderer=create(React.createElement(BuzzChannels));});
      await act(async()=>{await vi.advanceTimersByTimeAsync(35_000);});
      expect(renderer.root.findAllByProps({testID:'room-deck-unavailable'})).toHaveLength(0);
      expect(renderer.root.findAllByProps({testID:'connection-status-disconnected'})).toHaveLength(0);
      expect(deck.workspaceReads).toBe(0);
    } finally {if(renderer)await act(async()=>renderer.unmount());vi.useRealTimers();}
  });

  it('does not add a second recovery surface for a socket read timeout', async () => {
    deck.selectedWorkspace=null;deck.workspaceFailures=[new RoomViewHttpError(0,'timeout')];
    let renderer!:ReactTestRenderer;
    try {
      await act(async()=>{renderer=create(React.createElement(BuzzChannels));});await quiet();
      expect(deck.workspaceReads).toBe(1);
      expect(renderer.root.findAllByProps({testID:'room-deck-error-retry'})).toHaveLength(0);
      expect(renderer.root.findAllByProps({testID:'connection-status-disconnected'})).toHaveLength(0);
      expect(router.replace).not.toHaveBeenCalledWith('/beeline/community');
    } finally {if(renderer)await act(async()=>renderer.unmount());}
  });

  it('keeps startup failure recovery visible while the socket is connected', async () => {
    deck.selectedWorkspace = null;
    deck.connectionState = 'connected';
    deck.workspaceFailures = [new RoomViewHttpError(503, 'unavailable')];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChannels));
    });
    await quiet();
    expect(renderer.root.findAllByType('Text').length).toBeGreaterThan(0);
    const retry = renderer.root.findByProps({ testID: 'room-deck-error-retry' });
    await act(async () => {
      retry.props.onPress();
    });
    await quiet();
    expect(deck.workspaceReads).toBe(2);
    expect(deck.reconnects).toBe(1);
    expect(renderer.root.findAllByProps({ testID: 'connection-status-disconnected' })).toHaveLength(
      0,
    );
    await act(async () => renderer.unmount());
  });


  it('does not retry a server refusal as a transient startup timeout', async () => {
    deck.selectedWorkspace = null;
    deck.workspaceFailures = [new RoomViewHttpError(403, 'forbidden')];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChannels));
    });
    await quiet();
    expect(deck.workspaceReads).toBe(1);
    expect(renderer.root.findAllByProps({ testID: 'room-deck-error-retry' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'room-deck-unavailable' }).length).toBeGreaterThan(0);
    expect(router.replace).not.toHaveBeenCalledWith('/beeline/community');
    await act(async () => renderer.unmount());
  });


  it('keeps saved Rooms without a per-screen connection banner when a later read fails', async () => {
    deck.connectionState = 'disconnected';
    const renderer = await mountDeck();
    const reads = deck.workspaceReads;
    deck.workspaceFailures = [new RoomViewHttpError(503, 'unavailable')];
    const workspaceWatch = deck.subscriptions.find((entry) =>
      entry.filters.some((filter: any) => filter.kinds?.includes(9000)),
    );
    expect(workspaceWatch).toBeTruthy();
    await act(async () =>
      workspaceWatch!.emit({
        monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:workspaces' },
      }),
    );
    await quiet();
    expect(deck.workspaceReads).toBe(reads + 1);
    expect(paintedRows(renderer)[0]!.latestMessage?.text).toBe('earlier');
    expect(renderer.root.findAllByProps({ testID: 'room-deck-unavailable' })).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ testID: 'connection-status-disconnected' }).length,
    ).toBe(0);
    expect(
      renderer.root.findAllByProps({ testID: 'connection-status-reconnect' }).length,
    ).toBe(0);
    await act(async () => renderer.unmount());
  });
});
describe('Deleted workspace removal', () => {
  it('removes a cached deleted workspace on the first read after an offline session', async () => {
    vi.mocked(mobileSurfaceCache.read).mockResolvedValue(chatList({ id: 'cached', text: 'old room', createdAt: 1 }) as never);
    deck.workspacesResponse = { workspaces: [], viewer, truncated: false, watchFilters: [] };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChannels));
    });
    await quiet();
    expect(router.replace).toHaveBeenCalledWith('/beeline/community');
    expect(saveActiveCommunityId).toHaveBeenCalledWith('viewer', null);
    expect(mobileSurfaceCache.remove).toHaveBeenCalled();
    expect(renderer.root.findAllByType('SectionList')).toHaveLength(0);
    await act(async () => renderer.unmount());
  });


  it('does not repaint deleted rooms when an older chats read finishes late', async () => {
    const renderer = await mountDeck();
    let finish!: (value: ChatListView) => void;
    deck.chatsResponse = new Promise<ChatListView>((resolve) => {
      finish = resolve;
    });
    act(() =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'resync' },
      }),
    );
    await quiet();
    deck.workspacesResponse = { workspaces: [], viewer, truncated: false, watchFilters: [] };
    const workspaceWatch = deck.subscriptions.find(
      (entry) => !entry.filters.some((filter) => filter['#h']?.length),
    );
    act(() =>
      workspaceWatch!.emit({
        monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' },
      }),
    );
    await quiet();
    await act(async () => finish(chatList({ id: 'late', text: 'deleted data', createdAt: 1 })));
    expect(renderer.root.findAllByType('SectionList')).toHaveLength(0);
    expect(router.replace).toHaveBeenCalledWith('/beeline/community');
    await act(async () => renderer.unmount());
  });


  it('drops a deleted workspace tile and opens the remaining workspace', async () => {
    const renderer = await mountDeck();
    deck.workspacesResponse = {
      workspaces: [{ id: 'remaining', name: 'Remaining', role: 'member', updatedAt: 1 }],
      viewer,
      truncated: false,
      watchFilters: [],
    };
    const workspaceWatch = deck.subscriptions.find(
      (entry) => !entry.filters.some((filter) => filter['#h']?.length),
    );
    act(() =>
      workspaceWatch!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: '',
          reason: 'postgres:memberships',
        },
      }),
    );
    await quiet();
    expect(mobileSurfaceCache.write).toHaveBeenCalledWith(
      expect.anything(),
      deck.workspacesResponse,
      expect.any(Function),
    );
    expect(vi.mocked(router.replace)).toHaveBeenCalledWith({
      pathname: '/beeline/channels',
      params: { communityId: 'remaining' },
    });
    expect(vi.mocked(saveActiveCommunityId)).toHaveBeenCalledWith('viewer', 'remaining');
    expect(renderer.root.findAllByType('SectionList')).toHaveLength(0);
    await act(async () => renderer.unmount());
  });


  it('clears the last workspace rooms and persisted selection after live deletion', async () => {
    const renderer = await mountDeck();
    expect(paintedRows(renderer)).toHaveLength(1);
    deck.workspacesResponse = {
      workspaces: [],
      viewer,
      truncated: false,
      watchFilters: [],
      deletedNotices: [{ workspaceId: 'workspace', workspaceName: 'Work' }],
    };
    const workspaceWatch = deck.subscriptions.find(
      (entry) => !entry.filters.some((filter) => filter['#h']?.length),
    );
    act(() =>
      workspaceWatch!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: '',
          reason: 'postgres:memberships',
        },
      }),
    );
    await quiet();
    expect(vi.mocked(router.replace)).toHaveBeenCalledWith('/beeline/community');
    expect(vi.mocked(saveActiveCommunityId)).toHaveBeenCalledWith('viewer', null);
    expect(renderer.root.findAllByType('BuzzCommunityShell')).toHaveLength(0);
    expect(renderer.root.findAllByType('SectionList')).toHaveLength(0);
    await act(async () => renderer.unmount());
  });
});
describe('Room list gestures', () => {
const scope5 = fixtureScope5();


  it('blocks vertical drags and their late release, then accepts a resting tap without delay', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    const list = scope5.listIn(renderer);
    expect(scope5.swipeIn(renderer).props).toMatchObject({
      enabled: true,
      activeOffsetX: [-15, 15],
      failOffsetY: [-10, 10],
    });
    act(() => {
      expect(scope5.touchIn(renderer).props.onStartShouldSetResponderCapture()).toBe(false);
      list.props.onScrollBeginDrag();
      scope5.pressIn(renderer).props.onPress();
    });
    expect(scope5.swipeIn(renderer).props.enabled).toBe(false);
    expect(dispatchRoomOpenTap).not.toHaveBeenCalled();
    act(() => {
      list.props.onScrollEndDrag({
        nativeEvent: { velocity: { y: 0 }, contentOffset: { y: 100 } },
      });
      scope5.touchIn(renderer).props.onTouchEnd();
      scope5.pressIn(renderer).props.onPress();
    });
    expect(dispatchRoomOpenTap).not.toHaveBeenCalled();
    expect(scope5.swipeIn(renderer).props.enabled).toBe(true);
    act(() => {
      scope5.touchIn(renderer).props.onStartShouldSetResponderCapture();
      scope5.pressIn(renderer).props.onPress();
    });
    expect(dispatchRoomOpenTap).toHaveBeenCalledOnce();
    console.log(
      'Vertical drag and late release: no Room opened; next resting tap opens immediately',
    );
    act(() => renderer.unmount());
  });


  it('keeps swipes disabled between fling release and momentum-begin, and until a stop touch ends', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    const list = scope5.listIn(renderer);
    act(() => {
      scope5.touchIn(renderer).props.onStartShouldSetResponderCapture();
      list.props.onScrollBeginDrag();
      list.props.onScrollEndDrag({
        nativeEvent: { velocity: { y: -2 }, contentOffset: { y: 100 } },
      });
      scope5.touchIn(renderer).props.onTouchEnd();
    });
    expect(scope5.swipeIn(renderer).props.enabled).toBe(false);
    act(() => {
      list.props.onMomentumScrollBegin();
      scope5.touchIn(renderer).props.onStartShouldSetResponderCapture();
      list.props.onMomentumScrollEnd();
    });
    expect(scope5.swipeIn(renderer).props.enabled).toBe(false);
    act(() => scope5.touchIn(renderer).props.onTouchEnd());
    expect(scope5.swipeIn(renderer).props.enabled).toBe(true);
    console.log('Fling and coast-stop touch: swipes disabled; release at rest: swipes enabled');
    act(() => renderer.unmount());
  });


  it('handles drag receipts without velocity and cancels settlement when momentum begins', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    const list = scope5.listIn(renderer);
    vi.useFakeTimers();
    try {
      act(() => {
        scope5.touchIn(renderer).props.onStartShouldSetResponderCapture();
        list.props.onScrollBeginDrag();
        list.props.onScrollEndDrag({ nativeEvent: { contentOffset: { y: 100 } } });
        scope5.touchIn(renderer).props.onTouchEnd();
      });
      expect(scope5.swipeIn(renderer).props.enabled).toBe(false);
      act(() => vi.advanceTimersByTime(16));
      expect(scope5.swipeIn(renderer).props.enabled).toBe(true);
      act(() => {
        list.props.onScrollBeginDrag();
        list.props.onScrollEndDrag({ nativeEvent: { contentOffset: { y: 100 } } });
        list.props.onMomentumScrollBegin();
        vi.advanceTimersByTime(16);
      });
      expect(scope5.swipeIn(renderer).props.enabled).toBe(false);
      act(() => list.props.onMomentumScrollEnd());
      expect(scope5.swipeIn(renderer).props.enabled).toBe(true);
    } finally {
      act(() => renderer.unmount());
      vi.useRealTimers();
    }
  });


  it('blocks a corner long press and toggle during scrolling', async () => {
    deck.renderRows = true;
    deck.chatsResponse = listOf([
      room('room-a', 10, {
        cornerCount: 1,
        openCorners: [{ id: 'corner-1', name: 'fix', state: 'working', mine: true }],
      }),
    ]);
    const renderer = await mountDeck();
    const list = scope5.listIn(renderer);
    const glyph = () =>
      renderer.root.find(
        (node: any) => node.type === 'Pressable' && node.props.testID === 'room-room-a-corners',
      );
    await act(async () => {
      list.props.onScrollBeginDrag();
      glyph().props.onPress();
      await glyph().props.onLongPress();
    });
    expect(deck.createCorner).not.toHaveBeenCalled();
    expect(glyph().props.accessibilityState.expanded).toBe(false);
    act(() => renderer.unmount());
  });


  it('blocks the iOS bounce-stop touch when momentum-end arrives before touch-start', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    const list = scope5.listIn(renderer);
    vi.useFakeTimers();
    try {
      act(() => {
        list.props.onMomentumScrollBegin();
        list.props.onMomentumScrollEnd();
        scope5.touchIn(renderer).props.onStartShouldSetResponderCapture();
        scope5.touchIn(renderer).props.onTouchEnd();
        scope5.pressIn(renderer).props.onPress();
      });
      expect(dispatchRoomOpenTap).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(16);
        scope5.touchIn(renderer).props.onStartShouldSetResponderCapture();
        scope5.pressIn(renderer).props.onPress();
      });
      expect(dispatchRoomOpenTap).toHaveBeenCalledOnce();
    } finally {
      act(() => renderer.unmount());
      vi.useRealTimers();
    }
  });


  it('keeps a coast-stopping touch from opening the Room after momentum ends', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    vi.useFakeTimers();
    try {
      const list = scope5.listIn(renderer);
      const rowPress = () => scope5.pressIn(renderer);
      act(() => {
        list.props.onScrollBeginDrag?.();
        list.props.onScrollEndDrag?.({
          nativeEvent: { velocity: { y: 2 }, contentOffset: { y: 100 } },
        });
        list.props.onMomentumScrollBegin?.();
        scope5.touchIn(renderer).props.onStartShouldSetResponderCapture?.();
        list.props.onMomentumScrollEnd?.();
        scope5.touchIn(renderer).props.onTouchEnd?.();
        rowPress().props.onPress();
      });
      expect(dispatchRoomOpenTap).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      console.log(
        'Reproduction room-list-coast: fling → touch row → momentum ends → release: no Room opened',
      );
      // Native setTimeout(16) can return after only 15 ms on Date.now's clock.
      // Prove both sides of the guard with the same clock the hook reads.
      act(() => {
        vi.advanceTimersByTime(15);
        scope5.touchIn(renderer).props.onStartShouldSetResponderCapture();
        rowPress().props.onPress();
      });
      expect(dispatchRoomOpenTap).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
        scope5.touchIn(renderer).props.onStartShouldSetResponderCapture();
        rowPress().props.onPress();
      });
      expect(dispatchRoomOpenTap).toHaveBeenCalledOnce();
      console.log('Resting tap: Room open dispatched immediately');
    } finally {
      act(() => renderer.unmount());
      vi.useRealTimers();
    }
  });
});
describe('Room deck live path', () => {
  it('sends an invite parked before sign-in to its own screen instead of the deck', async () => {
    const token = `bzi_${'a'.repeat(64)}`;
    deck.storedInvite = token;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChannels));
    });
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/join/[token]',
        params: { token },
      }),
    );
    // The deck stops there: no Workspace or chats read, no watches.
    expect(deck.chatsReads).toBe(0);
    expect(deck.subscriptions).toHaveLength(0);
    await act(async () => renderer.unmount());
  });


  it('requests a private repository from the Room creation sheet', async () => {
    const renderer = await mountDeck();
    const sheet = renderer.root.findByType('NewRoomDialog');

    await act(async () => sheet.props.handleCreateRepository(78, 'new-repo'));

    expect(deck.createRepository).toHaveBeenCalledWith({
      installationId: 78,
      name: 'new-repo',
      private: true,
    });
    await act(async () => renderer.unmount());
  });


  it('keeps the final lobby card above the bottom safe area', async () => {
    deck.bottomInset = 34;
    const renderer = await mountDeck();
    const list = renderer.root.find(
      (node: { type: unknown; props: { testID?: string } }) =>
        node.type === 'SectionList' && node.props.testID === 'room-list',
    );
    const contentStyles = [list.props.contentContainerStyle].flat().filter(Boolean);

    expect(contentStyles.at(-1)).toMatchObject({ paddingBottom: 58 });
  });


  it("toggles the Room's corner dropdown on mobile without a selected conversation state", async () => {
    const renderer = await mountDeck();
    const item = paintedRows(renderer)[0]!;
    // The row and its dropdown read the Room's corners from the corner store.
    applyChatListCorners(
      [
        {
          room: item.room,
          cornerCount: 1,
          openCorners: [
            { id: 'corner-1', name: 'fix', state: 'working' as const, mine: true as const },
          ],
        },
      ],
      -1,
    );
    const renderRow = () => {
      const list = renderer.root.find((node: any) => node.type === 'SectionList');
      return create(list.props.renderItem({ item, index: 0, section: { data: [item] } }));
    };
    let row: ReactTestRenderer;
    await act(async () => {
      row = renderRow();
    });
    const conversation = row!.root.findByType(ConversationRow);
    expect(conversation.props.selected).toBeUndefined();
    expect(conversation.props.cornersExpanded).toBe(false);
    act(() => conversation.props.onToggleCorners(conversation.props.item.room.id));
    expect(router.push).not.toHaveBeenCalled();
    let opened: ReactTestRenderer;
    await act(async () => {
      opened = renderRow();
    });
    expect(opened!.root.findByType(ConversationRow).props.cornersExpanded).toBe(true);
    expect(
      opened!.root.findAllByProps({ testID: 'desktop-corner-corner-1' }).length,
    ).toBeGreaterThan(0);
    act(() => {
      row!.unmount();
      opened!.unmount();
      renderer.unmount();
    });
  });


  it('opens a new corner from a long press on the row corner glyph and lands in it', async () => {
    const renderer = await mountDeck();
    const list = renderer.root.find((node: any) => node.type === 'SectionList');
    let row: ReactTestRenderer;
    await act(async () => {
      row = create(
        list.props.renderItem({
          item: { ...paintedRows(renderer)[0], cornerCount: 1 },
          index: 0,
          section: { data: [paintedRows(renderer)[0]] },
        }),
      );
    });
    const conversation = row!.root.findByType(ConversationRow);
    vi.mocked(router.push).mockClear();
    await act(async () => {
      await conversation.props.onLongPressCorners(conversation.props.item.room.id);
    });

    expect(deck.createCorner).toHaveBeenCalledOnce();
    const [roomId, title] = deck.createCorner.mock.calls[0]!;
    expect(roomId).toBe('room-a');
    expect(title).toMatch(/-corner$/);
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'corner-new', parent: 'room-a', title, returnTo: 'room-list' },
    });
    act(() => {
      row!.unmount();
      renderer.unmount();
    });
  });
});
