/**
 * App-issued codes authorize `npx usebeeline connect`. New codes deliberately
 * carry no product prefix; the `BUZZ-` form remains valid only so a code minted
 * before this change can be redeemed before its normal expiry.
 */
export const AGENT_PAIRING_CODE_ENTROPY_BYTES = 8;

const CURRENT_AGENT_PAIRING_CODE = /^[0-9A-F]{8}-[0-9A-F]{8}$/;
const LEGACY_AGENT_PAIRING_CODE = /^BUZZ-[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/;

export function normalizeAgentPairingCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  return isAgentPairingCode(normalized) ? normalized : undefined;
}

export function isAgentPairingCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (CURRENT_AGENT_PAIRING_CODE.test(value) || LEGACY_AGENT_PAIRING_CODE.test(value))
  );
}

export function createAgentPairingCode(entropy: Uint8Array): string {
  if (entropy.length !== AGENT_PAIRING_CODE_ENTROPY_BYTES) {
    throw new Error(`pairing code entropy must be ${AGENT_PAIRING_CODE_ENTROPY_BYTES} bytes`);
  }
  const encoded = Array.from(entropy, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `${encoded.slice(0, 8)}-${encoded.slice(8)}`;
}
