import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');

describe('Room-list swipe-left leave', () => {
  it('offers the exit tile only to plain members, and never on a DM row', () => {
    // Room membership roles mirror the Workspace role on every join path
    // (membership-join.ts); the server's leaveRoom accepts only plain members.
    expect(source).toContain("const canLeaveRooms = chatList?.workspace.role === 'member'");
    expect(source).toContain("canLeaveRooms && !item.directMessage && Platform.OS !== 'web'");
    expect(source).toContain('testID={`room-leave-swipe-${item.room.id}`}');
  });

  it('reveals one icon-only tile with no label', () => {
    const reveal = source.slice(
      source.indexOf('renderRightActions'),
      source.indexOf('testID={`room-leave-swipe-'),
    );
    // The tile is a single close glyph; there is no word label under it.
    expect(reveal).toContain('×');
    expect(reveal).toContain('styles.leaveTile');
    expect(reveal).not.toMatch(/<Text[^>]*>\s*[A-Z][A-Z\s]+<\/Text>/);
    expect(reveal).not.toMatch(/<Text[^>]*>[A-Z][A-Z\s]+<\/Text>/);
    // The tile itself is the specified 28px square, and the styles build it
    // from that one constant with no label style of its own.
    expect(source).toContain('const LEAVE_TILE_SIZE = 28;');
    expect(source).toContain('leaveTileButton: {');
    expect(source).toContain('width: LEAVE_TILE_SIZE,');
    expect(source).not.toContain('leaveTileLabel:');
  });

  it('confirms "Leave #room?" with No/Yes before calling leaveRoom', () => {
    const leavePath = source.slice(
      source.indexOf('const handleLeaveRoom'),
      source.indexOf('}, [transport]);'),
    );
    expect(leavePath).toContain('`Leave ${title}?`');
    expect(leavePath).toContain("'Other members keep their access.'");
    expect(leavePath).toContain("cancelText: 'No'");
    expect(leavePath).toContain("confirmText: 'Yes'");
    expect(leavePath).toContain('destructive: true');
    expect(leavePath).toContain('transport.leaveRoom(item.room.id)');
    expect(leavePath).toContain('chatScheduler.current?.force()');
  });

  it('explains a missing transport and a refused leave instead of going silent', () => {
    expect(source).toContain("Modal.alert('Cannot leave yet'");
    expect(source).toContain('Could not leave ${ROOM_LABEL}:');
  });
});
