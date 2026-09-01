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
      "rosterModal: {\n    width: '100%',\n    maxWidth: 460,\n    maxHeight: '100%'",
    );
  });

  it('announces agent status once through the roster row, not again through its light', () => {
    expect(source).toContain('<RosterPresenceLight online={agentOnline} />');
    expect(source).toContain('importantForAccessibility="no"');
  });
});
