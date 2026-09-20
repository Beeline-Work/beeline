import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const chat = readFileSync(path.join(root, 'chat/[channelId].tsx'), 'utf8');
const surface = readFileSync(path.join(root, 'chat/_chat-surface.tsx'), 'utf8');
const layout = readFileSync(path.join(root, '../_layout.tsx'), 'utf8');
const session = readFileSync(path.join(root, 'chat/useRoomSurfaceSession.ts'), 'utf8');
const channels = readFileSync(path.join(root, 'channels.tsx'), 'utf8');
const sidebar = readFileSync(path.join(root, '../../../components/SidebarView.tsx'), 'utf8');
const trace = readFileSync(path.join(root, '../../../buzz/room-open-trace.ts'), 'utf8');
const prefetch = readFileSync(path.join(root, '../../../buzz/room-open-prefetch.ts'), 'utf8');

describe('Room open occupancy', () => {
  it('marks navigation dispatch, route mount, and cache-read separately from auth', () => {
    expect(prefetch).toContain("markRoomOpen('nav-dispatch', roomId)");
    expect(chat).toContain("markRoomOpen('route-mount', decodedId)");
    expect(session).toContain("markRoomOpen('session-effect', channelId)");
    expect(session).toContain("markRoomOpen('cache-read-start')");
    expect(session).toContain("markRoomOpen('auth-start')");
    expect(session.indexOf("markRoomOpen('cache-read-start')")).toBeLessThan(
      session.indexOf("markRoomOpen('auth-start')"),
    );
    expect(session).toContain('liveDraftDrainStore.setActive(true)');
  });

  it('pushes the Room without a stack animation stealing the tap-to-pixel budget', () => {
    const chatScreen = layout.slice(layout.indexOf('beeline/chat/[channelId]'));
    expect(chatScreen).toContain("animation: 'none'");
  });

  it('mounts the real Room surface instead of a last-message pixel', () => {
    expect(chat).toContain("from './_chat-surface'");
    expect(chat).toContain('BuzzChatSurface');
    expect(chat).toContain('useRoomSurfaceSession');
    expect(chat).not.toContain('RoomOpenPixel');
    expect(chat).not.toContain('attachChatSurfaceAfterPaint');
    expect(chat).not.toContain('afterPixelIdle');
    expect(channels).not.toContain('room-open-deck-overlay');
    expect(channels).not.toContain('openingSeed');
    expect(channels).not.toContain('RoomOpenPixel');
    expect(channels).not.toContain('seedRoomOpenPixel');
    expect(channels).not.toContain('preloadChatSurface');
    expect(sidebar).not.toContain('preloadChatSurface');
    expect(sidebar).toContain('dispatchRoomOpenTap');
    expect(prefetch).toContain('dispatchRoomOpenTap');
    expect(prefetch).not.toContain('seedRoomOpenPixel');
    expect(surface).toContain('testID="chat-back"');
    expect(surface).toContain('testID="chat-messages"');
    expect(surface).toContain('<ConversationComposer');
  });

  it('pauses the live-draft drain before the back action so leave is not queued behind the turn', () => {
    const back = surface.slice(surface.indexOf('const handleBack = useCallback'));
    const pauseAt = back.indexOf('liveDraftStore.setActive(false)');
    const popAt = back.indexOf("if (action.type === 'pop')");
    expect(pauseAt).toBeGreaterThan(0);
    expect(popAt).toBeGreaterThan(pauseAt);
    expect(surface).toContain("navigation.addListener('beforeRemove'");
    expect(surface).toContain('liveDraftStore.setActive(false)');
  });

  it('keeps ROOM_OPEN console probes out of a release product that did not ask for them', () => {
    // The guard used to be "development only", which meant the one build that
    // could answer "why is this Room slow on my phone" was the one build that
    // never ran on a phone. It is now "silent unless this bundle was compiled
    // with the flag", which is every build we ship by default. What must stay
    // true is that a release bundle says nothing on its own.
    expect(trace).toContain('EXPO_PUBLIC_ROOM_OPEN_TRACE');
    expect(trace).toContain('const isDev = typeof __DEV__ !== ');
    expect(trace).toContain('return !isDev && !RELEASE_TRACE_ENABLED;');
    expect(trace).toContain('[ROOM_OPEN]');
  });
});
