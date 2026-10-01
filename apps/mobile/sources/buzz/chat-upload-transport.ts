import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport/buzz-rig-transport';

/** Makes staging and Send use the same phone media route, even before chat hydration. */
export async function chatUploadTransport(
  current: BuzzRigTransport | null,
  adopt: (transport: BuzzRigTransport) => void,
): Promise<BuzzRigTransport> {
  if (current) return current;
  const identity = await loadBuzzIdentity();
  if (!identity) throw new Error('Beeline identity is unavailable');
  const transport = new BuzzRigTransport(identity);
  adopt(transport);
  return transport;
}
