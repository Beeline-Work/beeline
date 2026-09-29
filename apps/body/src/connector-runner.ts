/**
 * Connector usage capture (Workbench PR 1).
 *
 * Every agent tool call that goes through a Squire connection is recorded and
 * batched per agent turn: one turn produces ONE `postConnectionUsage` daemon
 * operation, never one per tool call (captain decision 2026-09-14, Q6). The
 * room already shows the outcome card per use; the batched report is what the
 * server turns into the connection owner's receipt DM.
 *
 * A tool call reaches Squire through the harness's mounted MCP servers, so the
 * turn loops hand every settled tool call to `captureConnectionUsage`, which
 * recognises Squire tools by name (with or without the `<server>__` prefix the
 * harness prepends), shapes the usage record from the call's arguments and
 * result, and accumulates it on the turn's batch. The turn's final flush
 * publishes the whole batch at once and clears it; a failed publish is logged,
 * never raised — usage capture must not fail an agent turn.
 *
 * Each record also carries its event class (captain ruling 2026-09-15): the
 * server turns only approval requests (a credential read in clear, a host
 * added to a key) and vault changes made on the owner's behalf into receipt
 * DMs. Ordinary `use_credential` spending stays on the key's own Workbench
 * record and never arrives as a DM.
 */
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type {
  ConnectionUsageEventClass,
  ConnectionUsageRecord,
  ToolCallLike,
} from './connector-usage-types.js';

/** The smallest tool-call shape both turn loops already hold. */
export type { ToolCallLike };

type UsageApi = {
  execute<Name extends keyof DaemonOperationMap>(
    name: Name,
    input: DaemonOperationMap[Name]['input'],
  ): Promise<DaemonOperationMap[Name]['output']>;
};

export type ConnectionTurn = {
  readonly requestId: string;
  readonly agentId: string;
  readonly roomId?: string;
  readonly cornerId?: string;
};

function toolName(call: ToolCallLike): string {
  const raw = `${call.title ?? ''} ${call.kind ?? ''}`;
  const match = raw.match(
    /(?:^|__|\b)(use_credential|fetch_credential|grant_app_access|revoke_app_access)\b/,
  );
  return match?.[1] ?? '';
}

/**
 * The event class each Squire verb means to the key's owner. Ordinary
 * `use_credential` spending carries no class: it is recorded, never DM'd.
 */
const SQUIRE_EVENT_CLASS: Readonly<Record<string, ConnectionUsageEventClass>> = {
  fetch_credential: 'approval', // the credential was read in clear
  grant_app_access: 'approval', // a host was added to a key
  revoke_app_access: 'vault-change', // access removed on the owner's behalf
};

function record(call: unknown): Record<string, unknown> {
  return call && typeof call === 'object' ? (call as Record<string, unknown>) : {};
}

function serializedSize(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * Shape one Squire tool call into a usage record, or undefined when the call
 * is not a Squire connection call.
 */
export function squireUsageFromToolCall(call: ToolCallLike): ConnectionUsageRecord | undefined {
  const tool = toolName(call);
  if (!tool) return undefined;
  const args = record(call.rawInput);
  const result = record(call.content ?? call.rawOutput);
  const resultPayload = record(result.content ?? result);
  const url = typeof args.url === 'string' ? args.url : '';
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : tool;
  const operation = url ? `${method} ${url}` : `${method} ${String(args.reference ?? '')}`.trim();
  const statusCode =
    typeof resultPayload.status === 'number'
      ? resultPayload.status
      : /failed|error|denied/i.test(call.status ?? '')
        ? 0
        : 200;
  return {
    ref: String(args.reference ?? args.service ?? ''),
    service: typeof args.service === 'string' ? args.service : null,
    operation: operation.slice(0, 300),
    statusCode,
    bytes: serializedSize(resultPayload.body ?? resultPayload),
    ...(typeof args.grant_id === 'string' ? { grantId: args.grant_id } : {}),
    ...(SQUIRE_EVENT_CLASS[tool] ? { eventClass: SQUIRE_EVENT_CLASS[tool] } : {}),
  };
}

/**
 * Per-turn usage batches. One turn, one batch, one publish — a turn that
 * calls three connections three times still posts exactly one
 * `postConnectionUsage` when its final tool flush runs.
 */
export class ConnectorUsageRecorder {
  private readonly batches = new Map<string, ConnectionUsageRecord[]>();
  private readonly turns = new Map<string, ConnectionTurn>();

  record(turn: ConnectionTurn, usage: ConnectionUsageRecord): void {
    if (!usage.ref) return;
    const existing = this.batches.get(turn.requestId) ?? [];
    existing.push(usage);
    this.batches.set(turn.requestId, existing);
    if (!this.turns.has(turn.requestId)) this.turns.set(turn.requestId, turn);
  }

  /** Everything recorded for this turn so far; used by tests and diagnostics. */
  pending(requestId: string): readonly ConnectionUsageRecord[] {
    return this.batches.get(requestId) ?? [];
  }

  /**
   * Publish the turn's whole batch as ONE operation call and clear it.
   * Returns the published record count (0 when nothing was recorded or the
   * publish failed — a failed usage report never fails the agent turn).
   */
  async flush(api: UsageApi, requestId: string): Promise<number> {
    const usage = this.batches.get(requestId);
    const turn = this.turns.get(requestId);
    if (!usage?.length || !turn) return 0;
    this.batches.delete(requestId);
    this.turns.delete(requestId);
    try {
      await api.execute('postConnectionUsage', {
        requestId: turn.requestId,
        agentId: turn.agentId,
        ...(turn.roomId ? { roomId: turn.roomId } : {}),
        ...(turn.cornerId ? { cornerId: turn.cornerId } : {}),
        usage,
      });
      return usage.length;
    } catch (error) {
      console.error('[connector] connection usage report failed:', error);
      return 0;
    }
  }
}

/**
 * Turn-loop seam: recognise Squire tool calls among the settled calls and
 * record their usage on the turn's batch. Cheap and side-effect free when
 * nothing is a Squire call.
 */
export function captureConnectionUsage(
  recorder: ConnectorUsageRecorder,
  turn: ConnectionTurn,
  calls: readonly ToolCallLike[],
): void {
  for (const call of calls) {
    const usage = squireUsageFromToolCall(call);
    if (usage) recorder.record(turn, usage);
  }
}
