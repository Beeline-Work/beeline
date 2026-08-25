/**
 * Signed permission ledger for bounded factory side effects.
 *
 * Model text is never authority. Only events built and parsed here may enter
 * the permission fold, and every executor must call `verifyPermissionAction`
 * against fresh membership, role, revocation, and execution reads immediately
 * before publishing its `started` receipt.
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  KIND_STREAM_MESSAGE,
  TAG_PERMISSION_DECISION,
  TAG_PERMISSION_EXECUTION,
  TAG_PERMISSION_REQUEST,
  TAG_PERMISSION_REVOCATION,
} from './kinds.js';
import type { Identity } from './types.js';

export const PERMISSION_REQUEST_MARKER = TAG_PERMISSION_REQUEST;
export const PERMISSION_DECISION_MARKER = TAG_PERMISSION_DECISION;
export const PERMISSION_REVOCATION_MARKER = TAG_PERMISSION_REVOCATION;
export const PERMISSION_EXECUTION_MARKER = TAG_PERMISSION_EXECUTION;

export const PERMISSION_PROTOCOL_VERSION = 1 as const;
export const MAX_PERMISSION_SUMMARY_CHARS = 600;
export const MAX_PERMISSION_NOTE_CHARS = 600;
export const MAX_PERMISSION_REASON_CHARS = 80;
export const MAX_PERMISSION_LIST_ITEMS = 128;
export const MAX_PERMISSION_USES = 10_000;
export const MAX_PERMISSION_RATE_WINDOW_SECONDS = 31 * 24 * 60 * 60;
export const MAX_PERMISSION_GRANT_TTL_SECONDS = 31 * 24 * 60 * 60;
export const MAX_PERMISSION_CONTENT_CHARS = 32_000;

const HEX_64 = /^[0-9a-f]{64}$/;
const PROTOCOL_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SHA_256 = /^[0-9a-f]{64}$/;

type JsonRecord = Record<string, unknown>;

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
  | {
      type: 'delegation.escalate';
      delegationId: string;
      extraTurns: number;
      extraReservedTokens: number;
      permittedAgentPubkeys: string[];
    };

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
    delegationId?: string;
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

const tierOne = (): 1 => 1;

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
  'delegation.escalate': {
    type: 'delegation.escalate',
    minimumRole: 'admin',
    defaultGrantTtlSeconds: 30 * 60,
    maximumGrantTtlSeconds: 24 * 60 * 60,
    defaultMaxUses: 1,
    defaultRateWindowSeconds: 60 * 60,
    executor: 'body',
    tier: tierOne,
  },
};

function object(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmpty(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

function protocolId(value: unknown): string | undefined {
  const candidate = nonEmpty(value, 64);
  return candidate && PROTOCOL_ID.test(candidate) ? candidate : undefined;
}

function token(value: unknown, max = 256): string | undefined {
  const candidate = nonEmpty(value, max);
  return candidate && SAFE_TOKEN.test(candidate) ? candidate : undefined;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : undefined;
}

function pubkey(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_64.test(value) ? value : undefined;
}

function uniqueStrings(
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

function parseArtifact(value: unknown): ArtifactRevisionRef | undefined {
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

function parseArtifacts(value: unknown): ArtifactRevisionRef[] | undefined {
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

function parseDestination(value: unknown): NormalizedDestination | undefined {
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

function parseDestinations(value: unknown): NormalizedDestination[] | undefined {
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
    case 'delegation.escalate': {
      const delegationId = protocolId(input.delegationId);
      const extraTurns = integer(input.extraTurns, 1, 1_000);
      const extraReservedTokens = integer(input.extraReservedTokens, 0);
      const permittedAgentPubkeys = uniqueStrings(input.permittedAgentPubkeys, pubkey, 64);
      if (
        !delegationId ||
        extraTurns === undefined ||
        extraReservedTokens === undefined ||
        !permittedAgentPubkeys
      ) {
        return undefined;
      }
      return {
        type: input.type,
        delegationId,
        extraTurns,
        extraReservedTokens,
        permittedAgentPubkeys,
      };
    }
    default:
      return undefined;
  }
}

function parseEnvelope(
  value: unknown,
  scope: PermissionScope,
): PermissionGrantEnvelopeV1 | undefined {
  const input = object(value);
  const policy = PERMISSION_SCOPE_REGISTRY[scope.type];
  if (!input) return undefined;
  const tier = integer(input.tier, 1, 2);
  const mode = input.mode;
  const notBefore = integer(input.notBefore);
  const expiresAt = integer(input.expiresAt);
  const maxUses = integer(input.maxUses, 1, MAX_PERMISSION_USES);
  const budgetInput = object(input.budget);
  const rateInput = object(input.rate);
  const rateMaxUses = integer(rateInput?.maxUses, 1, MAX_PERMISSION_USES);
  const windowSeconds = integer(rateInput?.windowSeconds, 1, MAX_PERMISSION_RATE_WINDOW_SECONDS);
  if (
    (tier !== 1 && tier !== 2) ||
    !['standing', 'per-action'].includes(String(mode)) ||
    notBefore === undefined ||
    expiresAt === undefined ||
    maxUses === undefined ||
    !budgetInput ||
    !rateInput ||
    rateMaxUses === undefined ||
    windowSeconds === undefined ||
    expiresAt <= notBefore ||
    expiresAt - notBefore > policy.maximumGrantTtlSeconds ||
    rateMaxUses > maxUses ||
    tier !== policy.tier(scope) ||
    (tier === 1 && mode !== 'standing') ||
    (tier === 2 && (mode !== 'per-action' || maxUses !== 1 || rateMaxUses !== 1))
  ) {
    return undefined;
  }
  const maxMinorUnits =
    budgetInput.maxMinorUnits === undefined ? undefined : integer(budgetInput.maxMinorUnits, 1);
  const currency =
    budgetInput.currency === undefined ? undefined : nonEmpty(budgetInput.currency, 3);
  const maxReservedTokens =
    budgetInput.maxReservedTokens === undefined
      ? undefined
      : integer(budgetInput.maxReservedTokens, 0);
  if (
    (budgetInput.maxMinorUnits !== undefined && maxMinorUnits === undefined) ||
    (budgetInput.currency !== undefined && (!currency || !CURRENCY.test(currency))) ||
    (budgetInput.maxReservedTokens !== undefined && maxReservedTokens === undefined) ||
    (maxMinorUnits === undefined) !== (currency === undefined)
  ) {
    return undefined;
  }
  if (scope.type === 'money.spend') {
    if (!maxMinorUnits || currency !== scope.currency || maxMinorUnits > scope.maxMinorUnits) {
      return undefined;
    }
  } else if (maxMinorUnits !== undefined || currency !== undefined) {
    return undefined;
  }
  return {
    tier,
    mode: mode as 'standing' | 'per-action',
    notBefore,
    expiresAt,
    maxUses,
    budget: {
      ...(maxMinorUnits !== undefined ? { maxMinorUnits, currency } : {}),
      ...(maxReservedTokens !== undefined ? { maxReservedTokens } : {}),
    },
    rate: { maxUses: rateMaxUses, windowSeconds },
  };
}

export function defaultPermissionGrantEnvelope(
  scope: PermissionScope,
  decidedAt: number,
): PermissionGrantEnvelopeV1 {
  const policy = PERMISSION_SCOPE_REGISTRY[scope.type];
  const tier = policy.tier(scope);
  const maxUses = tier === 2 ? 1 : policy.defaultMaxUses;
  return {
    tier,
    mode: tier === 2 ? 'per-action' : 'standing',
    notBefore: decidedAt,
    expiresAt: decidedAt + policy.defaultGrantTtlSeconds,
    maxUses,
    budget: {
      ...(scope.type === 'money.spend'
        ? { maxMinorUnits: scope.maxMinorUnits, currency: scope.currency }
        : {}),
    },
    rate: { maxUses, windowSeconds: policy.defaultRateWindowSeconds },
  };
}

function parseRequestContent(value: unknown): PermissionRequestV1 | undefined {
  const input = object(value);
  const provenance = object(input?.provenance);
  const scope = parsePermissionScope(input?.scope);
  const permissionId = protocolId(input?.permissionId);
  const roomId = token(input?.roomId);
  const workspaceId = token(input?.workspaceId);
  const requesterAgentPubkey = pubkey(input?.requesterAgentPubkey);
  const summary = nonEmpty(input?.summary, MAX_PERMISSION_SUMMARY_CHARS);
  const immediateTurnEventId =
    provenance &&
    typeof provenance.immediateTurnEventId === 'string' &&
    HEX_64.test(provenance.immediateTurnEventId)
      ? provenance.immediateTurnEventId
      : undefined;
  const rootEventId =
    provenance && typeof provenance.rootEventId === 'string' && HEX_64.test(provenance.rootEventId)
      ? provenance.rootEventId
      : undefined;
  const delegationId =
    provenance?.delegationId === undefined ? undefined : protocolId(provenance.delegationId);
  const scheduleRunId =
    provenance?.scheduleRunId === undefined ? undefined : token(provenance.scheduleRunId);
  const requestedAt = integer(input?.requestedAt);
  const requestExpiresAt = integer(input?.requestExpiresAt);
  if (
    input?.version !== PERMISSION_PROTOCOL_VERSION ||
    !permissionId ||
    !roomId ||
    !workspaceId ||
    !requesterAgentPubkey ||
    !['admin', 'owner'].includes(String(input?.audience)) ||
    !summary ||
    !scope ||
    !provenance ||
    !immediateTurnEventId ||
    !rootEventId ||
    (provenance.delegationId !== undefined && !delegationId) ||
    (provenance.scheduleRunId !== undefined && !scheduleRunId) ||
    requestedAt === undefined ||
    requestExpiresAt === undefined ||
    requestExpiresAt <= requestedAt ||
    (scope.type === 'room.create' && scope.workspaceId !== workspaceId)
  ) {
    return undefined;
  }
  return {
    version: 1,
    permissionId,
    roomId,
    workspaceId,
    requesterAgentPubkey,
    audience: input.audience as PermissionAudience,
    summary,
    scope,
    provenance: {
      immediateTurnEventId,
      rootEventId,
      ...(delegationId ? { delegationId } : {}),
      ...(scheduleRunId ? { scheduleRunId } : {}),
    },
    requestedAt,
    requestExpiresAt,
  };
}

function parseDecisionContent(
  value: unknown,
  scope: PermissionScope,
): PermissionDecisionV1 | undefined {
  const input = object(value);
  const permissionId = protocolId(input?.permissionId);
  const requestEventId =
    typeof input?.requestEventId === 'string' && HEX_64.test(input.requestEventId)
      ? input.requestEventId
      : undefined;
  const decidedAt = integer(input?.decidedAt);
  const note =
    input?.note === undefined ? undefined : nonEmpty(input.note, MAX_PERMISSION_NOTE_CHARS);
  if (
    input?.version !== 1 ||
    !permissionId ||
    !requestEventId ||
    !['grant', 'deny'].includes(String(input?.decision)) ||
    decidedAt === undefined ||
    (input.note !== undefined && !note)
  ) {
    return undefined;
  }
  const grant = input.decision === 'grant' ? parseEnvelope(input.grant, scope) : undefined;
  if (
    (input.decision === 'grant' && !grant) ||
    (input.decision === 'deny' && input.grant !== undefined)
  ) {
    return undefined;
  }
  return {
    version: 1,
    permissionId,
    requestEventId,
    decision: input.decision as 'grant' | 'deny',
    decidedAt,
    ...(grant ? { grant } : {}),
    ...(note ? { note } : {}),
  };
}

function parseRevocationContent(value: unknown): PermissionRevocationV1 | undefined {
  const input = object(value);
  const permissionId = protocolId(input?.permissionId);
  const grantEventId =
    typeof input?.grantEventId === 'string' && HEX_64.test(input.grantEventId)
      ? input.grantEventId
      : undefined;
  const revokedAt = integer(input?.revokedAt);
  const reason = token(input?.reason, MAX_PERMISSION_REASON_CHARS);
  const note =
    input?.note === undefined ? undefined : nonEmpty(input.note, MAX_PERMISSION_NOTE_CHARS);
  if (
    input?.version !== 1 ||
    !permissionId ||
    !grantEventId ||
    revokedAt === undefined ||
    !reason ||
    (input.note !== undefined && !note)
  ) {
    return undefined;
  }
  return { version: 1, permissionId, grantEventId, revokedAt, reason, ...(note ? { note } : {}) };
}

function parseExecutionContent(value: unknown): PermissionExecutionV1 | undefined {
  const input = object(value);
  const permissionId = protocolId(input?.permissionId);
  const grantEventId =
    typeof input?.grantEventId === 'string' && HEX_64.test(input.grantEventId)
      ? input.grantEventId
      : undefined;
  const actionId = token(input?.actionId);
  const idempotencyKey = token(input?.idempotencyKey);
  const attempt = integer(input?.attempt, 1, 1_000);
  const at = integer(input?.at);
  const result = input?.result === undefined ? undefined : nonEmpty(input.result, 600);
  const chargeInput = input?.charge === undefined ? undefined : object(input.charge);
  if (
    input?.version !== 1 ||
    !permissionId ||
    !grantEventId ||
    !actionId ||
    !idempotencyKey ||
    attempt === undefined ||
    !['started', 'succeeded', 'failed', 'unknown'].includes(String(input?.status)) ||
    at === undefined ||
    (input.result !== undefined && !result) ||
    (input.charge !== undefined && !chargeInput)
  ) {
    return undefined;
  }
  let charge: PermissionExecutionV1['charge'];
  if (chargeInput) {
    const uses = integer(chargeInput.uses, 1, MAX_PERMISSION_USES);
    const minorUnits =
      chargeInput.minorUnits === undefined ? undefined : integer(chargeInput.minorUnits, 0);
    const currency =
      chargeInput.currency === undefined ? undefined : nonEmpty(chargeInput.currency, 3);
    const reservedTokens =
      chargeInput.reservedTokens === undefined ? undefined : integer(chargeInput.reservedTokens, 0);
    if (
      uses === undefined ||
      (chargeInput.minorUnits !== undefined && minorUnits === undefined) ||
      (chargeInput.currency !== undefined && (!currency || !CURRENCY.test(currency))) ||
      (minorUnits === undefined) !== (currency === undefined) ||
      (chargeInput.reservedTokens !== undefined && reservedTokens === undefined)
    ) {
      return undefined;
    }
    charge = {
      uses,
      ...(minorUnits !== undefined ? { minorUnits, currency } : {}),
      ...(reservedTokens !== undefined ? { reservedTokens } : {}),
    };
  }
  return {
    version: 1,
    permissionId,
    grantEventId,
    actionId,
    idempotencyKey,
    attempt,
    status: input.status as PermissionExecutionStatus,
    at,
    ...(charge ? { charge } : {}),
    ...(result ? { result } : {}),
  };
}

function uniqueTag(event: NostrEvent, name: string): string | undefined {
  const matches = event.tags.filter((candidate) => candidate[0] === name);
  return matches.length === 1 && typeof matches[0]?.[1] === 'string' && matches[0][1]
    ? matches[0][1]
    : undefined;
}

function marker(event: NostrEvent): string | undefined {
  const markers = event.tags.filter((candidate) => candidate[0] === 't');
  return markers.length === 1 ? markers[0]?.[1] : undefined;
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function baseEventValid(event: NostrEvent): boolean {
  return (
    event.kind === KIND_STREAM_MESSAGE &&
    event.content.length <= MAX_PERMISSION_CONTENT_CHARS &&
    verifyEvent(event) &&
    marker(event) !== undefined
  );
}

export function parsePermissionRequest(event: NostrEvent): ParsedPermissionRequest | undefined {
  if (!baseEventValid(event) || marker(event) !== PERMISSION_REQUEST_MARKER) return undefined;
  const value = parseRequestContent(parseJson(event.content));
  if (!value) return undefined;
  const pTags = event.tags.filter((candidate) => candidate[0] === 'p');
  if (
    uniqueTag(event, 'h') !== value.roomId ||
    uniqueTag(event, 'permission') !== value.permissionId ||
    uniqueTag(event, 'scope') !== value.scope.type ||
    uniqueTag(event, 'agent') !== value.requesterAgentPubkey ||
    uniqueTag(event, 'workspace') !== value.workspaceId ||
    uniqueTag(event, 'audience') !== value.audience ||
    uniqueTag(event, 'request') !== value.provenance.immediateTurnEventId ||
    uniqueTag(event, 'root') !== value.provenance.rootEventId ||
    uniqueTag(event, 'expires') !== String(value.requestExpiresAt) ||
    event.created_at !== value.requestedAt ||
    event.pubkey !== value.requesterAgentPubkey ||
    pTags.length === 0 ||
    pTags.some((candidate) => !pubkey(candidate[1])) ||
    new Set(pTags.map((candidate) => candidate[1])).size !== pTags.length
  ) {
    return undefined;
  }
  return { type: 'request', event, value };
}

export function parsePermissionDecision(
  event: NostrEvent,
  request: ParsedPermissionRequest,
): ParsedPermissionDecision | undefined {
  if (!baseEventValid(event) || marker(event) !== PERMISSION_DECISION_MARKER) return undefined;
  const value = parseDecisionContent(parseJson(event.content), request.value.scope);
  const replyTags = event.tags.filter((candidate) => candidate[0] === 'e');
  if (
    !value ||
    uniqueTag(event, 'h') !== request.value.roomId ||
    uniqueTag(event, 'permission') !== request.value.permissionId ||
    uniqueTag(event, 'decision') !== value.decision ||
    uniqueTag(event, 'scope') !== request.value.scope.type ||
    uniqueTag(event, 'agent') !== request.value.requesterAgentPubkey ||
    uniqueTag(event, 'p') !== request.value.requesterAgentPubkey ||
    value.permissionId !== request.value.permissionId ||
    value.requestEventId !== request.event.id ||
    value.decidedAt > request.value.requestExpiresAt ||
    event.created_at !== value.decidedAt ||
    replyTags.length !== 1 ||
    replyTags[0]?.[1] !== request.event.id ||
    replyTags[0]?.[3] !== 'reply' ||
    (value.decision === 'grant' &&
      (uniqueTag(event, 'expires') !== String(value.grant?.expiresAt) ||
        uniqueTag(event, 'max-uses') !== String(value.grant?.maxUses) ||
        uniqueTag(event, 'mode') !== value.grant?.mode ||
        uniqueTag(event, 'tier') !== String(value.grant?.tier))) ||
    (value.decision === 'deny' &&
      ['expires', 'max-uses', 'mode', 'tier'].some((name) =>
        event.tags.some((candidate) => candidate[0] === name),
      ))
  ) {
    return undefined;
  }
  return { type: 'decision', event, value };
}

export function parsePermissionRevocation(
  event: NostrEvent,
  request: ParsedPermissionRequest,
): ParsedPermissionRevocation | undefined {
  if (!baseEventValid(event) || marker(event) !== PERMISSION_REVOCATION_MARKER) return undefined;
  const value = parseRevocationContent(parseJson(event.content));
  if (
    !value ||
    uniqueTag(event, 'h') !== request.value.roomId ||
    uniqueTag(event, 'permission') !== request.value.permissionId ||
    uniqueTag(event, 'grant') !== value.grantEventId ||
    uniqueTag(event, 'reason') !== value.reason ||
    uniqueTag(event, 'p') !== request.value.requesterAgentPubkey ||
    value.permissionId !== request.value.permissionId ||
    event.created_at !== value.revokedAt
  ) {
    return undefined;
  }
  return { type: 'revocation', event, value };
}

export function parsePermissionExecution(
  event: NostrEvent,
  request: ParsedPermissionRequest,
): ParsedPermissionExecution | undefined {
  if (!baseEventValid(event) || marker(event) !== PERMISSION_EXECUTION_MARKER) return undefined;
  const value = parseExecutionContent(parseJson(event.content));
  if (
    !value ||
    uniqueTag(event, 'h') !== request.value.roomId ||
    uniqueTag(event, 'permission') !== request.value.permissionId ||
    uniqueTag(event, 'grant') !== value.grantEventId ||
    uniqueTag(event, 'action') !== value.actionId ||
    uniqueTag(event, 'idempotency') !== value.idempotencyKey ||
    uniqueTag(event, 'attempt') !== String(value.attempt) ||
    uniqueTag(event, 'status') !== value.status ||
    uniqueTag(event, 'result') !== value.result ||
    event.created_at !== value.at ||
    value.permissionId !== request.value.permissionId
  ) {
    return undefined;
  }
  return { type: 'execution', event, value };
}

export function parsePermissionEvent(
  event: NostrEvent,
  request?: ParsedPermissionRequest,
): ParsedPermissionEvent | undefined {
  if (marker(event) === PERMISSION_REQUEST_MARKER) return parsePermissionRequest(event);
  if (!request) return undefined;
  if (marker(event) === PERMISSION_DECISION_MARKER) return parsePermissionDecision(event, request);
  if (marker(event) === PERMISSION_REVOCATION_MARKER)
    return parsePermissionRevocation(event, request);
  if (marker(event) === PERMISSION_EXECUTION_MARKER)
    return parsePermissionExecution(event, request);
  return undefined;
}

function sign(
  identity: Identity,
  tags: string[][],
  content: unknown,
  createdAt: number,
): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: createdAt,
      kind: KIND_STREAM_MESSAGE,
      tags,
      content: JSON.stringify(content),
    },
    identity.secretKey,
  );
}

export function buildPermissionRequest(
  requester: Identity,
  input: PermissionRequestV1,
  eligibleHumanPubkeys: readonly string[],
): NostrEvent {
  const value = parseRequestContent(input);
  const humans = uniqueStrings(eligibleHumanPubkeys, pubkey, 64);
  if (!value || value.requesterAgentPubkey !== requester.publicKey || !humans) {
    throw new Error('invalid permission request');
  }
  return sign(
    requester,
    [
      ['h', value.roomId],
      ['t', PERMISSION_REQUEST_MARKER],
      ['permission', value.permissionId],
      ['scope', value.scope.type],
      ['agent', value.requesterAgentPubkey],
      ['workspace', value.workspaceId],
      ['audience', value.audience],
      ['request', value.provenance.immediateTurnEventId],
      ['root', value.provenance.rootEventId],
      ['expires', String(value.requestExpiresAt)],
      ...humans.map((human) => ['p', human]),
    ],
    value,
    value.requestedAt,
  );
}

export function buildPermissionDecision(
  signer: Identity,
  request: ParsedPermissionRequest,
  input: PermissionDecisionV1,
): NostrEvent {
  const value = parseDecisionContent(input, request.value.scope);
  if (
    !value ||
    value.permissionId !== request.value.permissionId ||
    value.requestEventId !== request.event.id
  ) {
    throw new Error('invalid permission decision');
  }
  return sign(
    signer,
    [
      ['h', request.value.roomId],
      ['t', PERMISSION_DECISION_MARKER],
      ['permission', value.permissionId],
      ['e', request.event.id, '', 'reply'],
      ['decision', value.decision],
      ['scope', request.value.scope.type],
      ['agent', request.value.requesterAgentPubkey],
      ...(value.grant
        ? [
            ['expires', String(value.grant.expiresAt)],
            ['max-uses', String(value.grant.maxUses)],
            ['mode', value.grant.mode],
            ['tier', String(value.grant.tier)],
          ]
        : []),
      ['p', request.value.requesterAgentPubkey],
    ],
    value,
    value.decidedAt,
  );
}

export function buildPermissionRevocation(
  signer: Identity,
  request: ParsedPermissionRequest,
  input: PermissionRevocationV1,
): NostrEvent {
  const value = parseRevocationContent(input);
  if (!value || value.permissionId !== request.value.permissionId) {
    throw new Error('invalid permission revocation');
  }
  return sign(
    signer,
    [
      ['h', request.value.roomId],
      ['t', PERMISSION_REVOCATION_MARKER],
      ['permission', value.permissionId],
      ['grant', value.grantEventId],
      ['reason', value.reason],
      ['p', request.value.requesterAgentPubkey],
    ],
    value,
    value.revokedAt,
  );
}

export function buildPermissionExecution(
  executor: Identity,
  request: ParsedPermissionRequest,
  input: PermissionExecutionV1,
): NostrEvent {
  const value = parseExecutionContent(input);
  if (!value || value.permissionId !== request.value.permissionId) {
    throw new Error('invalid permission execution');
  }
  return sign(
    executor,
    [
      ['h', request.value.roomId],
      ['t', PERMISSION_EXECUTION_MARKER],
      ['permission', value.permissionId],
      ['grant', value.grantEventId],
      ['action', value.actionId],
      ['idempotency', value.idempotencyKey],
      ['attempt', String(value.attempt)],
      ['status', value.status],
      ...(value.result ? [['result', value.result]] : []),
    ],
    value,
    value.at,
  );
}

function compareEvents(a: { event: NostrEvent }, b: { event: NostrEvent }): number {
  return a.event.created_at - b.event.created_at || a.event.id.localeCompare(b.event.id);
}

export type PermissionUsage = {
  uses: number;
  minorUnits: number;
  reservedTokens: number;
  committedAt: number[];
  actionStatuses: ReadonlyMap<string, PermissionExecutionStatus>;
};

export function summarizePermissionUsage(
  executions: readonly ParsedPermissionExecution[],
  grantEventId: string,
): PermissionUsage {
  const byAction = new Map<string, ParsedPermissionExecution[]>();
  for (const execution of executions) {
    if (execution.value.grantEventId !== grantEventId) continue;
    const list = byAction.get(execution.value.actionId) ?? [];
    list.push(execution);
    byAction.set(execution.value.actionId, list);
  }
  let uses = 0;
  let minorUnits = 0;
  let reservedTokens = 0;
  const committedAt: number[] = [];
  const actionStatuses = new Map<string, PermissionExecutionStatus>();
  for (const [actionId, events] of byAction) {
    events.sort(compareEvents);
    const started = events.find((event) => event.value.status === 'started');
    const terminal = [...events].reverse().find((event) => event.value.status !== 'started');
    const effective = terminal?.value.status ?? started?.value.status;
    if (!effective) continue;
    actionStatuses.set(actionId, effective);
    if (effective === 'failed') continue;
    const charge = started?.value.charge ?? terminal?.value.charge ?? { uses: 1 };
    uses += charge.uses;
    minorUnits += charge.minorUnits ?? 0;
    reservedTokens += charge.reservedTokens ?? 0;
    const committed = started?.value.at ?? terminal!.value.at;
    for (let use = 0; use < charge.uses; use += 1) committedAt.push(committed);
  }
  return { uses, minorUnits, reservedTokens, committedAt, actionStatuses };
}

export type PermissionFoldState =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'denied'; decision: ParsedPermissionDecision }
  | { status: 'granted'; decision: ParsedPermissionDecision; usage: PermissionUsage }
  | {
      status: 'revoked';
      decision: ParsedPermissionDecision;
      revocation: ParsedPermissionRevocation;
    }
  | { status: 'executing'; decision: ParsedPermissionDecision; usage: PermissionUsage }
  | { status: 'unknown'; decision: ParsedPermissionDecision; usage: PermissionUsage }
  | { status: 'consumed'; decision: ParsedPermissionDecision; usage: PermissionUsage };

export function foldPermissionLedger(input: {
  request: ParsedPermissionRequest;
  decisions: readonly ParsedPermissionDecision[];
  revocations?: readonly ParsedPermissionRevocation[];
  executions?: readonly ParsedPermissionExecution[];
  now: number;
  decisionAuthorized?: (decision: ParsedPermissionDecision) => boolean;
  revocationAuthorized?: (revocation: ParsedPermissionRevocation) => boolean;
}): PermissionFoldState {
  const decision = [...input.decisions]
    .filter(
      (candidate) =>
        candidate.value.permissionId === input.request.value.permissionId &&
        candidate.value.requestEventId === input.request.event.id &&
        candidate.value.decidedAt <= input.request.value.requestExpiresAt &&
        candidate.value.decidedAt <= input.now &&
        (input.decisionAuthorized?.(candidate) ?? true),
    )
    .sort(compareEvents)[0];
  if (!decision) {
    return input.now > input.request.value.requestExpiresAt
      ? { status: 'expired' }
      : { status: 'pending' };
  }
  if (decision.value.decision === 'deny') return { status: 'denied', decision };
  const grant = decision.value.grant!;
  if (input.now < grant.notBefore) return { status: 'pending' };
  if (input.now > grant.expiresAt) return { status: 'expired' };
  const revocation = [...(input.revocations ?? [])]
    .filter(
      (candidate) =>
        candidate.value.permissionId === input.request.value.permissionId &&
        candidate.value.grantEventId === decision.event.id &&
        candidate.value.revokedAt <= input.now &&
        (input.revocationAuthorized?.(candidate) ?? true),
    )
    .sort(compareEvents)[0];
  if (revocation) return { status: 'revoked', decision, revocation };
  const usage = summarizePermissionUsage(
    (input.executions ?? []).filter((execution) => execution.value.at <= input.now),
    decision.event.id,
  );
  if ([...usage.actionStatuses.values()].includes('unknown'))
    return { status: 'unknown', decision, usage };
  if ([...usage.actionStatuses.values()].includes('started'))
    return { status: 'executing', decision, usage };
  if (usage.uses >= grant.maxUses) return { status: 'consumed', decision, usage };
  return { status: 'granted', decision, usage };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as JsonRecord)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable action identity; callers reserve ordinals before any side effect. */
export function permissionActionId(
  scope: PermissionScope,
  requestEventId: string,
  ordinal: number,
): string {
  if (!HEX_64.test(requestEventId) || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error('invalid permission action identity');
  }
  return `pa_${bytesToHex(
    sha256(utf8ToBytes(`buzz-permission-action:v1:${requestEventId}:${ordinal}:${stable(scope)}`)),
  )}`;
}

function sameSet<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): boolean {
  return stable([...left].map(key).sort()) === stable([...right].map(key).sort());
}

/** Whether one concrete action stays wholly inside the signed request scope. */
export function permissionScopeAllows(boundary: PermissionScope, action: PermissionScope): boolean {
  if (boundary.type !== action.type) return false;
  switch (boundary.type) {
    case 'money.spend':
      return (
        action.type === 'money.spend' &&
        boundary.currency === action.currency &&
        boundary.connectorId === action.connectorId &&
        boundary.merchant === action.merchant &&
        boundary.purpose === action.purpose &&
        action.maxMinorUnits <= boundary.maxMinorUnits
      );
    case 'message.send':
      return (
        action.type === 'message.send' &&
        boundary.channel === action.channel &&
        boundary.connectorId === action.connectorId &&
        sameSet(boundary.artifacts, action.artifacts, (value) => stable(value)) &&
        sameSet(boundary.recipients, action.recipients, (value) => stable(value))
      );
    case 'content.publish':
      return (
        action.type === 'content.publish' &&
        boundary.connectorId === action.connectorId &&
        stable(boundary.destination) === stable(action.destination) &&
        sameSet(boundary.artifacts, action.artifacts, (value) => stable(value))
      );
    default:
      return stable(boundary) === stable(action);
  }
}

export interface PermissionConcreteAction {
  permissionId: string;
  requestEventId: string;
  grantEventId: string;
  ordinal: number;
  actionId: string;
  idempotencyKey: string;
  workspaceId: string;
  roomId: string;
  scope: PermissionScope;
  executor: PermissionExecutor;
  /** Exact signing identity whose receipts consume this envelope. */
  executorPubkey: string;
  charge: {
    uses: number;
    minorUnits?: number;
    currency?: string;
    reservedTokens?: number;
  };
}

export type PermissionFreshReader = {
  /** Immutable event lookup may cache only after signature verification. */
  readEvent(eventId: string): Promise<NostrEvent | undefined>;
  /** The following authority and usage methods MUST perform current reads. */
  isRegisteredAgent(pubkey: string): Promise<boolean>;
  isRoomMember(roomId: string, pubkey: string): Promise<boolean>;
  isWorkspaceMember(workspaceId: string, pubkey: string): Promise<boolean>;
  roleForRoom(roomId: string, pubkey: string): Promise<'owner' | 'admin' | 'member' | null>;
  hasDeviceCustody(pubkey: string): Promise<boolean>;
  permissionHistory(roomId: string, permissionId: string): Promise<readonly NostrEvent[]>;
};

export type PermissionVerificationResult =
  | {
      authorized: true;
      request: ParsedPermissionRequest;
      decision: ParsedPermissionDecision;
      usage: PermissionUsage;
    }
  | {
      authorized: false;
      terminal: boolean;
      reason:
        | 'authority-unavailable'
        | 'request-invalid'
        | 'requester-not-agent'
        | 'requester-not-current-member'
        | 'decision-invalid'
        | 'decision-not-winning'
        | 'signer-is-agent'
        | 'signer-not-device-held'
        | 'signer-not-current-admin'
        | 'executor-mismatch'
        | 'not-yet-valid'
        | 'expired'
        | 'denied'
        | 'revoked'
        | 'exhausted'
        | 'rate-exhausted'
        | 'budget-exhausted'
        | 'action-already-succeeded'
        | 'action-outcome-unknown'
        | 'action-mismatch';
    };

function roleSatisfies(
  role: 'owner' | 'admin' | 'member' | null,
  minimum: PermissionRole,
): boolean {
  return role === 'owner' || (minimum === 'admin' && role === 'admin');
}

type CurrentHumanAuthority =
  | { authorized: true }
  | {
      authorized: false;
      reason: 'signer-is-agent' | 'signer-not-device-held' | 'signer-not-current-admin';
    };

async function currentHumanAuthorized(
  reader: PermissionFreshReader,
  request: ParsedPermissionRequest,
  event: { event: NostrEvent },
  minimum: PermissionRole,
): Promise<CurrentHumanAuthority> {
  if (await reader.isRegisteredAgent(event.event.pubkey)) {
    return { authorized: false, reason: 'signer-is-agent' };
  }
  if (!(await reader.hasDeviceCustody(event.event.pubkey))) {
    return { authorized: false, reason: 'signer-not-device-held' };
  }
  if (
    !(await reader.isRoomMember(request.value.roomId, event.event.pubkey)) ||
    !(await reader.isWorkspaceMember(request.value.workspaceId, event.event.pubkey)) ||
    !roleSatisfies(await reader.roleForRoom(request.value.roomId, event.event.pubkey), minimum)
  ) {
    return { authorized: false, reason: 'signer-not-current-admin' };
  }
  return { authorized: true };
}

/**
 * Full fail-closed execution preflight. The reader names current-state methods
 * explicitly so callers cannot accidentally pass a transcript/cache snapshot.
 */
export async function verifyPermissionAction(input: {
  reader: PermissionFreshReader;
  action: PermissionConcreteAction;
  now: number;
}): Promise<PermissionVerificationResult> {
  try {
    const requestEvent = await input.reader.readEvent(input.action.requestEventId);
    const request = requestEvent ? parsePermissionRequest(requestEvent) : undefined;
    if (
      !request ||
      request.value.permissionId !== input.action.permissionId ||
      request.value.workspaceId !== input.action.workspaceId ||
      request.value.roomId !== input.action.roomId
    ) {
      return { authorized: false, terminal: true, reason: 'request-invalid' };
    }
    if (!(await input.reader.isRegisteredAgent(request.event.pubkey))) {
      return { authorized: false, terminal: true, reason: 'requester-not-agent' };
    }
    if (
      !(await input.reader.isRoomMember(request.value.roomId, request.event.pubkey)) ||
      !(await input.reader.isWorkspaceMember(request.value.workspaceId, request.event.pubkey))
    ) {
      return { authorized: false, terminal: true, reason: 'requester-not-current-member' };
    }
    const decisionEvent = await input.reader.readEvent(input.action.grantEventId);
    const requestedDecision = decisionEvent
      ? parsePermissionDecision(decisionEvent, request)
      : undefined;
    if (!requestedDecision || requestedDecision.value.decision !== 'grant') {
      return { authorized: false, terminal: true, reason: 'decision-invalid' };
    }
    const policy = PERMISSION_SCOPE_REGISTRY[request.value.scope.type];
    const minimumRole: PermissionRole =
      request.value.audience === 'owner' ? 'owner' : policy.minimumRole;
    if (policy.executor !== input.action.executor) {
      return { authorized: false, terminal: true, reason: 'executor-mismatch' };
    }
    const history = await input.reader.permissionHistory(
      request.value.roomId,
      request.value.permissionId,
    );
    const decisions = history.flatMap((event) => {
      const parsed = parsePermissionDecision(event, request);
      return parsed && parsed.value.decidedAt <= input.now ? [parsed] : [];
    });
    const authorizedDecisions: ParsedPermissionDecision[] = [];
    let requestedDecisionAuthority: CurrentHumanAuthority | undefined;
    for (const decision of decisions) {
      const authority = await currentHumanAuthorized(input.reader, request, decision, minimumRole);
      if (decision.event.id === requestedDecision.event.id) requestedDecisionAuthority = authority;
      if (authority.authorized) {
        authorizedDecisions.push(decision);
      }
    }
    if (requestedDecisionAuthority && !requestedDecisionAuthority.authorized) {
      return { authorized: false, terminal: true, reason: requestedDecisionAuthority.reason };
    }
    const winner = authorizedDecisions.sort(compareEvents)[0];
    if (!winner || winner.event.id !== requestedDecision.event.id) {
      return { authorized: false, terminal: true, reason: 'decision-not-winning' };
    }
    if (winner.value.decision === 'deny') {
      return { authorized: false, terminal: true, reason: 'denied' };
    }
    const grant = winner.value.grant!;
    if (input.now < grant.notBefore)
      return { authorized: false, terminal: false, reason: 'not-yet-valid' };
    if (input.now > grant.expiresAt) {
      return { authorized: false, terminal: true, reason: 'expired' };
    }
    const revocations = history.flatMap((event) => {
      const parsed = parsePermissionRevocation(event, request);
      return parsed && parsed.value.revokedAt <= input.now ? [parsed] : [];
    });
    for (const revocation of revocations) {
      if (
        revocation.value.grantEventId === winner.event.id &&
        (await currentHumanAuthorized(input.reader, request, revocation, minimumRole)).authorized
      ) {
        return { authorized: false, terminal: true, reason: 'revoked' };
      }
    }
    const executions = history.flatMap((event) => {
      const parsed = parsePermissionExecution(event, request);
      return parsed && parsed.value.at <= input.now ? [parsed] : [];
    });
    const usage = summarizePermissionUsage(
      executions.filter((execution) => execution.event.pubkey === input.action.executorPubkey),
      winner.event.id,
    );
    const existing = usage.actionStatuses.get(input.action.actionId);
    if (existing === 'succeeded') {
      return { authorized: false, terminal: true, reason: 'action-already-succeeded' };
    }
    if (existing === 'unknown' || existing === 'started') {
      return { authorized: false, terminal: true, reason: 'action-outcome-unknown' };
    }
    if (!permissionScopeAllows(request.value.scope, input.action.scope)) {
      return { authorized: false, terminal: true, reason: 'action-mismatch' };
    }
    if (
      !Number.isSafeInteger(input.action.ordinal) ||
      input.action.ordinal < 0 ||
      permissionActionId(input.action.scope, request.event.id, input.action.ordinal) !==
        input.action.actionId
    ) {
      return { authorized: false, terminal: true, reason: 'action-mismatch' };
    }
    if (!HEX_64.test(input.action.executorPubkey)) {
      return { authorized: false, terminal: true, reason: 'executor-mismatch' };
    }
    if (
      input.action.executor === 'human-device' &&
      input.action.executorPubkey !== winner.event.pubkey
    ) {
      return { authorized: false, terminal: true, reason: 'executor-mismatch' };
    }
    if (
      input.action.scope.type === 'money.spend' &&
      (input.action.charge.minorUnits !== input.action.scope.maxMinorUnits ||
        input.action.charge.currency !== input.action.scope.currency)
    ) {
      return { authorized: false, terminal: true, reason: 'action-mismatch' };
    }
    if (
      input.action.scope.type !== 'money.spend' &&
      (input.action.charge.minorUnits !== undefined || input.action.charge.currency !== undefined)
    ) {
      return { authorized: false, terminal: true, reason: 'action-mismatch' };
    }
    if (input.action.charge.uses < 1 || usage.uses + input.action.charge.uses > grant.maxUses) {
      return { authorized: false, terminal: true, reason: 'exhausted' };
    }
    const windowStart = input.now - grant.rate.windowSeconds;
    const recentUses = usage.committedAt.filter((at) => at >= windowStart).length;
    if (recentUses + input.action.charge.uses > grant.rate.maxUses) {
      return { authorized: false, terminal: false, reason: 'rate-exhausted' };
    }
    if (
      grant.budget.maxMinorUnits !== undefined &&
      (input.action.charge.currency !== grant.budget.currency ||
        usage.minorUnits + (input.action.charge.minorUnits ?? 0) > grant.budget.maxMinorUnits)
    ) {
      return { authorized: false, terminal: true, reason: 'budget-exhausted' };
    }
    if (
      grant.budget.maxReservedTokens !== undefined &&
      usage.reservedTokens + (input.action.charge.reservedTokens ?? 0) >
        grant.budget.maxReservedTokens
    ) {
      return { authorized: false, terminal: true, reason: 'budget-exhausted' };
    }
    return { authorized: true, request, decision: winner, usage };
  } catch {
    return { authorized: false, terminal: false, reason: 'authority-unavailable' };
  }
}
