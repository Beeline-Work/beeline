import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import {
  claimInstitutionalMemoryJob,
  completeInstitutionalMemoryJob,
  enqueueInstitutionalMemoryTurnReview,
  failInstitutionalMemoryJob,
  institutionalMemoryShadowConfigFromEnv,
} from './institutional-memory-shadow.js';
import { PgliteDatabase } from './test-support.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const ROOM = '20000000-0000-4000-8000-000000000001';
const DM = '20000000-0000-4000-8000-000000000002';
const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const OTHER_AGENT = 'c'.repeat(64);
const MESSAGE = 'd'.repeat(64);
const DM_MESSAGE = 'e'.repeat(64);
const config = { enabled: true, dailyJobLimit: 20, leaseMs: 60_000 } as const;

let database: PgliteDatabase;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Human'),($2,'agent','Bee'),($3,'agent','Wasp')`,
    [HUMAN, AGENT, OTHER_AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Memory')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,machine_id) VALUES
       ($1,$3,'host-1'),($2,$3,'host-1')`,
    [AGENT, OTHER_AGENT, HUMAN],
  );
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Shared')`, [
    ROOM,
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,direct_participants)
       VALUES($1,$2,'DM',jsonb_build_array($3::text,$4::text))`,
    [DM, WORKSPACE, HUMAN, AGENT],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
       ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member'),
       ($1,$6,$2,'owner'),($1,$6,$3,'member'),($1,$6,$4,'member')`,
    [WORKSPACE, HUMAN, AGENT, OTHER_AGENT, ROOM, DM],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES
       ($1,$2,$3,'Remember that deploy writes the marker last.'),
       ($4,$5,$3,'Please make a mock before you build for me.')`,
    [MESSAGE, ROOM, HUMAN, DM_MESSAGE, DM],
  );
});

afterEach(async () => {
  await database.close();
});

async function enqueue(roomId = ROOM, sourceMessageId = MESSAGE, requestId = 'request-1') {
  return database.transaction((db) =>
    enqueueInstitutionalMemoryTurnReview(db, {
      roomId,
      sourceMessageId,
      requestId,
      config,
    }),
  );
}

function shadowDaemon(): DaemonService {
  return new DaemonService(
    database,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    config,
  );
}

const usage = {
  inputBytes: 120,
  outputBytes: 80,
  inputTokens: 30,
  outputTokens: 20,
  estimatedCostUsdMicros: 12,
  model: 'test-model',
  extractorVersion: 'shadow-v1',
} as const;

function workspaceProposal(roomId: string, sourceMessageId: string) {
  return {
    proposalVersion: 1 as const,
    candidateType: 'fact_candidate' as const,
    memoryKind: 'workspace_fact' as const,
    canonicalKey: 'deploy.release-marker-last',
    body: 'The release migration writes its schema marker last.',
    source: { roomId, messageIds: [sourceMessageId] },
    audience: 'workspace' as const,
    confidence: 0.95,
    classification: {
      stillTrueForAnotherRequester: true,
      rationale: 'The deploy ordering is true regardless of who asks.',
    },
    cas: { baseVersion: null },
  };
}

describe('institutional memory phase-0 shadow capture', () => {
  it('is dark by default and enqueues each completed turn at most once when enabled', async () => {
    expect(institutionalMemoryShadowConfigFromEnv({})).toMatchObject({ enabled: false });
    await database.transaction((db) =>
      enqueueInstitutionalMemoryTurnReview(db, {
        roomId: ROOM,
        sourceMessageId: MESSAGE,
        requestId: 'dark',
        config: { enabled: false },
      }),
    );
    expect((await database.query(`SELECT 1 FROM institutional_memory_jobs`)).rowCount).toBe(0);

    const first = await enqueue();
    const duplicate = await enqueue();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(duplicate).toBeUndefined();
    expect((await database.query(`SELECT 1 FROM institutional_memory_jobs`)).rowCount).toBe(1);
    expect(
      (
        await database.query<{ source_audience_kind: string }>(
          `SELECT source_audience_kind FROM institutional_memory_jobs`,
        )
      ).rows[0]?.source_audience_kind,
    ).toBe('workspace_candidate');
  });

  it('claims only authorized source Rooms and limits one active extraction per host', async () => {
    await enqueue();
    await enqueue(ROOM, MESSAGE, 'request-2');
    const claims = await Promise.all([
      claimInstitutionalMemoryJob(database, AGENT, config),
      claimInstitutionalMemoryJob(database, OTHER_AGENT, config),
    ]);
    const claimed = claims.find((candidate) => candidate !== undefined);
    expect(claims.filter((candidate) => candidate !== undefined)).toHaveLength(1);
    expect(claimed).toMatchObject({
      workspaceId: WORKSPACE,
      sourceRoomId: ROOM,
      sourceMessageId: MESSAGE,
      requesterIdentityId: HUMAN,
      directMessage: false,
    });
    expect(claimed?.messages.map((message) => message.id)).toContain(MESSAGE);
    await expect(
      claimInstitutionalMemoryJob(database, OTHER_AGENT, config),
    ).resolves.toBeUndefined();
  });

  it('requires both a reported host and current source-Room membership', async () => {
    await enqueue();
    await database.query(`UPDATE agents SET machine_id=NULL WHERE agent_id=$1`, [AGENT]);
    await expect(claimInstitutionalMemoryJob(database, AGENT, config)).resolves.toBeUndefined();

    await database.query(`UPDATE agents SET machine_id='host-1' WHERE agent_id=$1`, [AGENT]);
    await database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, AGENT],
    );
    await expect(claimInstitutionalMemoryJob(database, AGENT, config)).resolves.toBeUndefined();
  });

  it('enqueues shadow review in the transaction that completes an agent command', async () => {
    const command = await createAgentCommand(database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: MESSAGE,
      reason: 'human_tag',
      turnRequestId: 'shadow-hook-request',
    });
    await claimAgentCommand(database, ROOM, AGENT, command!.id, 'generation-1');
    await shadowDaemon().execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        agentId: AGENT,
        requestId: 'shadow-hook-request',
        generationId: 'generation-1',
        status: 'complete',
      },
      AGENT,
    );
    expect(
      (
        await database.query<{ source_request_id: string; status: string }>(
          `SELECT source_request_id,status FROM institutional_memory_jobs`,
        )
      ).rows,
    ).toEqual([{ source_request_id: 'shadow-hook-request', status: 'pending' }]);
  });

  it('stores validated extraction as shadow evidence without creating or serving memory', async () => {
    await enqueue();
    const claimed = (await claimInstitutionalMemoryJob(database, AGENT, config))!;
    await completeInstitutionalMemoryJob(
      database,
      AGENT,
      {
        agentId: AGENT,
        jobId: claimed.id,
        leaseToken: claimed.leaseToken,
        proposal: workspaceProposal(ROOM, MESSAGE),
        usage,
      },
      config,
    );
    expect(
      (await database.query<{ status: string }>(`SELECT status FROM institutional_memory_jobs`))
        .rows[0]?.status,
    ).toBe('completed');
    expect((await database.query(`SELECT 1 FROM institutional_memory_items`)).rowCount).toBe(0);
    expect(
      (
        await database.query<{ served: boolean; total_bytes: number; candidate_count: number }>(
          `SELECT served,total_bytes,candidate_count FROM institutional_context_serves`,
        )
      ).rows[0],
    ).toEqual({ served: false, total_bytes: 0, candidate_count: 1 });
    expect((await database.query(`SELECT 1 FROM institutional_memory_fact_events`)).rowCount).toBe(
      1,
    );

    // Same content hash makes a transport retry idempotent.
    await expect(
      completeInstitutionalMemoryJob(
        database,
        AGENT,
        {
          agentId: AGENT,
          jobId: claimed.id,
          leaseToken: claimed.leaseToken,
          proposal: workspaceProposal(ROOM, MESSAGE),
          usage,
        },
        config,
      ),
    ).resolves.toBeUndefined();
  });

  it('keeps DM facts out of shared memory but accepts the requester profile exception', async () => {
    await enqueue(DM, DM_MESSAGE, 'dm-request');
    const claimed = (await claimInstitutionalMemoryJob(database, AGENT, config))!;
    await expect(
      completeInstitutionalMemoryJob(
        database,
        AGENT,
        {
          agentId: AGENT,
          jobId: claimed.id,
          leaseToken: claimed.leaseToken,
          proposal: workspaceProposal(DM, DM_MESSAGE),
          usage,
        },
        config,
      ),
    ).rejects.toThrow(/direct-message facts/);

    await completeInstitutionalMemoryJob(
      database,
      AGENT,
      {
        agentId: AGENT,
        jobId: claimed.id,
        leaseToken: claimed.leaseToken,
        proposal: {
          ...workspaceProposal(DM, DM_MESSAGE),
          candidateType: 'correction_candidate',
          memoryKind: 'human_profile_fact',
          subjectIdentityId: HUMAN,
          audience: 'human_profile',
          classification: {
            stillTrueForAnotherRequester: false,
            rationale: 'This describes how the requester likes to work.',
          },
        },
        usage,
      },
      config,
    );
    expect(
      (
        await database.query<{ requester_identity_id: string; memory_kind: string }>(
          `SELECT requester_identity_id,memory_kind FROM institutional_memory_correction_events`,
        )
      ).rows[0],
    ).toEqual({ requester_identity_id: HUMAN, memory_kind: 'human_profile_fact' });
  });

  it('rejects credential material from model proposals', async () => {
    await enqueue();
    const claimed = (await claimInstitutionalMemoryJob(database, AGENT, config))!;
    await expect(
      completeInstitutionalMemoryJob(
        database,
        AGENT,
        {
          agentId: AGENT,
          jobId: claimed.id,
          leaseToken: claimed.leaseToken,
          proposal: {
            ...workspaceProposal(ROOM, MESSAGE),
            body: 'Use api_key=super-secret-value in production.',
          },
          usage,
        },
        config,
      ),
    ).rejects.toThrow(/credential material/);
  });

  it('retries bounded worker failures and loses authority after the lease is consumed', async () => {
    await enqueue();
    const claimed = (await claimInstitutionalMemoryJob(database, AGENT, config))!;
    await failInstitutionalMemoryJob(
      database,
      AGENT,
      {
        agentId: AGENT,
        jobId: claimed.id,
        leaseToken: claimed.leaseToken,
        error: 'provider unavailable',
        retryable: true,
      },
      config,
    );
    expect(
      (await database.query<{ status: string }>(`SELECT status FROM institutional_memory_jobs`))
        .rows[0]?.status,
    ).toBe('retry');
    await expect(
      failInstitutionalMemoryJob(
        database,
        AGENT,
        {
          agentId: AGENT,
          jobId: claimed.id,
          leaseToken: claimed.leaseToken,
          error: 'late duplicate',
          retryable: true,
        },
        config,
      ),
    ).rejects.toThrow(/lease conflict/);
  });
});
