/**
 * Narrow host runtime for the signed permission spine.
 *
 * This module deliberately knows nothing about model prose. Producers hand it
 * a validated typed request or concrete action. Consumers get fresh
 * verification, a durable claim, and started/terminal receipts around exactly
 * one adapter invocation.
 */
import type { NostrEvent } from '@beeline/nostr';
import {
  buildPermissionExecution,
  buildPermissionRequest,
  parsePermissionExecution,
  parsePermissionRequest,
  verifyPermissionAction,
  type Identity,
  type PermissionConcreteAction,
  type PermissionExecutionStatus,
  type PermissionFreshReader,
  type PermissionRequestV1,
  type PermissionScope,
  type PermissionUsage,
  type PermissionGrantEnvelopeV1,
  type ParsedPermissionRequest,
} from '@beeline/buzz-client';

export interface PermissionDirectiveRosterEntry {
  handle: string;
  pubkey: string;
  kind: 'agent' | 'human';
}

/**
 * The first narrow prose normalizer: deterministic outcome-Room creation.
 * Anything outside this exact grammar stays inert prose. Native structured
 * calls can supply every other registry scope without widening this parser.
 */
export function parseRoomCreatePermissionDirective(input: {
  task: string;
  workspaceId: string;
  reservedRoomId: string;
  principalPubkey: string;
  roster: readonly PermissionDirectiveRosterEntry[];
}): Extract<PermissionScope, { type: 'room.create' }> | undefined {
  const match =
    /^create\s+(?:an?\s+)?(?:outcome\s+)?room\s+named\s+["“]([^"”]{1,120})["”]\s+with\s+(.+?)[.]?$/i.exec(
      input.task.trim(),
    );
  if (!match?.[1] || !match[2]) return undefined;
  const handles = match[2]
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((handle) => handle.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  if (handles.length === 0 || new Set(handles).size !== handles.length) return undefined;
  const resolved = handles.map((handle) =>
    input.roster.filter(
      (candidate) => candidate.handle.trim().replace(/^@/, '').toLowerCase() === handle,
    ),
  );
  if (resolved.some((matches) => matches.length !== 1)) return undefined;
  const entries = resolved.map((matches) => matches[0]!);
  const participantPubkeys = [
    ...new Set([
      input.principalPubkey,
      ...entries.filter((entry) => entry.kind === 'human').map((entry) => entry.pubkey),
    ]),
  ];
  const agentPubkeys = [
    ...new Set(entries.filter((entry) => entry.kind === 'agent').map((entry) => entry.pubkey)),
  ];
  if (agentPubkeys.length === 0) return undefined;
  return {
    type: 'room.create',
    workspaceId: input.workspaceId,
    roomId: input.reservedRoomId,
    name: match[1].trim(),
    visibility: 'invite-only',
    participantPubkeys,
    agentPubkeys,
  };
}

export type PermissionActionClaim = 'claimed' | 'duplicate';

export interface PermissionCapacityReservation {
  key: string;
  grantEventId: string;
  actionId: string;
  at: number;
  charge: PermissionConcreteAction['charge'];
  usage: PermissionUsage;
  grant: PermissionGrantEnvelopeV1;
}

export type PermissionCapacityResult =
  'claimed' | 'duplicate' | 'exhausted' | 'rate-exhausted' | 'budget-exhausted';

export interface PermissionRuntimeDependencies {
  identity: Identity;
  reader: PermissionFreshReader;
  publish(event: NostrEvent): Promise<void>;
  publishTerminalReceipt?(event: NostrEvent): Promise<void>;
  /** Atomic and durable across restarts. Keys include the explicit attempt. */
  claim(key: string): Promise<PermissionActionClaim>;
  /** Atomically reserve shared envelope capacity before any side effect. */
  reserveCapacity(input: PermissionCapacityReservation): Promise<PermissionCapacityResult>;
  now?: () => number;
}

export interface PermissionAdapterResult {
  /** Bounded provider/Room result code; never a credential or raw response. */
  result?: string;
}

export class PermissionKnownFailure extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'PermissionKnownFailure';
  }
}

export type PermissionExecutionOutcome =
  | { status: 'succeeded'; receipt: NostrEvent; result?: string }
  | { status: 'failed' | 'unknown'; receipt: NostrEvent; result: string }
  | {
      status: 'refused';
      terminal: boolean;
      reason: string;
      receipt?: NostrEvent;
    }
  | { status: 'duplicate' };

/**
 * Opaque continuation for an adapter whose actual side effect begins only
 * after Body returns from an ACP permission callback. The started receipt and
 * capacity reservation already exist when this handle is returned; callers
 * must close it with `complete` from the tool's terminal ACP update.
 */
export interface PermissionExecutionHandle {
  readonly request: ParsedPermissionRequest;
  readonly action: PermissionConcreteAction;
  readonly attempt: number;
  readonly attemptKey: string;
}

export type PermissionBeginOutcome =
  | { status: 'started'; receipt: NostrEvent; execution: PermissionExecutionHandle }
  | { status: 'failed'; receipt: NostrEvent; result: string }
  | {
      status: 'refused';
      terminal: boolean;
      reason: string;
      receipt?: NostrEvent;
    }
  | { status: 'duplicate' };

function boundedResult(value: unknown): string {
  const text = String(value instanceof Error ? value.message : value)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return (text || 'adapter-error').slice(0, 600);
}

export class PermissionRuntime {
  private readonly inFlight = new Set<string>();

  constructor(private readonly dependencies: PermissionRuntimeDependencies) {}

  async publishRequest(
    input: PermissionRequestV1,
    eligibleHumanPubkeys: readonly string[],
  ): Promise<NostrEvent> {
    const event = buildPermissionRequest(this.dependencies.identity, input, eligibleHumanPubkeys);
    await this.dependencies.publish(event);
    return event;
  }

  async execute(input: {
    action: PermissionConcreteAction;
    attempt: number;
    preflight?: () => Promise<void>;
    invoke: (context: {
      idempotencyKey: string;
      actionId: string;
      attempt: number;
    }) => Promise<PermissionAdapterResult>;
  }): Promise<PermissionExecutionOutcome> {
    const begun = await this.begin({
      action: input.action,
      attempt: input.attempt,
      ...(input.preflight ? { preflight: input.preflight } : {}),
    });
    if (begun.status !== 'started') return begun;

    try {
      const adapter = await input.invoke({
        idempotencyKey: input.action.idempotencyKey,
        actionId: input.action.actionId,
        attempt: input.attempt,
      });
      return this.complete({
        execution: begun.execution,
        status: 'succeeded',
        ...(adapter.result ? { result: adapter.result } : {}),
      });
    } catch (error) {
      const known = error instanceof PermissionKnownFailure;
      return this.complete({
        execution: begun.execution,
        status: known ? 'failed' : 'unknown',
        result: known ? error.code : boundedResult(error),
      });
    }
  }

  async reverify(execution: PermissionExecutionHandle): Promise<boolean> {
    const now = this.dependencies.now?.() ?? Math.floor(Date.now() / 1000);
    const reader: PermissionFreshReader = {
      ...this.dependencies.reader,
      permissionHistory: async (roomId, permissionId) =>
        (await this.dependencies.reader.permissionHistory(roomId, permissionId)).filter((event) => {
          const parsed = parsePermissionExecution(event, execution.request);
          return parsed?.value.actionId !== execution.action.actionId;
        }),
    };
    const verification = await verifyPermissionAction({
      reader,
      action: execution.action,
      now,
    });
    return (
      verification.authorized &&
      verification.request.event.id === execution.request.event.id &&
      verification.request.value.permissionId === execution.request.value.permissionId
    );
  }

  /** Reserve and publish `started` immediately before an externally-run action. */
  async begin(input: {
    action: PermissionConcreteAction;
    attempt: number;
    preflight?: () => Promise<void>;
  }): Promise<PermissionBeginOutcome> {
    const { action, attempt } = input;
    if (
      action.executorPubkey !== this.dependencies.identity.publicKey ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1
    ) {
      return { status: 'refused', terminal: true, reason: 'executor-mismatch' };
    }
    const attemptKey = `${action.grantEventId}:${action.actionId}:${attempt}`;
    if (this.inFlight.has(attemptKey)) return { status: 'duplicate' };
    this.inFlight.add(attemptKey);
    let keepInFlight = false;
    try {
      const now = this.dependencies.now?.() ?? Math.floor(Date.now() / 1000);
      const verification = await verifyPermissionAction({
        reader: this.dependencies.reader,
        action,
        now,
      });
      if (!verification.authorized) {
        const refusal = await this.publishRefusalIfPossible(
          action,
          attempt,
          verification.reason,
          verification.terminal,
        );
        return {
          status: 'refused',
          terminal: verification.terminal,
          reason: verification.reason,
          ...(refusal ? { receipt: refusal } : {}),
        };
      }

      try {
        await input.preflight?.();
      } catch (error) {
        const result = `preflight:${boundedResult(error)}`;
        const receipt = await this.publishReceipt(
          verification.request,
          action,
          attempt,
          'failed',
          result,
          false,
        );
        return { status: 'failed', receipt, result };
      }

      const capacity = await this.dependencies.reserveCapacity({
        key: attemptKey,
        grantEventId: verification.decision.event.id,
        actionId: action.actionId,
        at: now,
        charge: action.charge,
        usage: verification.usage,
        grant: verification.decision.value.grant!,
      });
      if (capacity === 'duplicate') {
        return { status: 'duplicate' };
      }
      if (capacity !== 'claimed') {
        const receipt = await this.publishRefusalIfPossible(action, attempt, capacity, true);
        return {
          status: 'refused',
          terminal: true,
          reason: capacity,
          ...(receipt ? { receipt } : {}),
        };
      }
      const receipt = await this.publishReceipt(
        verification.request,
        action,
        attempt,
        'started',
        undefined,
        true,
      );
      keepInFlight = true;
      return {
        status: 'started',
        receipt,
        execution: { request: verification.request, action, attempt, attemptKey },
      };
    } finally {
      if (!keepInFlight) this.inFlight.delete(attemptKey);
    }
  }

  /** Publish one terminal receipt for an action begun with `begin`. */
  async complete(input: {
    execution: PermissionExecutionHandle;
    status: Exclude<PermissionExecutionStatus, 'started'>;
    result?: string;
  }): Promise<PermissionExecutionOutcome> {
    const { execution, status } = input;
    if (!this.inFlight.has(execution.attemptKey)) return { status: 'duplicate' };
    const result = input.result ? boundedResult(input.result) : undefined;
    const receipt = await this.publishReceipt(
      execution.request,
      execution.action,
      execution.attempt,
      status,
      result,
      false,
    );
    // A failed relay publish leaves the execution open so its owner can retry
    // the terminal receipt instead of permanently losing the ledger outcome.
    this.inFlight.delete(execution.attemptKey);
    if (status === 'succeeded') {
      return { status, receipt, ...(result ? { result } : {}) };
    }
    return { status, receipt, result: result ?? 'adapter-error' };
  }

  private async publishRefusalIfPossible(
    action: PermissionConcreteAction,
    attempt: number,
    reason: string,
    terminal: boolean,
  ): Promise<NostrEvent | undefined> {
    if (!terminal) return undefined;
    const event = await this.dependencies.reader
      .readEvent(action.requestEventId)
      .catch(() => undefined);
    const request = event ? parsePermissionRequest(event) : undefined;
    if (!request || request.value.permissionId !== action.permissionId) return undefined;
    const key = `refusal:${action.grantEventId}:${action.actionId}:${attempt}:${reason}`;
    if ((await this.dependencies.claim(key)) === 'duplicate') return undefined;
    return this.publishReceipt(request, action, attempt, 'failed', `refused:${reason}`, false);
  }

  private async publishReceipt(
    request: NonNullable<ReturnType<typeof parsePermissionRequest>>,
    action: PermissionConcreteAction,
    attempt: number,
    status: PermissionExecutionStatus,
    result: string | undefined,
    includeCharge: boolean,
  ): Promise<NostrEvent> {
    const event = buildPermissionExecution(this.dependencies.identity, request, {
      version: 1,
      permissionId: action.permissionId,
      grantEventId: action.grantEventId,
      actionId: action.actionId,
      idempotencyKey: action.idempotencyKey,
      attempt,
      status,
      at: this.dependencies.now?.() ?? Math.floor(Date.now() / 1000),
      ...(includeCharge ? { charge: action.charge } : {}),
      ...(result ? { result } : {}),
    });
    if (status === 'started' || !this.dependencies.publishTerminalReceipt) {
      await this.dependencies.publish(event);
    } else {
      await this.dependencies.publishTerminalReceipt(event);
    }
    return event;
  }
}
