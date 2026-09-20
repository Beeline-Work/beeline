import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

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
): Promise<PhoneOperationMap[Name]['output']> {
  const response = await monolithSession.fetch(
    `${getBuzzRuntimeConfig().monolithUrl}/v1/phone/operations/${name}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
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
