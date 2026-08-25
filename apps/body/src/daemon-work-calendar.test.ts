import { createHash } from 'node:crypto';
import { createIdentity, type Identity } from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { describe, expect, it } from 'vitest';
import {
  authorizeDaemonWorkSchedule,
  readScheduledTurnReceiptTail,
  validateArtifactRevisionEvents,
  type DaemonWorkScheduleAuthorityDependencies,
  type DaemonWorkScheduleAuthorityFacts,
} from './daemon-work-calendar.js';
import {
  buildWorkSchedule,
  buildWorkSchedulePauseCard,
  buildWorkScheduleProjection,
  deterministicScheduleRunId,
  parseWorkSchedule,
  parseWorkScheduleCheckpoint,
  type ParsedWorkSchedule,
  type WorkScheduleV1,
} from './work-calendar.js';

function scheduleFixture(agent: Identity, principal: Identity): WorkScheduleV1 {
  return {
    version: 1,
    scheduleId: 'authority-job',
    revision: 1,
    workspaceId: 'authority-workspace',
    roomId: 'authority-room',
    agentPubkey: agent.publicKey,
    principalPubkey: principal.publicKey,
    prompt: 'Prepare the authorized draft.',
    cadence: { type: 'interval', everySeconds: 60, anchorAt: 1_900_000_000 },
    startsAt: 1_900_000_000,
    expiresAt: 1_900_100_000,
    maxRuns: 10,
    perRunReservedTokens: 100,
    dailyReservedTokens: 1_000,
    catchUp: 'latest-one',
    maxConsecutiveFailures: 3,
    status: 'active',
  };
}

function parsedSchedule(author: Identity, schedule: WorkScheduleV1): ParsedWorkSchedule {
  const parsed = parseWorkSchedule(
    buildWorkSchedule(author, schedule, { createdAt: schedule.startsAt - 10 }),
  );
  if (!parsed) throw new Error('fixture schedule did not parse');
  return parsed;
}

function authorityFixture(options: { agentAuthored?: boolean; grantValid?: boolean } = {}) {
  const agent = createIdentity();
  const principal = createIdentity();
  const schedule = scheduleFixture(agent, principal);
  if (options.agentAuthored) schedule.permissionGrantEventId = 'a'.repeat(64);
  const parsed = parsedSchedule(options.agentAuthored ? agent : principal, schedule);
  const facts: DaemonWorkScheduleAuthorityFacts = {
    workspaceMemberPubkeys: [agent.publicKey, principal.publicKey],
    roomMemberPubkeys: [agent.publicKey, principal.publicKey],
    roomArchived: false,
    authorIsAgent: options.agentAuthored === true,
    principalIsAgent: false,
    principalCanDrive: true,
    principalRole: 'owner',
    authorRole: options.agentAuthored ? 'member' : 'owner',
  };
  const dependencies: DaemonWorkScheduleAuthorityDependencies = {
    workspaceId: schedule.workspaceId,
    agentPubkey: agent.publicKey,
    readCurrentEvents: async () => [parsed.event],
    readFacts: async () => facts,
    verifyScheduleGrant: async () => options.grantValid === true,
    readFailurePauses: async () => [],
  };
  return { agent, principal, schedule, parsed, facts, dependencies };
}

describe('scheduled receipt history recovery', () => {
  it('uses a million-run checkpoint and reads only a bounded receipt tail', async () => {
    const fixture = authorityFixture();
    const checkpointEvent = buildWorkScheduleProjection(fixture.agent, {
      version: 1,
      type: 'runtime',
      checkpointVersion: 1,
      workspaceId: fixture.schedule.workspaceId,
      roomId: fixture.schedule.roomId,
      agentPubkey: fixture.agent.publicKey,
      principalPubkey: fixture.principal.publicKey,
      scheduleId: fixture.schedule.scheduleId,
      revision: 1,
      status: 'active',
      consecutiveFailures: 0,
      updatedAt: 1_999_999_999,
      runCount: 1_000_000,
      budgetDay: '2033-05-18',
      dailyReservedTokens: 100,
      latestNominalAt: 1_999_999_940,
      latestRunId: deterministicScheduleRunId(
        fixture.schedule.scheduleId,
        fixture.schedule.revision,
        1_999_999_940,
      ),
      latestRunStatus: 'complete',
      receiptCursorAt: 1_999_999_999,
      receiptCursorId: 'd'.repeat(64),
    });
    const checkpoint = parseWorkScheduleCheckpoint(checkpointEvent);
    expect(checkpoint).toBeDefined();
    const events = Array.from({ length: 2 }, (_, index): NostrEvent => ({
      id: index.toString(16).padStart(64, '0'),
      pubkey: fixture.agent.publicKey,
      created_at: 2_000_000_000 + index,
      kind: 9,
      tags: [],
      content: '',
      sig: 'b'.repeat(128),
    }));
    const observed: Array<Record<string, unknown>> = [];
    const query = async (filters: Record<string, unknown>[]) => {
      observed.push(filters[0]!);
      return events;
    };
    const recovered = await readScheduledTurnReceiptTail(
      query,
      fixture.agent.publicKey,
      [fixture.parsed],
      [checkpoint],
      8,
    );
    expect(recovered).toHaveLength(2);
    expect(observed).toEqual([
      expect.objectContaining({ since: 1_999_999_999, limit: 9 }),
    ]);
  });

  it('fails closed when the bounded tail is truncated', async () => {
    const fixture = authorityFixture();
    await expect(
      readScheduledTurnReceiptTail(
        async () =>
          Array.from({ length: 4 }, (_, index) => ({
            id: index.toString(16).padStart(64, '0'),
            pubkey: fixture.agent.publicKey,
            created_at: fixture.schedule.startsAt + index,
            kind: 9,
            tags: [],
            content: '',
            sig: 'b'.repeat(128),
          })),
        fixture.agent.publicKey,
        [fixture.parsed],
        [],
        3,
      ),
    ).rejects.toThrow('receipt tail exceeds recovery bound');
  });
});

describe('scheduled artifact authority', () => {
  it('accepts only the exact signed artifact revision and content digest', () => {
    const author = createIdentity();
    const content = JSON.stringify({ title: 'Pinned research', body: 'Exact revision bytes' });
    const event = signEvent(
      {
        pubkey: author.publicKey,
        created_at: 1_900_000_000,
        kind: 30078,
        tags: [
          ['d', 'artifact-one'],
          ['revision', '7'],
        ],
        content,
      },
      author.secretKey,
    );
    const artifact = {
      artifactId: 'artifact-one',
      revision: 7,
      eventId: event.id,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    expect(validateArtifactRevisionEvents([artifact], [event])).toEqual({ authorized: true });
    expect(
      validateArtifactRevisionEvents([{ ...artifact, revision: 8 }], [event]),
    ).toEqual({ authorized: false, terminal: true, reason: 'artifact-revision-mismatch' });
    expect(
      validateArtifactRevisionEvents([{ ...artifact, sha256: 'f'.repeat(64) }], [event]),
    ).toEqual({ authorized: false, terminal: true, reason: 'artifact-digest-mismatch' });
    expect(validateArtifactRevisionEvents([artifact], [])).toEqual({
      authorized: false,
      terminal: true,
      reason: 'artifact-missing',
    });
  });
});

describe('daemon work schedule authority', () => {
  it('accepts current human-admin configuration and an agent change with a live P1 grant', async () => {
    const human = authorityFixture();
    await expect(authorizeDaemonWorkSchedule(human.parsed, human.dependencies)).resolves.toEqual({
      authorized: true,
    });

    const agent = authorityFixture({ agentAuthored: true, grantValid: true });
    await expect(authorizeDaemonWorkSchedule(agent.parsed, agent.dependencies)).resolves.toEqual({
      authorized: true,
    });

    agent.schedule.status = 'deleted';
    agent.parsed = parsedSchedule(agent.agent, agent.schedule);
    agent.dependencies.readCurrentEvents = async () => [agent.parsed.event];
    await expect(authorizeDaemonWorkSchedule(agent.parsed, agent.dependencies)).resolves.toEqual({
      authorized: true,
    });
  });

  it.each([
    {
      reason: 'principal-removed',
      mutate: (fixture: ReturnType<typeof authorityFixture>) => {
        fixture.facts.roomMemberPubkeys = [fixture.agent.publicKey];
      },
    },
    {
      reason: 'agent-removed',
      mutate: (fixture: ReturnType<typeof authorityFixture>) => {
        fixture.facts.workspaceMemberPubkeys = [fixture.principal.publicKey];
      },
    },
    {
      reason: 'room-archived',
      mutate: (fixture: ReturnType<typeof authorityFixture>) => {
        fixture.facts.roomArchived = true;
      },
    },
    {
      reason: 'schedule-author-role-lost',
      mutate: (fixture: ReturnType<typeof authorityFixture>) => {
        fixture.facts.authorRole = 'member';
      },
    },
    {
      reason: 'principal-access-denied',
      mutate: (fixture: ReturnType<typeof authorityFixture>) => {
        fixture.facts.principalCanDrive = false;
      },
    },
  ])('fails closed when fresh authority reports $reason', async ({ reason, mutate }) => {
    const fixture = authorityFixture();
    mutate(fixture);
    await expect(
      authorizeDaemonWorkSchedule(fixture.parsed, fixture.dependencies),
    ).resolves.toEqual({ authorized: false, terminal: true, reason });
  });

  it('treats missing Room metadata as retryable rather than silently authorizing', async () => {
    const fixture = authorityFixture();
    fixture.facts.roomArchived = undefined;
    await expect(
      authorizeDaemonWorkSchedule(fixture.parsed, fixture.dependencies),
    ).resolves.toEqual({
      authorized: false,
      terminal: false,
      reason: 'room-metadata-unavailable',
    });

    fixture.facts.roomArchived = false;
    fixture.facts.principalCanDrive = undefined;
    await expect(
      authorizeDaemonWorkSchedule(fixture.parsed, fixture.dependencies),
    ).resolves.toEqual({
      authorized: false,
      terminal: false,
      reason: 'principal-access-unavailable',
    });
  });

  it('rejects a revoked agent grant and a schedule superseded while queued', async () => {
    const revoked = authorityFixture({ agentAuthored: true, grantValid: false });
    await expect(
      authorizeDaemonWorkSchedule(revoked.parsed, revoked.dependencies),
    ).resolves.toEqual({
      authorized: false,
      terminal: true,
      reason: 'schedule-change-grant-invalid',
    });

    const superseded = authorityFixture();
    const revision = parsedSchedule(superseded.principal, {
      ...superseded.schedule,
      revision: 2,
    });
    superseded.dependencies.readCurrentEvents = async () => [revision.event];
    await expect(
      authorizeDaemonWorkSchedule(superseded.parsed, superseded.dependencies),
    ).resolves.toEqual({
      authorized: false,
      terminal: true,
      reason: 'schedule-superseded',
    });
  });

  it('rejects an agent-authored schedule when its principal loses admin role', async () => {
    const fixture = authorityFixture({ agentAuthored: true, grantValid: true });
    fixture.facts.principalRole = 'member';
    await expect(
      authorizeDaemonWorkSchedule(fixture.parsed, fixture.dependencies),
    ).resolves.toEqual({
      authorized: false,
      terminal: true,
      reason: 'schedule-principal-role-lost',
    });
  });

  it('requires a human active revision after a failure pause', async () => {
    const fixture = authorityFixture({ agentAuthored: true, grantValid: true });
    fixture.schedule.revision = 2;
    fixture.parsed = parsedSchedule(fixture.agent, fixture.schedule);
    fixture.dependencies.readCurrentEvents = async () => [fixture.parsed.event];
    fixture.dependencies.readFailurePauses = async () => [
      buildWorkSchedulePauseCard(fixture.agent, fixture.schedule, 1_900_000_001),
    ];
    await expect(
      authorizeDaemonWorkSchedule(fixture.parsed, fixture.dependencies),
    ).resolves.toEqual({ authorized: false, terminal: true, reason: 'human-resume-required' });
  });

  it('treats the highest cross-author revision as canonical', async () => {
    const fixture = authorityFixture();
    const agentRevision = {
      ...fixture.schedule,
      revision: 2,
      permissionGrantEventId: 'a'.repeat(64),
    };
    const newer = parsedSchedule(fixture.agent, agentRevision);
    fixture.dependencies.readCurrentEvents = async () => [fixture.parsed.event, newer.event];
    await expect(
      authorizeDaemonWorkSchedule(fixture.parsed, fixture.dependencies),
    ).resolves.toEqual({ authorized: false, terminal: true, reason: 'schedule-superseded' });
  });

  it('ignores an ineligible outsider when selecting the canonical revision', async () => {
    const fixture = authorityFixture();
    const outsider = createIdentity();
    const forged = parsedSchedule(outsider, {
      ...fixture.schedule,
      revision: 999,
      principalPubkey: outsider.publicKey,
    });
    fixture.dependencies.readCurrentEvents = async () => [fixture.parsed.event, forged.event];
    fixture.dependencies.readFacts = async (candidate) => ({
      ...fixture.facts,
      authorIsAgent: candidate.event.pubkey === fixture.agent.publicKey,
      principalCanDrive: candidate.value.principalPubkey === fixture.principal.publicKey,
    });
    await expect(
      authorizeDaemonWorkSchedule(fixture.parsed, fixture.dependencies),
    ).resolves.toEqual({ authorized: true });
  });

  it('allows an agent revision only after a current human-admin active resume', async () => {
    const fixture = authorityFixture({ agentAuthored: true, grantValid: true });
    const paused = buildWorkSchedulePauseCard(fixture.agent, fixture.schedule, 1_900_000_001);
    const humanResume = parsedSchedule(fixture.principal, {
      ...fixture.schedule,
      revision: 2,
      permissionGrantEventId: undefined,
    });
    const agentRevision = parsedSchedule(fixture.agent, {
      ...fixture.schedule,
      revision: 3,
    });
    fixture.dependencies.readCurrentEvents = async () => [
      fixture.parsed.event,
      humanResume.event,
      agentRevision.event,
    ];
    fixture.dependencies.readFailurePauses = async () => [paused];
    fixture.dependencies.readFacts = async (candidate) => ({
      ...fixture.facts,
      authorIsAgent: candidate.event.pubkey === fixture.agent.publicKey,
      authorRole: candidate.event.pubkey === fixture.principal.publicKey ? 'owner' : 'member',
    });
    await expect(
      authorizeDaemonWorkSchedule(agentRevision, fixture.dependencies),
    ).resolves.toEqual({ authorized: true });
  });
});
