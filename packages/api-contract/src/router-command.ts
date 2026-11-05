
/** Durable intent identity is separate from a socket's transient request id. */
export interface RouterCommandIdentity {
  readonly v: 1;
  readonly id: string;
}
/** Bounded identity, independent of native runtime and database schema versions. */
const ROUTER_COMMAND_ID_MAX_LENGTH = 128;
export type RouterCommandState = 'committed' | 'pending' | 'unknown' | 'result-expired';
export interface RouterCommandReceipt<Result = unknown> {
  readonly v: 1;
  readonly operation: string;
  readonly commandId: string;
  readonly state: RouterCommandState;
  readonly result?: Result;
}
export function parseRouterCommandIdentity(value: unknown): RouterCommandIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_command_identity');
  const identity = value as Record<string, unknown>;
  if (identity.v !== 1 || typeof identity.id !== 'string' ||
      identity.id.length > ROUTER_COMMAND_ID_MAX_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(identity.id) ||
      Object.keys(identity).some(key => key !== 'v' && key !== 'id')) throw new Error('invalid_command_identity');
  return { v: 1, id: identity.id };
}
