import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');

describe('Room deck bootstrap', () => {
  it('turns a fresh server Workspace response into the first chats request', () => {
    const workspaceApply = source.slice(
      source.indexOf('workspaceRefresh = new SurfaceRefreshScheduler'),
      source.indexOf('workspaceScheduler.current = workspaceRefresh'),
    );
    expect(workspaceApply).toContain('!value.workspaces.some');
    expect(workspaceApply).toContain("pathname: '/beeline/channels'");
    expect(workspaceApply).toContain('communityId: nextId');
  });

  it('restores the persisted Workspace before choosing server recency order', () => {
    expect(source).toContain('const [storedWorkspaceId, cachedWorkspaces] = await Promise.all([');
    expect(source).toContain('loadActiveCommunityId(nextIdentity.publicKey)');
    expect(source).toContain('mobileSurfaceCache.read(workspaceCacheAddress, isWorkspaceListView)');
    expect(source).toContain(
      'requestedWorkspaceId ?? storedWorkspaceId ?? cachedWorkspaces?.workspaces[0]?.id',
    );
  });

  it('shows the Room loader whenever the Room deck itself is loading', () => {
    expect(source).toContain('<RoomDeckLoadingView');
    expect(source).not.toContain('consumeFirstRoomDeckAfterBoot');
    expect(source).not.toContain('suppressFirstDeckPaint');
    expect(source).not.toContain('suppressPaint=');
  });

  it('puts start-Room and connect-Agent buttons directly on the empty Room deck', () => {
    const emptyDeck = source.slice(
      source.indexOf('function EmptyRoomActions'),
      source.indexOf('function firstParam'),
    );
    expect(emptyDeck).toContain('testID="empty-add-room"');
    expect(emptyDeck).toContain('onPress={onAddRoom}');
    expect(emptyDeck).toContain('testID="empty-connect-agent"');
    expect(emptyDeck).toContain('onPress={onConnectAgent}');
    expect(emptyDeck).toContain('label="Start a Room"');
    expect(emptyDeck).toContain('label="Connect an agent"');
    expect(emptyDeck).not.toContain('label="ADD ROOM"');
    expect(emptyDeck).not.toContain('label="CONNECT AGENT"');
    // Both are the one shared Button, not hand-rolled Pressables.
    expect(emptyDeck.match(/<Button\n/g)).toHaveLength(2);
    expect(emptyDeck).not.toContain('<Pressable');
  });

  it('wires the buttons to the existing Room dialog and shared agent-connect sheet', () => {
    expect(source).toContain('onAddRoom={() => setShowCreateRoom(true)}');
    expect(source).toContain('onConnectAgent={() => void connectAgent()}');
    expect(source).toMatch(/\(\s*await transport\.ensureClient\(\)\s*\)\.createAgentPairingCode\(/);
    expect(source).toContain('<MemberPickerSheet');
    expect(source).toContain('agentConnectOnly');
    expect(source).toContain('testID="empty-agent-connect-sheet"');
    expect(source).toContain('onCopyPairCommand={(command) => void copyPairCommand(command)}');
  });

  it('opens the existing Room dialog for a fresh desktop navigation request', () => {
    expect(source).toContain('requestedNewRoom === handledNewRoomRequest.current');
    expect(source).toContain('handledNewRoomRequest.current = requestedNewRoom');
    expect(source).toContain('setShowCreateRoom(true)');
    expect(source).toContain('!canManageWorkspace');
  });

  it('opens the shared direct-message picker for a fresh desktop DM request', () => {
    expect(source).toContain('handledNewDirectMessageRequest.current = requestedNewDirectMessage');
    expect(source).toContain('setMemberPickerVisible(true)');
    expect(source).toContain('!viewerIsAgent');
  });

  it('refetches an acknowledged Room write without leaving the refreshed deck', () => {
    const createPath = source.slice(
      source.indexOf('const createRoom = useCallback'),
      source.indexOf('const compose = useCallback'),
    );
    expect(createPath).toContain('chatStore.current?.force()');
    expect(createPath).not.toContain('openRoom(roomId)');
  });

  it('does not auto-open a Room before the stored Workspace is read', () => {
    const bootstrap = source.slice(
      source.indexOf('const nextIdentity = await loadBuzzIdentity()'),
      source.indexOf('const [storedWorkspaceId, cachedWorkspaces] = await Promise.all(['),
    );
    expect(bootstrap).not.toContain('claimFirstLaunchLanding');
    expect(bootstrap).not.toContain('welcomeRoomHref');
    expect(bootstrap).not.toContain('/beeline/chat/');
  });

  it('reads the Room list from the app-level store and never seeds a Workspace #h', () => {
    const store = readFileSync(path.join(__dirname, '../../../buzz/chat-list-store.ts'), 'utf8');
    expect(source).toContain('acquireChatList(');
    expect(source).not.toContain('surfaceSubscribe(filters, (event)');
    expect(store).toContain('chatWatchFiltersKey(value.watchFilters) !== this.watchKey');
    expect(store).toContain("this.value?.watchFilters ?? []");
    expect(store).not.toContain("'#h': [");
    expect(store).toContain('if (filters.length === 0) {');
  });
});
