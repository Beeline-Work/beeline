import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const chat = readFileSync(path.join(root, 'chat/[channelId].tsx'), 'utf8');
const surface = readFileSync(path.join(root, 'chat/_chat-surface.tsx'), 'utf8');
const channels = readFileSync(path.join(root, 'channels.tsx'), 'utf8');
const sidebar = readFileSync(path.join(root, '../../../components/SidebarView.tsx'), 'utf8');
const composer = readFileSync(
  path.join(root, '../../../components/buzz/ConversationComposer.tsx'),
  'utf8',
);
const paintBudgets = readFileSync(
  path.join(root, '../../../buzz/monolith-client-paint-budgets.test.ts'),
  'utf8',
);
const openDesign = readFileSync(path.join(root, 'chat/room-open.design.test.ts'), 'utf8');

function sliceAround(source: string, needle: string, before: number, after: number): string {
  const index = source.indexOf(needle);
  expect(index, `missing ${needle}`).toBeGreaterThanOrEqual(0);
  return source.slice(Math.max(0, index - before), index + needle.length + after);
}

/**
 * Honest Room-open contract. A last-message pixel is not a loaded Room:
 * header, transcript (more than the last message), and composer must paint.
 * Scrolling the Room list must not reveal that last-message payload as if
 * the Room had opened.
 */
describe('Room open paints a Room, not the last message', () => {
  it('keeps the 450 ms bar on a full transcript projection, not a last-message paint', () => {
    expect(paintBudgets).toContain('const CLIENT_PAINT_TARGET_MS = 450');
    expect(paintBudgets).toContain('const TRANSCRIPT_MESSAGE_COUNT = 30');
    expect(paintBudgets).toContain('expect(hydrated.messages.length).toBe(TRANSCRIPT_MESSAGE_COUNT)');
    expect(paintBudgets).toContain("function paintTranscript(view: RoomView): number");
    expect(paintBudgets).toContain('projector.project(current.messages, current.viewer.identity.pubkey)');
  });

  it('does not accept last-message-only occupancy as a loaded Room', () => {
    expect(openDesign).not.toContain(
      'keeps newest-row first paint aligned to header+composer and loads history only after a reader scroll',
    );
    expect(openDesign).not.toContain('starts the 6k chrome chunk after the newest-row pixel');
    expect(openDesign).not.toContain("expect(channels).toContain('room-open-deck-overlay')");
    expect(openDesign).not.toContain("expect(channels).toContain('openingSeed')");
    expect(openDesign).not.toContain("expect(channels).toContain('seedRoomOpenPixel')");
    expect(openDesign).not.toContain("expect(chat).toContain('attachChatSurfaceAfterPaint')");
  });

  it('does not overlay the last-message payload on the Room list from a press or scroll', () => {
    expect(channels).not.toContain('room-open-deck-overlay');
    expect(channels).not.toContain('openingSeed');
    expect(channels).not.toContain('setOpeningSeed');
    expect(channels).not.toContain('seedRoomOpenPixel');
    expect(channels).not.toContain('RoomOpenPixel');
    const pressIn = sliceAround(channels, 'onPressIn={() => {', 0, 420);
    expect(pressIn).not.toContain('seedRoomOpenPixel');
    expect(pressIn).not.toContain('setOpeningSeed');
    expect(pressIn).toContain('prefetchRoom');
  });

  it('opens a Room without stacking a second copy of the same channel', () => {
    expect(channels).toContain('navigateToRoom');
    expect(channels).not.toContain('router.push(`/beeline/chat/${encodeURIComponent(id)}`');
    expect(sidebar).toContain('navigateToRoom');
    expect(sidebar).not.toContain('router.push(`/beeline/chat/${encodeURIComponent(id)}`');
  });

  it('opens the Room with header, transcript, and composer instead of a last-message pixel', () => {
    expect(chat).not.toContain('RoomOpenPixel');
    expect(chat).not.toContain('roomOpenPixelSnapshot');
    expect(chat).not.toContain('attachChatSurfaceAfterPaint');
    expect(chat).not.toContain('afterPixelIdle');
    expect(chat).not.toContain("showPixel");
    expect(chat).toContain('useRoomSurfaceSession');
    expect(chat).toMatch(/from ['"]\.\/_chat-surface['"]/);
    expect(chat).toContain('BuzzChatSurface');
    expect(surface).toContain('testID="chat-back"');
    expect(surface).toContain('testID="chat-messages"');
    expect(surface).toContain('<ConversationComposer');
    expect(composer).toContain('testIDPrefix = \'chat\'');
    expect(composer).toContain('${testIDPrefix}-composer-input-row');
  });

  it('a bookmark open lands on that message, not the newest row', () => {
    expect(surface).toContain('notificationMessageId');
    const landing = surface.slice(
      surface.indexOf('useScrollFollowOnArrival'),
      surface.indexOf('Reveal the exact fact'),
    );
    expect(landing).toMatch(/notificationMessageId|messageAnchor/);
    expect(landing).not.toContain('openLandsOnTail: !desktopTranscript');
    expect(landing).toMatch(/if \([^)]*(?:messageAnchor|notificationMessageId)[^)]*\) return/);
  });
});
