/** Permission scope types, policy registry, and strict scope parser. */
import type { NostrEvent } from '@beeline/nostr';
import {
  TAG_PERMISSION_DECISION,
  TAG_PERMISSION_EXECUTION,
  TAG_PERMISSION_REQUEST,
  TAG_PERMISSION_REVOCATION,
} from './kinds.js';

export const PERMISSION_REQUEST_MARKER = TAG_PERMISSION_REQUEST;
export const PERMISSION_DECISION_MARKER = TAG_PERMISSION_DECISION;
export const PERMISSION_REVOCATION_MARKER = TAG_PERMISSION_REVOCATION;
export const PERMISSION_EXECUTION_MARKER = TAG_PERMISSION_EXECUTION;

export const PERMISSION_PROTOCOL_VERSION = 1 as const;
export const MAX_PERMISSION_SUMMARY_CHARS = 600;
export const MAX_PERMISSION_NOTE_CHARS = 600;
export const MAX_PERMISSION_REASON_CHARS = 80;
export const MAX_PERMISSION_LIST_ITEMS = 128;
export const MAX_PERMISSION_USES = 100_000;
export const MAX_PERMISSION_RATE_WINDOW_SECONDS = 31 * 24 * 60 * 60;
export const MAX_PERMISSION_GRANT_TTL_SECONDS = 31 * 24 * 60 * 60;
export const MAX_PERMISSION_CONTENT_CHARS = 32_000;

export const HEX_64 = /^[0-9a-f]{64}$/;
export const PROTOCOL_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;
export const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const SHA_256 = /^[0-9a-f]{64}$/;

export type JsonRecord = Record<string, unknown>;

export type ArtifactRevisionRef = {
  artifactId: string;
  revision: number;
  eventId: string;
  sha256: string;
};

export type NormalizedDestination = {
  type: 'email' | 'phone' | 'social' | 'room' | 'url';
  value: string;
};

export type MissionCornerOperation = 'open' | 'close';
export type MissionScheduleOperation = 'create' | 'update' | 'pause' | 'delete' | 'fire';
export type MissionScheduleMode = 'script' | 'model';

/** A static budget slice owned by exactly one mission agent. */
export interface MissionTargetAllocation {
  agentPubkey: string;
  maxActiveCorners: number;
  maxReservedTokensPerDay: number;
  maxTotalReservedTokens: number;
}

/**
 * A non-overlapping schedule allocation. The captain grants the slot and its
 * limits; the CoS supplies a new exact revision digest for every audited
 * create/update/fire action without asking the captain to re-sign it.
 */
export interface MissionScheduleAllocation {
  scheduleId: string;
  targetAgentPubkey: string;
  modes: MissionScheduleMode[];
  maxRuns: number;
  maxReservedTokensPerRun: number;
  maxReservedTokensPerDay: number;
  maxTotalReservedTokens: number;
  maxScriptRuntimeSeconds: number;
  revisionDigest?: string;
}

/**
 * One captain-signed mission boundary. Derived actions are represented as
 * attenuated values of this same scope and verified by the ordinary
 * permission ledger; this is deliberately not a second grant system.
 */
export interface MissionControlScope {
  type: 'mission.control';
  missionId: string;
  workspaceId: string;
  roomId: string;
  controllerAgentPubkey: string;
  repository: { key: string; targetBranch: string };
  cornerOperations: MissionCornerOperation[];
  scheduleOperations: MissionScheduleOperation[];
  targetAllocations: MissionTargetAllocation[];
  scheduleAllocations: MissionScheduleAllocation[];
  /** Standing land authority is exact to `repository`; false grants none. */
  land: boolean;
  landBinding?: { cornerId: string; sourceSha: string };
}

export const MAX_MISSION_RESERVED_TOKENS = 100_000_000;

export type PermissionScope =
  | {
      type: 'room.create';
      workspaceId: string;
      roomId: string;
      name: string;
      visibility: 'invite-only' | 'workspace';
      participantPubkeys: string[];
      agentPubkeys: string[];
      repository?: { key: string; targetBranch: string };
    }
  | {
      type: 'money.spend';
      currency: string;
      maxMinorUnits: number;
      merchant: string;
      purpose: string;
      connectorId: string;
    }
  | {
      type: 'message.send';
      channel: 'email' | 'sms' | 'social-dm';
      connectorId: string;
      artifacts: ArtifactRevisionRef[];
      recipients: NormalizedDestination[];
    }
  | {
      type: 'content.publish';
      connectorId: string;
      destination: NormalizedDestination;
      artifacts: ArtifactRevisionRef[];
    }
  | {
      type: 'operation.execute';
      connectorId: string;
      tool: string;
      argumentsDigest: string;
      target: string;
      risk: 'irreversible' | 'out-of-scope';
    }
  | {
      type: 'schedule.change';
      operation: 'create' | 'update' | 'pause' | 'delete';
      scheduleId: string;
      revisionDigest: string;
    }
  | MissionControlScope;

export type PermissionScopeType = PermissionScope['type'];
export type PermissionAudience = 'admin' | 'owner';
export type PermissionExecutor = 'human-device' | 'body' | 'ops-broker';
export type PermissionRole = 'admin' | 'owner';

export type PermissionGrantEnvelopeV1 = {
  /** Tier 1 is autonomous inside a standing envelope; Tier 2 always asks. */
  tier: 1 | 2;
  mode: 'standing' | 'per-action';
  notBefore: number;
  expiresAt: number;
  maxUses: number;
  budget: {
    /** Total monetary spend over the envelope, when the scope spends money. */
    maxMinorUnits?: number;
    currency?: string;
    /** Conservative accounting reservation, not a cryptographic token limit. */
    maxReservedTokens?: number;
  };
  rate: {
    maxUses: number;
    windowSeconds: number;
  };
};

export interface PermissionRequestV1 {
  version: 1;
  permissionId: string;
  roomId: string;
  workspaceId: string;
  requesterAgentPubkey: string;
  audience: PermissionAudience;
  summary: string;
  scope: PermissionScope;
  provenance: {
    immediateTurnEventId: string;
    rootEventId: string;
    scheduleRunId?: string;
  };
  requestedAt: number;
  requestExpiresAt: number;
}

export interface PermissionDecisionV1 {
  version: 1;
  permissionId: string;
  requestEventId: string;
  decision: 'grant' | 'deny';
  decidedAt: number;
  grant?: PermissionGrantEnvelopeV1;
  note?: string;
}

export interface PermissionRevocationV1 {
  version: 1;
  permissionId: string;
  grantEventId: string;
  revokedAt: number;
  reason: string;
  note?: string;
}

export type PermissionExecutionStatus = 'started' | 'succeeded' | 'failed' | 'unknown';

export interface PermissionExecutionV1 {
  version: 1;
  permissionId: string;
  grantEventId: string;
  actionId: string;
  idempotencyKey: string;
  attempt: number;
  status: PermissionExecutionStatus;
  at: number;
  charge?: {
    uses: number;
    minorUnits?: number;
    currency?: string;
    reservedTokens?: number;
  };
  result?: string;
}

export type ParsedPermissionRequest = {
  type: 'request';
  event: NostrEvent;
  value: PermissionRequestV1;
};

export type ParsedPermissionDecision = {
  type: 'decision';
  event: NostrEvent;
  value: PermissionDecisionV1;
};

export type ParsedPermissionRevocation = {
  type: 'revocation';
  event: NostrEvent;
  value: PermissionRevocationV1;
};

export type ParsedPermissionExecution = {
  type: 'execution';
  event: NostrEvent;
  value: PermissionExecutionV1;
};

export type ParsedPermissionEvent =
  | ParsedPermissionRequest
  | ParsedPermissionDecision
  | ParsedPermissionRevocation
  | ParsedPermissionExecution;

export interface PermissionScopePolicy {
  type: PermissionScopeType;
  minimumRole: PermissionRole;
  defaultGrantTtlSeconds: number;
  maximumGrantTtlSeconds: number;
  defaultMaxUses: number;
  defaultRateWindowSeconds: number;
  executor: PermissionExecutor;
  tier(scope: PermissionScope): 1 | 2;
}

export const tierOne = (): 1 => 1;

export const PERMISSION_SCOPE_REGISTRY: Readonly<
  Record<PermissionScopeType, PermissionScopePolicy>
> = {
  'room.create': {
    type: 'room.create',
    minimumRole: 'admin',
    defaultGrantTtlSeconds: 30 * 60,
    maximumGrantTtlSeconds: 24 * 60 * 60,
    defaultMaxUses: 1,
    defaultRateWindowSeconds: 60 * 60,
    executor: 'human-device',
    tier: tierOne,
  },
  'money.spend': {
    type: 'money.spend',
    minimumRole: 'owner',
    defaultGrantTtlSeconds: 24 * 60 * 60,
    maximumGrantTtlSeconds: MAX_PERMISSION_GRANT_TTL_SECONDS,
    defaultMaxUses: 20,
    defaultRateWindowSeconds: 24 * 60 * 60,
    executor: 'ops-broker',
    tier: tierOne,
  },
  'message.send': {
    type: 'message.send',
    minimumRole: 'admin',
    defaultGrantTtlSeconds: 24 * 60 * 60,
    maximumGrantTtlSeconds: 7 * 24 * 60 * 60,
    defaultMaxUses: 20,
    defaultRateWindowSeconds: 24 * 60 * 60,
    executor: 'ops-broker',
    tier: tierOne,
  },
  'content.publish': {
    type: 'content.publish',
    minimumRole: 'admin',
    defaultGrantTtlSeconds: 24 * 60 * 60,
    maximumGrantTtlSeconds: 7 * 24 * 60 * 60,
    defaultMaxUses: 10,
    defaultRateWindowSeconds: 24 * 60 * 60,
    executor: 'ops-broker',
    tier: tierOne,
  },
  'operation.execute': {
    type: 'operation.execute',
    minimumRole: 'owner',
    defaultGrantTtlSeconds: 10 * 60,
    maximumGrantTtlSeconds: 10 * 60,
    defaultMaxUses: 1,
    defaultRateWindowSeconds: 10 * 60,
    executor: 'ops-broker',
    tier: () => 2,
  },
  'schedule.change': {
    type: 'schedule.change',
    minimumRole: 'admin',
    defaultGrantTtlSeconds: 24 * 60 * 60,
    maximumGrantTtlSeconds: 7 * 24 * 60 * 60,
    defaultMaxUses: 20,
    defaultRateWindowSeconds: 24 * 60 * 60,
    executor: 'body',
    tier: tierOne,
  },
  'mission.control': {
    type: 'mission.control',
    minimumRole: 'owner',
    defaultGrantTtlSeconds: 7 * 24 * 60 * 60,
    maximumGrantTtlSeconds: MAX_PERMISSION_GRANT_TTL_SECONDS,
    defaultMaxUses: 50_000,
    defaultRateWindowSeconds: 24 * 60 * 60,
    executor: 'body',
    tier: tierOne,
  },
};

export function object(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function nonEmpty(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

export function protocolId(value: unknown): string | undefined {
  const candidate = nonEmpty(value, 64);
  return candidate && PROTOCOL_ID.test(candidate) ? candidate : undefined;
}

export function token(value: unknown, max = 256): string | undefined {
  const candidate = nonEmpty(value, max);
  return candidate && SAFE_TOKEN.test(candidate) ? candidate : undefined;
}

export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : undefined;
}

export function pubkey(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_64.test(value) ? value : undefined;
}

export function uniqueStrings(
  value: unknown,
  parse: (candidate: unknown) => string | undefined,
  max = MAX_PERMISSION_LIST_ITEMS,
): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return undefined;
  const parsed = value.map(parse);
  if (parsed.some((candidate) => !candidate)) return undefined;
  const result = parsed as string[];
  return new Set(result).size === result.length ? result : undefined;
}

export function enumStrings<T extends string>(
  value: unknown,
  allowed: readonly T[],
  max = MAX_PERMISSION_LIST_ITEMS,
): T[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  if (
    value.some((candidate) => typeof candidate !== 'string' || !allowed.includes(candidate as T))
  ) {
    return undefined;
  }
  const result = value as T[];
  return new Set(result).size === result.length ? result : undefined;
}

export function parseArtifact(value: unknown): ArtifactRevisionRef | undefined {
  const input = object(value);
  if (!input) return undefined;
  const artifactId = token(input.artifactId);
  const revision = integer(input.revision, 1);
  const eventId =
    typeof input.eventId === 'string' && HEX_64.test(input.eventId) ? input.eventId : undefined;
  const sha256 =
    typeof input.sha256 === 'string' && SHA_256.test(input.sha256) ? input.sha256 : undefined;
  if (!artifactId || revision === undefined || !eventId || !sha256) return undefined;
  return { artifactId, revision, eventId, sha256 };
}

export function parseArtifacts(value: unknown): ArtifactRevisionRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PERMISSION_LIST_ITEMS) {
    return undefined;
  }
  const parsed = value.map(parseArtifact);
  if (parsed.some((candidate) => !candidate)) return undefined;
  const artifacts = parsed as ArtifactRevisionRef[];
  const ids = artifacts.map(
    (artifact) => `${artifact.artifactId}:${artifact.revision}:${artifact.eventId}`,
  );
  return new Set(ids).size === ids.length ? artifacts : undefined;
}

export function parseDestination(value: unknown): NormalizedDestination | undefined {
  const input = object(value);
  if (!input) return undefined;
  const type = input.type;
  const destination = nonEmpty(input.value, 512);
  if (!['email', 'phone', 'social', 'room', 'url'].includes(String(type)) || !destination) {
    return undefined;
  }
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) return undefined;
  if (type === 'url' && !/^https:\/\/[^\s]+$/i.test(destination)) return undefined;
  return { type: type as NormalizedDestination['type'], value: destination };
}

export function parseDestinations(value: unknown): NormalizedDestination[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PERMISSION_LIST_ITEMS) {
    return undefined;
  }
  const parsed = value.map(parseDestination);
  if (parsed.some((candidate) => !candidate)) return undefined;
  const destinations = parsed as NormalizedDestination[];
  const ids = destinations.map((destination) => `${destination.type}:${destination.value}`);
  return new Set(ids).size === ids.length ? destinations : undefined;
}

export function parsePermissionScope(value: unknown): PermissionScope | undefined {
  const input = object(value);
  if (!input || typeof input.type !== 'string') return undefined;
  switch (input.type) {
    case 'room.create': {
      const workspaceId = token(input.workspaceId);
      const roomId = token(input.roomId);
      const name = nonEmpty(input.name, 120);
      const participantPubkeys = uniqueStrings(input.participantPubkeys, pubkey, 64);
      const agentPubkeys = uniqueStrings(input.agentPubkeys, pubkey, 64);
      if (
        !workspaceId ||
        !roomId ||
        !name ||
        !['invite-only', 'workspace'].includes(String(input.visibility)) ||
        !participantPubkeys ||
        !agentPubkeys
      ) {
        return undefined;
      }
      const repositoryInput = input.repository === undefined ? undefined : object(input.repository);
      const repository = repositoryInput
        ? {
            key: token(repositoryInput.key),
            targetBranch: token(repositoryInput.targetBranch),
          }
        : undefined;
      if (repository && (!repository.key || !repository.targetBranch)) return undefined;
      return {
        type: input.type,
        workspaceId,
        roomId,
        name,
        visibility: input.visibility as 'invite-only' | 'workspace',
        participantPubkeys,
        agentPubkeys,
        ...(repository
          ? { repository: { key: repository.key!, targetBranch: repository.targetBranch! } }
          : {}),
      };
    }
    case 'money.spend': {
      const currency = nonEmpty(input.currency, 3);
      const maxMinorUnits = integer(input.maxMinorUnits, 1);
      const merchant = nonEmpty(input.merchant, 160);
      const purpose = nonEmpty(input.purpose, 600);
      const connectorId = token(input.connectorId);
      if (
        !currency ||
        !CURRENCY.test(currency) ||
        maxMinorUnits === undefined ||
        !merchant ||
        !purpose ||
        !connectorId
      ) {
        return undefined;
      }
      return { type: input.type, currency, maxMinorUnits, merchant, purpose, connectorId };
    }
    case 'message.send': {
      const connectorId = token(input.connectorId);
      const artifacts = parseArtifacts(input.artifacts);
      const recipients = parseDestinations(input.recipients);
      if (
        !['email', 'sms', 'social-dm'].includes(String(input.channel)) ||
        !connectorId ||
        !artifacts ||
        !recipients
      ) {
        return undefined;
      }
      return {
        type: input.type,
        channel: input.channel as 'email' | 'sms' | 'social-dm',
        connectorId,
        artifacts,
        recipients,
      };
    }
    case 'content.publish': {
      const connectorId = token(input.connectorId);
      const destination = parseDestination(input.destination);
      const artifacts = parseArtifacts(input.artifacts);
      if (!connectorId || !destination || !artifacts) return undefined;
      return { type: input.type, connectorId, destination, artifacts };
    }
    case 'operation.execute': {
      const connectorId = token(input.connectorId);
      const tool = token(input.tool);
      const argumentsDigest =
        typeof input.argumentsDigest === 'string' && SHA_256.test(input.argumentsDigest)
          ? input.argumentsDigest
          : undefined;
      const target = nonEmpty(input.target, 512);
      if (
        !connectorId ||
        !tool ||
        !argumentsDigest ||
        !target ||
        !['irreversible', 'out-of-scope'].includes(String(input.risk))
      ) {
        return undefined;
      }
      return {
        type: input.type,
        connectorId,
        tool,
        argumentsDigest,
        target,
        risk: input.risk as 'irreversible' | 'out-of-scope',
      };
    }
    case 'schedule.change': {
      const scheduleId = protocolId(input.scheduleId);
      const revisionDigest =
        typeof input.revisionDigest === 'string' && SHA_256.test(input.revisionDigest)
          ? input.revisionDigest
          : undefined;
      if (
        !['create', 'update', 'pause', 'delete'].includes(String(input.operation)) ||
        !scheduleId ||
        !revisionDigest
      ) {
        return undefined;
      }
      return {
        type: input.type,
        operation: input.operation as 'create' | 'update' | 'pause' | 'delete',
        scheduleId,
        revisionDigest,
      };
    }
    case 'mission.control': {
      const missionId = token(input.missionId);
      const workspaceId = token(input.workspaceId);
      const roomId = token(input.roomId);
      const controllerAgentPubkey = pubkey(input.controllerAgentPubkey);
      const repositoryInput = object(input.repository);
      const repositoryKey = token(repositoryInput?.key);
      const targetBranch = token(repositoryInput?.targetBranch);
      const cornerOperations = enumStrings<MissionCornerOperation>(input.cornerOperations, [
        'open',
        'close',
      ]);
      const scheduleOperations = enumStrings<MissionScheduleOperation>(input.scheduleOperations, [
        'create',
        'update',
        'pause',
        'delete',
        'fire',
      ]);
      const rawTargets = Array.isArray(input.targetAllocations)
        ? input.targetAllocations
        : undefined;
      const targetAllocations = rawTargets?.flatMap((candidate) => {
        const allocation = object(candidate);
        const agentPubkey = pubkey(allocation?.agentPubkey);
        const maxActiveCorners = integer(allocation?.maxActiveCorners, 0, 1_000);
        const maxReservedTokensPerDay = integer(
          allocation?.maxReservedTokensPerDay,
          0,
          MAX_MISSION_RESERVED_TOKENS,
        );
        const maxTotalReservedTokens = integer(
          allocation?.maxTotalReservedTokens,
          0,
          Number.MAX_SAFE_INTEGER,
        );
        return agentPubkey &&
          maxActiveCorners !== undefined &&
          maxReservedTokensPerDay !== undefined &&
          maxTotalReservedTokens !== undefined &&
          maxReservedTokensPerDay <= maxTotalReservedTokens
          ? [
              {
                agentPubkey,
                maxActiveCorners,
                maxReservedTokensPerDay,
                maxTotalReservedTokens,
              },
            ]
          : [];
      });
      const rawSchedules = Array.isArray(input.scheduleAllocations)
        ? input.scheduleAllocations
        : undefined;
      const scheduleAllocations = rawSchedules?.flatMap((candidate) => {
        const allocation = object(candidate);
        const scheduleId = token(allocation?.scheduleId);
        const targetAgentPubkey = pubkey(allocation?.targetAgentPubkey);
        const modes = enumStrings<MissionScheduleMode>(allocation?.modes, ['script', 'model']);
        const maxRuns = integer(allocation?.maxRuns, 1, 1_000_000);
        const maxReservedTokensPerRun = integer(
          allocation?.maxReservedTokensPerRun,
          0,
          MAX_MISSION_RESERVED_TOKENS,
        );
        const maxReservedTokensPerDay = integer(
          allocation?.maxReservedTokensPerDay,
          0,
          MAX_MISSION_RESERVED_TOKENS,
        );
        const maxTotalReservedTokens = integer(
          allocation?.maxTotalReservedTokens,
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const maxScriptRuntimeSeconds = integer(allocation?.maxScriptRuntimeSeconds, 1, 3_600);
        const revisionDigest =
          allocation?.revisionDigest === undefined
            ? undefined
            : typeof allocation.revisionDigest === 'string' &&
                SHA_256.test(allocation.revisionDigest)
              ? allocation.revisionDigest
              : null;
        return scheduleId &&
          targetAgentPubkey &&
          modes &&
          modes.length > 0 &&
          maxRuns !== undefined &&
          maxReservedTokensPerRun !== undefined &&
          maxReservedTokensPerDay !== undefined &&
          maxTotalReservedTokens !== undefined &&
          maxScriptRuntimeSeconds !== undefined &&
          revisionDigest !== null &&
          maxReservedTokensPerRun <= maxReservedTokensPerDay &&
          maxReservedTokensPerDay <= maxTotalReservedTokens &&
          maxReservedTokensPerRun * maxRuns >= maxTotalReservedTokens
          ? [
              {
                scheduleId,
                targetAgentPubkey,
                modes,
                maxRuns,
                maxReservedTokensPerRun,
                maxReservedTokensPerDay,
                maxTotalReservedTokens,
                maxScriptRuntimeSeconds,
                ...(revisionDigest ? { revisionDigest } : {}),
              },
            ]
          : [];
      });
      const targetKeys = targetAllocations?.map((allocation) => allocation.agentPubkey);
      const scheduleKeys = scheduleAllocations?.map((allocation) => allocation.scheduleId);
      if (
        !missionId ||
        !workspaceId ||
        !roomId ||
        !controllerAgentPubkey ||
        !repositoryKey ||
        !targetBranch ||
        !cornerOperations ||
        !scheduleOperations ||
        !rawTargets ||
        rawTargets.length === 0 ||
        rawTargets.length > MAX_PERMISSION_LIST_ITEMS ||
        !targetAllocations ||
        targetAllocations.length !== rawTargets.length ||
        new Set(targetKeys).size !== targetKeys?.length ||
        !targetAllocations.some((allocation) => allocation.agentPubkey === controllerAgentPubkey) ||
        !rawSchedules ||
        rawSchedules.length > MAX_PERMISSION_LIST_ITEMS ||
        !scheduleAllocations ||
        scheduleAllocations.length !== rawSchedules.length ||
        new Set(scheduleKeys).size !== scheduleKeys?.length ||
        scheduleAllocations.some(
          (allocation) => !targetKeys?.includes(allocation.targetAgentPubkey),
        ) ||
        targetAllocations.some((target) => {
          const schedules = scheduleAllocations.filter(
            (allocation) => allocation.targetAgentPubkey === target.agentPubkey,
          );
          return (
            schedules.reduce((sum, allocation) => sum + allocation.maxReservedTokensPerDay, 0) >
              target.maxReservedTokensPerDay ||
            schedules.reduce((sum, allocation) => sum + allocation.maxTotalReservedTokens, 0) >
              target.maxTotalReservedTokens
          );
        }) ||
        (scheduleOperations.length > 0 && scheduleAllocations.length === 0) ||
        (input.land !== true && input.land !== false) ||
        (cornerOperations.length === 0 && scheduleOperations.length === 0 && input.land === false)
      ) {
        return undefined;
      }
      return {
        type: input.type,
        missionId,
        workspaceId,
        roomId,
        controllerAgentPubkey,
        repository: { key: repositoryKey, targetBranch },
        cornerOperations,
        scheduleOperations,
        targetAllocations,
        scheduleAllocations,
        land: input.land,
      };
    }
    default:
      return undefined;
  }
}
