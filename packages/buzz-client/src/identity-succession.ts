import { OidcBindError, requestAuthJson } from './auth-json.js';
import type { Identity } from './types.js';

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

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
