import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { monolithSession, MONOLITH_REQUEST_TIMEOUT_MS } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

/**
 * Reads Beeline answers from its own database in well under a second. They
 * get the phone's read deadline and may be repeated on a fresh connection
 * when the first attempt stalls. Reads that wait on GitHub or a connector
 * are slow by nature and keep their callers' own bounds.
 */
const DATABASE_READS: ReadonlySet<string> = new Set<keyof PhoneOperationMap>([
  'countNeedsYou',
  'readNeedsYou',
  'listMessageBookmarks',
  'readStarPrompt',
  'readWelcomeCards',
  'listRoomWorkflowRuns',
  'readWorkflowRun',
  'listRoomSchedules',
  'readRoomWebhooks',
  'listWorkflowDefinitions',
  'readWorkflowDefinition',
  'getManagedIdentity',
  'resolveInvite',
  'getAuthCapabilities',
  'getIdentityRecovery',
  'readWebPushKey',
]);

/**
 * Writes the server answers the same however often they arrive: one keyed by
 * the id the phone chose (a corner, a message), or one that sets a state.
 * A stalled one is repeated on a fresh connection before anyone sees an error.
 */
function repeatableWrite(name: string, input: unknown): boolean {
  const fields = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'createHumanCorner':
      return typeof fields.cornerId === 'string';
    case 'sendRoomMessage':
    case 'sendRoomReply':
      return typeof fields.messageId === 'string';
    case 'reopenChat':
    case 'closeChat':
    case 'updateRoomPushState':
    case 'clearNeedsYou':
    case 'setMessageBookmark':
      return true;
    default:
      return false;
  }
}

/** How one phone operation is sent: its deadline, and whether a stall may repeat it. */
export function phoneOperationRequestOptions(
  name: string,
  input: unknown,
  options?: { timeoutMs?: number },
): { timeoutMs?: number; idempotent?: boolean } | undefined {
  const idempotent = DATABASE_READS.has(name) || repeatableWrite(name, input);
  if (!idempotent) return options;
  return { timeoutMs: options?.timeoutMs ?? MONOLITH_REQUEST_TIMEOUT_MS, idempotent: true };
}

export class MonolithPhoneOperationError extends Error {
  constructor(
    readonly operation: keyof PhoneOperationMap,
    readonly status: number,
    readonly code: string,
  ) {
    super(`Monolith ${String(operation)} failed (${status}): ${code}`);
    this.name = 'MonolithPhoneOperationError';
  }
}

/**
 * The sentence to show a person when an operation was refused. The server's
 * own reason rides in `code` (`server.ts` answers `{error: <message>}`), and
 * that reason is the whole point of a refusal: a control that refuses without
 * saying why reads as a control that does nothing.
 */
export function phoneOperationFailureReason(error: unknown): string {
  if (error instanceof MonolithPhoneOperationError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

export async function monolithPhoneOperation<Name extends keyof PhoneOperationMap>(
  name: Name,
  input: PhoneOperationMap[Name]['input'],
  options?: { timeoutMs?: number },
): Promise<PhoneOperationMap[Name]['output']> {
  const request = phoneOperationRequestOptions(name, input, options);
  const response = await monolithSession.fetch(
    `${getBuzzRuntimeConfig().monolithUrl}/v1/phone/operations/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
    // Forwarded only when set: any other write keeps monolithSession.fetch's
    // own no-timeout default.
    ...(request ? [request] : []),
  );
  if (!response.ok) {
    let code = 'request_failed';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) code = body.error;
    } catch {}
    throw new MonolithPhoneOperationError(name, response.status, code);
  }
  if (response.status === 204) return undefined as PhoneOperationMap[Name]['output'];
  return (await response.json()) as PhoneOperationMap[Name]['output'];
}
