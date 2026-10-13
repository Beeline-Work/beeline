import { nip98AuthHeader } from '@beeline/nostr';
import { DaemonApiError } from './daemon-api-client.js';
import {
  DEFAULT_DAEMON_MONOLITH_BASE_URL,
  readRuntimeRecord,
  runtimeIdentity,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
} from './runtime.js';

/** Possession proves identity; the server's current membership and owner grant prove authority. */
export async function migrateLegacyDaemonTransport(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentRuntimeRecord> {
  const runtime = await readRuntimeRecord(path);
  if (runtime.transport) return runtime;
  const baseUrl = process.env.BEELINE_MONOLITH_BASE_URL?.trim() || DEFAULT_DAEMON_MONOLITH_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, '')}/v1/auth/daemon/migrate-legacy`;
  const identity = runtimeIdentity(runtime.agent);
  const response = await fetchImpl(url, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST'),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workspaceId: runtime.communityId, pairedBy: runtime.pairedBy }),
  });
  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 404;
    throw new DaemonApiError(
      `legacy agent ${identity.publicKey} ${retryable ? 'migration unavailable; retrying' : 'needs reconnect'} (HTTP ${response.status})`,
      response.status,
      retryable,
      'legacy_reconnect_required',
    );
  }
  const result = (await response.json()) as { exchangeToken?: string; agentId?: string };
  if (
    result.agentId !== identity.publicKey ||
    !/^bde_[A-Za-z0-9_-]{43}$/.test(result.exchangeToken ?? '')
  )
    throw new Error('legacy migration returned an invalid identity');
  const migrated: AgentRuntimeRecord = {
    ...runtime,
    transport: { kind: 'monolith', baseUrl, exchangeToken: result.exchangeToken! },
  };
  await writeRuntimeRecord(migrated);
  return migrated;
}
