import { GOOGLE_TOOL_SCOPES } from '@beeline/api-contract/workbench';
import { createHash } from 'node:crypto';
import type { DaemonApiClient } from './daemon-api-client.js';

/** Resolve at session creation, so an already-running Room sees a new connection
 * on its next turn. The server renews an expired grant before returning it. */
export async function roomGoogleToolTokens(
  api: DaemonApiClient,
  roomId: string,
): Promise<{ drive?: string; youtube?: string }> {
  try {
    // An optional connector must not hold up Room activation on a slow
    // server-side Google refresh.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const grant = await Promise.race([
      api.execute('getRoomGoogleGrant', { roomId }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Google grant lookup timed out')), 3_000);
      }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); });
    if (grant.status !== 'ready' || !grant.credentials) return {};
    const { accessToken, scopes } = grant.credentials;
    const types = grant.connectedTypes ?? [];
    const hasScopes = (type: keyof typeof GOOGLE_TOOL_SCOPES) =>
      GOOGLE_TOOL_SCOPES[type].every((scope) => scopes.includes(scope));
    return {
      ...((types.includes('google-gmail') || types.includes('google-drive')) && hasScopes('google-drive')
        ? { drive: accessToken } : {}),
      ...(types.includes('google-youtube') && hasScopes('google-youtube')
        ? { youtube: accessToken } : {}),
    };
  } catch {
    // Google is optional to every Room turn. A transient grant-read failure
    // cannot stall the agent's ordinary work.
    return {};
  }
}

export function roomGoogleToolFingerprint(tokens: { drive?: string; youtube?: string }): string[] {
  return Object.entries(tokens).map(([name, token]) =>
    `google-${name}:${createHash('sha256').update(token).digest('hex')}`);
}
