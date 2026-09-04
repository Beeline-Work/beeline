import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');
const screen = readFileSync(new URL('../settings/schedules.tsx', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../../_layout.tsx', import.meta.url), 'utf8');

describe('scheduled Agent work', () => {
  it('exposes manager-only scheduled-work controls from the monolith Room action sheet', () => {
    expect(chat).toContain('getBuzzRuntimeConfig().monolithEnabled');
    expect(chat).toContain('testID="room-schedules-action"');
    expect(chat).toContain("pathname: '/beeline/settings/schedules'");
    expect(chat).toContain('label="Scheduled work"');
    expect(chat).toContain('View or stop Agent-managed recurring work.');
  });

  it('allows managers to inspect and stop existing work without scheduling it', () => {
    expect(screen).toContain("monolithPhoneOperation('listRoomSchedules'");
    expect(screen).toContain("monolithPhoneOperation('deleteRoomSchedule'");
    expect(screen).not.toContain("monolithPhoneOperation('createRoomSchedule'");
    expect(screen).toContain('AGENT-MANAGED SCHEDULES');
    expect(screen).toContain(
      'Scheduled work appears with this Room&apos;s repository notifications.',
    );
    expect(screen).toContain('CONFIRM STOP');
    expect(screen).not.toContain('Alert.alert');
  });

  it('draws no in-page back control: the stack header is the only back button (C75)', () => {
    expect(screen).not.toContain('router.back()');
    expect(screen).not.toContain('accessibilityLabel="Back"');
    expect(screen).not.toContain('styles.back');
    expect(screen).not.toContain('paddingTop: insets.top');
    expect(layout).toMatch(
      /name="beeline\/settings\/schedules"\s*options=\{\{\s*headerTitle: 'Scheduled work'/,
    );
  });

  it('calls repository activity Repo notifications everywhere it is presented to people', () => {
    expect(chat).toContain('label="Repo notifications"');
    expect(chat).toContain('Turn repository notifications on');
    expect(chat).toContain('Turn repository notifications off');
    expect(chat).not.toContain('REPO ACTIVITY');
    expect(chat).not.toContain('repository activity notices');
    // C102: the value is the switch on the trailing axis, so the broken
    // `REPO NOTIFICATIONS· ON` title string is gone rather than repaired.
    expect(chat).not.toContain('REPO NOTIFICATIONS');
    expect(chat).not.toContain("{'\\u00b7'}");
  });
});
