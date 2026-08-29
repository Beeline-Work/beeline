/** Production relay/authority adapter for the pure WorkCalendar state machine. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createBuzzClient,
  KIND_AGENT_ACCESS_CONFIG,
  KIND_AGENT_PRESENCE,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_PAIRING,
  TAG_AGENT_PRESENCE,
  agentAccessConfigKey,
  resolveAgentAccessAuthority,
  parsePermissionDecision,
  parsePermissionRequest,
  permissionActionId,
  resolveCurrentIdentityPubkey,
  verifyPermissionAction,
  type ArtifactRevisionRef,
  type PermissionConcreteAction,
  type PermissionFreshReader,
} from '@beeline/buzz-client';
import { createRelayClient } from '@beeline/gate';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { RoomRuntimeCoordinator } from './room-runtime.js';
import { runtimeIdentity, type AgentRuntimeRecord } from './runtime.js';
import {
  DurableWorkCalendarState,
  WORK_SCHEDULE_KIND,
  WORK_SCHEDULE_TAG,
  WorkCalendar,
  parseWorkSchedule,
  workScheduleKey,
  workScheduleRevisionDigest,
  workScheduleExecutionMode,
  type ParsedWorkSchedule,
  type ScheduleAuthorityResult,
} from './work-calendar.js';
import {
  missionActionOrdinal,
  resolveMissionAction,
  verifyMissionAction,
  type MissionExercise,
  type MissionGrantReference,
} from './mission-authority.js';
import { isSenderPermitted } from './access-policy.js';
import {
  BEELINE_AGENT_TOOL_SCHEMA_VERSION,
  BEELINE_MANDATE_DEFAULTS_VERSION,
} from './agent-tool-contract.js';

function hasMember(members: readonly { pubkey: string }[], pubkey: string): boolean {
  return members.some((member) => member.pubkey === pubkey);
}

function uniqueArtifactTag(event: NostrEvent, name: string): string | undefined {
  const values = event.tags.filter((tag) => tag[0] === name);
  return values.length === 1 ? values[0]?.[1] : undefined;
}

function mandateGeneration(event: NostrEvent): number | undefined {
  const raw = uniqueArtifactTag(event, 'mandate-generation');
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const generation = Number(raw);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined;
}

export function targetAccessSeedFromPresence(
  events: readonly NostrEvent[],
  roomId: string,
  targetAgentPubkey: string,
): { policy: 'everyone' | 'creator' | 'allowlist'; allowlist?: string[] } | undefined {
  const event = events
    .filter(
      (candidate) =>
        candidate.kind === KIND_AGENT_PRESENCE &&
        candidate.pubkey === targetAgentPubkey &&
        verifyEvent(candidate) &&
        uniqueArtifactTag(candidate, 'h') === roomId &&
        uniqueArtifactTag(candidate, 't') === TAG_AGENT_PRESENCE &&
        uniqueArtifactTag(candidate, 'agent') === targetAgentPubkey,
    )
    .sort(
      (left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id),
    )[0];
  const policy = event ? uniqueArtifactTag(event, 'access-policy') : undefined;
  if (policy !== 'everyone' && policy !== 'creator' && policy !== 'allowlist') return undefined;
  const allowlist = event!.tags
    .filter((tag) => tag[0] === 'access-allow')
    .map((tag) => tag[1])
    .filter((pubkey): pubkey is string => Boolean(pubkey && /^[0-9a-f]{64}$/.test(pubkey)));
  if (
    (policy === 'allowlist' &&
      (allowlist.length === 0 || new Set(allowlist).size !== allowlist.length)) ||
    (policy !== 'allowlist' && allowlist.length > 0)
  )
    return undefined;
  return { policy, ...(allowlist.length ? { allowlist } : {}) };
}

export function targetAgentAccessPermitted(input: {
  accessEvents: readonly NostrEvent[];
  presenceEvents: readonly NostrEvent[];
  workspaceId: string;
  roomId: string;
  targetAgentPubkey: string;
  controllerAgentPubkey: string;
  pairedOwnerPubkey: string;
  currentOwnerPubkey: string;
}): boolean | undefined {
  const seed = targetAccessSeedFromPresence(
    input.presenceEvents,
    input.roomId,
    input.targetAgentPubkey,
  );
  const authority = resolveAgentAccessAuthority({
    events: input.accessEvents,
    workspaceId: input.workspaceId,
    agentPubkey: input.targetAgentPubkey,
    pairedOwnerPubkey: input.pairedOwnerPubkey,
    currentOwnerPubkey: input.currentOwnerPubkey,
    ...(seed ? { seed } : {}),
  });
  if (authority === 'denied') return false;
  return authority
    ? isSenderPermitted(
        authority.policy,
        input.controllerAgentPubkey,
        authority.ownerPubkey,
        authority.allowlist,
      )
    : undefined;
}

export function validateArtifactRevisionEvents(
  artifacts: readonly ArtifactRevisionRef[],
  events: readonly NostrEvent[],
): ScheduleAuthorityResult {
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const artifact of artifacts) {
    const event = byId.get(artifact.eventId);
    if (!event) return { authorized: false, terminal: true, reason: 'artifact-missing' };
    if (!verifyEvent(event))
      return { authorized: false, terminal: true, reason: 'artifact-signature-invalid' };
    const artifactId = uniqueArtifactTag(event, 'artifact') ?? uniqueArtifactTag(event, 'd');
    if (artifactId !== artifact.artifactId)
      return { authorized: false, terminal: true, reason: 'artifact-id-mismatch' };
    if (uniqueArtifactTag(event, 'revision') !== String(artifact.revision))
      return { authorized: false, terminal: true, reason: 'artifact-revision-mismatch' };
    if (createHash('sha256').update(event.content).digest('hex') !== artifact.sha256)
      return { authorized: false, terminal: true, reason: 'artifact-digest-mismatch' };
  }
  return { authorized: true };
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
  /** Current target-agent policy admission for the CoS; undefined means the read failed. */
  targetAccessPermitted?: boolean;
}

export interface DaemonWorkScheduleAuthorityDependencies {
  workspaceId: string;
  agentPubkey: string;
  readCurrentEvents(schedule: ParsedWorkSchedule): Promise<readonly NostrEvent[]>;
  readFacts(schedule: ParsedWorkSchedule): Promise<DaemonWorkScheduleAuthorityFacts>;
  verifyScheduleGrant(schedule: ParsedWorkSchedule): Promise<boolean>;
  verifyAgentToolMandate?(schedule: ParsedWorkSchedule): Promise<boolean>;
  verifyMissionGrant(schedule: ParsedWorkSchedule): Promise<boolean>;
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
    const current = (await dependencies.readCurrentEvents(parsed))
      .flatMap((event) => {
        const candidate = parseWorkSchedule(event);
        return candidate &&
          candidate.value.workspaceId === schedule.workspaceId &&
          candidate.value.agentPubkey === schedule.agentPubkey &&
          candidate.event.pubkey === parsed.event.pubkey
          ? [candidate]
          : [];
      })
      .sort(
        (left, right) =>
          right.value.revision - left.value.revision ||
          right.event.created_at - left.event.created_at ||
          right.event.id.localeCompare(left.event.id),
      )[0];
    if (!current || current.event.id !== parsed.event.id) {
      return { authorized: false, terminal: true, reason: 'schedule-superseded' };
    }
    const facts = await dependencies.readFacts(parsed);
    if (facts.roomArchived === undefined) {
      return { authorized: false, terminal: false, reason: 'room-metadata-unavailable' };
    }
    if (facts.roomArchived) {
      return { authorized: false, terminal: true, reason: 'room-archived' };
    }
    if (
      !facts.workspaceMemberPubkeys.includes(schedule.agentPubkey) ||
      !facts.roomMemberPubkeys.includes(schedule.agentPubkey)
    ) {
      return { authorized: false, terminal: true, reason: 'agent-removed' };
    }
    if (
      !facts.workspaceMemberPubkeys.includes(schedule.principalPubkey) ||
      !facts.roomMemberPubkeys.includes(schedule.principalPubkey)
    ) {
      return { authorized: false, terminal: true, reason: 'principal-removed' };
    }
    const agentToolAuthorized = schedule.agentToolMandate
      ? parsed.event.pubkey === schedule.agentPubkey &&
        facts.authorIsAgent &&
        Boolean(await dependencies.verifyAgentToolMandate?.(parsed))
      : false;
    if (schedule.agentToolMandate && !agentToolAuthorized) {
      return { authorized: false, terminal: true, reason: 'agent-tool-mandate-invalid' };
    }
    if (facts.principalIsAgent && !agentToolAuthorized) {
      return { authorized: false, terminal: true, reason: 'principal-is-agent' };
    }
    if (!agentToolAuthorized && facts.principalCanDrive === undefined) {
      return { authorized: false, terminal: false, reason: 'principal-access-unavailable' };
    }
    if (!agentToolAuthorized && !facts.principalCanDrive) {
      return { authorized: false, terminal: true, reason: 'principal-access-denied' };
    }
    if (
      !agentToolAuthorized &&
      facts.principalRole !== 'owner' &&
      facts.principalRole !== 'admin'
    ) {
      return { authorized: false, terminal: true, reason: 'schedule-principal-role-lost' };
    }
    if (schedule.mission) {
      const targetAgentPubkey = schedule.targetAgentPubkey ?? schedule.agentPubkey;
      if (
        !facts.workspaceMemberPubkeys.includes(targetAgentPubkey) ||
        !facts.roomMemberPubkeys.includes(targetAgentPubkey)
      ) {
        return { authorized: false, terminal: true, reason: 'mission-target-removed' };
      }
      if (targetAgentPubkey !== schedule.agentPubkey && facts.targetAccessPermitted === undefined) {
        return { authorized: false, terminal: false, reason: 'mission-target-access-unavailable' };
      }
      if (targetAgentPubkey !== schedule.agentPubkey && !facts.targetAccessPermitted) {
        return { authorized: false, terminal: true, reason: 'mission-target-access-denied' };
      }
      if (
        parsed.event.pubkey !== schedule.mission.controllerAgentPubkey ||
        !facts.authorIsAgent ||
        !facts.workspaceMemberPubkeys.includes(schedule.mission.controllerAgentPubkey) ||
        !facts.roomMemberPubkeys.includes(schedule.mission.controllerAgentPubkey) ||
        !(await dependencies.verifyMissionGrant(parsed))
      ) {
        return { authorized: false, terminal: true, reason: 'mission-grant-invalid' };
      }
    } else if (parsed.event.pubkey === schedule.agentPubkey) {
      if (
        !facts.authorIsAgent ||
        (!schedule.agentToolMandate && !(await dependencies.verifyScheduleGrant(parsed)))
      ) {
        return { authorized: false, terminal: true, reason: 'schedule-change-grant-invalid' };
      }
    } else if (
      facts.authorIsAgent ||
      parsed.event.pubkey !== schedule.principalPubkey ||
      schedule.permissionGrantEventId
    ) {
      return { authorized: false, terminal: true, reason: 'human-author-mismatch' };
    } else if (facts.authorRole !== 'owner' && facts.authorRole !== 'admin') {
      return { authorized: false, terminal: true, reason: 'schedule-author-role-lost' };
    }
    return { authorized: true };
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
      rawEvents([{ kinds: [9], '#h': [roomId], '#permission': [permissionId], limit: 20_000 }]),
    permissionRevocations: (roomId, permissionId, grantEventId) =>
      rawEvents([
        {
          kinds: [9],
          '#h': [roomId],
          '#permission': [permissionId],
          '#grant': [grantEventId],
          '#t': ['buzz-permission-revocation'],
          limit: 256,
        },
      ]),
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

  const verifyAgentToolMandate = async (parsed: ParsedWorkSchedule): Promise<boolean> => {
    const mandate = parsed.value.agentToolMandate;
    if (!mandate) return false;
    const referenced = (await rawEvents([{ ids: [mandate.eventId], limit: 2 }])).find(
      (event) => event.id === mandate.eventId,
    );
    if (
      mandate.defaultsVersion !== BEELINE_MANDATE_DEFAULTS_VERSION ||
      !referenced ||
      !verifyEvent(referenced) ||
      referenced.pubkey !== identity.publicKey ||
      uniqueArtifactTag(referenced, 'h') !== parsed.value.roomId ||
      !referenced.tags.some((tag) => tag[0] === 't' && tag[1] === 'beeline-agent-mandate') ||
      uniqueArtifactTag(referenced, 'agent-tool-schema-version') !==
        String(BEELINE_AGENT_TOOL_SCHEMA_VERSION) ||
      uniqueArtifactTag(referenced, 'mandate-defaults-version') !==
        String(mandate.defaultsVersion) ||
      mandateGeneration(referenced) === undefined
    ) {
      return false;
    }
    const current = (
      await rawEvents([
        {
          kinds: [KIND_STREAM_MESSAGE],
          authors: [identity.publicKey],
          '#h': [parsed.value.roomId],
          '#t': ['beeline-agent-mandate'],
          limit: 20,
        },
      ])
    )
      .filter(
        (event) =>
          verifyEvent(event) &&
          event.pubkey === identity.publicKey &&
          uniqueArtifactTag(event, 'h') === parsed.value.roomId &&
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'beeline-agent-mandate') &&
          uniqueArtifactTag(event, 'agent-tool-schema-version') ===
            String(BEELINE_AGENT_TOOL_SCHEMA_VERSION),
      )
      .sort(
        (left, right) =>
          (mandateGeneration(right) ?? -1) - (mandateGeneration(left) ?? -1) ||
          right.created_at - left.created_at ||
          right.id.localeCompare(left.id),
      )[0];
    return (
      Boolean(current) &&
      current!.id === referenced.id &&
      uniqueArtifactTag(current!, 'mandate-defaults-version') === String(mandate.defaultsVersion)
    );
  };

  const missionReference = (parsed: ParsedWorkSchedule): MissionGrantReference | undefined => {
    const mission = parsed.value.mission;
    return mission
      ? {
          missionId: mission.missionId,
          grantEventId: mission.grantEventId,
          controllerAgentPubkey: mission.controllerAgentPubkey,
        }
      : undefined;
  };

  const scheduleExercise = (
    parsed: ParsedWorkSchedule,
    operation: Extract<MissionExercise, { kind: 'schedule' }>['operation'],
  ): Extract<MissionExercise, { kind: 'schedule' }> => {
    const schedule = parsed.value;
    const mode = workScheduleExecutionMode(schedule);
    return {
      kind: 'schedule',
      operation,
      scheduleId: schedule.scheduleId,
      revisionDigest: workScheduleRevisionDigest(schedule),
      mode,
      targetAgentPubkey: schedule.targetAgentPubkey ?? schedule.agentPubkey,
      maxRuns: schedule.maxRuns,
      perRunReservedTokens: schedule.perRunReservedTokens,
      dailyReservedTokens: schedule.dailyReservedTokens,
      totalReservedTokens: schedule.maxRuns * schedule.perRunReservedTokens,
      scriptRuntimeSeconds:
        schedule.execution && schedule.execution.mode !== 'model'
          ? schedule.execution.timeoutSeconds
          : 1,
    };
  };

  const scheduleChangeOperation = (
    parsed: ParsedWorkSchedule,
  ): Extract<MissionExercise, { kind: 'schedule' }>['operation'] =>
    parsed.value.status === 'cancelled'
      ? 'delete'
      : parsed.value.status === 'paused'
        ? 'pause'
        : parsed.value.revision === 1
          ? 'create'
          : 'update';

  const verifyMissionGrant = async (parsed: ParsedWorkSchedule): Promise<boolean> => {
    const mission = parsed.value.mission;
    const reference = missionReference(parsed);
    if (!mission || !reference) return false;
    const result = await verifyMissionAction({
      reader: freshReader(),
      reference,
      workspaceId: parsed.value.workspaceId,
      roomId: parsed.value.roomId,
      principalPubkey: parsed.value.principalPubkey,
      repository: mission.repository,
      executorPubkey: identity.publicKey,
      exercise: scheduleExercise(parsed, scheduleChangeOperation(parsed)),
      ordinal: parsed.value.revision,
      idempotencyKey: `mission-schedule-change:${parsed.value.scheduleId}:${parsed.value.revision}`,
      reservedTokens: 0,
      now: Math.floor((input.nowMs?.() ?? Date.now()) / 1_000),
    });
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
          let targetAccessPermitted: boolean | undefined = true;
          const targetAgentPubkey = schedule.value.targetAgentPubkey ?? schedule.value.agentPubkey;
          if (schedule.value.mission && targetAgentPubkey !== schedule.value.agentPubkey) {
            try {
              const agentRecords = await rawEvents([
                {
                  kinds: [KIND_STREAM_MESSAGE],
                  '#p': [targetAgentPubkey],
                  '#t': [TAG_AGENT],
                  limit: 20,
                },
              ]);
              const agentRecord = agentRecords
                .filter(
                  (event) =>
                    verifyEvent(event) &&
                    event.pubkey === targetAgentPubkey &&
                    uniqueArtifactTag(event, 'h') === schedule.value.workspaceId,
                )
                .sort(
                  (left, right) =>
                    right.created_at - left.created_at || right.id.localeCompare(left.id),
                )[0];
              const pairingHash = agentRecord
                ? uniqueArtifactTag(agentRecord, 'pairing')
                : undefined;
              if (!pairingHash) throw new Error('target pairing authority unavailable');
              const pairingEvents = await rawEvents([
                {
                  kinds: [KIND_STREAM_MESSAGE],
                  '#d': [pairingHash],
                  '#t': [TAG_AGENT_PAIRING],
                  limit: 20,
                },
              ]);
              const pairing = pairingEvents.find(
                (event) =>
                  verifyEvent(event) &&
                  uniqueArtifactTag(event, 'd') === pairingHash &&
                  uniqueArtifactTag(event, 'h') === schedule.value.workspaceId,
              );
              if (!pairing) throw new Error('target paired owner unavailable');
              const currentOwner = await resolveCurrentIdentityPubkey(
                input.runtime.relayBaseUrl,
                identity,
                pairing.pubkey,
              );
              if (
                !hasMember(workspaceMembers, currentOwner) ||
                (await client.isAgentIdentity(currentOwner))
              ) {
                targetAccessPermitted = false;
              } else {
                const [accessEvents, presenceEvents] = await Promise.all([
                  rawEvents([
                    {
                      kinds: [KIND_AGENT_ACCESS_CONFIG],
                      '#d': [agentAccessConfigKey(schedule.value.workspaceId, targetAgentPubkey)],
                      limit: 20,
                    },
                  ]),
                  rawEvents([
                    {
                      kinds: [KIND_AGENT_PRESENCE],
                      authors: [targetAgentPubkey],
                      '#d': [`${TAG_AGENT_PRESENCE}:${schedule.value.roomId}`],
                      limit: 5,
                    },
                  ]),
                ]);
                targetAccessPermitted = targetAgentAccessPermitted({
                  accessEvents,
                  presenceEvents,
                  workspaceId: schedule.value.workspaceId,
                  roomId: schedule.value.roomId,
                  targetAgentPubkey,
                  controllerAgentPubkey: schedule.value.agentPubkey,
                  pairedOwnerPubkey: pairing.pubkey,
                  currentOwnerPubkey: currentOwner,
                });
              }
            } catch {
              targetAccessPermitted = undefined;
            }
          }
          return {
            workspaceMemberPubkeys: workspaceMembers.map((member) => member.pubkey),
            roomMemberPubkeys: roomMembers.map((member) => member.pubkey),
            roomArchived: metadata ? metadata.archived === true : undefined,
            authorIsAgent,
            principalIsAgent,
            principalCanDrive,
            principalRole: principalRole ?? undefined,
            authorRole: authorRole ?? undefined,
            targetAccessPermitted,
          };
        } finally {
          client.disconnect();
        }
      },
      verifyScheduleGrant,
      verifyAgentToolMandate,
      verifyMissionGrant,
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
    validateScheduleCreation: async (creation) => {
      for (const candidate of creation) {
        if (candidate.value.mission) {
          if (!(await verifyMissionGrant(candidate))) return false;
        } else if (candidate.event.pubkey === candidate.value.agentPubkey) {
          if (candidate.value.agentToolMandate) {
            if (!(await verifyAgentToolMandate(candidate))) return false;
          } else if (
            !candidate.value.permissionGrantEventId ||
            !(await verifyScheduleGrant(candidate))
          ) {
            return false;
          }
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
    missionAction: async (parsed, nominalAt) => {
      const mission = parsed.value.mission;
      const reference = missionReference(parsed);
      if (!mission || !reference) return undefined;
      const exercise = scheduleExercise(parsed, 'fire');
      const actionInput = {
        reader: freshReader(),
        reference,
        workspaceId: parsed.value.workspaceId,
        roomId: parsed.value.roomId,
        principalPubkey: parsed.value.principalPubkey,
        repository: mission.repository,
        executorPubkey: identity.publicKey,
        exercise,
        ordinal: missionActionOrdinal(
          `schedule-fire:${parsed.value.scheduleId}:${parsed.value.revision}:${nominalAt}`,
        ),
        idempotencyKey: `mission-schedule-fire:${parsed.value.scheduleId}:${parsed.value.revision}:${nominalAt}`,
        reservedTokens: parsed.value.perRunReservedTokens,
      };
      const verification = await verifyMissionAction({
        ...actionInput,
        now: Math.floor((input.nowMs?.() ?? Date.now()) / 1_000),
      });
      if (!verification.authorized) return undefined;
      return resolveMissionAction(actionInput);
    },
    validateArtifacts: async (parsed) => {
      const artifacts = parsed.value.artifactRefs ?? [];
      if (artifacts.length === 0) return { authorized: true };
      try {
        const events = await rawEvents([
          { ids: artifacts.map((artifact) => artifact.eventId), limit: artifacts.length + 1 },
        ]);
        if (events.length > artifacts.length)
          return { authorized: false, terminal: true, reason: 'artifact-read-ambiguous' };
        return validateArtifactRevisionEvents(artifacts, events);
      } catch {
        return { authorized: false, terminal: false, reason: 'artifact-unavailable' };
      }
    },
    publish: async (event) => {
      await relay.publishEvent(event);
    },
    dispatch: (request, beforeModelActivation) =>
      input.roomRuntime.dispatchScheduledTurn(request, beforeModelActivation),
    now: () => Math.floor((input.nowMs?.() ?? Date.now()) / 1_000),
  });
}
