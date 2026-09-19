import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const chat = readFileSync(path.join(root, 'chat/[channelId].tsx'), 'utf8');
const surface = readFileSync(path.join(root, 'chat/chat-surface.tsx'), 'utf8');
const layout = readFileSync(path.join(root, '../_layout.tsx'), 'utf8');
const session = readFileSync(path.join(root, 'chat/useRoomSurfaceSession.ts'), 'utf8');
const channels = readFileSync(path.join(root, 'channels.tsx'), 'utf8');

describe('Room open-to-pixel occupancy', () => {
  it('marks navigation dispatch, route mount, and cache-read separately from auth', () => {
    expect(channels).toContain("markRoomOpen('nav-dispatch', roomId)");
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

  it('imports the 6k chrome module only after the newest-row shell commits', () => {
    expect(chat).toContain("import('./chat-surface')");
    expect(chat).not.toContain("from './chat-surface'");
    expect(chat).not.toContain('from "./chat-surface"');
    expect(chat.indexOf("markRoomOpen('route-mount', decodedId)")).toBeLessThan(
      chat.indexOf("import('./chat-surface')"),
    );
  });

  it('keeps newest-row first paint aligned to header+composer and loads history only after a reader scroll', () => {
    expect(chat).toContain('const headerReserve = insets.top + 60');
    expect(surface).toContain('loadOlderTranscriptIfReaderAsked');
    expect(surface).toContain('if (!allowOlderHistoryRef.current) return');
    expect(surface).toContain('onEndReached={desktopTranscript ? undefined : loadOlderTranscriptIfReaderAsked}');
    expect(surface).toContain('initialNumToRender={Math.max(1, transcriptMessages.length)}');
    expect(chat).toContain('color: theme.buzz.textPrimary');
    expect(chat).toContain('pixel-layout-newest');
    expect(channels).toContain('beginRoomOpenPrefetch');
    expect(channels).toContain('seedRoomOpenPixel');
    expect(chat).toContain('roomOpenPixelSeed(decodedId)');
  });
});
