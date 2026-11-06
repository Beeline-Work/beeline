import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, type TokenAuth } from "./auth.js";
import { PHONE_READ_OPERATIONS } from "@beeline/api-contract/phone";
import { ServerOptions, json } from './server.js';




export const phoneFamilies = new WeakMap<IncomingMessage, string>();



/** Identity plus the sign-in family, when this auth implementation can name one. */
export async function readPhoneSession(
  auth: {
    authenticatePhone(token: string): Promise<string | null>;
    authenticatePhoneSession?(token: string): Promise<{ identityId: string; familyId: string } | null>;
  },
  token: string,
): Promise<{ identityId: string; familyId: string | null } | null> {
  if (typeof auth.authenticatePhoneSession === 'function') {
    const session = await auth.authenticatePhoneSession(token);
    return session ? { identityId: session.identityId, familyId: session.familyId } : null;
  }
  const identityId = await auth.authenticatePhone(token);
  return identityId ? { identityId, familyId: null } : null;
}



export async function phoneIdentity(
  request: IncomingMessage,
  options: ServerOptions,
): Promise<string | null> {
  const value = bearer(request.headers.authorization);
  // Family is recorded beside the identity lookup. The identity return stays the
  // access-token query System messages already follow.
  if (value) await rememberPhoneFamily(request, options.auth, value);
  return value ? options.auth.authenticatePhone(value) : null;
}



export async function rememberPhoneFamily(
  request: IncomingMessage,
  auth: TokenAuth,
  token: string,
): Promise<void> {
  if (typeof auth.authenticatePhoneSession !== 'function') return;
  const session = await auth.authenticatePhoneSession(token);
  if (session?.familyId) phoneFamilies.set(request, session.familyId);
}



export async function daemonIdentity(
  request: IncomingMessage,
  options: ServerOptions,
): Promise<string | null> {
  const value = bearer(request.headers.authorization);
  return value ? options.auth.authenticateDaemon(value) : null;
}


/**
 * Why a daemon request was refused, in the only two shapes a helper may act
 * on. `agent_removed` is a settled fact — the token is revoked and its agent
 * holds no membership anywhere — and is what lets the helper stop itself.
 * Everything else stays the ordinary 401 it retries against.
 */
export async function refuseDaemon(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  const value = bearer(request.headers.authorization);
  const retired = value ? await options.auth.retiredDaemonAgent(value) : null;
  if (retired) json(response, 403, { error: 'agent_removed' });
  else json(response, 401, { error: 'daemon_token_required' });
}



// Non-phone consumers: apps/server/scripts/verify-fly-cutover.mjs, infra/free-agent/*.mjs,
// and apps/mobile/evidence/corner-list-live/proof-kit/control.mts. Keep this closed list.
export const NON_PHONE_HTTP_WRITES = ['createWorkspace', 'deleteWorkspace', 'sendRoomMessage', 'requestCornerClose'] as const;


export type PhoneHttpOperation = (name: (typeof PHONE_READ_OPERATIONS)[number] | (typeof NON_PHONE_HTTP_WRITES)[number], input: Record<string, unknown>,
  viewerId: string, familyId?: string) => Promise<unknown>;
