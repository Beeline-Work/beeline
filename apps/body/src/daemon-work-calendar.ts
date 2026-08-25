/** Production relay/authority adapter for the pure WorkCalendar state machine. */
import { resolve } from 'node:path';
import {
  createBuzzClient,
  parsePermissionDecision,
  parsePermissionRequest,
  permissionActionId,
  verifyPermissionAction,
  type PermissionConcreteAction,
  type PermissionFreshReader,
} from '@beeline/buzz-client';
import { createRelayClient } from '@beeline/gate';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { RoomRuntimeCoordinator } from './room-runtime.js';
import { runtimeIdentity, type AgentRuntimeRecord } from './runtime.js';
import {
  DurableWorkCalendarState,
  SCHEDULED_TURN_TAG,
  WORK_SCHEDULE_KIND,
  WORK_SCHEDULE_PAUSED_TAG,
  WORK_SCHEDULE_TAG,
  WorkCalendar,
  parseWorkSchedule,
  workScheduleKey,
  workScheduleRevisionDigest,
  type ParsedWorkSchedule,
  type ScheduleAuthorityResult,
} from './work-calendar.js';

function hasMember(members: readonly { pubkey: string }[], pubkey: string): boolean {
  return members.some((member) => member.pubkey === pubkey);
}

function rawRequestEventId(event: NostrEvent): string | undefined {
  try {
    const value = JSON.parse(event.content) as { requestEventId?: unknown };
    return typeof value.requestEventId === 'string' && /^[0-9a-f]{64}$/.test(value.requestEventId)
      ? value.requestEventId
      : undefined;
  } catch {
    return undefined;
  }
}

export interface DaemonWorkScheduleAuthorityFacts {
  workspaceMemberPubkeys: readonly string[];
  roomMemberPubkeys: readonly string[];
  roomArchived: boolean | undefined;
  authorIsAgent: boolean;
  principalIsAgent: boolean;
  principalCanDrive: boolean | undefined;
  principalRole: string | undefined;
  authorRole: string | undefined;
}

export interface DaemonWorkScheduleAuthorityDependencies {
  workspaceId: string;
  agentPubkey: string;
  readCurrentEvents(schedule: ParsedWorkSchedule): Promise<readonly NostrEvent[]>;
  readFacts(schedule: ParsedWorkSchedule): Promise<DaemonWorkScheduleAuthorityFacts>;
  verifyScheduleGrant(schedule: ParsedWorkSchedule): Promise<boolean>;
  readFailurePauses(schedule: ParsedWorkSchedule): Promise<readonly NostrEvent[]>;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

async function requiresHumanResume(
  parsed: ParsedWorkSchedule,
  candidates: readonly ParsedWorkSchedule[],
  dependencies: DaemonWorkScheduleAuthorityDependencies,
): Promise<boolean> {
  const pauseRevision = (await dependencies.readFailurePauses(parsed))
    .filter(
      (event) =>
        event.kind === 9 &&
        event.pubkey === dependencies.agentPubkey &&
        verifyEvent(event) &&
        tagValue(event, 't') === WORK_SCHEDULE_PAUSED_TAG &&
        tagValue(event, 'schedule') === parsed.value.scheduleId,
    )
    .map((event) => Number(tagValue(event, 'revision')))
    .filter((revision) => Number.isSafeInteger(revision) && revision >= 1)
    .sort((left, right) => right - left)[0];
  if (pauseRevision === undefined) return false;
  if (parsed.value.revision <= pauseRevision) return true;
  for (const candidate of candidates) {
    if (
      candidate.value.status !== 'active' ||
      candidate.value.revision <= pauseRevision ||
      candidate.value.revision > parsed.value.revision ||
      candidate.event.pubkey !== candidate.value.principalPubkey ||
      candidate.event.pubkey === candidate.value.agentPubkey
    ) {
      continue;
    }
    const authority = await authorizeCandidate(candidate, candidates, dependencies, false);
    if (authority.authorized) return false;
  }
  return true;
}

async function authorizeCandidate(
  parsed: ParsedWorkSchedule,
  candidates: readonly ParsedWorkSchedule[],
  dependencies: DaemonWorkScheduleAuthorityDependencies,
  checkFailurePause: boolean,
): Promise<ScheduleAuthorityResult> {
  const schedule = parsed.value;
  const facts = await dependencies.readFacts(parsed);
  if (facts.roomArchived === undefined)
    return { authorized: false, terminal: false, reason: 'room-metadata-unavailable' };
  if (facts.roomArchived)
    return { authorized: false, terminal: true, reason: 'room-archived' };
  if (
    !facts.workspaceMemberPubkeys.includes(schedule.agentPubkey) ||
    !facts.roomMemberPubkeys.includes(schedule.agentPubkey)
  )
    return { authorized: false, terminal: true, reason: 'agent-removed' };
  if (
    !facts.workspaceMemberPubkeys.includes(schedule.principalPubkey) ||
    !facts.roomMemberPubkeys.includes(schedule.principalPubkey)
  )
    return { authorized: false, terminal: true, reason: 'principal-removed' };
  if (facts.principalCanDrive === undefined)
    return { authorized: false, terminal: false, reason: 'principal-access-unavailable' };
  if (!facts.principalCanDrive)
    return { authorized: false, terminal: true, reason: 'principal-access-denied' };
  if (facts.principalIsAgent)
    return { authorized: false, terminal: true, reason: 'principal-is-agent' };
  if (facts.principalRole !== 'owner' && facts.principalRole !== 'admin')
    return { authorized: false, terminal: true, reason: 'schedule-principal-role-lost' };
  if (parsed.event.pubkey === schedule.agentPubkey) {
    if (!facts.authorIsAgent || !(await dependencies.verifyScheduleGrant(parsed)))
      return { authorized: false, terminal: true, reason: 'schedule-change-grant-invalid' };
    if (
      checkFailurePause &&
      schedule.status === 'active' &&
      (await requiresHumanResume(parsed, candidates, dependencies))
    )
      return { authorized: false, terminal: true, reason: 'human-resume-required' };
  } else if (
    facts.authorIsAgent ||
    parsed.event.pubkey !== schedule.principalPubkey ||
    schedule.permissionGrantEventId
  )
    return { authorized: false, terminal: true, reason: 'human-author-mismatch' };
  else if (facts.authorRole !== 'owner' && facts.authorRole !== 'admin')
    return { authorized: false, terminal: true, reason: 'schedule-author-role-lost' };
  return { authorized: true };
}

/** Pure production-policy seam: every fact is freshly read by the daemon adapter below. */
export async function authorizeDaemonWorkSchedule(
  parsed: ParsedWorkSchedule,
  dependencies: DaemonWorkScheduleAuthorityDependencies,
): Promise<ScheduleAuthorityResult> {
  const schedule = parsed.value;
  try {
    if (
      schedule.workspaceId !== dependencies.workspaceId ||
      schedule.agentPubkey !== dependencies.agentPubkey
    ) {
      return { authorized: false, terminal: true, reason: 'schedule-target-mismatch' };
    }
    const candidates = (await dependencies.readCurrentEvents(parsed))
      .flatMap((event) => {
        const candidate = parseWorkSchedule(event);
        return candidate &&
          candidate.value.workspaceId === schedule.workspaceId &&
          candidate.value.agentPubkey === schedule.agentPubkey &&
          candidate.value.principalPubkey === schedule.principalPubkey &&
          workScheduleKey(candidate.value) === workScheduleKey(schedule) &&
          (candidate.event.pubkey === candidate.value.principalPubkey ||
            candidate.event.pubkey === candidate.value.agentPubkey)
          ? [candidate]
          : [];
      });
    const current = [...candidates].sort(
      (left, right) =>
        right.value.revision - left.value.revision ||
        right.event.created_at - left.event.created_at ||
        right.event.id.localeCompare(left.event.id),
    )[0];
    if (!current || current.event.id !== parsed.event.id) {
      return { authorized: false, terminal: true, reason: 'schedule-superseded' };
    }
    return await authorizeCandidate(parsed, candidates, dependencies, true);
  } catch {
    return { authorized: false, terminal: false, reason: 'authority-unavailable' };
  }
}

export function createDaemonWorkCalendar(input: {
  runtime: AgentRuntimeRecord;
  configPath: string;
  roomRuntime: RoomRuntimeCoordinator;
  nowMs?: () => number;
}): WorkCalendar {
  const identity = runtimeIdentity(input.runtime.agent);
  const relayConfig = {
    baseUrl: input.runtime.relayBaseUrl,
    host: input.runtime.relayHost ?? new URL(input.runtime.relayBaseUrl).host,
  };
  const relay = createRelayClient(identity, relayConfig);

  const rawEvents = async (filters: Record<string, unknown>[]): Promise<NostrEvent[]> =>
    relay.queryEvents(filters);

  const freshReader = (): PermissionFreshReader => ({
    readEvent: async (eventId) =>
      (await rawEvents([{ ids: [eventId], limit: 2 }])).find((event) => event.id === eventId),
    isRegisteredAgent: async (pubkey) => {
      const client = createBuzzClient({ ...relayConfig, identity });
      try {
        return await client.isAgentIdentity(pubkey);
      } finally {
        client.disconnect();
      }
    },
    isRoomMember: async (roomId, pubkey) => {
      const client = createBuzzClient({ ...relayConfig, identity });
      try {
        return hasMember(await client.listMembers(roomId), pubkey);
      } finally {
        client.disconnect();
      }
    },
    isWorkspaceMember: async (workspaceId, pubkey) => {
      const client = createBuzzClient({ ...relayConfig, identity });
      try {
        return hasMember(await client.listMembers(workspaceId), pubkey);
      } finally {
        client.disconnect();
      }
    },
    roleForRoom: async (roomId, pubkey) => {
      const client = createBuzzClient({ ...relayConfig, identity });
      try {
        return await client.getChannelRole(roomId, pubkey);
      } finally {
        client.disconnect();
      }
    },
    hasDeviceCustody: async (pubkey) => {
      const client = createBuzzClient({ ...relayConfig, identity });
      try {
        return !(await client.isAgentIdentity(pubkey));
      } finally {
        client.disconnect();
      }
    },
    permissionHistory: (roomId, permissionId) =>
      rawEvents([{ kinds: [9], '#h': [roomId], '#permission': [permissionId], limit: 1_000 }]),
  });

  const verifyScheduleGrant = async (parsed: ParsedWorkSchedule): Promise<boolean> => {
    const schedule = parsed.value;
    const grantEventId = schedule.permissionGrantEventId;
    if (!grantEventId) return false;
    const grantEvent = (await rawEvents([{ ids: [grantEventId], limit: 2 }])).find(
      (event) => event.id === grantEventId,
    );
    const requestEventId = grantEvent ? rawRequestEventId(grantEvent) : undefined;
    if (!grantEvent || !requestEventId) return false;
    const requestEvent = (await rawEvents([{ ids: [requestEventId], limit: 2 }])).find(
      (event) => event.id === requestEventId,
    );
    const request = requestEvent ? parsePermissionRequest(requestEvent) : undefined;
    const decision = request ? parsePermissionDecision(grantEvent, request) : undefined;
    if (!request || !decision || decision.value.decision !== 'grant') return false;
    const scope = request.value.scope;
    if (
      scope.type !== 'schedule.change' ||
      scope.scheduleId !== schedule.scheduleId ||
      scope.revisionDigest !== workScheduleRevisionDigest(schedule)
    ) {
      return false;
    }
    const ordinal = 0;
    const action: PermissionConcreteAction = {
      permissionId: request.value.permissionId,
      requestEventId: request.event.id,
      grantEventId,
      ordinal,
      actionId: permissionActionId(scope, request.event.id, ordinal),
      idempotencyKey: `schedule-change:${schedule.scheduleId}:${schedule.revision}`,
      workspaceId: schedule.workspaceId,
      roomId: schedule.roomId,
      scope,
      executor: 'body',
      executorPubkey: identity.publicKey,
      charge: { uses: 1 },
    };
    const result = await verifyPermissionAction({
      reader: freshReader(),
      action,
      now: Math.floor((input.nowMs?.() ?? Date.now()) / 1_000),
    });
    // A schedule-change receipt consuming the action is expected. All current
    // authority, expiry, and revocation checks happen before this result.
    return result.authorized || result.reason === 'action-already-succeeded';
  };

  const authorize = (parsed: ParsedWorkSchedule): Promise<ScheduleAuthorityResult> =>
    authorizeDaemonWorkSchedule(parsed, {
      workspaceId: input.runtime.communityId,
      agentPubkey: identity.publicKey,
      // Re-read the exact replaceable key immediately before every model
      // activation. The periodic heap refresh is a wake optimization, never an
      // authority cache: a newer pause/revision must invalidate an old run now.
      readCurrentEvents: (schedule) =>
        rawEvents([
          {
            kinds: [WORK_SCHEDULE_KIND],
            '#d': [workScheduleKey(schedule.value)],
            '#t': [WORK_SCHEDULE_TAG],
            limit: 100,
          },
        ]),
      readFacts: async (schedule) => {
        const client = createBuzzClient({ ...relayConfig, identity });
        try {
          const [
            workspaceMembers,
            roomMembers,
            metadata,
            authorIsAgent,
            principalIsAgent,
            principalCanDrive,
            principalRole,
            authorRole,
          ] = await Promise.all([
            client.listMembers(schedule.value.workspaceId),
            client.listMembers(schedule.value.roomId),
            client.getChannelMetadata(schedule.value.roomId),
            client.isAgentIdentity(schedule.event.pubkey),
            client.isAgentIdentity(schedule.value.principalPubkey),
            input.roomRuntime.currentPrincipalCanDrive(
              schedule.value.roomId,
              schedule.value.workspaceId,
              schedule.value.principalPubkey,
            ),
            client.getChannelRole(schedule.value.roomId, schedule.value.principalPubkey),
            client.getChannelRole(schedule.value.roomId, schedule.event.pubkey),
          ]);
          return {
            workspaceMemberPubkeys: workspaceMembers.map((member) => member.pubkey),
            roomMemberPubkeys: roomMembers.map((member) => member.pubkey),
            roomArchived: metadata ? metadata.archived === true : undefined,
            authorIsAgent,
            principalIsAgent,
            principalCanDrive,
            principalRole: principalRole ?? undefined,
            authorRole: authorRole ?? undefined,
          };
        } finally {
          client.disconnect();
        }
      },
      verifyScheduleGrant,
      readFailurePauses: (schedule) =>
        rawEvents([
          {
            kinds: [9],
            '#t': [WORK_SCHEDULE_PAUSED_TAG],
            '#schedule': [schedule.value.scheduleId],
            authors: [identity.publicKey],
            limit: 100,
          },
        ]),
    });

  return new WorkCalendar({
    identity,
    workspaceId: input.runtime.communityId,
    store: new DurableWorkCalendarState(
      resolve(input.configPath, '..', 'work-calendar-state.json'),
    ),
    readSchedules: () =>
      rawEvents([
        {
          kinds: [WORK_SCHEDULE_KIND],
          '#t': [WORK_SCHEDULE_TAG],
          '#agent': [identity.publicKey],
          limit: 1_000,
        },
      ]),
    readReceipts: () =>
      rawEvents([
        { kinds: [9], '#t': [SCHEDULED_TURN_TAG], '#agent': [identity.publicKey], limit: 5_000 },
      ]),
    validateScheduleCreation: async (creation) => {
      for (const candidate of creation) {
        if (candidate.event.pubkey === candidate.value.agentPubkey) {
          if (!candidate.value.permissionGrantEventId || !(await verifyScheduleGrant(candidate)))
            return false;
        } else if (
          candidate.event.pubkey !== candidate.value.principalPubkey ||
          candidate.value.permissionGrantEventId
        ) {
          return false;
        }
      }
      return true;
    },
    authorize,
    publish: async (event) => {
      await relay.publishEvent(event);
    },
    dispatch: (request, beforeModelActivation, publishOutput) =>
      input.roomRuntime.dispatchScheduledTurn(request, beforeModelActivation, publishOutput),
    now: () => Math.floor((input.nowMs?.() ?? Date.now()) / 1_000),
  });
}
