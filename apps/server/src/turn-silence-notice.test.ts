import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCommand, claimAgentCommand } from './agent-command.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { ConnectionPresence } from './connection-presence.js';
import { LiveHub } from './live.js';
import type { CommittedTurnLiveRow } from './live.js';
import { noteFirstSilence, reclaimExpiredCommandLeases } from './turn-silence-notice.js';
import { flushDueCommanderWakes } from './commander-wakes.js';
import { repositoryCacheDamagedFault } from '@beeline/api-contract/daemon';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const AGENT = 'b'.repeat(64);
const HUMAN = 'a'.repeat(64);

async function fixture() {
  const database = await migratedDatabase();
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

  describe('Reproduction free-turn-closure', () => {
    beforeEach(async () => {
      await database.query(`INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys)
        VALUES($1,$2,$3,'test')`, [AGENT, WORKSPACE, HUMAN]);
    });

    it.each([
      ['allowance', 'provider allowance is spent', 'allowance-spent', 'midnight UTC'],
      ['timeout', 'free-agent-time-limit', 'hiccup', '15-minute limit'],
      ['crash', 'runtime_exited: code=1', 'hiccup', 'runtime failure'],
    ])('%s: receipt replay posts exactly one closing line', async (_, reason, reasonKind, expected) => {
      const requestId = 'e'.repeat(64);
      await ask(database, requestId);
      const service = new DaemonService(database, new LiveHub());
      const input = { roomId: ROOM, requestId, generationId: 'g1', status: 'failed' as const,
        reason, reasonKind: reasonKind as 'hiccup' | 'allowance-spent' };
      await service.execute('postAgentTurnReceipt', input, AGENT);
      await noteFirstSilence(database, new LiveHub(), { ...input, agentId: AGENT });
      const rows = await database.query(`SELECT text FROM messages WHERE card->>'freeAgentClosed'='true'`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].text).toContain(expected);
      expect(rows.rows[0].text).toMatch(/continue/);
      expect((await commandState(database, (await database.query<{ id: string }>(
        `SELECT id FROM agent_commands WHERE turn_request_id=$1`, [requestId])).rows[0].id))?.state).toBe('complete');
    });

    it('closes a textless end using the allowance refusal for that exact request', async () => {
      const requestId = 'e'.repeat(64);
      await ask(database, requestId);
      await database.query(`INSERT INTO free_agent_events(agent_id,kind,detail)
        VALUES($1,'allowance_reached',$2::jsonb)`, [AGENT,
        JSON.stringify({ limit: 'daily', roomId: ROOM, requestId })]);
      await new DaemonService(database, new LiveHub()).execute('postAgentTurnReceipt', {
        roomId: ROOM, requestId, generationId: 'g1', status: 'complete',
      }, AGENT);
      expect((await failureLine(database, requestId))?.text).toContain('midnight UTC');
    });

    it('normal final reply posts no closing line', async () => {
      const requestId = 'e'.repeat(64);
      await ask(database, requestId);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text,request_id)
        VALUES($1,$2,$3,'Here is the finished game',$4)`, ['f'.repeat(64),ROOM,AGENT,requestId]);
      await new DaemonService(database, new LiveHub()).execute('postAgentTurnReceipt', {
        roomId: ROOM, requestId, generationId: 'g1', status: 'complete',
      }, AGENT);
      expect(await failureLine(database, requestId)).toBeUndefined();
    });

    it('an empty complete receipt closes once with an honest status', async () => {
      const requestId = 'e'.repeat(64);
      await ask(database, requestId);
      const service = new DaemonService(database, new LiveHub());
      for (let i = 0; i < 2; i++) await service.execute('postAgentTurnReceipt', {
        roomId: ROOM, requestId, generationId: 'g1', status: 'complete',
      }, AGENT);
      expect((await failureLine(database, requestId))?.text).toContain('ended without a reply');
    });

    it('a dead lease closes without a helper receipt', async () => {
      const requestId = 'e'.repeat(64);
      await ask(database, requestId);
      await database.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '10 minutes'`);
      await reclaimExpiredCommandLeases(database,new LiveHub());
      await reclaimExpiredCommandLeases(database,new LiveHub());
      expect((await failureLine(database,requestId))?.text).toContain('runtime failure');
      expect((await database.query(`SELECT id FROM messages WHERE card->>'freeAgentClosed'='true'`)).rowCount).toBe(1);
    });
  });

  it('harness-node-missing-path: writes an actionable Room row from a failed daemon receipt', async () => {
    const requestId = 'f'.repeat(64);
    await ask(database, requestId);
    await new DaemonService(database, new LiveHub()).execute('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      generationId: 'g1',
      status: 'failed',
      reason: "runtime_exited: ACP agent /nvm/bin/codex-acp exited code=127: env: node: No such file or directory",
      reasonKind: 'hiccup',
    }, AGENT);
    const row = await failureLine(database, requestId);
    expect(row?.text).toContain("@candy could not answer · it couldn't start: the background service can't find Node");
    expect(row?.text).toContain('`beeline connect`');
    expect(row?.text).not.toContain('runtime_exited');
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
      text: "@candy could not answer · its provider is failing; switch its model in the agent's settings. provider error 429 concurrency_limit. Resending your message.",
      silence: 'hiccup',
      state: 'failed',
    });
    expect(await commandState(database, command.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 1,
      generation_id: null,
    });
  });

  it('retries a private order hiccup without writing a public failure line', async () => {
    const requestId = '1'.repeat(63) + 'e';
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: null,
      turnRequestId: requestId,
      privatePayload: { kind: 'order', text: 'Also cover the Room loop', authorId: HUMAN, fromRoomId: ROOM },
      reason: 'order',
    });
    await claimAgentCommand(database, ROOM, AGENT, command!.id, 'g1');
    const result = await new DaemonService(database, new LiveHub()).execute(
      'postAgentTurnReceipt',
      { roomId: ROOM, requestId, generationId: 'g1', status: 'failed',
        reason: 'AcpClient not started', reasonKind: 'hiccup' },
      AGENT,
    );
    expect(result).toMatchObject({ hiccupRestart: true, hiccupAttempt: 1 });
    expect(await failureLine(database, requestId)).toBeUndefined();
    expect(await commandState(database, command!.id)).toEqual({
      state: 'pending', hiccup_attempts: 1, generation_id: null,
    });
  });

  it.each(['human', 'agent'])('requeues an interrupted %s command without spending a hiccup attempt', async (author) => {
    const requestId = 'e'.repeat(64);
    const command = await ask(database, requestId);
    if (author === 'agent') await database.query('UPDATE messages SET author_id=$1 WHERE id=$2', [AGENT, requestId]);
    const daemon = new DaemonService(database, new LiveHub());
    const receipt = {
      roomId: ROOM,
      requestId,
      generationId: 'g1',
      status: 'failed' as const,
      reason: 'helper updated while the turn was running',
      reasonKind: 'update-interrupted' as const,
    };
    const result = await daemon.execute('postAgentTurnReceipt', receipt, AGENT);
    expect(result).toMatchObject({ updateRequeued: true });
    expect(result.hiccupRestart).toBeUndefined();
    expect(await failureLine(database, requestId)).toEqual({
      text: '@candy was interrupted by an update · the request is queued to resume.',
      silence: 'update-interrupted',
      state: 'failed',
    });
    expect(await commandState(database, command.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 0,
      generation_id: null,
    });
    expect(await daemon.execute('postAgentTurnReceipt', receipt, AGENT)).toMatchObject({
      updateRequeued: true,
    });
    expect(
      (
        await database.query(
          `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='turn-failed' AND card->>'requestId'=$2`,
          [ROOM, requestId],
        )
      ).rows,
    ).toHaveLength(1);
    await claimAgentCommand(database, ROOM, AGENT, command.id, 'g2');
    expect((await commandState(database, command.id))?.state).toBe('claimed');
  });

  it('restates a presence failure in place when the updated helper replays a generation-free receipt', async () => {
    const requestId = 'f'.repeat(64);
    const command = await ask(database, requestId);
    const live = new LiveHub();
    await noteFirstSilence(database, live, {
      roomId: ROOM,
      requestId,
      agentId: AGENT,
      generationId: 'g1',
      reason: 'the turn stalled',
    });
    const original = (
      await database.query<{ id: string }>(
        `SELECT id FROM messages WHERE room_id=$1 AND card_type='turn-failed'
         AND card->>'requestId'=$2`,
        [ROOM, requestId],
      )
    ).rows[0]!;
    // An install can exceed the usual recent-line coalescing window. The
    // journaled receipt still names the same failed turn, so it must update
    // that line rather than post another one.
    await database.query(`UPDATE messages SET created_at=now()-interval '11 minutes' WHERE id=$1`, [
      original.id,
    ]);
    expect(await commandState(database, command.id)).toMatchObject({
      state: 'pending',
      hiccup_attempts: 1,
      generation_id: null,
    });

    const daemon = new DaemonService(database, live);
    const receipt = {
      roomId: ROOM,
      requestId,
      status: 'failed' as const,
      reason: 'helper updated while the turn was running',
      reasonKind: 'update-interrupted' as const,
    };
    expect(await daemon.execute('postAgentTurnReceipt', receipt, AGENT)).toMatchObject({
      updateRequeued: true,
    });
    expect(await failureLine(database, requestId)).toEqual({
      text: '@candy was interrupted by an update · the request is queued to resume.',
      silence: 'update-interrupted',
      state: 'failed',
    });
    expect(await commandState(database, command.id)).toMatchObject({
      state: 'pending',
      hiccup_attempts: 1,
      generation_id: null,
    });
    expect(await daemon.execute('postAgentTurnReceipt', receipt, AGENT)).toMatchObject({
      updateRequeued: true,
    });
    expect(
      (
        await database.query<{ id: string }>(
          `SELECT id FROM messages WHERE room_id=$1 AND card_type='turn-failed'
           AND card->>'requestId'=$2`,
          [ROOM, requestId],
        )
      ).rows,
    ).toEqual([{ id: original.id }]);
  });

  it('maps each standing condition to its approved line and does not restart', async () => {
    const cases = [
      {
        requestId: '2'.repeat(64),
        reason: 'model selection unavailable',
        reasonKind: 'wrong-model' as const,
        text: "@candy could not answer · the selected model isn't available. Pick another in the agent's settings.",
        silence: 'wrong-model',
      },
      {
        requestId: '3'.repeat(64),
        reason:
          "You've hit your usage limit. Upgrade to Pro for more usage, or try again at Sep 19th, 2026 4:09 AM.",
        reasonKind: 'allowance-spent' as const,
        text: '@candy could not answer · the provider allowance is spent until Sep 19th, 2026 4:09 AM. Top up, or move the agent to another provider.',
        silence: 'allowance-spent',
      },
      {
        requestId: '4'.repeat(64),
        reason: 'ACP error -32000: Authentication required',
        reasonKind: 'not-signed-in' as const,
        text: "@candy could not answer · the helper could not authenticate with the provider. Check its log for the failed turn; if its login expired, run `beeline connect` on the helper's machine.",
        silence: 'not-signed-in',
      },
      {
        requestId: '5'.repeat(64),
        reason: 'fatal: repository not found github.com/acme/widgets.git',
        reasonKind: 'workspace-failure' as const,
        text: "@candy could not answer · the helper couldn't get a working copy of acme/widgets. Check the repository is reachable.",
        silence: 'workspace-failure',
      },
      {
        requestId: '6'.repeat(64),
        reason: 'server command protocol 1 is required; refusing intake',
        reasonKind: 'helper-out-of-date' as const,
        text: "@candy could not answer · the helper is out of date. Run `beeline start` on the helper's machine.",
        silence: 'helper-out-of-date',
      },
      {
        requestId: '7'.repeat(64),
        reason: 'resource_limit: ACP session exceeded its 8192 MiB memory limit',
        reasonKind: 'resource-limit' as const,
        text: '@candy could not answer · the session likely hit its memory limit. Run fewer tools at once or split the task.',
        silence: 'resource-limit',
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

  it('tells a Claude agent owner to send @agent login when its login fails', async () => {
    await database.query(`UPDATE agents SET harness='claude' WHERE agent_id=$1`, [AGENT]);
    const requestId = '7'.repeat(64);
    await ask(database, requestId, requestId.slice(0, 8));
    await new DaemonService(database, new LiveHub()).execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        requestId,
        generationId: requestId.slice(0, 8),
        status: 'failed',
        reason: 'ACP error -32000: Authentication required',
        reasonKind: 'not-signed-in',
      },
      AGENT,
    );
    expect(await failureLine(database, requestId)).toEqual({
      text: "@candy needs a Claude sign-in · send @candy login here. If that fails, its owner can run `beeline connect` on its machine.",
      silence: 'not-signed-in',
      state: 'failed',
    });
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
        text: "@candy could not answer \u00b7 the helper couldn't get a working copy of the repository. Check the repository is reachable.",
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

  it.each(['Authentication required', 'The model refused the request', 'Tool error: connection reset'])(
    'Reproduction CAPACITY-1: does not expand agent-triggered retries for %s', async reason => {
      const requestId = 'non-capacity-request';
      const command = await ask(database, requestId);
      await database.query('UPDATE messages SET author_id=$1 WHERE id=$2', [AGENT, requestId]);
      const result = await new DaemonService(database, new LiveHub()).execute('postAgentTurnReceipt', {
        roomId: ROOM, requestId, generationId: 'g1', status: 'failed', reason,
      }, AGENT);
      expect(result.hiccupRestart).toBeUndefined();
      expect((await commandState(database, command.id))?.state).toBe('complete');
    });

  it('Reproduction CAPACITY-1: an agent-triggered turn backs off, resumes, and stops after a finite budget', async () => {
    const requestId = 'capacity-request';
    const command = await ask(database, requestId);
    await database.query('UPDATE messages SET author_id=$1 WHERE id=$2', [AGENT, requestId]);
    const daemon = new DaemonService(database, new LiveHub());
    for (const attempt of [1, 2, 3]) {
      if (attempt > 1) {
        await database.query("UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE id=$1", [command.id]);
        await flushDueCommanderWakes(database);
        await claimAgentCommand(database, ROOM, AGENT, command.id, `g${attempt}`);
      }
      const result = await daemon.execute('postAgentTurnReceipt', {
        roomId: ROOM, requestId, generationId: `g${attempt}`, status: 'failed',
        reason: 'The model is at capacity; overloaded_error', reasonKind: 'hiccup',
      }, AGENT);
      expect(Boolean(result.hiccupRestart)).toBe(attempt < 3);
      const stored = (await database.query<{ state: string; delay: number | null }>(
        `SELECT state,EXTRACT(EPOCH FROM (wake_after-now()))::float delay FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!;
      expect(stored.state).toBe(attempt < 3 ? 'pending' : 'complete');
      if (attempt < 3) {
        expect(stored.delay).toBeGreaterThan(attempt === 1 ? 25 : 55);
        expect(stored.delay).toBeLessThanOrEqual(attempt === 1 ? 30 : 60);
      }
    }
    expect((await failureLine(database, requestId))?.text).toContain('Stopped retrying after three tries.');
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
      text: '@candy could not answer · ACP agent exited (code 1). Stopped retrying after three tries.',
      silence: 'hiccup',
      state: 'failed',
    });
  });

  it('Reproduction R2: a busy checkout keeps the order queued past three tries', async () => {
    const requestId = '8'.repeat(64);
    const command = await ask(database, requestId);
    const daemon = new DaemonService(database, new LiveHub());
    const reason = 'corner checkout is in use by another agent; retry after its turn and background tools finish';
    for (const attempt of [1, 2, 3, 4]) {
      if (attempt > 1) {
        await database.query(`UPDATE agent_commands SET wake_after=now()-interval '1 second' WHERE id=$1`, [command.id]);
        await flushDueCommanderWakes(database);
        await claimAgentCommand(database, ROOM, AGENT, command.id, `g${attempt}`);
      }
      const result = await daemon.execute('postAgentTurnReceipt', {
        roomId: ROOM, requestId, generationId: `g${attempt}`, status: 'failed', reason,
      }, AGENT);
      expect(result).toMatchObject({ updateRequeued: true });
      expect(result.hiccupRestart).toBeUndefined();
      const stored = (await database.query<{ state: string; hiccup_attempts: number; delay: number | null }>(
        `SELECT state,hiccup_attempts,EXTRACT(EPOCH FROM (wake_after-now()))::float delay
         FROM agent_commands WHERE id=$1`, [command.id])).rows[0]!;
      expect(stored.state).toBe('pending');
      expect(stored.hiccup_attempts).toBe(0);
      expect(stored.delay).toBeGreaterThan(10);
      expect(stored.delay).toBeLessThanOrEqual(15);
    }
    expect(await failureLine(database, requestId)).toBeUndefined();
    expect((await database.query(`SELECT 1 FROM messages WHERE text LIKE 'failed:%'`)).rowCount).toBe(0);
  });

  it('WAKE-STORM: repeated ACP rejections settle each command and share one notice until recovery', async () => {
    const daemon = new DaemonService(database, new LiveHub());
    for (let attempt = 0; attempt < 8; attempt++) {
      const command = await ask(database, `protocol-${attempt}`);
      const result = await daemon.execute('postAgentTurnReceipt', {
        roomId: ROOM, requestId: command.turn_request_id, generationId: 'g1', status: 'failed',
        reason: 'ACP error -32602: Invalid params', reasonKind: 'hiccup',
      }, AGENT);
      expect(result.hiccupRestart).toBeUndefined();
      expect(await commandState(database, command.id)).toMatchObject({ state: 'complete', hiccup_attempts: 0 });
      // A long outage must not start another failure span every ten minutes.
      await database.query(`UPDATE messages SET created_at=now()-interval '1 hour' WHERE card_type='turn-failed'`);
    }
    const notices = async () => (await database.query(`SELECT id FROM messages WHERE room_id=$1 AND card_type='turn-failed'`, [ROOM])).rows;
    expect(await notices()).toHaveLength(1);
    // Transcript ordering can put a notice after its cause's timestamp.
    await database.query(`UPDATE messages SET created_at=now()+interval '1 day' WHERE card_type='turn-failed'`);
    const recovered = await ask(database, 'protocol-recovered');
    await daemon.execute('postAgentTurnReceipt', {
      roomId: ROOM, requestId: recovered.turn_request_id, generationId: 'g1', status: 'complete',
    }, AGENT);
    const failed = await ask(database, 'protocol-new-span');
    await daemon.execute('postAgentTurnReceipt', {
      roomId: ROOM, requestId: failed.turn_request_id, generationId: 'g1', status: 'failed',
      reason: 'ACP error -32602: Invalid params', reasonKind: 'hiccup',
    }, AGENT);
    expect(await notices()).toHaveLength(2);
  });

  it('WAKE-STORM: a GitHub reset shares one notice across retries, long waits and new wakes', async () => {
    const daemon = new DaemonService(database, new LiveHub());
    const requestId = 'github-reset';
    const command = await ask(database, requestId);
    const reason = 'GitHub rate limit; checks readable again at 2026-10-27T18:07:00.000Z';
    for (const attempt of [1, 2, 3]) {
      if (attempt > 1) await claimAgentCommand(database, ROOM, AGENT, command.id, `g${attempt}`);
      await daemon.execute('postAgentTurnReceipt', { roomId: ROOM, requestId,
        generationId: `g${attempt}`, status: 'failed', reason, reasonKind: 'hiccup' }, AGENT);
      await database.query(`UPDATE messages SET created_at=now()-interval '1 hour' WHERE card_type='turn-failed'`);
    }
    const next = await ask(database, 'github-reset-new-wake');
    await daemon.execute('postAgentTurnReceipt', { roomId: ROOM, requestId: next.turn_request_id,
      generationId: 'g1', status: 'failed', reason, reasonKind: 'hiccup' }, AGENT);
    const notices = (await database.query<{ request_id: string }>(
      `SELECT card->>'requestId' request_id FROM messages WHERE room_id=$1 AND card_type='turn-failed'`, [ROOM])).rows;
    expect(notices).toEqual([{ request_id: requestId }]);
  });

  it.each(['human', 'agent'])('retries a hung harness once for a %s trigger, then completes its command', async (author) => {
    const requestId = 'hang-request';
    const command = await ask(database, requestId);
    if (author === 'agent') await database.query('UPDATE messages SET author_id=$1 WHERE id=$2', [AGENT, requestId]);
    const daemon = new DaemonService(database, new LiveHub());
    for (const attempt of [1, 2]) {
      if (attempt > 1) await claimAgentCommand(database, ROOM, AGENT, command.id, `g${attempt}`);
      const result = await daemon.execute('postAgentTurnReceipt', {
        roomId: ROOM, requestId, generationId: `g${attempt}`, status: 'failed',
        reason: 'turn_backstop: no ACP traffic for 45 minutes; last activity: tool_call',
        reasonKind: 'hiccup',
      }, AGENT);
      expect(Boolean(result.hiccupRestart)).toBe(attempt === 1);
      expect((await commandState(database, command.id))?.state).toBe(attempt === 1 ? 'pending' : 'complete');
    }
    expect((await failureLine(database, requestId))?.text).toContain('Stopped retrying after two tries.');
    expect((await database.query(
      `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    )).rows[0]?.status).toBe('failed');
  });

  it('reports an exhausted auth-shaped hiccup without assuming the helper is signed out', async () => {
    // A transient token-refresh race (claude-agent-acp mid-OAuth-refresh) gets
    // the same bounded hiccup retries as any other hiccup; only once those
    // are exhausted, the Room names the failed authentication without
    // deciding whether the helper's login expired or the refresh raced.
    const requestId = '9'.repeat(64);
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
          reason:
            'ACP error -32603: Internal error; harness stderr: 401 authentication_error: OAuth token refresh in progress',
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
      text: "@candy could not answer · the helper could not authenticate with the provider. Check its log for the failed turn; if its login expired, run `beeline connect` on the helper's machine.",
      silence: 'not-signed-in',
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
      text: '@candy could not answer · the model ended its turn with no text (stop reason end_turn). Resending your message.',
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
    expect(lines).toEqual([]);
    expect((await database.query(`SELECT * FROM messages WHERE author_id=$1`, [AGENT])).rows).toEqual([]);
    expect((await database.query(`SELECT * FROM agent_commands WHERE id<>$1`, [command.id])).rows).toEqual([]);
    expect((await database.query(`SELECT status FROM agent_turns WHERE request_id=$1`, [requestId])).rows).toEqual([{ status: 'complete' }]);
    console.info('Demonstrated silent-turns: no message, no notification source, no wake; audit receipt complete');
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

  it('Reproduction R1: a live helper that never starts the turn is not called offline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const requestId = '9'.repeat(64);
    await presence.announce(ROOM, AGENT, { lifecycleId: 'boot-1' });
    await database.query(
      `INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('live-helper',clock_timestamp())`,
    );
    await database.query(
      `INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
       VALUES($1,1,'live-helper','live-helper')`,
      [AGENT],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy Hello')`,
      [requestId, ROOM, HUMAN],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM, agentId: AGENT, sourceMessageId: requestId, reason: 'order',
      privatePayload: { kind: 'order', text: 'Continue', authorId: HUMAN, fromRoomId: ROOM },
    });
    await presence.observe(ROOM);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failureLine(database, requestId)).toBeUndefined();
    expect((await database.query(
      `SELECT text FROM messages WHERE text ILIKE '%offline%' OR text ILIKE '%unreachable%'`,
    )).rows).toEqual([]);
    expect((await commandState(database, command!.id))?.state).toBe('pending');
    const presenceBody = (await database.query<{ body: { status: string } }>(
      `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence' LIMIT 1`, [AGENT],
    )).rows[0]?.body;
    expect(presenceBody?.status).toBe('online');
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
      text: "@candy is offline · the helper is unreachable. If it stays offline, run `beeline start` on its machine.",
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
    const toHelper: string[] = [];
    live.subscribeAll((event) => {
      if (event.type === 'invalidate' && event.targetAgentId === AGENT) toHelper.push(event.reason);
    });
    await presence.observe(ROOM);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failureLine(database, requestId)).toMatchObject({ silence: 'offline' });
    expect(await commandState(database, command!.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 0,
      generation_id: null,
    });
    expect(toHelper.every((reason) => reason === 'postgres:agent_commands')).toBe(true);
  });

  it('fails only the stalled turn: another Room keeps its turn and the helper is never told to exit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const otherRoom = '33333333-3333-4333-8333-333333333333';
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other')`, [
      otherRoom,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
      [WORKSPACE, otherRoom, HUMAN, AGENT],
    );
    const otherRequest = '9'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy keep going')`,
      [otherRequest, otherRoom, HUMAN],
    );
    const otherCommand = (await createAgentCommand(database, {
      roomId: otherRoom,
      agentId: AGENT,
      sourceMessageId: otherRequest,
      reason: 'human_tag',
    }))!;
    await claimAgentCommand(database, otherRoom, AGENT, otherCommand.id, 'g-other');

    const requestId = 'd'.repeat(64);
    const command = await ask(database, requestId);
    const turn: CommittedTurnLiveRow = (
      await database.query<CommittedTurnLiveRow>(
        `SELECT room_id,request_id,agent_id,status,started_at,created_at,generation_id,NULL::text requested_by
         FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
        [ROOM, requestId],
      )
    ).rows[0]!;
    const toHelper: Array<{ roomId: string; reason: string }> = [];
    live.subscribeAll((event) => {
      if (event.type === 'invalidate' && event.targetAgentId === AGENT)
        toHelper.push({ roomId: event.roomId, reason: event.reason });
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
      text: expect.stringMatching(/no turn receipt for \d+ seconds; the helper disconnected\. Resending your message\./),
      silence: 'hiccup',
      state: 'failed',
    });
    expect(await commandState(database, command.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 1,
      generation_id: null,
    });
    // The only thing the helper hears is the requeued command for this Room.
    expect(toHelper).toEqual([{ roomId: ROOM, reason: 'postgres:agent_commands' }]);
    expect(await commandState(database, otherCommand.id)).toEqual({
      state: 'claimed',
      hiccup_attempts: 0,
      generation_id: 'g-other',
    });
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [otherRoom, otherRequest, AGENT],
        )
      ).rows[0]?.status,
    ).toBe('working');
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

  it('shows a damaged repo cache as one plain line and files it for the owner', async () => {
    const requestId = '7'.repeat(64);
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
    const reason = repositoryCacheDamagedFault('repositories/655f97ec88f4e595a04a9e67.git', 'chad');
    await new DaemonService(database, new LiveHub()).execute(
      'postAgentTurnReceipt',
      { roomId: ROOM, requestId, status: 'failed', reason, reasonKind: 'workspace-failure' },
      AGENT,
    );
    const line = await failureLine(database, requestId);
    expect(line).toMatchObject({ silence: 'workspace-failure', state: 'failed' });
    expect(line!.text).toBe(`@candy could not answer · ${reason}.`);
    expect(
      (
        await database.query(
          `SELECT category,summary,detail,reporter_owner_id,room_id FROM feedback_items WHERE source_kind='agent'`,
        )
      ).rows,
    ).toEqual([
      {
        category: 'bug',
        summary: 'A helper repo cache is damaged and automatic repair failed',
        detail: reason,
        reporter_owner_id: HUMAN,
        room_id: ROOM,
      },
    ]);
    expect(await commandState(database, command!.id)).toMatchObject({ state: 'pending' });
  });

  it('coalesces concurrent silence detectors into one restart', async () => {
    const requestId = 'f'.repeat(64);
    const command = await ask(database, requestId);
    const live = new LiveHub();
    const outcomes = await Promise.all([
      noteFirstSilence(database, live, {
        roomId: ROOM,
        requestId,
        agentId: AGENT,
        generationId: 'g1',
        reason: 'the turn stalled',
        reasonKind: 'hiccup',
      }),
      noteFirstSilence(database, live, {
        roomId: ROOM,
        requestId,
        agentId: AGENT,
        generationId: 'g1',
        reason: 'the turn stalled',
        reasonKind: 'hiccup',
        stalled: true,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.hiccupRestart)).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome.hiccupRestart && outcome.attempt === 1)).toBe(true);
    expect(await commandState(database, command.id)).toEqual({
      state: 'pending',
      hiccup_attempts: 1,
      generation_id: null,
    });
  });

  it('Reproduction posted-reply: a committed answer suppresses a generation-free stall', async () => {
    const requestId = '7'.repeat(63) + 'a';
    const command = await ask(database, requestId);
    await new DaemonService(database, new LiveHub()).execute('postRoomMessage',
      { roomId: ROOM, requestId, generationId: 'g1', text: 'Already answered.' }, AGENT);
    await noteFirstSilence(database, new LiveHub(), {
      roomId: ROOM, requestId, agentId: AGENT, reason: 'the turn stalled', reasonKind: 'hiccup', stalled: true,
    });
    expect(await failureLine(database, requestId)).toBeUndefined();
    expect(await commandState(database, command.id)).toMatchObject({ state: 'complete', hiccup_attempts: 0 });
  });

  it.each(['done', 'blocked', 'stale-done', 'later-prose'])('Reproduction reported-stall: preserves only a done report from this generation (%s)', async outcome => {
    const requestId = '7'.repeat(63) + 'b';
    const command = await ask(database, requestId);
    await database.query(`UPDATE agent_commands SET report_outcome=$2,
      private_payload=$3::jsonb WHERE id=$1`, [command.id, outcome === 'blocked' ? 'blocked' : 'done',
        JSON.stringify({ reportedGenerationId: outcome === 'stale-done' ? 'old-generation' : 'g1',
          ...(outcome === 'later-prose' ? { reportedOutcome: null } : {}) })]);
    await database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
      VALUES($1,$2,$3,'working','g1') ON CONFLICT(room_id,request_id,agent_id)
      DO UPDATE SET status='working',generation_id='g1'`, [ROOM, requestId, AGENT]);
    await noteFirstSilence(database, new LiveHub(), {
      roomId: ROOM, requestId, agentId: AGENT, generationId: 'g1',
      reason: 'no turn receipt for 90 seconds; the helper stopped reporting this turn', reasonKind: 'hiccup', stalled: true,
    });
    const turn = (await database.query(`SELECT status FROM agent_turns WHERE request_id=$1`, [requestId])).rows[0];
    if (outcome === 'done') {
      expect(turn).toEqual({ status: 'complete' });
      expect(await commandState(database, command.id)).toMatchObject({ state: 'complete', hiccup_attempts: 0 });
      expect(await failureLine(database, requestId)).toBeUndefined();
    } else {
      expect(turn).toEqual({ status: 'failed' });
      expect(await commandState(database, command.id)).toMatchObject({ state: 'pending', hiccup_attempts: 1 });
    }
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
      stalled: true,
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
      stalled: true,
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

describe('expired command lease sweep', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await fixture();
  });
  afterEach(async () => {
    await database.close();
  });

  it('terminates a long-expired claim with no human trigger, which noteFirstSilence cannot reach', async () => {
    const requestId = '1'.repeat(63) + 'c';
    // An agent-to-agent dispatch: the source message is agent-authored, so
    // noteFirstSilence's own trigger lookup (which requires a human author)
    // never frees this command no matter how long it stalls.
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@candy go')`,
      [requestId, ROOM, AGENT],
    );
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: requestId,
      reason: 'agent_tag',
    });
    await claimAgentCommand(database, ROOM, AGENT, command!.id, 'stale-gen');
    await database.query(
      `UPDATE agent_commands SET lease_expires_at=now()-interval '1 hour' WHERE id=$1`,
      [command!.id],
    );

    const live = new LiveHub();
    const toHelper: Array<{ roomId: string; reason: string }> = [];
    live.subscribeAll((event) => {
      if (event.type === 'invalidate' && event.targetAgentId === AGENT)
        toHelper.push({ roomId: event.roomId, reason: event.reason });
    });
    expect(
      await noteFirstSilence(database, live, {
        roomId: ROOM,
        requestId,
        agentId: AGENT,
        generationId: 'stale-gen',
        reason: 'the turn stalled',
        reasonKind: 'hiccup',
        stalled: true,
      }),
    ).toMatchObject({ hiccupRestart: false });
    expect(await commandState(database, command!.id)).toMatchObject({ state: 'claimed' });

    const terminated = await reclaimExpiredCommandLeases(database, live);
    expect(terminated).toBe(1);
    expect(await commandState(database, command!.id)).toMatchObject({ state: 'complete' });
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
          [ROOM, AGENT, requestId],
        )
      ).rows[0]?.status,
    ).toBe('failed');
    expect(toHelper).toEqual([{ roomId: ROOM, reason: 'postgres:agent_commands' }]);

    // Idempotent: nothing left to terminate on a second pass.
    expect(await reclaimExpiredCommandLeases(database, live)).toBe(0);
  });

  it('leaves a freshly claimed command alone', async () => {
    const requestId = '1'.repeat(63) + 'd';
    const command = await ask(database, requestId);
    expect(await reclaimExpiredCommandLeases(database, new LiveHub())).toBe(0);
    expect(await commandState(database, command.id)).toMatchObject({ state: 'claimed' });
  });

  it('never touches a command already reclaimed under a new generation', async () => {
    const requestId = '1'.repeat(63) + 'g';
    const command = await ask(database, requestId);
    await database.query(
      `UPDATE agent_commands SET lease_expires_at=now()-interval '1 hour' WHERE id=$1`,
      [command.id],
    );
    await claimAgentCommand(database, ROOM, AGENT, command.id, 'g-fresh');
    expect(await reclaimExpiredCommandLeases(database, new LiveHub())).toBe(0);
    expect(await commandState(database, command.id)).toMatchObject({
      state: 'claimed',
      generation_id: 'g-fresh',
    });
  });
});
