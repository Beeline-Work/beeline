/**
 * Small shared shapes for the connector usage capture. Kept separate from
 * `connector-runner.ts` so tests and turn loops can import the types without
 * pulling in the implementation.
 */
import type {
  ConnectionUsageEventClass,
  ConnectionUsageRecord,
} from '@beeline/api-contract/daemon';

export type { ConnectionUsageEventClass, ConnectionUsageRecord };

/** The subset of the ACP `ToolCallEntry` the usage capture reads. */
export type ToolCallLike = {
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly content?: unknown;
  readonly rawOutput?: unknown;
};
