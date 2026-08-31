/**
 * Shared agent-first human authority verifier.
 *
 * Factory permissions prove the signer is not a registered agent before
 * considering mutable roles, require device custody, then resolve the current
 * Room role from the same relay reader. Lookup uncertainty is fail-closed but
 * retryable.
 */
import { isRegisteredAgentIdentity } from './agent-identity.js';
import { resolveChannelRole, type ChannelRole } from './provisioning.js';
import type { RelayReader } from './relay.js';

export type HumanKeyCustody = 'device' | 'managed' | 'remote';
export type HumanAuthorityRole = 'admin' | 'owner';

export interface HumanAuthorityDependencies {
  isRegisteredAgent(pubkey: string, relay: RelayReader): Promise<boolean>;
  resolveRole(channelId: string, pubkey: string, relay: RelayReader): Promise<ChannelRole | null>;
}

export interface HumanAuthorityResult {
  authorized: boolean;
  reason: string;
  /** False for lookup uncertainty so durable workers keep retrying. */
  terminal: boolean;
}

function roleSatisfies(role: ChannelRole | null, minimumRole: HumanAuthorityRole): boolean {
  return role === 'owner' || (minimumRole === 'admin' && role === 'admin');
}

export async function authorizeHumanAuthority(
  input: {
    pubkey: string;
    relay: RelayReader;
    channelId: string;
    custody: HumanKeyCustody;
    minimumRole: HumanAuthorityRole;
    purpose: string;
    roleDescription?: string;
  },
  dependencies: HumanAuthorityDependencies = {
    isRegisteredAgent: isRegisteredAgentIdentity,
    resolveRole: resolveChannelRole,
  },
): Promise<HumanAuthorityResult> {
  let signerIsAgent: boolean;
  try {
    signerIsAgent = await dependencies.isRegisteredAgent(input.pubkey, input.relay);
  } catch (error) {
    return {
      authorized: false,
      terminal: false,
      reason: `cannot prove ${input.purpose} signer is human; agent identity lookup failed: ${String(error)}`,
    };
  }
  if (signerIsAgent) {
    return {
      authorized: false,
      terminal: true,
      reason: `${input.purpose} REFUSED: signer ${input.pubkey} is a registered agent identity; agents can never authorize ${input.purpose}`,
    };
  }
  if (input.custody !== 'device') {
    return {
      authorized: false,
      terminal: true,
      reason: `${input.purpose} REFUSED: trusted reviewer key custody must be device-held (custody=${input.custody})`,
    };
  }

  let signerRole: ChannelRole | null;
  try {
    signerRole = await dependencies.resolveRole(input.channelId, input.pubkey, input.relay);
  } catch (error) {
    return {
      authorized: false,
      terminal: false,
      reason: `cannot prove ${input.purpose} signer is a ${input.roleDescription ?? `human ${input.minimumRole}`}; role lookup failed: ${String(error)}`,
    };
  }
  if (!roleSatisfies(signerRole, input.minimumRole)) {
    return {
      authorized: false,
      terminal: true,
      reason: `${input.purpose} REFUSED: ${input.roleDescription ?? `human ${input.minimumRole}`} role required (signer role=${signerRole ?? 'none'})`,
    };
  }
  return {
    authorized: true,
    terminal: false,
    reason: `authorized device-held ${input.roleDescription ?? `human ${input.minimumRole}`}`,
  };
}
