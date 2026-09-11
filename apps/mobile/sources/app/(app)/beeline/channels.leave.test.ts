import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'channels.tsx'), 'utf8');
const roomSessionSource = readFileSync(
  path.join(__dirname, 'chat', 'useRoomSurfaceSession.ts'),
  'utf8',
);

describe('Chat-list swipe-left actions', () => {
  it('offers destructive Leave for member Rooms and non-destructive Close for DMs', () => {
    expect(source).toContain("const canLeaveRooms = chatList?.workspace.role === 'member'");
    expect(source).toContain("!viewerIsAgent && Platform.OS !== 'web'");
    expect(source).toContain('testID={`chat-close-swipe-${item.room.id}`}');
    expect(source).toContain('!item.directMessage && canLeaveRooms');
    expect(source).toContain('testID={`room-leave-action-${item.room.id}`}');
    expect(source).toContain('item.directMessage && (');
    expect(source).toContain('testID={`chat-close-action-${item.room.id}`}');
  });

  it('reveals one icon-only action for each row contract', () => {
    const reveal = source.slice(
      source.indexOf('renderRightActions'),
      source.indexOf('testID={`chat-close-swipe-'),
    );
    expect(reveal).toContain('×');
    expect(reveal).toContain('!');
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

  it('closes only DMs without a destructive confirmation and refreshes the deck', () => {
    const closePath = source.slice(
      source.indexOf('const handleCloseChat'),
      source.indexOf('const handleLeaveRoom'),
    );
    expect(closePath).toContain('transport.closeChat(item.room.id)');
    expect(closePath).toContain('chatScheduler.current?.force()');
    expect(closePath).not.toContain('Modal.confirm');
    expect(closePath).toContain("Modal.alert('Cannot close yet'");
    expect(closePath).toContain('Could not close chat:');
    const actions = source.slice(
      source.indexOf('renderRightActions'),
      source.indexOf('testID={`chat-close-swipe-'),
    );
    expect(actions.indexOf('item.directMessage && (')).toBeLessThan(
      actions.indexOf('onPress={() => handleCloseChat(item)}'),
    );
  });

  it('confirms "Leave #room?" with No/Yes before calling leaveRoom', () => {
    const leavePath = source.slice(
      source.indexOf('const handleLeaveRoom'),
      source.indexOf('  useEffect(', source.indexOf('const handleLeaveRoom')),
    );
    expect(leavePath).toContain('`Leave ${title}?`');
    expect(leavePath).toContain("'Other members keep their access.'");
    expect(leavePath).toContain("cancelText: 'No'");
    expect(leavePath).toContain("confirmText: 'Yes'");
    expect(leavePath).toContain('destructive: true');
    expect(leavePath).toContain('transport.leaveRoom(item.room.id)');
    expect(leavePath).toContain('chatScheduler.current?.force()');
    expect(leavePath).not.toContain('transport.closeChat');
  });

  it('preserves the row and surfaces a failed leave instead of going silent', () => {
    expect(source).toContain("Modal.alert('Cannot leave yet'");
    expect(source).toContain('Could not leave ${ROOM_LABEL}:');
  });

  it('gives Workspace owners and admins a truthful cannot-leave action', () => {
    expect(source).toContain('!item.directMessage && canManageWorkspace');
    expect(source).toContain('testID={`room-leave-constraint-${item.room.id}`}');
    expect(source).toContain('`Cannot leave ${title}`');
    expect(source).toContain(
      "'Workspace owners and admins cannot leave Rooms. Change your Workspace role first.'",
    );
  });

  it('explicitly reopens a top-level chat when its Room surface is navigated to', () => {
    expect(roomSessionSource).toContain('if (!view.parent && !reopenedChat)');
    expect(roomSessionSource).toContain('nextTransport.reopenChat(channelId)');
  });
});
