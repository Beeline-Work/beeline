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
  return (await response.json()) as PhoneOperationMap[Name]['output'];
}
