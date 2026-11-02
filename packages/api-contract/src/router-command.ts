import type { RouterAuthorityCertificate, RouterCut } from './router-protocol.js';

/** Durable intent identity is separate from a socket's transient request id. */
export interface RouterCommandIdentity {
  readonly v: 1;
  readonly id: string;
}
export const COMMAND_DEDUP_CAPABILITY = 'commandDedupV1' as const;
/** Protocol floor token, independent of Android/iOS native runtime and DB
 * schema versions. Deployment must establish an actual ledger-preserving
 * server release floor on both machines before enabling commandDedupV1.
 * This token alone is not deployment/rollback evidence. */
export const COMMAND_DEDUP_ROLLBACK_FLOOR = 'command-ledger-v1' as const;
export const ROUTER_COMMAND_ID_MAX_LENGTH = 128;
export type RouterCommandState = 'committed' | 'pending' | 'unknown' | 'result-expired';
/** Coverage belongs only to the optional command-result convenience payload.
 * It never acknowledges other facts or advances a projection stream cursor. */
export interface RouterCommandCoverage {
  readonly scope: { readonly workspaceId: string; readonly roomId?: string };
  readonly cut: RouterCut;
  readonly authority: RouterAuthorityCertificate;
}
export interface RouterCommandReceipt<Result = unknown> {
  readonly v: 1;
  readonly operation: string;
  readonly commandId: string;
  readonly state: RouterCommandState;
  readonly result?: Result;
  readonly coverage?: RouterCommandCoverage;
}
export function parseRouterCommandIdentity(value: unknown): RouterCommandIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_command_identity');
  const identity = value as Record<string, unknown>;
  if (identity.v !== 1 || typeof identity.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(identity.id) ||
      Object.keys(identity).some(key => key !== 'v' && key !== 'id')) throw new Error('invalid_command_identity');
  return { v: 1, id: identity.id };
}
