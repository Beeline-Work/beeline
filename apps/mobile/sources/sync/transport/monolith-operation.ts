import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

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
  if (!response.ok) throw new Error(`Monolith ${String(name)} failed (${response.status})`);
  if (response.status === 204) return undefined as PhoneOperationMap[Name]['output'];
  return (await response.json()) as PhoneOperationMap[Name]['output'];
}
