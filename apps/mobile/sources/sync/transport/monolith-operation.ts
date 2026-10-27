import { appErrorCopy } from '@/buzz/app-error-copy';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { monolithSession, MONOLITH_REQUEST_TIMEOUT_MS, MonolithRequestTimeoutError } from '@/auth/monolith-session';
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
  // Repository installation may wait for GitHub's installation propagation;
  // retain its existing longer deadline rather than cutting it to the default.
  if (name === 'actOnRepositoryCard') return { timeoutMs: options?.timeoutMs ?? 60_000, idempotent: !['install', 'organization'].includes(String((input as { action?: unknown })?.action)) };
  // Creation can rotate a user grant, mint an installation grant, then create
  // the repository: 3 sequential GitHub calls × 15s, plus local work.
  if (name === 'createGitHubRepository') return { timeoutMs: options?.timeoutMs ?? 60_000 };
  // The queue/recovery merge path can make 22 sequential GitHub calls (15s
  // each) and two bounded retry-read backoffs (90s each). Keep 30s for local
  // work. The call-count table in evidence/operation-deadlines documents it.
  if (name === 'approveCornerMerge') return { timeoutMs: options?.timeoutMs ?? 540_000 };
  const idempotent = DATABASE_READS.has(name) || repeatableWrite(name, input);
  if (!idempotent) return { timeoutMs: options?.timeoutMs ?? 20_000 };
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
  return appErrorCopy(error);
}

export async function monolithPhoneOperation<Name extends keyof PhoneOperationMap>(
  name: Name,
  input: PhoneOperationMap[Name]['input'],
  options?: { timeoutMs?: number; baseUrl?: string },
): Promise<PhoneOperationMap[Name]['output']> {
  const request = phoneOperationRequestOptions(name, input, options);
  // Bound authorization, transport and response decoding together. Native
  // transports may ignore abort, so the caller also races the deadline.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      performPhoneOperation(name, input, request, controller.signal, options?.baseUrl),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new MonolithRequestTimeoutError());
          controller.abort();
        }, request?.timeoutMs ?? 20_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function performPhoneOperation<Name extends keyof PhoneOperationMap>(
  name: Name,
  input: PhoneOperationMap[Name]['input'],
  request: ReturnType<typeof phoneOperationRequestOptions>,
  signal: AbortSignal,
  baseUrl = getBuzzRuntimeConfig().monolithUrl,
): Promise<PhoneOperationMap[Name]['output']> {
  const response = await monolithSession.fetch(
    `${baseUrl}/v1/phone/operations/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    },
    request,
  );
  if (!response.ok) {
    let code = 'request_failed';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) code = body.error;
    } catch {}
    throw new MonolithPhoneOperationError(name, response.status, code);
  }
  if (['createWorkspace', 'sendRoomMessage', 'sendRoomReply'].includes(name))
    void import('@/auth/signin-funnel').then(module => module.funnelSuccessfulOperation(name)).catch(() => undefined);
  if (response.status === 204) return undefined as PhoneOperationMap[Name]['output'];
  return (await response.json()) as PhoneOperationMap[Name]['output'];
}
