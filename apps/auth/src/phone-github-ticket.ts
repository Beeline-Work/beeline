import { sha256 } from './protocol.js';
import type { AuthStore, PhoneTicketExchangeResult } from './store.js';

export interface PhoneGitHubIdentityProof {
  subject: string;
  login: string;
  name: string;
}

export type PhoneGitHubTicketVerification =
  | { status: 'verified'; identity: PhoneGitHubIdentityProof }
  | { status: 'invalid' }
  | Exclude<PhoneTicketExchangeResult, { status: 'exchanged' }>;

/** Verify and atomically consume the auth service's one-use GitHub ticket. */
export async function verifyPhoneGitHubTicket(
  store: AuthStore,
  community: string,
  ticket: string,
  now = new Date(),
): Promise<PhoneGitHubTicketVerification> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return { status: 'invalid' };
  const result = await store.consumeTicketForPhone(sha256(ticket), community, now);
  if (result.status !== 'exchanged') return result;
  const login = result.ticket.providerLogin?.trim();
  if (!login) throw new Error('GitHub ticket has no login');
  return {
    status: 'verified',
    identity: {
      subject: result.ticket.subject,
      login,
      name: result.ticket.providerDisplayName?.trim() || login,
    },
  };
}
