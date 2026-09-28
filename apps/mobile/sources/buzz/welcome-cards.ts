import type { WelcomeCardsView } from '@beeline/api-contract/phone';
import { monolithSession } from '@/auth/monolith-session';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

async function request(
  name: 'readWelcomeCards' | 'completeWelcomeCards',
): Promise<WelcomeCardsView> {
  const response = await monolithSession.fetch(
    `${getBuzzRuntimeConfig().monolithUrl}/v1/phone/operations/${name}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  if (!response.ok) throw new Error(`Welcome cards ${name} failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || typeof (value as WelcomeCardsView).due !== 'boolean')
    throw new Error('Invalid welcome cards response');
  return value as WelcomeCardsView;
}

export const readWelcomeCards = () => request('readWelcomeCards');
export const completeWelcomeCards = () => request('completeWelcomeCards');
