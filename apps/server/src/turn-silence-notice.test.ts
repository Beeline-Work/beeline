import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCommand, claimAgentCommand } from './agent-command.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { ConnectionPresence } from './connection-presence.js';
import { LiveHub } from './live.js';
import type { CommittedTurnLiveRow } from './live.js';
import { noteFirstSilence } from './turn-silence-notice.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const AGENT = 'b'.repeat(64);
const HUMAN = 'a'.repeat(64);

async function fixture() {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Candy','candy')`,
    [HUMAN, AGENT],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
    ROOM,
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT, ROOM],
  );
  return database;
}

async function ask(database: PgliteDatabase, requestId: string, generation = 'g1') {
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy hi')`,
    [requestId, ROOM, HUMAN],
  );
  const command = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: AGENT,
    sourceMessageId: requestId,
    reason: 'human_tag',
  });
  await claimAgentCommand(database, ROOM, AGENT, command!.id, generation);
  return command!;
}

async function failureLine(database: PgliteDatabase, requestId: string) {
  return (
    await database.query<{ text: string; silence: string; state: string }>(
      `SELECT text,card->>'silenceKind' silence,card->>'state' state FROM messages
       WHERE room_id=$1 AND card_type='turn-failed' AND card->>'requestId'=$2`,
      [ROOM, requestId],
    )
  ).rows[0];
}

async function commandState(database: PgliteDatabase, commandId: string) {
  return (
    await database.query<{ state: string; hiccup_attempts: number; generation_id: string | null }>(
      `SELECT state,hiccup_attempts,generation_id FROM agent_commands WHERE id=$1`,
      [commandId],
    )
  ).rows[0];
}

describe('first-silence notice', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await fixture();
  });
  afterEach(async () => {
    await database.close();
  });

  it('reopens a hiccup command and phrases the restart remedy', async () => {
    const requestId = '1'.repeat(64);
    const command = await ask(database, requestId);
    const result = await new DaemonService(database, new LiveHub()).execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        requestId,
        generationId: 'g1',
        status: 'failed',
        reason: 'provider error 429 concurrency_limit',
        reasonKind: 'hiccup',
      },
      AGENT,
    );
    expect(result).toMatchObject({ hiccupRestart: true, hiccupAttempt: 1 });
    expect(await failureLine(database, requestId)).toEqual({
      text: '@candy could not answer · provider error 429 concurrency_limit. Restarting her and resending your message.',
      silence: 'hiccup',
      state: 'failed',
    });
    expect(await commandState(database, command.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 1,
      generation_id: null,
    });
  });

  it('maps each standing condition to its approved line and does not restart', async () => {
    const cases = [
      {
        requestId: '2'.repeat(64),
        reason: 'model selection unavailable',
        reasonKind: 'wrong-model' as const,
        text: "@candy could not answer · she's set to a model that isn't available. Pick another in her settings.",
        silence: 'wrong-model',
      },
      {
        requestId: '3'.repeat(64),
        reason:
          "You've hit your usage limit. Upgrade to Pro for more usage, or try again at Sep 19th, 2026 4:09 AM.",
        reasonKind: 'allowance-spent' as const,
        text: '@candy could not answer · her provider allowance is spent until Sep 19th, 2026 4:09 AM. Top up, or move her to another provider.',
        silence: 'allowance-spent',
      },
      {
        requestId: '4'.repeat(64),
        reason: 'ACP error -32000: Authentication required',
        reasonKind: 'not-signed-in' as const,
        text: "@candy could not answer · she isn't signed in to her provider. Run `beeline connect` on her machine.",
        silence: 'not-signed-in',
      },
      {
        requestId: '5'.repeat(64),
        reason: 'fatal: repository not found github.com/acme/widgets.git',
        reasonKind: 'workspace-failure' as const,
        text: "@candy could not answer · she couldn't get a working copy of acme/widgets. Check the repository is reachable.",
        silence: 'workspace-failure',
      },
      {
        requestId: '6'.repeat(64),
        reason: 'server command protocol 1 is required; refusing intake',
        reasonKind: 'helper-out-of-date' as const,
        text: '@candy could not answer · her helper is out of date. Run `beeline start` on her machine.',
        silence: 'helper-out-of-date',
      },
    ];
    const daemon = new DaemonService(database, new LiveHub());
    for (const testCase of cases) {
      const command = await ask(database, testCase.requestId, testCase.requestId.slice(0, 8));
      const result = await daemon.execute(
        'postAgentTurnReceipt',
        {
          roomId: ROOM,
          requestId: testCase.requestId,
          generationId: testCase.requestId.slice(0, 8),
          status: 'failed',
          reason: testCase.reason,
          reasonKind: testCase.reasonKind,
        },
        AGENT,
      );
      expect(result.hiccupRestart).toBeUndefined();
      expect(await failureLine(database, testCase.requestId)).toEqual({
        text: testCase.text,
        silence: testCase.silence,
        state: 'failed',
      });
      expect((await commandState(database, command.id))?.state).toBe('complete');
    }
  });

  /**
   * T4: a Trusty Squire answer the helper cannot act on — a busy Chrome
   * profile, or no host broker holding the socket — is a standing condition,
   * not a hiccup. It is inscribed once and the turn is never restarted.
   */
  it('inscribes a busy Squire profile or a missing host broker once, with no restart', async () => {
    const daemon = new DaemonService(database, new LiveHub());
    const squireFaults = [
      ['c'.repeat(64), 'profile_busy: another session holds the Trusty Squire browser profile'],
      ['d'.repeat(64), 'broker unavailable'],
    ] as const;
    for (const [requestId, reason] of squireFaults) {
      const command = await ask(database, requestId, requestId.slice(0, 8));
      const receipt = {
        roomId: ROOM,
        requestId,
        generationId: requestId.slice(0, 8),
        status: 'failed' as const,
        // No reasonKind: the server classifies the helper's own words, which is
        // what turns a Squire fault into a standing condition rather than a
        // hiccup the daemon would silently retry.
        reason,
      };
      const result = await daemon.execute('postAgentTurnReceipt', receipt, AGENT);

      expect(result.hiccupRestart).toBeUndefined();
      expect(await failureLine(database, requestId)).toEqual({
        text: "@candy could not answer \u00b7 she couldn't get a working copy of the repository. Check the repository is reachable.",
        silence: 'workspace-failure',
        state: 'failed',
      });
      expect((await commandState(database, command.id))?.state).toBe('complete');

      // A second delivery of the same standing fault adds no second line and
      // still asks for no restart.
      const repeat = await daemon
        .execute('postAgentTurnReceipt', receipt, AGENT)
        .catch(() => ({ hiccupRestart: undefined }));
      expect(repeat.hiccupRestart).toBeUndefined();
      expect(
        (
          await database.query(
            `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='turn-failed' AND card->>'requestId'=$2`,
            [ROOM, requestId],
          )
        ).rows,
      ).toHaveLength(1);
    }
  });

  it('gives up after three hiccups and says so once', async () => {
    const requestId = '7'.repeat(64);
    const command = await ask(database, requestId);
    const daemon = new DaemonService(database, new LiveHub());
    for (const attempt of [1, 2, 3]) {
      if (attempt > 1) await claimAgentCommand(database, ROOM, AGENT, command.id, `g${attempt}`);
      const result = await daemon.execute(
        'postAgentTurnReceipt',
        {
          roomId: ROOM,
          requestId,
          generationId: `g${attempt}`,
          status: 'failed',
          reason: 'ACP agent exited (code 1)',
          reasonKind: 'hiccup',
        },
        AGENT,
      );
      if (attempt < 3) {
        expect(result).toMatchObject({ hiccupRestart: true, hiccupAttempt: attempt });
        expect((await commandState(database, command.id))?.state).toBe('pending');
      } else {
        expect(result.hiccupRestart).toBeUndefined();
        expect((await commandState(database, command.id))?.state).toBe('complete');
      }
    }
    expect(await failureLine(database, requestId)).toEqual({
      text: '@candy could not answer · ACP agent exited (code 1). Stopped restarting after three tries.',
      silence: 'hiccup',
      state: 'failed',
    });
  });

  it('keeps the silence line after a later successful answer', async () => {
    const requestId = '8'.repeat(64);
    const command = await ask(database, requestId);
    const daemon = new DaemonService(database, new LiveHub());
    await daemon.execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        requestId,
        generationId: 'g1',
        status: 'failed',
        reason: 'the model ended its turn with no text (stop reason end_turn)',
        reasonKind: 'hiccup',
      },
      AGENT,
    );
    await claimAgentCommand(database, ROOM, AGENT, command.id, 'g2');
    await daemon.execute(
      'postRoomMessage',
      { roomId: ROOM, requestId, generationId: 'g2', text: 'Here is the answer.' },
      AGENT,
    );
    expect(await failureLine(database, requestId)).toMatchObject({
      text: '@candy could not answer · the model ended its turn with no text (stop reason end_turn). Restarting her and resending your message.',
      state: 'failed',
    });
  });

  it('records a deliberate no-reply completion without calling it a failure', async () => {
    const requestId = '0'.repeat(64);
    const command = await ask(database, requestId);
    const daemon = new DaemonService(database, new LiveHub());
    await daemon.execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        requestId,
        generationId: 'g1',
        status: 'complete',
        completionKind: 'no-reply',
      },
      AGENT,
    );
    const lines = (
      await database.query<{ text: string; card_type: string; state: string; completion: string }>(
        `SELECT text,card_type,card->>'state' state,card->>'completionKind' completion
         FROM messages WHERE room_id=$1 AND card->>'requestId'=$2 ORDER BY created_at,id`,
        [ROOM, requestId],
      )
    ).rows;
    expect(lines).toEqual([
      {
        text: '@candy had nothing to add · this turn completed normally.',
        card_type: 'turn-no-reply',
        state: 'complete',
        completion: 'no-reply',
      },
    ]);
    expect((await commandState(database, command.id))?.state).toBe('complete');
  });

  it('rejects a no-reply kind on a failed receipt', async () => {
    const requestId = 'a'.repeat(64);
    await ask(database, requestId);
    await expect(
      new DaemonService(database, new LiveHub()).execute(
        'postAgentTurnReceipt',
        {
          roomId: ROOM,
          requestId,
          generationId: 'g1',
          status: 'failed',
          completionKind: 'no-reply',
        },
        AGENT,
      ),
    ).rejects.toThrow('completion kind requires complete status');
    expect(await failureLine(database, requestId)).toBeUndefined();
  });
});

describe('90-second first silence from presence', () => {
  let database: PgliteDatabase;
  let live: LiveHub;
  let presence: ConnectionPresence;
  beforeEach(async () => {
    database = await fixture();
    live = new LiveHub();
    presence = new ConnectionPresence(database, live, 50);
  });
  afterEach(async () => {
    await presence.stop();
    vi.useRealTimers();
    await database.close();
  });

  it('inscribes the offline line when a delivered message is never picked up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const requestId = 'c'.repeat(64);
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy Hello')`,
      [requestId, ROOM, HUMAN],
    );
    await presence.observe(ROOM);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failureLine(database, requestId)).toEqual({
      text: "@candy is offline · her helper isn't running. Run `beeline start` on her machine.",
      silence: 'offline',
      state: 'failed',
    });
  });

  it('leaves an unclaimed command pending so beeline start can pick it up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const requestId = 'e'.repeat(64);
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy hi')`,
      [requestId, ROOM, HUMAN],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: requestId,
      reason: 'human_tag',
    });
    const restarts: number[] = [];
    live.subscribeAll((event) => {
      if (event.type === 'invalidate' && event.reason === 'hiccup-restart') {
        restarts.push(event.hiccupAttempt ?? 0);
      }
    });
    await presence.observe(ROOM);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failureLine(database, requestId)).toMatchObject({ silence: 'offline' });
    expect(await commandState(database, command!.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 0,
      generation_id: null,
    });
    expect(restarts).toEqual([]);
  });

  it('restarts a stalled working turn once and reopens the original command', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const requestId = 'd'.repeat(64);
    const command = await ask(database, requestId);
    const turn: CommittedTurnLiveRow = (
      await database.query<CommittedTurnLiveRow>(
        `SELECT room_id,request_id,agent_id,status,started_at,created_at,generation_id,NULL::text requested_by
         FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
        [ROOM, requestId],
      )
    ).rows[0]!;
    const restarts: number[] = [];
    live.subscribeAll((event) => {
      if (event.type === 'invalidate' && event.reason === 'hiccup-restart') {
        restarts.push(event.hiccupAttempt ?? 0);
      }
    });
    live.publish({
      type: 'invalidate',
      roomId: ROOM,
      reason: 'turn',
      agentId: AGENT,
      requestId,
      committedRow: { type: 'turn', row: turn },
    });
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(async () => {
      expect(await failureLine(database, requestId)).toBeTruthy();
    });
    expect(await failureLine(database, requestId)).toEqual({
      text: '@candy could not answer · the turn stalled. Restarting her and resending your message.',
      silence: 'hiccup',
      state: 'failed',
    });
    expect(await commandState(database, command.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 1,
      generation_id: null,
    });
    expect(restarts).toEqual([1]);
  });

  it('lets a silent long-running turn heartbeat past the deadline and publish exactly one reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const requestId = 'd'.repeat(63) + '1';
    const command = await ask(database, requestId);
    const daemon = new DaemonService(database, live);
    const turn = (
      await database.query<CommittedTurnLiveRow>(
        `SELECT room_id,request_id,agent_id,status,started_at,created_at,generation_id,NULL::text requested_by
         FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
        [ROOM, requestId],
      )
    ).rows[0]!;
    live.publish({
      type: 'invalidate',
      roomId: ROOM,
      reason: 'turn',
      agentId: AGENT,
      requestId,
      committedRow: { type: 'turn', row: turn },
    });

    for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) {
      await vi.advanceTimersByTimeAsync(40);
      await daemon.execute(
        'postAgentTurnReceipt',
        {
          roomId: ROOM,
          requestId,
          generationId: 'g1',
          status: 'working',
          heartbeat: true,
        },
        AGENT,
      );
    }
    await daemon.execute(
      'postRoomMessage',
      { roomId: ROOM, requestId, generationId: 'g1', text: 'The only reply.' },
      AGENT,
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(await failureLine(database, requestId)).toBeUndefined();
    expect(await commandState(database, command.id)).toEqual({
      state: 'complete',
      hiccup_attempts: 0,
      generation_id: 'g1',
    });
    expect(
      (
        await database.query<{ text: string }>(
          `SELECT text FROM messages WHERE request_id=$1 AND author_id=$2 ORDER BY created_at,id`,
          [requestId, AGENT],
        )
      ).rows,
    ).toEqual([{ text: 'The only reply.' }]);
  });

  it('inscribes every Room that still has an unanswered delivery when presence demotes once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const SECOND_ROOM = '33333333-3333-4333-8333-333333333333';
    const firstRequest = 'a'.repeat(64);
    const secondRequest = 'b'.repeat(64);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Second')`, [
      SECOND_ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
      [WORKSPACE, SECOND_ROOM, HUMAN, AGENT],
    );
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy Hello'),($4,$5,$3,'@candy Hello')`,
      [firstRequest, ROOM, HUMAN, secondRequest, SECOND_ROOM],
    );
    await presence.observe();
    await vi.advanceTimersByTimeAsync(100);
    const rooms = (
      await database.query<{ room_id: string }>(
        `SELECT room_id FROM messages WHERE card_type='turn-failed' ORDER BY room_id`,
      )
    ).rows.map((row) => row.room_id);
    expect(rooms).toEqual([ROOM, SECOND_ROOM].sort());
    const presenceStatus = (
      await database.query<{ status: string }>(
        `SELECT body->>'status' status FROM live_outputs WHERE agent_id=$1 AND kind='presence'`,
        [AGENT],
      )
    ).rows.map((row) => row.status);
    expect(presenceStatus).toEqual(['offline']);
  });
});

describe('silence detector ownership', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await fixture();
  });
  afterEach(async () => {
    await database.close();
  });

  it('accepts the startup-failure receipt before a corner loop can claim its command', async () => {
    const requestId = '9'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy hi')`,
      [requestId, ROOM, HUMAN],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: requestId,
      reason: 'human_tag',
    });
    const result = await new DaemonService(database, new LiveHub()).execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        requestId,
        status: 'failed',
        reason: 'corner parent Room repository state is not verified yet',
        reasonKind: 'workspace-failure',
      },
      AGENT,
    );
    expect(result.hiccupRestart).toBeUndefined();
    expect(await failureLine(database, requestId)).toMatchObject({
      silence: 'workspace-failure',
      state: 'failed',
    });
    expect(await commandState(database, command!.id)).toEqual({
      state: 'complete',
      hiccup_attempts: 0,
      generation_id: null,
    });
  });

  it('keeps a pending corner-start command redeliverable after a transient clone failure', async () => {
    const requestId = '8'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy hi')`,
      [requestId, ROOM, HUMAN],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: requestId,
      reason: 'human_tag',
    });
    const result = await new DaemonService(database, new LiveHub()).execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        requestId,
        status: 'failed',
        reason:
          'Command failed: git clone https://github.example/acme/widgets.git\nfatal: unable to access repository',
        reasonKind: 'workspace-failure',
      },
      AGENT,
    );
    expect(result.hiccupRestart).toBeUndefined();
    const line = await failureLine(database, requestId);
    expect(line).toMatchObject({ silence: 'workspace-failure', state: 'failed' });
    expect(line!.text).not.toMatch(/restarting|resending/i);
    expect(await commandState(database, command!.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 0,
      generation_id: null,
    });
  });

  it('coalesces concurrent silence detectors into one restart', async () => {
    const requestId = 'f'.repeat(64);
    const command = await ask(database, requestId);
    const live = new LiveHub();
    const liveRestarts: number[] = [];
    live.subscribeAll((event) => {
      if (event.type === 'invalidate' && event.reason === 'hiccup-restart') {
        liveRestarts.push(event.hiccupAttempt ?? 0);
      }
    });
    const outcomes = await Promise.all([
      noteFirstSilence(database, live, {
        roomId: ROOM,
        requestId,
        agentId: AGENT,
        generationId: 'g1',
        reason: 'the turn stalled',
        reasonKind: 'hiccup',
        liveRestart: false,
      }),
      noteFirstSilence(database, live, {
        roomId: ROOM,
        requestId,
        agentId: AGENT,
        generationId: 'g1',
        reason: 'the turn stalled',
        reasonKind: 'hiccup',
        liveRestart: true,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.hiccupRestart)).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome.hiccupRestart && outcome.attempt === 1)).toBe(true);
    expect(await commandState(database, command.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 1,
      generation_id: null,
    });
    expect(liveRestarts.length).toBeLessThanOrEqual(1);
  });

  it('does not reopen a completed command when a stale stall detector finishes', async () => {
    const requestId = '1'.repeat(63) + 'a';
    const command = await ask(database, requestId);
    const live = new LiveHub();
    const daemon = new DaemonService(database, live);
    await daemon.execute(
      'postRoomMessage',
      { roomId: ROOM, requestId, generationId: 'g1', text: 'One answer.' },
      AGENT,
    );

    const outcome = await noteFirstSilence(database, live, {
      roomId: ROOM,
      requestId,
      agentId: AGENT,
      generationId: 'g1',
      reason: 'the turn stalled',
      reasonKind: 'hiccup',
      liveRestart: true,
    });

    expect(outcome.hiccupRestart).toBe(false);
    expect(await commandState(database, command.id)).toEqual({
      state: 'complete',
      hiccup_attempts: 0,
      generation_id: 'g1',
    });
    expect(await failureLine(database, requestId)).toBeUndefined();
    expect(
      (
        await database.query<{ count: number }>(
          `SELECT count(*)::integer count FROM messages WHERE request_id=$1 AND author_id=$2`,
          [requestId, AGENT],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it('does not let a stale generation fail or reopen its successor', async () => {
    const requestId = '1'.repeat(63) + 'b';
    const command = await ask(database, requestId);
    await database.query(
      `UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
      [command.id],
    );
    await claimAgentCommand(database, ROOM, AGENT, command.id, 'g2');

    const outcome = await noteFirstSilence(database, new LiveHub(), {
      roomId: ROOM,
      requestId,
      agentId: AGENT,
      generationId: 'g1',
      reason: 'the turn stalled',
      reasonKind: 'hiccup',
      liveRestart: true,
    });

    expect(outcome.hiccupRestart).toBe(false);
    expect(await commandState(database, command.id)).toEqual({
      state: 'claimed',
      hiccup_attempts: 0,
      generation_id: 'g2',
    });
    expect(await failureLine(database, requestId)).toBeUndefined();
  });
});
