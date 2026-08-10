/**
 * A named keypair used in the proof. Three identities compose the gate:
 *   - worker   — repo owner (signs kind:30617); holds the ONLY key that can
 *                push `main`. The merge worker runs as this identity.
 *   - reviewer — the human approver. The worker trusts ONLY this pubkey's
 *                signed approvals. (In the product this key lives on the phone.)
 *   - agent    — a channel Member. Can push feature branches; the relay's
 *                branch protection physically blocks it from pushing `main`.
 */
import { generateKeypair, type Keypair } from '@beeline/nostr';

export interface Identity extends Keypair {
  name: string;
}

export function newIdentity(name: string): Identity {
  return { name, ...generateKeypair() };
}
