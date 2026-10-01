import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
const screen = readFileSync(new URL('../settings/schedules.tsx', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../../_layout.tsx', import.meta.url), 'utf8');

describe('scheduled Agent work', () => {
  it('exposes manager-only scheduled-work controls from the monolith Room action sheet', () => {
    expect(chat).toContain('getBuzzRuntimeConfig().monolithEnabled');
    expect(chat).toContain('testID="room-schedules-action"');
    expect(chat).toContain("pathname: '/beeline/settings/schedules'");
    expect(chat).toContain('label="Scheduled work"');
    expect(chat).not.toContain('View or stop Agent-managed recurring work.');
  });

  it('allows managers to inspect and stop existing work without scheduling it', () => {
    expect(screen).toContain("monolithPhoneOperation('listRoomSchedules'");
    expect(screen).toContain("monolithPhoneOperation('deleteRoomSchedule'");
    expect(screen).not.toContain("monolithPhoneOperation('createRoomSchedule'");
    // No explainer paragraph stands above the list (DESIGN.md).
    expect(screen).not.toContain('AGENT-MANAGED SCHEDULES');
    expect(screen).not.toContain('repository notifications');
    expect(screen).toContain('CONFIRM STOP');
    expect(screen).not.toContain('Alert.alert');
  });

  it('labels corner schedules and opens their corner from the parent Room list', () => {
    expect(screen).toContain("import { cornerHref } from '@/buzz/corner-navigation'");
    expect(screen).toContain('<CornerGlyph size={CORNER_META_SIZE} />');
    expect(screen).toContain('router.push(cornerHref(corner.id, roomId!, corner.name))');
    expect(screen).toContain('testID={`open-scheduled-work-${schedule.id}`}');
  });

  it('draws the shared PageHeader, Room over Scheduled Work, and no stack header', () => {
    expect(screen).toContain('<PageHeader');
    expect(screen).toContain('title="Scheduled Work"');
    expect(screen).toContain("eyebrow={displayRoomIndexTitle(roomName ?? undefined) ?? 'Room'}");
    expect(screen).toContain('onBack={() => router.back()}');
    expect(layout).toMatch(
      /name="beeline\/settings\/schedules"\s*options=\{\{\s*headerShown: false/,
    );
  });

  it('says a cadence in words, never as a raw cron expression', () => {
    expect(screen).toContain('scheduleCadenceLabel(schedule.cadence)');
    expect(screen).not.toContain('cadence.expression');
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
