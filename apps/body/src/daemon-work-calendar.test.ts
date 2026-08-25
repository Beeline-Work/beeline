import { createIdentity, type Identity } from '@beeline/buzz-client';
import { describe, expect, it } from 'vitest';
import {
  authorizeDaemonWorkSchedule,
  type DaemonWorkScheduleAuthorityDependencies,
  type DaemonWorkScheduleAuthorityFacts,
} from './daemon-work-calendar.js';
import {
  buildWorkSchedule,
  buildWorkSchedulePauseCard,
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
    readFailurePauses: async () => [],
  };
  return { agent, principal, schedule, parsed, facts, dependencies };
}

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
