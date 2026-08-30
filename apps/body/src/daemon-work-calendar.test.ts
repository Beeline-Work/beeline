import { createHash } from 'node:crypto';
import {
  KIND_AGENT_PRESENCE,
  TAG_AGENT_PRESENCE,
  buildAgentAccessConfig,
  createIdentity,
  type Identity,
} from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';
import { describe, expect, it } from 'vitest';
import {
  authorizeDaemonWorkSchedule,
  targetAgentAccessPermitted,
  validateArtifactRevisionEvents,
  type DaemonWorkScheduleAuthorityDependencies,
  type DaemonWorkScheduleAuthorityFacts,
} from './daemon-work-calendar.js';
import {
  buildWorkSchedule,
  parseWorkSchedule,
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
  };
  return { agent, principal, schedule, parsed, facts, dependencies };
}

describe('daemon work schedule authority', () => {
  it('uses the target seed fallback and current paired-owner override exactly', () => {
    const target = createIdentity();
    const owner = createIdentity();
    const controller = createIdentity();
    const presence = signEvent(
      {
        pubkey: target.publicKey,
        created_at: 10,
        kind: KIND_AGENT_PRESENCE,
        tags: [
          ['d', `${TAG_AGENT_PRESENCE}:authority-room`],
          ['h', 'authority-room'],
          ['t', TAG_AGENT_PRESENCE],
          ['agent', target.publicKey],
          ['status', 'online'],
          ['access-policy', 'everyone'],
        ],
        content: 'online',
      },
      target.secretKey,
    );
    const input = {
      accessEvents: [],
      presenceEvents: [presence],
      workspaceId: 'authority-workspace',
      roomId: 'authority-room',
      targetAgentPubkey: target.publicKey,
      controllerAgentPubkey: controller.publicKey,
      pairedOwnerPubkey: owner.publicKey,
      currentOwnerPubkey: owner.publicKey,
    };
    expect(targetAgentAccessPermitted(input)).toBe(true);
    const override = buildAgentAccessConfig(owner, {
      version: 1,
      workspaceId: input.workspaceId,
      agentPubkey: target.publicKey,
      policy: 'creator',
      revision: 1,
      updatedAt: 11,
    });
    expect(targetAgentAccessPermitted({ ...input, accessEvents: [override] })).toBe(false);
    expect(
      targetAgentAccessPermitted({
        ...input,
        accessEvents: [override],
        controllerAgentPubkey: owner.publicKey,
      }),
    ).toBe(true);
  });

  it('requires the target agent access decision for a cross-agent mission', async () => {
    const fixture = authorityFixture();
    const target = createIdentity();
    fixture.schedule.targetAgentPubkey = target.publicKey;
    fixture.schedule.execution = { mode: 'model' };
    fixture.schedule.cadence = {
      type: 'interval',
      everySeconds: 15 * 60,
      anchorAt: fixture.schedule.startsAt,
    };
    fixture.schedule.mission = {
      missionId: 'mission-one',
      grantEventId: 'a'.repeat(64),
      controllerAgentPubkey: fixture.agent.publicKey,
      repository: { key: 'github:123', targetBranch: 'refs/heads/main' },
    };
    fixture.facts.workspaceMemberPubkeys = [
      ...fixture.facts.workspaceMemberPubkeys,
      target.publicKey,
    ];
    fixture.facts.roomMemberPubkeys = [...fixture.facts.roomMemberPubkeys, target.publicKey];
    fixture.facts.authorIsAgent = true;
    fixture.facts.targetAccessPermitted = false;
    fixture.dependencies.verifyMissionGrant = async () => true;
    const parsed = parsedSchedule(fixture.agent, fixture.schedule);
    fixture.dependencies.readCurrentEvents = async () => [parsed.event];
    await expect(authorizeDaemonWorkSchedule(parsed, fixture.dependencies)).resolves.toEqual({
      authorized: false,
      terminal: true,
      reason: 'mission-target-access-denied',
    });
    fixture.facts.targetAccessPermitted = true;
    await expect(authorizeDaemonWorkSchedule(parsed, fixture.dependencies)).resolves.toEqual({
      authorized: true,
    });
  });

  it('accepts current human-admin configuration and an agent change with a live P1 grant', async () => {
    const human = authorityFixture();
    await expect(authorizeDaemonWorkSchedule(human.parsed, human.dependencies)).resolves.toEqual({
      authorized: true,
    });

    const agent = authorityFixture({ agentAuthored: true, grantValid: true });
    await expect(authorizeDaemonWorkSchedule(agent.parsed, agent.dependencies)).resolves.toEqual({
      authorized: true,
    });
  });

  it('authorizes an agent-tool schedule from the current mandate instead of human drive policy', async () => {
    const agent = createIdentity();
    const schedule = scheduleFixture(agent, agent);
    schedule.agentToolMandate = {
      eventId: 'b'.repeat(64),
      defaultsVersion: 2,
    };
    const parsed = parsedSchedule(agent, schedule);
    const facts: DaemonWorkScheduleAuthorityFacts = {
      workspaceMemberPubkeys: [agent.publicKey],
      roomMemberPubkeys: [agent.publicKey],
      roomArchived: false,
      authorIsAgent: true,
      principalIsAgent: true,
      principalCanDrive: false,
      principalRole: 'member',
      authorRole: 'member',
    };
    await expect(
      authorizeDaemonWorkSchedule(parsed, {
        workspaceId: schedule.workspaceId,
        agentPubkey: agent.publicKey,
        readCurrentEvents: async () => [parsed.event],
        readFacts: async () => facts,
        verifyScheduleGrant: async () => false,
        verifyAgentToolMandate: async () => 'valid',
      }),
    ).resolves.toEqual({ authorized: true });
  });

  it('keeps an unreadable agent-tool mandate retryable but pauses a proven-invalid mandate', async () => {
    const agent = createIdentity();
    const schedule = scheduleFixture(agent, agent);
    schedule.agentToolMandate = { eventId: 'b'.repeat(64), defaultsVersion: 2 };
    const parsed = parsedSchedule(agent, schedule);
    const facts: DaemonWorkScheduleAuthorityFacts = {
      workspaceMemberPubkeys: [agent.publicKey],
      roomMemberPubkeys: [agent.publicKey],
      roomArchived: false,
      authorIsAgent: true,
      principalIsAgent: true,
      principalCanDrive: false,
      principalRole: 'member',
      authorRole: 'member',
    };
    const dependencies: DaemonWorkScheduleAuthorityDependencies = {
      workspaceId: schedule.workspaceId,
      agentPubkey: agent.publicKey,
      readCurrentEvents: async () => [parsed.event],
      readFacts: async () => facts,
      verifyScheduleGrant: async () => false,
      verifyAgentToolMandate: async () => 'unavailable',
    };

    await expect(authorizeDaemonWorkSchedule(parsed, dependencies)).resolves.toEqual({
      authorized: false,
      terminal: false,
      reason: 'agent-tool-mandate-unavailable',
    });
    dependencies.verifyAgentToolMandate = async () => 'invalid';
    await expect(authorizeDaemonWorkSchedule(parsed, dependencies)).resolves.toEqual({
      authorized: false,
      terminal: true,
      reason: 'agent-tool-mandate-invalid',
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
      reason: 'schedule-principal-role-lost',
      mutate: (fixture: ReturnType<typeof authorityFixture>) => {
        fixture.facts.principalRole = 'member';
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

  it('revalidates the exact signed artifact revision and digest', () => {
    const author = createIdentity();
    const content = 'artifact revision contents';
    const event = signEvent(
      {
        pubkey: author.publicKey,
        created_at: 1_900_000_000,
        kind: 30078,
        tags: [
          ['d', 'artifact-one'],
          ['artifact', 'artifact-one'],
          ['revision', '4'],
        ],
        content,
      },
      author.secretKey,
    );
    const ref = {
      artifactId: 'artifact-one',
      revision: 4,
      eventId: event.id,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    expect(validateArtifactRevisionEvents([ref], [event])).toEqual({ authorized: true });
    expect(validateArtifactRevisionEvents([{ ...ref, sha256: '0'.repeat(64) }], [event])).toEqual({
      authorized: false,
      terminal: true,
      reason: 'artifact-digest-mismatch',
    });
  });
});
