import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const chat = readFileSync(path.join(root, 'chat/[channelId].tsx'), 'utf8');
const pixel = readFileSync(path.join(root, 'chat/_room-open-pixel.tsx'), 'utf8');
const surface = readFileSync(path.join(root, 'chat/_chat-surface.tsx'), 'utf8');
const layout = readFileSync(path.join(root, '../_layout.tsx'), 'utf8');
const load = readFileSync(path.join(root, 'chat/_chat-surface-load.ts'), 'utf8');
const session = readFileSync(path.join(root, 'chat/useRoomSurfaceSession.ts'), 'utf8');
const channels = readFileSync(path.join(root, 'channels.tsx'), 'utf8');
const sidebar = readFileSync(path.join(root, '../../../components/SidebarView.tsx'), 'utf8');
const trace = readFileSync(path.join(root, '../../../buzz/room-open-trace.ts'), 'utf8');
const prefetch = readFileSync(path.join(root, '../../../buzz/room-open-prefetch.ts'), 'utf8');

describe('Room open-to-pixel occupancy', () => {
  it('marks navigation dispatch, route mount, and cache-read separately from auth', () => {
    expect(prefetch).toContain("markRoomOpen('nav-dispatch', roomId)");
    expect(chat).toContain("markRoomOpen('route-mount', decodedId)");
    expect(session).toContain("markRoomOpen('session-effect', channelId)");
    expect(session).toContain("markRoomOpen('cache-read-start')");
    expect(session).toContain("markRoomOpen('auth-start')");
    expect(session.indexOf("markRoomOpen('cache-read-start')")).toBeLessThan(
      session.indexOf("markRoomOpen('auth-start')"),
    );
  });

  it('pushes the Room without a stack animation stealing the tap-to-pixel budget', () => {
    const chatScreen = layout.slice(layout.indexOf('beeline/chat/[channelId]'));
    expect(chatScreen).toContain("animation: 'none'");
  });

  it('starts the 6k chrome chunk after the newest-row pixel, never on the deck tap', () => {
    expect(load).toContain("import('./_chat-surface')");
    expect(load).toContain('surface-preload-start');
    expect(load).toContain('surface-preload-error');
    expect(load).toContain('pending = null');
    expect(chat).toContain('attachChatSurfaceAfterPaint');
    expect(chat).toContain('afterPixelIdle');
    expect(chat).not.toContain("from './_chat-surface'");
    expect(chat).not.toContain('from "./_chat-surface"');
    expect(channels).not.toContain('preloadChatSurface');
    expect(sidebar).not.toContain('preloadChatSurface');
    expect(channels).toContain('RoomOpenPixel');
    expect(channels).toContain('openingSeed');
    expect(channels).toContain('room-open-deck-overlay');
    expect(sidebar).toContain('dispatchRoomOpenTap');
    expect(prefetch).toContain('dispatchRoomOpenTap');
    expect(prefetch).not.toContain('preloadChatSurface');
    expect(chat.indexOf("markRoomOpen('route-mount', decodedId)")).toBeLessThan(
      chat.lastIndexOf('attachChatSurfaceAfterPaint'),
    );
    expect(pixel.indexOf('pixel-ui-frame')).toBeGreaterThanOrEqual(0);
    expect(chat.lastIndexOf('attachChatSurfaceAfterPaint')).toBeGreaterThan(0);
    const gate = chat.slice(
      chat.indexOf('export default function BuzzChat'),
      chat.indexOf('function RoomSessionHost'),
    );
    expect(gate).not.toContain('useRoomSurfaceSession');
    expect(gate).toContain('setSessionOn(true)');
  });

  it('keeps newest-row first paint aligned to header+composer and loads history only after a reader scroll', () => {
    expect(pixel).toContain('const headerReserve = insets.top + 60');
    expect(surface).toContain('loadOlderTranscriptIfReaderAsked');
    expect(surface).toContain('if (!allowOlderHistoryRef.current) return');
    expect(surface).toContain('onEndReached={desktopTranscript ? undefined : loadOlderTranscriptIfReaderAsked}');
    expect(surface).toContain(
      'initialNumToRender={\n              desktopTranscript ? Math.max(1, transcriptMessages.length) : undefined\n            }',
    );
    expect(surface).toContain('formatTerminalTurnOverlay');
    expect(pixel).toContain('roomOpenNewestTextMetrics()');
    expect(pixel).toContain('color: theme.buzz.textPrimary');
    expect(pixel).toContain('pixel-layout-newest');
    expect(channels).toContain('beginRoomOpenPrefetch');
    expect(channels).toContain('seedRoomOpenPixel');
    expect(chat).toContain('roomOpenPixelSeed(decodedId)');
  });

  it('reserves the chrome composer stack without importing ConversationComposer', () => {
    expect(chat).not.toContain('ConversationComposer');
    expect(chat).not.toContain('COMPOSER_SINGLE_LINE_INPUT_HEIGHT');
    expect(pixel).toContain("from '@/buzz/room-open-geometry'");
    expect(pixel).toContain('room-open-pixel-composer-reserve');
    expect(pixel).toContain('ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT');
    expect(pixel).toContain('roomOpenComposerSafePadding(Platform.OS, insets.bottom)');
  });

  it('keeps ROOM_OPEN console probes out of release product', () => {
    expect(trace).toContain('typeof __DEV__ !== \'undefined\' && !__DEV__');
    expect(trace).toContain('[ROOM_OPEN]');
  });
});
