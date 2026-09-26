#!/usr/bin/env node
/**
 * End-to-end institutional-memory proof, on a DISPOSABLE Workspace.
 *
 * Everything here runs against the real HTTP server: a person's correction is a
 * phone operation, the helper learns it has work the only way a daemon ever does
 * — by asking for its commands — and every read a turn makes (its snapshot, a
 * history search, a restricted procedure load) goes through the same daemon
 * routes production uses. GitHub's news is a signed webhook delivery. Nothing
 * reaches past those routes.
 *
 * The Workspace this runs in is created by this script inside a throwaway
 * database, so the demonstration never touches a real one.
 *
 * The seven lifecycle steps the intent names:
 *   1. A person corrects agent A once, and agent B obeys on that person's next task.
 *   2. Another person's agent is unaffected by that preference.
 *   3. A shared fact reaches everyone's agents.
 *   4. Authorized history search returns audience-correct results.
 *   5. A completed corner's review produces a restricted procedure another agent can load.
 *   6. The curator ages, consolidates and retains memory over a simulated cycle.
 *   7. (the ledger those measures read) each step leaves its own rows behind.
 *
 * Local invocation:
 *   npm run prove:institutional-memory
 *
 * The JSON evidence this run produced is written to
 * `docs/institutional-memory-proof.json` and committed with the script.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { migrate } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { GitHubOperations } from '../apps/server/src/github-operations.js';
import {
  institutionalObjectiveDashboard,
  runInstitutionalCuratorCycle,
} from '../apps/server/src/institutional-curator.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

const WORKSPACE = '11111111-1111-4111-8111-111111111901';
const ROOM = '22222222-2222-4222-8222-222222222901';
const PRIVATE_ROOM = '22222222-2222-4222-8222-222222222902';
const CORNER = '33333333-3333-4333-8333-333333333901';
const PLAIN_CORNER = '33333333-3333-4333-8333-333333333902';
const HUMAN_A = 'a'.repeat(64);
const HUMAN_B = 'b'.repeat(64);
const AGENT_A = 'c'.repeat(64);
const AGENT_B = 'd'.repeat(64);
const AGENT_C = 'e'.repeat(64);
const INSTALLATION = 901;
const REPOSITORY = 901;
const WEBHOOK_SECRET = 'proof-webhook-secret';
const MERGE_COMMIT = 'f'.repeat(40);
const CORRECTION = 'Actually, I never want release notes generated for internal-only changes.';
const SHARED_FACT =
  'Release migrations must stay outside a transaction so the index builds concurrently.';
const ANCHOR_PATH = 'apps/server/src/database.ts';
const ANCHOR_BLOB = '9'.repeat(40);

type Step = {
  readonly step: string;
  readonly observation: Record<string, unknown>;
};

const evidence: Step[] = [];
/** Commands this run has already taken, so a later step never re-takes one. */
const consumedCommands = new Set<string>();

function record(step: string, observation: Record<string, unknown>): void {
  evidence.push({ step, observation });
  console.log(`\n■ ${step}`);
  for (const [key, value] of Object.entries(observation)) {
    console.log(`   ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`proof step failed: ${message}`);
}

let evidenceDatabase: PgliteDatabase;

async function main(): Promise<void> {
  const database = new PgliteDatabase();
  evidenceDatabase = database;
  await migrate(database);
  await seed(database);

  const pullRequestHeads = new Map([[901, '1'.repeat(40)]]);
  const githubApp = {
    installationToken: async () => ({
      token: 'installation-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    readPullRequest: async (_token: string, repository: string, number: number) => ({
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      headSha: pullRequestHeads.get(number) ?? '1'.repeat(40),
    }),
    readCommitCheckRollup: async () => ({
      state: 'passed' as const,
      total: 1,
      failing: [],
      checks: [],
    }),
    fileBlobSha: async () => ANCHOR_BLOB,
    deleteBranch: async () => undefined,
  } as unknown as GitHubAppClient;
  // The merge review is enqueued by the GitHub side, so this object needs the
  // same institutional-memory config the daemon route is built with.
  const recordInstitutionalMemory = {
    enabled: true,
    live: true,
    dailyJobLimit: 50,
    leaseMs: 5 * 60_000,
  } as const;
  const github = new GitHubOperations(
    database,
    {} as GitHubOAuthClient,
    githubApp,
    'github-client-secret',
    undefined,
    undefined,
    recordInstitutionalMemory,
  );
  const phone = new PhoneService(database, 'http://placeholder', github);
  const live = new LiveHub();
  const daemon = new DaemonService(
    database,
    live,
    async () => github.roomToken(ROOM),
    1024 * 1024,
    false,
    undefined,
    false,
    undefined,
    (input) => github.prChecksStatus(input),
    undefined,
    recordInstitutionalMemory,
  );
  const auth = new TokenAuth(database, async (ticket) =>
    ticket === 'proof-b'
      ? { subject: 'proof-mate', login: 'proofmate', name: 'Proof Mate' }
      : { subject: 'proof-owner', login: 'proofowner', name: 'Proof Owner' },
  );
  const server = createBeelineServer({
    database,
    auth,
    phone,
    daemon,
    live,
    mediaMaximumBytes: 1024 * 1024,
    github: {
      webhookSecret: WEBHOOK_SECRET,
      onWebhook: (event, payload) => github.processWebhook(event, payload),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (path: string, token: string, payload: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${text}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  const ownerToken = (await auth.exchangeGitHubOidc('proof-a')).accessToken;
  const mateToken = (await auth.exchangeGitHubOidc('proof-b')).accessToken;
  const phoneOperation = (name: string, payload: unknown, token = ownerToken) =>
    call(`/v1/phone/operations/${name}`, token, payload);
  const daemonTokenFor = async (agentId: string) => {
    const exchange = await auth.createDaemonExchange(agentId);
    return (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  };
  const daemonTokens = new Map([
    [AGENT_A, await daemonTokenFor(AGENT_A)],
    [AGENT_B, await daemonTokenFor(AGENT_B)],
    [AGENT_C, await daemonTokenFor(AGENT_C)],
  ]);
  const daemonOperation = (agentId: string, name: string, payload: unknown) =>
    call(`/v1/daemon/operations/${name}`, daemonTokens.get(agentId)!, payload);

  /** A person's message, then the helper taking it the way a daemon does. */
  const takeNextTask = async (
    agentId: string,
    roomId: string,
    sourceMessageId: string,
  ): Promise<{ requestId: string; generationId: string; sourceMessageId: string }> => {
    const commands = (await daemonOperation(agentId, 'getAgentCommands', { roomId })).commands as
      { id: string; turnRequestId: string; sourceMessageId: string }[] | undefined;
    const command = commands?.find((candidate) => candidate.sourceMessageId === sourceMessageId);
    assert(command, `expected a pending command for ${agentId} on ${sourceMessageId}`);
    consumedCommands.add(command.id);
    const generationId = randomUUID();
    await daemonOperation(agentId, 'claimAgentCommand', {
      roomId,
      commandId: command.id,
      generationId,
    });
    return {
      requestId: command.turnRequestId,
      generationId,
      sourceMessageId: command.sourceMessageId,
    };
  };
  const snapshotFor = async (
    agentId: string,
    roomId: string,
    task: { requestId: string; generationId: string },
  ) => {
    const snapshot = await daemonOperation(agentId, 'getInstitutionalContext', {
      roomId,
      requestId: task.requestId,
      generationId: task.generationId,
    });
    return snapshot as { text: string; itemIds: string[]; totalBytes: number };
  };
  const completeTurn = async (
    agentId: string,
    roomId: string,
    task: { requestId: string; generationId: string },
    metrics: { inputTokens: number; promptBytes: number; toolCalls: number },
  ) =>
    daemonOperation(agentId, 'postAgentTurnReceipt', {
      roomId,
      requestId: task.requestId,
      generationId: task.generationId,
      status: 'complete',
      ...metrics,
    });
  const workerOperation = (name: string, payload: unknown, agentId = AGENT_A) =>
    daemonOperation(agentId, name, payload);
  /**
   * Claim the next job of one kind. The queue also holds review work from the
   * turns this run posted, so a job of another kind is answered with an empty
   * proposal — which is exactly what a host does when a turn taught nothing —
   * until the wanted one is in hand.
   */
  const claimJobOfKind = async (
    triggerKind: string,
    agentId = AGENT_A,
    matches: (job: { id: string; context?: { targetCommit?: string } }) => boolean = () => true,
  ) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const claimed = (await workerOperation(
        'claimInstitutionalMemoryJob',
        { agentId },
        agentId,
      )) as {
        job?: {
          id: string;
          leaseToken: string;
          triggerKind: string;
          context?: { targetCommit?: string; repository?: string };
        };
      };
      if (!claimed.job) break;
      if (claimed.job.triggerKind === triggerKind && matches(claimed.job)) return claimed.job;
      await workerOperation(
        'completeInstitutionalMemoryJob',
        {
          agentId,
          jobId: claimed.job.id,
          leaseToken: claimed.job.leaseToken,
          proposal: null,
          usage: {
            inputBytes: 10,
            outputBytes: 10,
            model: 'proof-model',
            extractorVersion: 'proof-extractor',
          },
        },
        agentId,
      );
    }
    throw new Error(`no ${triggerKind} job could be claimed`);
  };

  const webhook = async (event: string, delivery: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const response = await fetch(`${origin}/v1/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
      },
      body,
    });
    if (!response.ok) throw new Error(`webhook ${event} -> ${response.status}`);
  };
  const base = {
    installation: { id: INSTALLATION },
    repository: { id: REPOSITORY, full_name: 'proof-owner/proof-repo' },
    sender: { login: 'proofowner' },
  };
  // ── Step 1: a person corrects agent A once ────────────────────────────────
  const correctionMessage = (await phoneOperation('sendRoomMessage', {
    roomId: ROOM,
    messageId: randomBytes(32).toString('hex'),
    text: `@agenta ${CORRECTION}`,
    mentions: ['agenta'],
  })) as { messageId: string };
  const correctionTask = await takeNextTask(AGENT_A, ROOM, correctionMessage.messageId);
  await completeTurn(AGENT_A, ROOM, correctionTask, {
    inputTokens: 40_000,
    promptBytes: 80_000,
    toolCalls: 3,
  });
  const reviewJob = (
    await database.query<{ id: string; trigger_kind: string; mode: string }>(
      `SELECT id,trigger_kind,mode FROM institutional_memory_jobs
       WHERE workspace_id=$1 AND trigger_kind='turn_review'`,
      [WORKSPACE],
    )
  ).rows[0];
  assert(reviewJob, 'the settled turn enqueued a review job');
  const claimed = (await workerOperation('claimInstitutionalMemoryJob', { agentId: AGENT_A })) as {
    enabled: boolean;
    job?: { id: string; leaseToken: string };
  };
  assert(claimed.job, 'the host claimed the review job');
  await workerOperation('completeInstitutionalMemoryJob', {
    agentId: AGENT_A,
    jobId: claimed.job.id,
    leaseToken: claimed.job.leaseToken,
    proposal: {
      proposalVersion: 1,
      candidateType: 'preference_candidate',
      memoryKind: 'human_profile_fact',
      subjectIdentityId: HUMAN_A,
      canonicalKey: 'release-notes-internal-only',
      body: CORRECTION,
      source: { roomId: ROOM, messageIds: [correctionMessage.messageId] },
      audience: 'human_profile',
      confidence: 0.9,
      classification: {
        stillTrueForAnotherRequester: false,
        rationale: 'This is how one person wants their release notes handled.',
      },
      cas: { baseVersion: null },
    },
    usage: {
      inputBytes: 400,
      outputBytes: 120,
      model: 'proof-model',
      extractorVersion: 'proof-extractor',
    },
  });
  record('a person corrects agent A once', {
    correction: CORRECTION,
    enqueuedJob: reviewJob.id,
    memoryItem: (
      await database.query<{ kind: string; canonical_key: string }>(
        `SELECT kind,canonical_key FROM institutional_memory_items WHERE workspace_id=$1`,
        [WORKSPACE],
      )
    ).rows,
  });

  // Agent B on that person's next task.
  const agentBMessage = (await phoneOperation('sendRoomMessage', {
    roomId: ROOM,
    messageId: randomBytes(32).toString('hex'),
    text: '@agentb please write up this release for me',
    mentions: ['agentb'],
  })) as { messageId: string };
  const agentBTask = await takeNextTask(AGENT_B, ROOM, agentBMessage.messageId);
  const agentBSnapshot = await snapshotFor(AGENT_B, ROOM, agentBTask);
  assert(
    agentBSnapshot.text.includes(CORRECTION),
    'the correction reached agent B on that person’s next task',
  );
  record('agent B obeys on that person’s next task', {
    injected: agentBSnapshot.text.includes(CORRECTION),
    totalBytes: agentBSnapshot.totalBytes,
    items: agentBSnapshot.itemIds.length,
  });

  // ── Step 2: another person's agent is unaffected ──────────────────────────
  const agentCMessage = (await phoneOperation(
    'sendRoomMessage',
    {
      roomId: ROOM,
      messageId: randomBytes(32).toString('hex'),
      text: '@agentc please write up this release for me',
      mentions: ['agentc'],
    },
    mateToken,
  )) as { messageId: string };
  const agentCTask = await takeNextTask(AGENT_C, ROOM, agentCMessage.messageId);
  const agentCSnapshot = await snapshotFor(AGENT_C, ROOM, agentCTask);
  assert(
    !agentCSnapshot.text.includes(CORRECTION),
    'the other person’s agent must not receive that preference',
  );
  record('another person’s agent is unaffected', {
    injected: agentCSnapshot.text.includes(CORRECTION),
    text: agentCSnapshot.text,
  });

  // ── Step 3: a shared fact reaches everyone's agents ───────────────────────
  const factMessage = (await phoneOperation('sendRoomMessage', {
    roomId: ROOM,
    messageId: randomBytes(32).toString('hex'),
    text: `@agenta remember this for everybody: ${SHARED_FACT}`,
    mentions: ['agenta'],
  })) as { messageId: string };
  const factTask = await takeNextTask(AGENT_A, ROOM, factMessage.messageId);
  const proposal = (await daemonOperation(AGENT_A, 'proposeInstitutionalMemory', {
    agentId: AGENT_A,
    roomId: ROOM,
    requestId: factTask.requestId,
    generationId: factTask.generationId,
    memoryKind: 'workspace_fact',
    canonicalKey: 'release-migration-transactions',
    body: SHARED_FACT,
    sourceMessageIds: [factMessage.messageId],
    correction: false,
    confidence: 0.8,
    cas: { baseVersion: null },
  })) as { itemId: string; version: number };
  await completeTurn(AGENT_A, ROOM, factTask, {
    inputTokens: 10_000,
    promptBytes: 20_000,
    toolCalls: 1,
  });
  assert(proposal.itemId, 'the workspace fact was stored');
  const agentBWithFact = await snapshotFor(AGENT_B, ROOM, agentBTask);
  const agentCWithFact = await snapshotFor(AGENT_C, ROOM, agentCTask);
  assert(
    agentBWithFact.text.includes(SHARED_FACT) && agentCWithFact.text.includes(SHARED_FACT),
    'the shared fact must reach every agent in the Workspace',
  );
  record('a shared fact reaches everyone’s agents', {
    itemId: proposal.itemId,
    agentB: agentBWithFact.text.includes(SHARED_FACT),
    agentC: agentCWithFact.text.includes(SHARED_FACT),
  });

  // ── Step 4: authorized history search is audience-correct ────────────────
  const privateMarker = 'private-marker-quartz-lantern';
  const privateMessage = (await phoneOperation('sendRoomMessage', {
    roomId: PRIVATE_ROOM,
    messageId: randomBytes(32).toString('hex'),
    text: `@agenta internal-only note about ${privateMarker} that nobody outside this Room may see.`,
    mentions: ['agenta'],
  })) as { messageId: string };
  const sharedSearch = (await daemonOperation(AGENT_B, 'searchInstitutionalHistory', {
    agentId: AGENT_B,
    roomId: ROOM,
    requestId: agentBTask.requestId,
    generationId: agentBTask.generationId,
    query: privateMarker,
  })) as { results: { messageId: string; roomId: string }[]; omitted: number };
  assert(
    sharedSearch.results.length === 0,
    'a private Room must not leak into a shared output Room',
  );
  const privateTask = await takeNextTask(AGENT_A, PRIVATE_ROOM, privateMessage.messageId);
  const privateSearch = (await daemonOperation(AGENT_A, 'searchInstitutionalHistory', {
    agentId: AGENT_A,
    roomId: PRIVATE_ROOM,
    requestId: privateTask.requestId,
    generationId: privateTask.generationId,
    query: privateMarker,
  })) as { results: { messageId: string; roomId: string }[] };
  assert(privateSearch.results.length === 1, 'the private Room’s own member must find it');
  record('authorized history search is audience-correct', {
    sharedRoomResults: sharedSearch.results.length,
    privateRoomResults: privateSearch.results.length,
    privateRoom: privateSearch.results[0]?.roomId === PRIVATE_ROOM,
  });

  // A corner turn of its own, so the serve ledger holds a corner and the p95
  // budget gate is measured from a REAL harness token count rather than its
  // byte estimate. The second corner in the same repository merges with no
  // serve at all, which is the eligible-but-unserved cohort it is compared to.
  const cornerMessage = (await phoneOperation('sendRoomMessage', {
    roomId: CORNER,
    messageId: randomBytes(32).toString('hex'),
    text: '@agenta pick this up in the corner as agreed, the same release rules apply',
    mentions: ['agenta'],
  })) as { messageId: string };
  const cornerTask = await takeNextTask(AGENT_A, CORNER, cornerMessage.messageId);
  const cornerSnapshot = await snapshotFor(AGENT_A, CORNER, cornerTask);
  await completeTurn(AGENT_A, CORNER, cornerTask, {
    inputTokens: 30_000,
    promptBytes: 60_000,
    toolCalls: 2,
  });
  assert(cornerSnapshot.itemIds.length > 0, 'the corner turn received the shared memory');
  await webhook('pull_request', randomUUID(), {
    ...base,
    action: 'closed',
    pull_request: {
      number: 902,
      title: 'Retire the old migration runner',
      html_url: 'https://github.com/proof-owner/proof-repo/pull/902',
      head: { ref: 'feature/idle-migrations', sha: '2'.repeat(40) },
      base: { ref: 'main' },
      merged: true,
      merged_at: '2026-09-26T13:00:00Z',
      merge_commit_sha: 'a'.repeat(40),
      merged_by: { login: 'proofmate' },
      commits: 1,
      changed_files: 1,
    },
  });
  const servedState = (
    await database.query<{ corner_serve: string; real_tokens: string }>(
      `SELECT (SELECT count(*) FROM institutional_context_serves
               WHERE room_id=$1 AND mode='live' AND served)::text corner_serve,
              (SELECT count(*) FROM institutional_context_serves
               WHERE room_id=$1 AND actual_input_tokens IS NOT NULL)::text real_tokens`,
      [CORNER],
    )
  ).rows[0]!;
  record('a corner turn is measured from the harness’s own token count', {
    cornerServes: Number(servedState.corner_serve),
    servesWithRealTokens: Number(servedState.real_tokens),
    sharedFactReachedCorner: cornerSnapshot.itemIds.length,
  });

  // ── Step 5: a merged corner's review produces a restricted procedure ──────

  await webhook('pull_request', randomUUID(), {
    ...base,
    action: 'closed',
    pull_request: {
      number: 901,
      title: 'Keep release migrations safe',
      html_url: 'https://github.com/proof-owner/proof-repo/pull/901',
      head: { ref: 'feature/safe-migrations', sha: '1'.repeat(40) },
      base: { ref: 'main' },
      merged: true,
      merged_at: '2026-09-26T12:00:00Z',
      merge_commit_sha: MERGE_COMMIT,
      merged_by: { login: 'proofowner' },
      commits: 2,
      changed_files: 3,
    },
  });
  const mergeJob = (
    await database.query<{ id: string }>(
      `SELECT id FROM institutional_memory_jobs WHERE workspace_id=$1 AND trigger_kind='merge_review'`,
      [WORKSPACE],
    )
  ).rows[0];
  assert(mergeJob, 'the merge enqueued a review job');
  // Two corners merged in this run; the review under proof is the one whose
  // merge commit the procedure is anchored to.
  const claimedMerge = await claimJobOfKind(
    'merge_review',
    AGENT_A,
    (job) => job.context?.targetCommit === MERGE_COMMIT,
  );
  const mergeContext = {
    repository: claimedMerge.context?.repository ?? 'proof-owner/proof-repo',
    targetCommit: claimedMerge.context?.targetCommit ?? MERGE_COMMIT,
  };
  await workerOperation('completeInstitutionalMemoryJob', {
    agentId: AGENT_A,
    jobId: claimedMerge.id,
    leaseToken: claimedMerge.leaseToken,
    proposal: {
      proposalVersion: 1,
      skill: {
        slug: 'safe-release-migrations',
        description: 'Build release migrations without blocking writers',
        markdown:
          '# Safe release migrations\n\nBuild indexes concurrently, outside a transaction, and write the schema marker last.',
        // No current version to compare against: this is the first procedure.
        baseVersion: null,
        anchor: {
          repository: mergeContext.repository,
          targetCommit: mergeContext.targetCommit,
          path: ANCHOR_PATH,
        },
      },
      findings: [
        {
          taxonomy: 'migration-safety',
          summary: 'Concurrent index creation must not run inside a transaction.',
          severity: 'warning',
          confidence: 0.7,
          path: ANCHOR_PATH,
        },
      ],
    },
    usage: {
      inputBytes: 800,
      outputBytes: 300,
      model: 'proof-model',
      extractorVersion: 'proof-extractor',
    },
  });
  const loadMessage = (await phoneOperation('sendRoomMessage', {
    roomId: ROOM,
    messageId: randomBytes(32).toString('hex'),
    text: '@agentb load the release migration procedure before you touch the migration',
    mentions: ['agentb'],
  })) as { messageId: string };
  const agentBLoadTask = await takeNextTask(AGENT_B, ROOM, loadMessage.messageId);
  const loaded = (await daemonOperation(AGENT_B, 'loadWorkspaceSkill', {
    agentId: AGENT_B,
    roomId: ROOM,
    requestId: agentBLoadTask.requestId,
    generationId: agentBLoadTask.generationId,
    slug: 'safe-release-migrations',
  })) as { slug: string; version: number; markdown: string; anchor: unknown };
  assert(
    loaded.markdown.includes('concurrently'),
    'another agent must be able to load the restricted procedure',
  );
  record('a completed corner’s review produces a loadable restricted procedure', {
    slug: loaded.slug,
    version: loaded.version,
    anchor: loaded.anchor,
    markdownBytes: loaded.markdown.length,
  });

  // ── Step 6: the curator ages, consolidates and retains ───────────────────
  const secondMessage = (await phoneOperation('sendRoomMessage', {
    roomId: ROOM,
    messageId: randomBytes(32).toString('hex'),
    text: '@agenta also, keep the same release-note preference for our internal-only changes please.',
    mentions: ['agenta'],
  })) as { messageId: string };
  const secondTask = await takeNextTask(AGENT_A, ROOM, secondMessage.messageId);
  await completeTurn(AGENT_A, ROOM, secondTask, {
    inputTokens: 20_000,
    promptBytes: 40_000,
    toolCalls: 1,
  });
  const claimedSecond = await claimJobOfKind('turn_review');
  await workerOperation('completeInstitutionalMemoryJob', {
    agentId: AGENT_A,
    jobId: claimedSecond.id,
    leaseToken: claimedSecond.leaseToken,
    proposal: {
      proposalVersion: 1,
      candidateType: 'preference_candidate',
      memoryKind: 'human_profile_fact',
      subjectIdentityId: HUMAN_A,
      canonicalKey: 'release-notes-keep-same-preference',
      body: 'Keep the same release-note preference for internal-only changes.',
      source: { roomId: ROOM, messageIds: [secondTask.sourceMessageId] },
      audience: 'human_profile',
      confidence: 0.7,
      classification: {
        stillTrueForAnotherRequester: false,
        rationale: 'How one person wants their release notes handled.',
      },
      cas: { baseVersion: null },
    },
    usage: {
      inputBytes: 300,
      outputBytes: 90,
      model: 'proof-model',
      extractorVersion: 'proof-extractor',
    },
  });
  // One simulated week: the curator queues its consolidation work, the host
  // answers it with a merge, and the aging clock runs on top of it.
  const weekOne = new Date(Date.now() + 1_000);
  await advanceHostTo(weekOne);
  const queued = await runInstitutionalCuratorCycle(database, recordInstitutionalMemory, weekOne, {
    anchors: {
      resolveRoomRepository: async () => ({
        token: 'installation-token',
        repository: 'proof-owner/proof-repo',
        defaultBranch: 'main',
      }),
      fileBlobSha: async () => ANCHOR_BLOB,
    },
  });
  const curatorJob = (
    await database.query<{
      id: string;
      context: { partition: string; candidates: { id: string }[] };
    }>(
      `SELECT id,context FROM institutional_memory_jobs
       WHERE workspace_id=$1 AND trigger_kind='curator'
         AND jsonb_array_length(context->'candidates')>1
       ORDER BY created_at,id LIMIT 1`,
      [WORKSPACE],
    )
  ).rows[0];
  assert(curatorJob, 'the cycle queued curator work');
  // The partition under proof is the one holding duplicate preferences.
  const claimedCurator = await claimJobOfKind(
    'curator',
    AGENT_A,
    (job) => job.id === curatorJob.id,
  );
  const candidates = curatorJob.context.candidates ?? [];
  await workerOperation('completeInstitutionalMemoryJob', {
    agentId: AGENT_A,
    jobId: claimedCurator.id,
    leaseToken: claimedCurator.leaseToken,
    proposal: {
      proposalVersion: 1,
      partition: curatorJob.context.partition,
      actions:
        candidates.length > 1
          ? [
              {
                action: 'consolidate',
                targetType: 'memory_item',
                targetId: candidates[0]!.id,
                baseVersion: 1,
                duplicateIds: candidates.slice(1).map((candidate) => candidate.id),
                body: `${CORRECTION} Keep one canonical statement of it.`,
                rationale: 'The same preference was recorded twice.',
              },
            ]
          : [],
    },
    usage: {
      inputBytes: 200,
      outputBytes: 60,
      model: 'proof-model',
      extractorVersion: 'proof-extractor',
    },
  });

  // Later simulated cycles at the measured cadence: the deterministic lifecycle
  // ages what was never re-affirmed, archives it, and finally ends its CONTENT —
  // the row and its sources stay, so the ledger still explains what was served.
  const cycleTimes = [40, 80, 150].map((days) => new Date(Date.now() + days * 86_400_000));
  const queuedLater: number[] = [];
  for (const at of cycleTimes) {
    await advanceHostTo(at);
    queuedLater.push(await runInstitutionalCuratorCycle(database, recordInstitutionalMemory, at));
  }
  const lifecycle = (
    await database.query<{
      stale_state: string;
      archived_state: string;
      retained_without_body: string;
      versions_retained: string;
    }>(
      `SELECT (SELECT count(*) FROM institutional_memory_items
               WHERE workspace_id=$1 AND state='stale')::text stale_state,
              (SELECT count(*) FROM institutional_memory_items
               WHERE workspace_id=$1 AND state='archived')::text archived_state,
              (SELECT count(*) FROM institutional_memory_items
               WHERE workspace_id=$1 AND deleted_at IS NOT NULL AND body='')::text retained_without_body,
              (SELECT count(*) FROM workspace_skill_versions version
               JOIN workspace_skills skill ON skill.id=version.skill_id
               WHERE skill.workspace_id=$1)::text versions_retained`,
      [WORKSPACE],
    )
  ).rows[0]!;
  const dashboard = await institutionalObjectiveDashboard(database, WORKSPACE);
  record('the curator ages, consolidates and retains over simulated cycles', {
    firstCycleQueuedJobs: queued,
    laterCycleQueuedJobs: queuedLater,
    staleItems: Number(lifecycle.stale_state),
    archivedItems: Number(lifecycle.archived_state),
    retainedWithoutBody: Number(lifecycle.retained_without_body),
    procedureVersionsRetained: Number(lifecycle.versions_retained),
    consolidatedItems: (
      await database.query<{ consolidated_items: number }>(
        `SELECT consolidated_items FROM institutional_curator_cycles
         WHERE workspace_id=$1 ORDER BY created_at`,
        [WORKSPACE],
      )
    ).rows.map((row) => row.consolidated_items),
    staleServeRate: dashboard.staleServeRate,
    contextServes: dashboard.contextServes,
    p95ContextTokens: dashboard.p95ContextTokens,
    p95TurnInputTokens: dashboard.p95TurnInputTokens,
    tokenSampledServes: dashboard.tokenSampledServes,
    cycleTimeByCohort: dashboard.cornerCycleTime,
    comparableClusters: dashboard.comparableClusters.map((cluster) => cluster.repository),
    yieldByCohort: dashboard.yieldByCohort.map((cohort) => ({
      cohort: cohort.cohort,
      corners: cohort.corners,
      successfulTurns: cohort.successfulTurns,
      toolCallsPerSuccessfulTurn: cohort.toolCallsPerSuccessfulTurn,
      measuredTurns: cohort.measuredTurns,
    })),
  });

  // ── The ledger every measure above reads ─────────────────────────────────
  record('the serve and outcome ledgers carry the run', {
    serves: (
      await database.query<{ count: string }>(
        `SELECT count(*)::text count FROM institutional_context_serves WHERE workspace_id=$1`,
        [WORKSPACE],
      )
    ).rows[0]!.count,
    outcomes: (
      await database.query<{ kind: string; count: string }>(
        `SELECT kind,count(*)::text count FROM institutional_memory_outcomes
         WHERE workspace_id=$1 GROUP BY kind ORDER BY kind`,
        [WORKSPACE],
      )
    ).rows,
    jobs: (
      await database.query<{ trigger_kind: string; status: string; count: string }>(
        `SELECT trigger_kind,status,count(*)::text count FROM institutional_memory_jobs
         WHERE workspace_id=$1 GROUP BY trigger_kind,status ORDER BY trigger_kind,status`,
        [WORKSPACE],
      )
    ).rows,
  });

  const target = join(process.cwd(), 'docs', 'institutional-memory-proof.json');
  await writeFile(
    target,
    `${JSON.stringify(
      {
        note: 'Generated by `npm run prove:institutional-memory`. The Workspace is created inside a disposable database by the script; no real Workspace is touched.',
        ranAt: new Date().toISOString(),
        workspace: WORKSPACE,
        steps: evidence,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nEvidence written to ${target}`);
  server.close();
  await database.close();
}

async function seed(database: PgliteDatabase): Promise<void> {
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Proof Owner','proofowner'),($2,'human','Proof Mate','proofmate'),
       ($3,'agent','Alpha','agenta'),($4,'agent','Beta','agentb'),($5,'agent','Gamma','agentc')`,
    [HUMAN_A, HUMAN_B, AGENT_A, AGENT_B, AGENT_C],
  );
  await database.query(
    `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
     VALUES('github','proof-owner',$1,'https://github.com','beeline','proofowner'),
           ('github','proof-mate',$2,'https://github.com','beeline','proofmate')`,
    [HUMAN_A, HUMAN_B],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,machine_id) VALUES
       ($1,$4,'proof-host'),($2,$4,'proof-host'),($3,$5,'proof-host-b')`,
    [AGENT_A, AGENT_B, AGENT_C, HUMAN_A, HUMAN_B],
  );
  await database.query(
    `INSERT INTO github_installations(
       installation_id,owner_id,account_id,account_login,account_type,repository_selection,status
     ) VALUES($1,$2,'901','proof-owner','User','selected','active')`,
    [INSTALLATION, HUMAN_A],
  );
  await database.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
     VALUES($1,$2,'proof-owner/proof-repo','main')`,
    [REPOSITORY, INSTALLATION],
  );
  await database.query(
    `INSERT INTO rooms(
       id,workspace_id,created_by,name,repository_key,repository_remote,repository_resolution,
       github_installation_id
     ) VALUES($1,$2,$3,'Proof Room','proof-owner/proof-repo',
              'https://github.com/proof-owner/proof-repo.git','repository',$4)`,
    [ROOM, WORKSPACE, HUMAN_A, INSTALLATION],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,visibility)
     VALUES($1,$2,$3,'Proof private Room','invite-only')`,
    [PRIVATE_ROOM, WORKSPACE, HUMAN_A],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,parent_id,name)
     VALUES($1,$2,$3,$4,'Safe migrations'),($5,$2,$3,$4,'Idle corner')`,
    [CORNER, WORKSPACE, HUMAN_A, ROOM, PLAIN_CORNER],
  );
  // The same repository, twice: the served corner and the one memory never
  // reached. That pair is what makes the cohort comparison readable at all.
  await database.query(
    `INSERT INTO corner_facts(
       corner_id,owner_agent_id,commissioned_by,objective,feature_branch,lifecycle
     ) VALUES($1,$2,$3,'Retire the old migration runner','feature/idle-migrations',$4::jsonb)`,
    [
      PLAIN_CORNER,
      AGENT_B,
      HUMAN_A,
      JSON.stringify({
        lifecycle: 'in-review',
        checks: 'unknown',
        branch: 'feature/idle-migrations',
        pr: {
          number: 902,
          url: 'https://github.com/proof-owner/proof-repo/pull/902',
          title: 'Retire the old migration runner',
          targetBranch: 'main',
          headSha: '2'.repeat(40),
        },
      }),
    ],
  );
  await database.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective,feature_branch,lifecycle)
     VALUES($1,$2,$3,'Keep release migrations safe','feature/safe-migrations',$4::jsonb)`,
    [
      CORNER,
      AGENT_A,
      HUMAN_A,
      JSON.stringify({
        lifecycle: 'in-review',
        checks: 'unknown',
        branch: 'feature/safe-migrations',
        pr: {
          number: 901,
          url: 'https://github.com/proof-owner/proof-repo/pull/901',
          title: 'Keep release migrations safe',
          targetBranch: 'main',
          headSha: '1'.repeat(40),
        },
      }),
    ],
  );
  for (const who of [HUMAN_A, HUMAN_B, AGENT_A, AGENT_B, AGENT_C])
    for (const room of [null, ROOM, CORNER, PLAIN_CORNER])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
        [WORKSPACE, room, who, who === HUMAN_A ? 'owner' : 'member'],
      );
  // The private Room is where the audience rule is proved: only its own two
  // members are in it, while the shared Room holds everybody.
  for (const who of [HUMAN_A, AGENT_A])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
      [WORKSPACE, PRIVATE_ROOM, who, who === HUMAN_A ? 'owner' : 'member'],
    );
  await database.query(
    `INSERT INTO institutional_memory_workspace_rollouts(
       workspace_id,stage,stale_after_days,archive_after_days,retention_days,availability_observed_at
     ) VALUES($1,'live',7,14,30,$2)`,
    [WORKSPACE, new Date()],
  );
  // A host that is online from the first sample, so every simulated span below
  // is MEASURED availability rather than an offline gap: the aging clock may
  // only move over time somebody could actually have served the Workspace.
  await database.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
     VALUES($1,$2,'presence','presence',$3::jsonb,$4)`,
    [ROOM, AGENT_A, JSON.stringify({ status: 'online', observedAt: Date.now() }), new Date()],
  );
}

/** Move the simulated clock: the cursor and the host sample move together. */
async function advanceHostTo(at: Date): Promise<void> {
  const database = evidenceDatabase;
  await database.query(
    `UPDATE institutional_memory_workspace_rollouts SET availability_observed_at=$2
     WHERE workspace_id=$1`,
    [WORKSPACE, at],
  );
  await database.query(
    `UPDATE live_outputs SET updated_at=$2 WHERE agent_id=$1 AND kind='presence'`,
    [AGENT_A, at],
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // PGlite keeps its worker alive; the proof has printed everything it knows.
  .finally(() => process.exit(process.exitCode ?? 0));
