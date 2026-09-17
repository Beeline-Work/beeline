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
    const inputRow = styleBlock('  inputRow: {', '  composerMultiline:');
    expect(surface).toContain('minHeight: 44');
    expect(inputRow).toContain("alignItems: 'center'");
    expect(inputRow).toContain('paddingVertical: 8');
    expect(inputRow).toContain('paddingHorizontal: 10');
    expect(surface).toContain('borderRadius: 10');
    expect(surface).toContain('borderWidth: 1');
    expect(surface).toContain('borderColor: theme.buzz.border');
    expect(surface).toContain('backgroundColor: theme.buzz.bgRaised');
  });

  it('centers Android text within the fixed-height input without trimming font bounds', () => {
    expect(composer).toContain("inputAndroid: { textAlignVertical: 'center' }");
    expect(composer).not.toContain('includeFontPadding: false');
    expect(composer).toContain("textAlignVertical: 'top'");
  });

  it('keeps reply quotes and staged files inside the one composer hairline', () => {
    expect(composer).toContain('testID={`${testIDPrefix}-composer-adjuncts`}');
    expect(composer).toContain('testID="reply-composer-banner"');
    expect(composer).toContain('Replying to');
    expect(composer).toContain('visibleAttachments = attachments.slice(0, 3)');
    expect(composer).toContain('{hiddenAttachmentCount} more');
    expect(composer).not.toContain('borderStrong');
    expect(room.indexOf('reply-composer-banner')).toBe(-1);
    expect(room).toContain('reply={');
    expect(room).toContain('attachments={pendingAttachments.map');
  });

  it('keeps the border one pixel and changes only its token on focus', () => {
    const focused = styleBlock('  composerFocused: {', '  attachButton:');
    expect(focused).toContain('borderColor: theme.buzz.accent');
    expect(focused).not.toContain('borderWidth: 2');
    expect(focused).not.toMatch(/shadow|glow/i);
  });

  it('uses muted chrome until text is present and keeps the send control always renderable', () => {
    expect(composer).toContain('sendDisabled && styles.sendButtonTextDisabled');
    expect(composer).toContain('sendButtonTextDisabled: { color: theme.buzz.textMuted }');
    expect(composer).toContain('const showSend = !showMic;');
    expect(composer).not.toContain('sendButtonArmed');
    expect(composer).toContain(
      'attachButtonText: {\n    ...theme.buzz.type.body,\n    color: theme.buzz.textMuted',
    );
    expect(composer.match(/hitSlop=\{9\}/g)).toHaveLength(3);
  });

  it('holds Rooms, DMs, corners, and desktop to 16px side margins', () => {
    expect(room).toContain('inputBar: {\n      paddingHorizontal: 16');
    expect(desktop).toContain('cockpitComposer: { paddingHorizontal: 16');
    expect(room).toContain('<ConversationComposer');
    expect(desktop).toContain('<ConversationComposer');
  });
});
