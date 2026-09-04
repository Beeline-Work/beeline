import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Room actions sheet and the corner's are ONE list in ONE vocabulary
 * (captain report C102). This screen has no render harness, so the structural
 * guarantees are checked as source text — the technique `roomRepo.design.test`
 * and `no-foreground-blocking.test` already use here.
 */
const chat = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');

function sheet(marker: string, label: string): string {
  const start = chat.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  const end = chat.indexOf('</HullActionSheetModal>', start);
  expect(end, `unclosed ${label}`).toBeGreaterThan(start);
  return chat.slice(start, end);
}

const roomSheet = sheet('testID="room-actions-sheet"', 'Room actions sheet');
const cornerSheet = sheet('testID="corner-actions-sheet"', 'corner actions sheet');

const ROOM_ROWS = [
  'rename-room-action',
  'room-repo-action',
  'room-github-events-toggle',
  'room-repo-readonly',
  'room-schedules-action',
  'delete-room-action',
  'leave-room-action',
] as const;

function row(source: string, testID: string): string {
  const anchor = source.indexOf(`testID="${testID}"`);
  expect(anchor, `missing row ${testID}`).toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf('<HullActionSheetRow', anchor);
  expect(start, `row ${testID} is not a HullActionSheetRow`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('/>', anchor);
  return source.slice(start, end + 2);
}

describe('Room and corner actions sheets', () => {
  it('are the shared bottom sheet, not two hand-built floating surfaces', () => {
    // Before C102 each sheet hand-rolled HullModal + HullFloatingSurface with
    // its own eyebrow, 19px title and × close.
    expect(chat).not.toContain('HullFloatingSurface');
    expect(chat).not.toContain('roomActionsModal');
    expect(chat).not.toContain('roomActionsModalEyebrow');
    expect(chat).toContain('<HullActionSheetModal');
    for (const marker of ['room-actions-close', 'corner-actions-close']) {
      expect(chat).toContain(`<HullActionSheetCancel`);
      expect(chat).toContain(`testID="${marker}"`);
    }
  });

  it('renders every row through the one shared row, so none of them wears a box', () => {
    for (const testID of ROOM_ROWS) expect(row(roomSheet, testID)).toContain('<HullActionSheetRow');
    expect(row(cornerSheet, 'close-corner-action')).toContain('<HullActionSheetRow');
    // The retired framed-slab styles and their glyph column are gone outright.
    for (const style of [
      'roomRenameAction',
      'roomLifecycleAction',
      'roomLifecycleGlyph',
      'roomLifecycleTitle',
      'roomLifecycleHint',
      'roomLifecycleDanger',
      'roomLifecycleCopy',
    ]) {
      expect(chat, `styles.${style} must not come back`).not.toContain(`styles.${style}`);
    }
  });

  it('spends the trailing column on the closed vocabulary and nothing else', () => {
    // A setting that opens a picker: its value on the axis, the chevron last,
    // turned down while the picker stands open beneath the row.
    const repo = row(roomSheet, 'room-repo-action');
    expect(repo).toContain("chevron={showRoomRepoPicker ? 'down' : 'right'}");
    expect(repo).toContain("metadata={roomRepository ? roomRepository.binding.name : 'None'}");
    // A row that toggles gets the switch, never a filled/empty circle.
    const notifications = row(roomSheet, 'room-github-events-toggle');
    expect(notifications).toContain('toggle={{');
    expect(notifications).toContain('value: roomRepository.githubEventsEnabled !== false');
    expect(notifications).not.toContain('chevron');
    // A row that leaves for a screen gets the chevron alone.
    expect(row(roomSheet, 'room-schedules-action')).toContain('chevron="right"');
    // Plain actions carry nothing at all — no pencil, no square.
    for (const testID of ['delete-room-action', 'leave-room-action']) {
      const plain = row(roomSheet, testID);
      expect(plain).not.toContain('chevron');
      expect(plain).not.toContain('toggle=');
      expect(plain).not.toContain('metadata=');
    }
    expect(row(cornerSheet, 'close-corner-action')).not.toContain('chevron');
    // The retired glyph alphabet: a pencil, an empty square, a filled circle,
    // a clock, a red square and a corner's stop block.
    for (const glyph of ['✎', '▢', '◷', '○', '●', '□', '■', '↗']) {
      expect(roomSheet, `retired sheet glyph ${glyph}`).not.toContain(glyph);
      expect(cornerSheet, `retired sheet glyph ${glyph}`).not.toContain(glyph);
    }
  });

  it('keeps values and section-head capitals out of the row titles', () => {
    expect(chat).toContain('label="Repo"');
    expect(chat).toContain('label="Repo notifications"');
    expect(chat).toContain('label="Scheduled work"');
    expect(chat).toContain('label="Rename"');
    // The old titles crammed the value and the verb into the label, and the
    // notifications row even lost the space before its separator.
    expect(chat).not.toContain('REPO NOTIFICATIONS');
    expect(chat).not.toContain('· CHANGE');
    expect(chat).not.toContain('· NONE · LINK');
    expect(chat).not.toContain('SCHEDULED WORK');
    expect(chat).not.toContain('RENAME ');
    for (const testID of [...ROOM_ROWS, 'close-corner-action']) {
      const source = testID === 'close-corner-action' ? cornerSheet : roomSheet;
      const declaration = row(source, testID).match(/\n\s*label=(.*)/)![1];
      const labels = [...declaration.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)]
        .map((match) => match[1] ?? match[2] ?? match[3])
        // `${ROOM_LABEL}` and friends resolve to sentence case at runtime.
        .map((label) => label.replaceAll(/\$\{[^}]*\}/g, 'x'));
      expect(labels.length, `row ${testID} needs a label`).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label, `row ${testID} label carries a value`).not.toContain('·');
        expect(label, `row ${testID} label is shouting`).not.toMatch(/[A-Z]{3}/);
      }
    }
  });

  it('keeps the destructive rows destructive: the warning tone and the confirmation', () => {
    for (const testID of ['delete-room-action', 'leave-room-action']) {
      expect(row(roomSheet, testID)).toContain('destructive');
    }
    expect(row(cornerSheet, 'close-corner-action')).toContain('destructive');
    // The confirmation lives in the handler, and both rows still reach it.
    expect(chat).toContain('const handleRoomLifecycle = useCallback(async () => {');
    const handler = chat.slice(
      chat.indexOf('const handleRoomLifecycle = useCallback(async () => {'),
      chat.indexOf('const handleRenameRoom = useCallback'),
    );
    expect(handler).toContain('await Modal.confirm(');
    expect(handler).toContain('destructive: true');
  });

  it('leaves every action wired to exactly what it called before', () => {
    expect(row(roomSheet, 'rename-room-action')).toContain('setRenameEditing(true)');
    expect(row(roomSheet, 'room-repo-action')).toContain(
      'onPress={() => void handleToggleRoomRepoPicker()}',
    );
    expect(row(roomSheet, 'room-github-events-toggle')).toContain(
      'onPress={() => void handleToggleGitHubEvents()}',
    );
    expect(row(roomSheet, 'room-schedules-action')).toContain(
      "pathname: '/beeline/settings/schedules'",
    );
    for (const testID of ['delete-room-action', 'leave-room-action']) {
      expect(row(roomSheet, testID)).toContain('onPress={handleRoomLifecycle}');
    }
    expect(row(cornerSheet, 'close-corner-action')).toContain('void handleCloseCorner()');
    // A rename in flight still holds the sheet open against the scrim.
    expect(chat).toContain('dismissOnBackdrop={!renameBusy}');
    expect(chat).toContain('const closeRoomActions = useCallback(() => {');
  });
});
