import { describe, expect, it, TRIAGE, ROOM, TRIAGE_CORNER, database, daemon, triageTurn, rootFixture } from './test-support-feedback.test-support.js';

describe('triage corner: sibling fix corners and its daily schedule, with no setting', () => {
  it('opens a fix corner from the triage corner as a sibling in the parent Room', async () => {
    const turn = await triageTurn();
    const trigger = (
      await rootFixture.database.query<{ source_message_id: string }>(
        `SELECT source_message_id FROM agent_commands WHERE turn_request_id=$1`,
        [turn.requestId],
      )
    ).rows[0]!.source_message_id;
    const { cornerId } = (await daemon().execute(
      'createCorner',
      {
        ...turn,
        idempotencyKey: `fix-${turn.requestId}`,
        name: 'Fix-grant-card',
        objective: 'Fix the grant card that stays pending',
        brief: {
          spec: 'Fix the grant card that stays pending (feedback fb_123).\n\n## Checklist\n\n- AC-1: The grant card resolves after approval',
          approval: { sourceMessageId: trigger },
        },
      } as never,
      TRIAGE,
    )) as { cornerId: string };
    const created = (
      await rootFixture.database.query<{ parent_id: string }>(`SELECT parent_id FROM rooms WHERE id=$1`, [
        cornerId,
      ])
    ).rows[0]!;
    expect(created.parent_id).toBe(ROOM);
    const brief = (
      await rootFixture.database.query<{ spec: string }>(
        `SELECT spec FROM corner_brief_revisions WHERE corner_id=$1 AND revision=1`,
        [cornerId],
      )
    ).rows[0]!;
    expect(brief.spec).toContain('fb_123');
    // The sibling stays listed under the parent, but only the triage call site gets its row.
    const card = await rootFixture.database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='daemon-fact' AND card->>'cornerId'=$2`,
      [ROOM, cornerId],
    );
    expect(card.rowCount).toBe(0);
    expect((await rootFixture.database.query(`SELECT 1 FROM messages WHERE room_id=$1
      AND card_type='daemon-fact' AND card->>'cornerId'=$2`, [turn.roomId,cornerId])).rowCount).toBe(1);
  });


  it('runs a daily schedule created inside the triage corner in that corner', async () => {
    const turn = await triageTurn();
    const { scheduleId } = (await daemon().execute(
      'createAgentSchedule',
      { title: 'Scheduled check',
        ...turn,
        prompt: 'Start the feedback-triage workflow.',
        cadence: { kind: 'cron', expression: '0 14 * * *', timeZone: 'UTC' },
      } as never,
      TRIAGE,
    )) as { scheduleId: string };
    await rootFixture.database.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [
      scheduleId,
    ]);
    const { AgentScheduleLoop } = await import('./agent-schedules.js');
    expect(await new AgentScheduleLoop(rootFixture.database).runOnce()).toBe(1);
    const fired = await rootFixture.database.query<{ room_id: string; reason: string }>(
      `SELECT room_id,reason FROM agent_commands WHERE agent_id=$1 AND reason='schedule'`,
      [TRIAGE],
    );
    expect(fired.rows).toEqual([{ room_id: TRIAGE_CORNER, reason: 'schedule' }]);
  });
});
