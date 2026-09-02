import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');
const screen = readFileSync(new URL('../settings/schedules.tsx', import.meta.url), 'utf8');

describe('scheduled Agent work', () => {
  it('exposes manager-only scheduled-work controls from the monolith Room action sheet', () => {
    expect(chat).toContain('getBuzzRuntimeConfig().monolithEnabled');
    expect(chat).toContain('testID="room-schedules-action"');
    expect(chat).toContain("pathname: '/beeline/settings/schedules'");
    expect(chat).toContain('SCHEDULED WORK');
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

  it('calls repository activity Repo notifications everywhere it is presented to people', () => {
    expect(chat).toContain('REPO NOTIFICATIONS');
    expect(chat).toContain('Turn repository notifications on');
    expect(chat).toContain('Turn repository notifications off');
    expect(chat).not.toContain('REPO ACTIVITY');
    expect(chat).not.toContain('repository activity notices');
  });
});
