import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const composer = readFileSync(new URL('./ConversationComposer.tsx', import.meta.url), 'utf8');
const room = readFileSync(
  new URL('../../app/(app)/beeline/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const desktop = readFileSync(new URL('../DesktopRoomInspector.tsx', import.meta.url), 'utf8');

const styleBlock = (start: string, end: string) =>
  composer.slice(composer.indexOf(start), composer.indexOf(end));

describe('Option A composer chrome', () => {
  it('draws the single-line 44px surface with approved geometry and semantic tokens', () => {
    const surface = styleBlock('  composer: {', '  composerMultiline:');
    expect(surface).toContain('minHeight: 44');
    expect(surface).toContain("alignItems: 'center'");
    expect(surface).toContain('paddingVertical: 8');
    expect(surface).toContain('paddingHorizontal: 10');
    expect(surface).toContain('borderRadius: 10');
    expect(surface).toContain('borderWidth: 1');
    expect(surface).toContain('borderColor: theme.buzz.border');
    expect(surface).toContain('backgroundColor: theme.buzz.bgRaised');
  });

  it('keeps the border one pixel and changes only its token on focus', () => {
    const focused = styleBlock('  composerFocused: {', '  attachButton:');
    expect(focused).toContain('borderColor: theme.buzz.accent');
    expect(focused).not.toContain('borderWidth: 2');
    expect(focused).not.toMatch(/shadow|glow/i);
  });

  it('uses muted chrome until text is present and preserves the brass held fill', () => {
    expect(composer).toContain('sendDisabled && styles.sendButtonTextDisabled');
    expect(composer).toContain('sendButtonTextDisabled: { color: theme.buzz.textMuted }');
    expect(composer).toContain('sendButtonArmed: { backgroundColor: theme.buzz.accent');
    expect(composer).toContain('attachButtonText: {\n    ...theme.buzz.type.body,\n    color: theme.buzz.textMuted');
    expect(composer.match(/hitSlop=\{9\}/g)).toHaveLength(2);
  });

  it('holds Rooms, DMs, corners, and desktop to 16px side margins', () => {
    expect(room).toContain("inputBar: {\n      paddingHorizontal: 16");
    expect(desktop).toContain('cockpitComposer: { paddingHorizontal: 16');
    expect(room).toContain('<ConversationComposer');
    expect(desktop).toContain('<ConversationComposer');
  });
});
