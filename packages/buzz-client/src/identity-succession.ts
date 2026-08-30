import { OidcBindError, requestAuthJson } from './auth-json.js';
import type { Identity } from './types.js';

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

/** Validated result of {@link fetchIdentityPredecessors}. */
export interface IdentitySuccessionChain {
  /** The keys that previously held this identity, oldest first. */
  predecessors: string[];
}

const IDENTITY_PREDECESSORS_TIMEOUT_MS = 5_000;

function withIdentityPredecessorTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new OidcBindError('offline', 'identity succession lookup timed out'));
    }, IDENTITY_PREDECESSORS_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Fetch this key's succession chain from the auth service: the device keys
 * that previously held the same Beeline identity (oldest first). Served only
 * to the key itself; a successor uses it to rediscover its predecessor's
 * Workspaces and migrate its own memberships after a replace.
 */
export async function fetchIdentityPredecessors(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
): Promise<string[]> {
  if (!HEX_KEY_RE.test(identity.publicKey))
    throw new OidcBindError('invalid_identity', 'invalid public key');
  const controller = new AbortController();
  const { body, status } = await withIdentityPredecessorTimeout(
    requestAuthJson(baseUrl, `/auth/oidc/predecessors/${identity.publicKey}`, {
      identity,
      signal: controller.signal,
    }),
    controller,
  );
  if (
    !Array.isArray(body.predecessors) ||
    body.predecessors.some((value) => typeof value !== 'string' || !HEX_KEY_RE.test(value))
  ) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid succession chain',
      status,
    );
  }
  return body.predecessors as string[];
}

/**
 * Resolve any historical device key to the current key of the same identity.
 *
 * Unlike {@link fetchIdentityPredecessors}, this is intentionally usable by a
 * different authenticated Workspace actor (including its paired agent): soul
 * readers need to verify that a predecessor author now names a current human
 * member, while the predecessor's private key is no longer available.
 */
export async function resolveCurrentIdentityPubkey(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  pubkey: string,
): Promise<string> {
  if (!HEX_KEY_RE.test(pubkey)) throw new OidcBindError('invalid_identity', 'invalid public key');
  const { body, status } = await requestAuthJson(baseUrl, `/auth/oidc/current/${pubkey}`, {
    identity,
  });
  if (typeof body.current_pubkey !== 'string' || !HEX_KEY_RE.test(body.current_pubkey)) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid current identity key',
      status,
    );
  }
  return body.current_pubkey;
}
