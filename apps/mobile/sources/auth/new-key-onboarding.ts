/**
 * "Create a new key" onboarding — the third way onto a device, alongside
 * Google-first bind and pasting an existing nsec.
 *
 * The rule this module exists to hold: a key created here is **not persisted**
 * until the person has actually put it in front of themselves and said so. A
 * device-held Nostr key has no server-side recovery — an unbacked one that is
 * silently written to SecureStore is an identity the person can lose to a wiped
 * phone with nothing to restore from. So the draft is generated in memory
 * (`persist: false`, the same deferral the Google bind path uses), and only
 * `canEnterWithNewKey` opens the door.
 *
 * Two independent facts gate it, both required:
 *   - `seen`    — the nsec was actually revealed or copied at least once.
 *                 A checkbox on top of a still-masked key confirms nothing.
 *   - `confirmed` — the explicit "I saved my key" acknowledgement.
 */
import { identityNpub, identityNsec, type Identity } from '@beeline/buzz-client';

import { generateBuzzIdentity } from './buzz-identity-storage';

export interface NewKeyDraft {
  /** In-memory only. Persisted by the caller once the backup gate opens. */
  identity: Identity;
  npub: string;
  nsec: string;
}

export interface NewKeyBackupState {
  /** The secret has been revealed or copied at least once on this screen. */
  seen: boolean;
  /** The explicit "I saved my key" acknowledgement. */
  confirmed: boolean;
}

/**
 * Generate a fresh device key WITHOUT writing it to storage. The caller
 * persists it only after `canEnterWithNewKey` returns true.
 */
export async function createNewKeyDraft(name = 'buzzy-mobile'): Promise<NewKeyDraft> {
  const identity = await generateBuzzIdentity(name, { persist: false });
  return { identity, npub: identityNpub(identity), nsec: identityNsec(identity) };
}

/** `nsec1…` prefix plus dots. Never derive the dot count from the real length. */
export function maskNsec(nsec: string): string {
  if (!nsec) return '';
  return `${nsec.slice(0, 5)}${'•'.repeat(32)}`;
}

/**
 * The acknowledgement is inert until the key has actually been shown or copied,
 * so the checkbox can never be a reflex tap over a masked string.
 */
export function canConfirmNewKeyBackup(state: Pick<NewKeyBackupState, 'seen'>): boolean {
  return state.seen;
}

/** The one gate into the app on this path. */
export function canEnterWithNewKey(state: NewKeyBackupState): boolean {
  return state.seen && state.confirmed;
}
