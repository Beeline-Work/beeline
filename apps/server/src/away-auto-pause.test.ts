import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migratedDatabase } from './test-support.js';
import { migrate, type SqlDatabase } from './database.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { nextAwayPauseDelay } from './away-auto-pause.js';
import { setAgentWakePaused } from './agent-wake-pause.js';
import { setRoomEventSubscriptions, listRoomSubscriptions } from './agent-subscriptions.js';
import { PhoneService } from './phone-service.js';
import { systemLine } from './system-line.js';
import { PushDeliveryLoop } from './background.js';
import { postRoomChoice } from './room-choice.js';

const PERSON = 'a'.repeat(64), AGENT = 'b'.repeat(64), SECOND = 'c'.repeat(64);
const DAY = 86_400_000;
let db: SqlDatabase;
afterEach(async () => { await db?.close(); });
async function fixture() {
  db = await migratedDatabase();
  const now = new Date(), workspace = randomUUID(), room = randomUUID(), otherRoom = randomUUID();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Worker','worker'),($3,'agent','Second','second')`, [PERSON, AGENT, SECOND]);
  await db.query('INSERT INTO workspaces(id,name) VALUES($1,\'Workspace\')', [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$3,$4,'One'),($2,$3,$4,'Two')`,
    [room, otherRoom, workspace, PERSON]);
  for (const agent of [AGENT, SECOND]) await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, PERSON]);
  for (const id of [PERSON, AGENT, SECOND]) for (const scope of [null, room, otherRoom])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
      [workspace, scope, id, id === PERSON ? 'owner' : 'member']);
  const schedule = randomUUID();
  await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
    VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":60}','Check work',$5)`,
    [schedule, workspace, room, AGENT, new Date(now.getTime() + 10 * DAY)]);
  await setRoomEventSubscriptions(db, otherRoom, SECOND, ['joined']);
  await db.query('UPDATE identities SET last_app_active_at=$2 WHERE id=$1', [PERSON, now]);
  return { now, room, otherRoom, schedule, loop: new AgentScheduleLoop(db), phone: new PhoneService(db, 'http://local.test') };
}
async function state() {
  return (await db.query<{ last_app_active_at: Date; away_warning_at: Date | null }>(
    'SELECT last_app_active_at,away_warning_at FROM identities WHERE id=$1', [PERSON])).rows[0]!;
}
async function warningCount() {
  return (await db.query("SELECT id FROM messages WHERE card_type='away-warning'")).rowCount;
}

describe('away auto pause', () => {
  it('warns once at 3 days in every affected Room and uses the normal push', async () => {
    const { now, room, loop, phone } = await fixture();
    const send = vi.fn(async () => undefined);
    await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment)
      VALUES('away-owner-device-12345678901234567890',$1,'android','physical')`, [PERSON]);
    const push = new PushDeliveryLoop(db, { send });
    await push.runOnce();
    expect(await nextAwayPauseDelay(db)).toBeGreaterThan(3 * DAY - 60_000);
    await loop.runOnce(new Date(now.getTime() + 3 * DAY - 1));
    expect(await warningCount()).toBe(0);
    const warnedAt = new Date(now.getTime() + 3 * DAY);
    await loop.runOnce(warnedAt);
    await loop.runOnce(warnedAt);
    expect(await warningCount()).toBe(2);
    expect((await state()).away_warning_at).toEqual(warnedAt);
    const transcript = await phone.readRoom(room, PERSON);
    expect(transcript!.messages.some(message => message.awayWarning && message.text.includes('within 1 day'))).toBe(true);
    await push.runOnce();
    expect(send).toHaveBeenCalled();
    expect((await db.query('SELECT id FROM agent_commands')).rowCount).toBe(0);
  });

  it('starts existing people at migration time instead of warning from account age', async () => {
    const { room, loop, phone } = await fixture();
    await phone.execute('sendRoomMessage', { roomId: room, text: 'Active before the upgrade' }, PERSON);
    await db.query("UPDATE identities SET created_at=now()-interval '30 days' WHERE id=$1", [PERSON]);
    // Recreate the upgrade from the schema before activity tracking existed.
    await db.query('ALTER TABLE identities DROP COLUMN last_app_active_at');
    const beforeMigration = new Date();
    await migrate(db);
    await loop.runOnce();
    expect(await warningCount()).toBe(0);
    expect((await state()).last_app_active_at.getTime()).toBeGreaterThanOrEqual(beforeMigration.getTime());
    expect(await loop.nextDelayMs()).toBeGreaterThan(3 * DAY - 60_000);
    expect((await db.query('SELECT id FROM agent_schedules WHERE paused_at IS NOT NULL')).rowCount).toBe(0);
    expect((await db.query('SELECT id FROM agent_subscriptions WHERE paused_at IS NOT NULL')).rowCount).toBe(0);

    // Repeated migrations preserve real activity rather than restarting the clock.
    const activeAt = new Date(Date.now() - DAY);
    await db.query('UPDATE identities SET last_app_active_at=$2 WHERE id=$1', [PERSON, activeAt]);
    await migrate(db);
    expect((await state()).last_app_active_at).toEqual(activeAt);
    const newcomer = (await db.query<{ last_app_active_at: Date }>(`INSERT INTO identities(id,kind,name)
      VALUES($1,'human','New person') RETURNING last_app_active_at`, ['d'.repeat(64)])).rows[0]!;
    expect(newcomer.last_app_active_at.getTime()).toBeGreaterThanOrEqual(beforeMigration.getTime());
  });

  it('uses the scheduler deadline for subscription-only owners', async () => {
    const { now, loop } = await fixture();
    await db.query('DELETE FROM agent_schedules');
    await db.query('UPDATE identities SET last_app_active_at=$2 WHERE id=$1',
      [PERSON, new Date(now.getTime() - 3 * DAY)]);
    expect(await loop.nextDelayMs()).toBe(0);
    await loop.runOnce(now);
    expect(await warningCount()).toBe(1);
    expect((await db.query('SELECT id FROM agent_subscriptions WHERE paused_at IS NOT NULL')).rowCount).toBe(0);
    await loop.runOnce(new Date(now.getTime() + DAY));
    expect((await db.query('SELECT id FROM agent_subscriptions WHERE paused_at IS NOT NULL')).rowCount).toBe(1);
    expect(await loop.nextDelayMs()).toBeUndefined();
  });

  it('pauses all owned schedules and subscriptions one day after the warning without deleting them', async () => {
    const { now, loop } = await fixture();
    await loop.runOnce(new Date(now.getTime() + 3 * DAY));
    await loop.runOnce(new Date(now.getTime() + 4 * DAY - 1));
    expect((await db.query('SELECT id FROM agent_schedules WHERE paused_at IS NOT NULL')).rowCount).toBe(0);
    await loop.runOnce(new Date(now.getTime() + 4 * DAY));
    expect((await db.query('SELECT id FROM agent_schedules WHERE paused_at IS NOT NULL')).rowCount).toBe(1);
    expect((await db.query('SELECT id FROM agent_subscriptions WHERE paused_at IS NOT NULL')).rowCount).toBe(1);
    expect(await loop.nextDelayMs()).toBeUndefined();
    expect(await warningCount()).toBe(2);
  });

  it('a successful message, reaction, card answer or repeated Room read cancels a pending warning', async () => {
    const { now, room, loop, phone } = await fixture();
    const message = randomBytes(32).toString('hex');
    await db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Hello')", [message, room, AGENT]);
    const choice = await postRoomChoice(db, { roomId: room, agentId: AGENT, mode: 'question', prompt: 'Choose?',
      options: [{ id: 'A', label: 'Continue', consequence: 'Keep working' }, { id: 'B', label: 'Stop', consequence: 'End work' }] });
    for (const action of [
      () => phone.execute('sendRoomMessage', { roomId: room, text: 'I am here' }, PERSON),
      () => phone.execute('reactToMessage', { roomId: room, messageId: message, emoji: '👍' }, PERSON),
      () => phone.execute('answerChoice', { choiceId: choice.choiceId, optionId: 'A' }, PERSON),
      () => phone.markRead(room, message, PERSON),
      () => phone.markRead(room, message, PERSON),
    ]) {
      await db.query('UPDATE identities SET last_app_active_at=$2,away_warning_at=$3 WHERE id=$1',
        [PERSON, new Date(now.getTime() - 3 * DAY), now]);
      await action();
      expect((await state()).away_warning_at).toBeNull();
      expect((await state()).last_app_active_at.getTime()).toBeGreaterThanOrEqual(now.getTime());
      await loop.runOnce(new Date(now.getTime() + DAY));
      expect((await db.query('SELECT id FROM agent_schedules WHERE paused_at IS NOT NULL')).rowCount).toBe(0);
    }
  });

  it('agent activity and delivered scheduled output do not count as person interaction', async () => {
    const { now, room, schedule, loop, phone } = await fixture();
    const agentActivity = (await db.query('SELECT last_app_active_at FROM identities WHERE id=$1', [AGENT])).rows[0]?.last_app_active_at;
    await db.query('UPDATE agent_schedules SET creator_id=$2,next_run_at=$3 WHERE id=$1', [schedule, PERSON, now]);
    await loop.runOnce(now);
    await phone.execute('sendRoomMessage', { roomId: room, text: 'Agent output' }, AGENT);
    expect((await state()).last_app_active_at).toEqual(now);
    expect((await db.query('SELECT last_app_active_at FROM identities WHERE id=$1', [AGENT])).rows[0]?.last_app_active_at).toEqual(agentActivity);
    await loop.runOnce(new Date(now.getTime() + 3 * DAY));
    expect((await state()).away_warning_at).not.toBeNull();
  });

  it('paused wake sources create no work and remain visible as paused', async () => {
    const { now, room, otherRoom, schedule, loop, phone } = await fixture();
    await db.query('UPDATE agent_schedules SET paused_at=$2,next_run_at=$2 WHERE id=$1', [schedule, now]);
    await db.query('UPDATE agent_subscriptions SET paused_at=$1', [now]);
    expect(await loop.runOnce(now)).toBe(0);
    await systemLine(db, { roomId: otherRoom, subject: { kind: 'human', id: PERSON, name: 'Owner' }, verb: 'joined', kind: 'joined' });
    expect((await db.query('SELECT id FROM agent_commands')).rowCount).toBe(0);
    expect((await phone.execute('listRoomSchedules', { roomId: room }, PERSON)).schedules[0]?.paused).toBe(true);
    expect((await listRoomSubscriptions(db, otherRoom)).subscriptions[0]?.paused).toBe(true);
  });

  it('agents resume their own sources at the next normal time with no catch-up', async () => {
    const { now, room, otherRoom, schedule, loop } = await fixture();
    const phase = new Date(now.getTime() - 7 * DAY + 30 * 60_000);
    await db.query('UPDATE agent_schedules SET paused_at=$2,next_run_at=$3 WHERE id=$1', [schedule, now, phase]);
    const subscription = (await db.query<{ id: string }>('UPDATE agent_subscriptions SET paused_at=$1 RETURNING id', [now])).rows[0]!.id;
    await expect(setAgentWakePaused(db, SECOND, { roomId: room, scheduleId: schedule, paused: false })).rejects.toThrow('wake source not found');
    await setAgentWakePaused(db, AGENT, { roomId: otherRoom, scheduleId: schedule, paused: false });
    await setAgentWakePaused(db, SECOND, { roomId: otherRoom, subscriptionId: subscription, paused: false });
    const resumed = (await db.query<{ next_run_at: Date; paused_at: Date | null }>('SELECT next_run_at,paused_at FROM agent_schedules WHERE id=$1', [schedule])).rows[0]!;
    expect(resumed.paused_at).toBeNull();
    expect(resumed.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect((resumed.next_run_at.getTime() - phase.getTime()) % 3_600_000).toBe(0);
    expect(await loop.runOnce(now)).toBe(0);
    expect(await loop.runOnce(resumed.next_run_at)).toBe(1);
    expect((await db.query('SELECT id FROM agent_commands')).rowCount).toBe(1);
    expect((await listRoomSubscriptions(db, otherRoom)).subscriptions[0]?.paused).toBeUndefined();
  });
});
