import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
const screen = readFileSync(new URL('../settings/schedules.tsx', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../../_layout.tsx', import.meta.url), 'utf8');
const schedule = readFileSync(new URL('../settings/schedule.tsx', import.meta.url), 'utf8');
const subscription = readFileSync(new URL('../settings/subscription.tsx', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../workflow.tsx', import.meta.url), 'utf8');
const work = readFileSync(new URL('../../../../buzz/scheduled-work.ts', import.meta.url), 'utf8');

describe('scheduled Agent work', () => {
  it('exposes manager-only scheduled-work controls from the monolith Room action sheet', () => {
    expect(chat).toContain('getBuzzRuntimeConfig().monolithEnabled');
    expect(chat).toContain('testID="room-schedules-action"');
    expect(chat).toContain("pathname: '/beeline/settings/schedules'");
    expect(chat).toContain('label="Schedules and subscriptions"');
    expect(chat).not.toContain('View or stop Agent-managed recurring work.');
  });

  it('allows managers to inspect and stop existing work without scheduling it', () => {
    expect(work).toContain("monolithPhoneOperation('listRoomSchedules'");
    expect(work).toContain("monolithPhoneOperation('deleteRoomSchedule'");
    expect(work).not.toContain("'createRoomSchedule'");
    // No explainer paragraph stands above the list (DESIGN.md).
    expect(screen).not.toContain('AGENT-MANAGED SCHEDULES');
    expect(screen).not.toContain('repository notifications');
    expect(screen).not.toContain('Alert.alert');
    expect(work).toContain("monolithPhoneOperation('listRoomSubscriptions'");
    expect(work).toContain("monolithPhoneOperation('deleteRoomSubscription'");
    // Both Stop actions live on the entry's own page, behind one confirm step.
    expect(schedule).toContain('<StopScheduledWork');
    expect(subscription).toContain('<StopScheduledWork');
    expect(workflow).toContain('<StopScheduledWork');
  });

  it('draws each entry as a settings row in one grammar, with no timestamp log', () => {
    expect(screen).toContain('<SettingsRow');
    expect(screen).toContain('chevron="right"');
    expect(screen).toContain('<WorkflowGlyph');
    expect(screen).not.toMatch(/LAST |NEVER FIRED|deliveries/);
    expect(subscription).not.toContain('deliveries');
    expect(layout).toMatch(/name="beeline\/settings\/schedule"\s*options=\{\{\s*headerShown: false/);
    expect(layout).toMatch(/name="beeline\/settings\/subscription"\s*options=\{\{\s*headerShown: false/);
  });

  it('draws the shared PageHeader, Room over Schedules and subscriptions, and no stack header', () => {
    expect(screen).toContain('<PageHeader');
    expect(screen).toContain('title="Schedules and subscriptions"');
    expect(screen).toContain("eyebrow={displayRoomIndexTitle(work?.roomName ?? undefined) ?? 'Room'}");
    expect(screen).toContain('onBack={() => router.back()}');
    expect(layout).toMatch(
      /name="beeline\/settings\/schedules"\s*options=\{\{\s*headerShown: false/,
    );
  });

  it('says a cadence in words, never as a raw cron expression', () => {
    expect(work).toContain('scheduleCadenceLabel(schedule.cadence)');
    expect(screen).not.toContain('cadence.expression');
    expect(work).not.toContain('cadence.expression');
  });

  it('offers no Room switch for repository activity', () => {
    expect(chat).not.toContain('label="Repo notifications"');
    expect(chat).not.toContain('REPO ACTIVITY');
    expect(chat).not.toContain('repository activity notices');
    // C102: the value is the switch on the trailing axis, so the broken
    // `REPO NOTIFICATIONS· ON` title string is gone rather than repaired.
    expect(chat).not.toContain('REPO NOTIFICATIONS');
    expect(chat).not.toContain("{'\\u00b7'}");
  });
});
