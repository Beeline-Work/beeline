/** Strict signed permission event codecs and builders. */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { KIND_STREAM_MESSAGE } from './kinds.js';
import type { Identity } from './types.js';
import {
  CURRENCY,
  HEX_64,
  MAX_PERMISSION_CONTENT_CHARS,
  MAX_PERMISSION_NOTE_CHARS,
  MAX_PERMISSION_REASON_CHARS,
  MAX_PERMISSION_SUMMARY_CHARS,
  MAX_PERMISSION_USES,
  MAX_PERMISSION_RATE_WINDOW_SECONDS,
  PERMISSION_DECISION_MARKER,
  PERMISSION_EXECUTION_MARKER,
  PERMISSION_PROTOCOL_VERSION,
  PERMISSION_REQUEST_MARKER,
  PERMISSION_REVOCATION_MARKER,
  PERMISSION_SCOPE_REGISTRY,
  integer,
  nonEmpty,
  object,
  parsePermissionScope,
  protocolId,
  pubkey,
  token,
  uniqueStrings,
  type ParsedPermissionDecision,
  type ParsedPermissionEvent,
  type ParsedPermissionExecution,
  type ParsedPermissionRequest,
  type ParsedPermissionRevocation,
  type PermissionDecisionV1,
  type PermissionAudience,
  type PermissionExecutionStatus,
  type PermissionExecutionV1,
  type PermissionGrantEnvelopeV1,
  type PermissionRequestV1,
  type PermissionRevocationV1,
  type PermissionScope,
} from './permission-scope.js';

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
  if (
    scope.type === 'mission.control' &&
    (maxReservedTokens === undefined ||
      maxReservedTokens >
        scope.targetAllocations.reduce(
          (sum, allocation) => sum + allocation.maxTotalReservedTokens,
          0,
        ))
  ) {
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
      ...(scope.type === 'mission.control'
        ? {
            maxReservedTokens: scope.targetAllocations.reduce(
              (sum, allocation) => sum + allocation.maxTotalReservedTokens,
              0,
            ),
          }
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
    (provenance.scheduleRunId !== undefined && !scheduleRunId) ||
    requestedAt === undefined ||
    requestExpiresAt === undefined ||
    requestExpiresAt <= requestedAt ||
    (scope.type === 'room.create' && scope.workspaceId !== workspaceId) ||
    (scope.type === 'mission.control' &&
      (scope.workspaceId !== workspaceId || scope.roomId !== roomId))
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
