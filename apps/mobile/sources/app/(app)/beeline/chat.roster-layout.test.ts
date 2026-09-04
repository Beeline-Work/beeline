import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../../components/buzz/RoomRosterSheet.tsx', import.meta.url),
  'utf8',
);

describe('Room participant roster layout', () => {
  it('bounds the modal content against the viewport before its roster ScrollView is measured', () => {
    const rosterStart = source.indexOf('accessibilityLabel={`Close ${ROOM_LABEL} roster`}');
    const rosterEnd = source.indexOf('testID="room-roster-sheet"', rosterStart);
    const rosterModal = source.slice(rosterStart, rosterEnd);

    expect(rosterStart).toBeGreaterThanOrEqual(0);
    expect(rosterEnd).toBeGreaterThan(rosterStart);
    expect(rosterModal).toContain("maxHeight: '82%'");
    expect(source).toContain(
      "rosterModal: {\n      width: '100%',\n      maxWidth: 460,\n      maxHeight: '100%'",
    );
  });

  it('marks agent state with the tile ring alone: no status square, no kind word (C76)', () => {
    // The ring reads the working record (C77); presence is the lowercase word
    // ending the meta line and the row's accessibility label.
    expect(source).toContain('alive={agentWorking}');
    expect(source).not.toContain('alive={agentOnline}');
    expect(source).toContain("' · online'");
    expect(source).toContain("' · offline'");
    expect(source).not.toContain('RosterPresenceLight');
    expect(source).not.toMatch(/'AGENT'|'PERSON'/);
    // Status is still announced once, through the row's accessibility label.
    expect(source).toContain("', online'");
  });

  it('reads in the Members page vocabulary: one word over counted section heads, roles from the type scale', () => {
    expect(source).toContain('{MEMBERS_LABEL}');
    expect(source).toContain('{section.label} {section.options.length}');
    expect(source).toContain('rosterName: { ...Typography.default(), ...hull.type.body');
    expect(source).toContain('rosterMeta: { ...Typography.default(), ...hull.type.meta');
    expect(source).not.toMatch(/fontSize:\s*\d/);
  });
});
