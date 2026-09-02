import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./[channelId].tsx', import.meta.url), 'utf8');
const screen = readFileSync(new URL('../settings/schedules.tsx', import.meta.url), 'utf8');

describe('Room schedule settings', () => {
  it('exposes manager-only schedule settings from the monolith Room action sheet', () => {
    expect(chat).toContain('getBuzzRuntimeConfig().monolithEnabled');
    expect(chat).toContain('testID="room-schedules-action"');
    expect(chat).toContain("pathname: '/beeline/settings/schedules'");
  });

  it('creates, lists, and deletes schedules only through named phone operations', () => {
    expect(screen).toContain("monolithPhoneOperation('listRoomSchedules'");
    expect(screen).toContain("monolithPhoneOperation('createRoomSchedule'");
    expect(screen).toContain("monolithPhoneOperation('deleteRoomSchedule'");
    expect(screen).not.toContain('Alert.alert');
  });
});
