import { appErrorCopy } from '@/buzz/app-error-copy';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { MONOLITH_REQUEST_TIMEOUT_MS } from '@/auth/monolith-session';
import { sharedLiveConnection } from './live-connection';
import { PhoneSocketError } from './phone-socket-error';

/**
 * Reads Beeline answers from its own database in well under a second. They
 * get the phone's read deadline. Reads that wait on GitHub or a connector
 * are slow by nature and keep their callers' own bounds.
 */
const DATABASE_READS: ReadonlySet<string> = new Set<keyof PhoneOperationMap>([
  'countNeedsYou',
  'readNeedsYou',
  'readTray',
  'listMessageBookmarks',
  'readStarPrompt',
  'readWelcomeCards',
  'listRoomWorkflowRuns',
  'readWorkflowRun',
  'listRoomSchedules',
  'readScheduledWork',
  'listRoomSubscriptions',
  'listWorkflowDefinitions',
  'readWorkflowDefinition',
  'getManagedIdentity',
  'readIdentitySettings',
  'readAgentProfile',
  'resolveInvite',
  'getAuthCapabilities',
  'getIdentityRecovery',
  'readWebPushKey',
]);

/**
 * Writes the server answers the same however often they arrive: one keyed by
 * the id the phone chose (a corner, a message), or one that sets a state.
 * Their existing read deadline remains unchanged on the socket.
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

/** Keep each operation’s existing deadline when moving it to the socket. */
export function phoneOperationRequestOptions(
  name: string,
  input: unknown,
  options?: { timeoutMs?: number },
): { timeoutMs: number } {
  // Repository installation may wait for GitHub's installation propagation;
  // retain its existing longer deadline rather than cutting it to the default.
  if (name === 'actOnRepositoryCard') return { timeoutMs: options?.timeoutMs ?? 60_000 };
  // Creation can rotate a user grant, mint an installation grant, then create
  // the repository: 3 sequential GitHub calls × 15s, plus local work.
  if (name === 'createGitHubRepository') return { timeoutMs: options?.timeoutMs ?? 60_000 };
  // The queue/recovery merge path can make 22 sequential GitHub calls (15s
  // each) and two bounded retry-read backoffs (90s each). Keep 30s for local
  // work. The call-count table in evidence/operation-deadlines documents it.
  if (name === 'approveCornerMerge') return { timeoutMs: options?.timeoutMs ?? 540_000 };
  const readDeadline = DATABASE_READS.has(name) || repeatableWrite(name, input);
  if (!readDeadline) return { timeoutMs: options?.timeoutMs ?? 20_000 };
  return { timeoutMs: options?.timeoutMs ?? MONOLITH_REQUEST_TIMEOUT_MS };
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
  return appErrorCopy(error);
}

export async function monolithPhoneOperation<Name extends keyof PhoneOperationMap>(
  name: Name,
  input: PhoneOperationMap[Name]['input'],
  options?: { timeoutMs?: number },
): Promise<PhoneOperationMap[Name]['output']> {
  try {
    const result = await sharedLiveConnection().request(name,
      name === 'createWorkspace' ? { ...input, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : input,
      phoneOperationRequestOptions(name, input, options),
    );
    if (['createWorkspace', 'sendRoomMessage', 'sendRoomReply'].includes(name))
      void import('@/auth/signin-funnel').then(module => module.funnelSuccessfulOperation(name)).catch(() => undefined);
    return result;
  } catch (error) {
    if (error instanceof PhoneSocketError)
      throw new MonolithPhoneOperationError(name, error.status, error.message);
    throw error;
  }
}
