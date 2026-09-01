import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { resolve } from 'node:path';
import {
  readRuntimeRecord,
  runtimeDirectory,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
} from './runtime.js';

type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];
type Output<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['output'];

export type DaemonFetch = typeof fetch;

export class DaemonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DaemonApiError';
  }
}

function endpoint(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

async function responseError(response: Response): Promise<DaemonApiError> {
  let code = 'request_failed';
  try {
    const value = (await response.json()) as { error?: unknown };
    if (typeof value.error === 'string' && value.error) code = value.error;
  } catch {
    // Bodies are deliberately not reflected: they can contain operator data.
  }
  return new DaemonApiError(
    `monolith daemon request failed (${response.status}: ${code})`,
    response.status,
    response.status === 408 || response.status === 429 || response.status >= 500,
  );
}

/** Typed client for the complete named daemon operation contract. */
export class DaemonApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly daemonToken: string,
    readonly agentId: string,
    private readonly fetchImpl: DaemonFetch = fetch,
  ) {}

  async execute<Name extends keyof DaemonOperationMap>(
    name: Name,
    input: Input<Name>,
  ): Promise<Output<Name>> {
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.agentId === 'string' && candidate.agentId !== this.agentId) {
      throw new Error('daemon operation agentId does not match the runtime identity');
    }
    const response = await this.fetchImpl(
      endpoint(this.baseUrl, `/v1/daemon/operations/${String(name)}`),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.daemonToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as Output<Name>;
  }
}

export interface ActivatedDaemonTransport {
  runtime: AgentRuntimeRecord;
  client: DaemonApiClient;
}

/**
 * Promote a staged one-use exchange token and persist the opaque daemon token
 * before any daemon operation runs. Re-entry with an already-promoted record
 * performs no exchange and is safe across daemon restarts.
 */
export async function activateDaemonTransport(
  path: string,
  fetchImpl: DaemonFetch = fetch,
): Promise<ActivatedDaemonTransport | undefined> {
  const runtime = await readRuntimeRecord(path);
  const expectedPath = resolve(
    runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey),
    'runtime.json',
  );
  if (resolve(path) !== expectedPath) {
    throw new Error(`refusing daemon token exchange outside canonical runtime path: ${path}`);
  }
  const transport = runtime.transport;
  if (!transport) return undefined;
  if ('daemonToken' in transport && transport.daemonToken) {
    return {
      runtime,
      client: new DaemonApiClient(
        transport.baseUrl,
        transport.daemonToken,
        runtime.agent.publicKey,
        fetchImpl,
      ),
    };
  }

  const response = await fetchImpl(endpoint(transport.baseUrl, '/v1/auth/daemon/exchange'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exchangeToken: transport.exchangeToken }),
  });
  if (!response.ok) throw await responseError(response);
  const result = (await response.json()) as { daemonToken?: unknown; agentId?: unknown };
  if (
    typeof result.daemonToken !== 'string' ||
    !/^bdt_[A-Za-z0-9_-]{43}$/.test(result.daemonToken) ||
    result.agentId !== runtime.agent.publicKey
  ) {
    throw new Error('daemon token exchange returned an invalid runtime identity');
  }
  const promoted: AgentRuntimeRecord = {
    ...runtime,
    transport: {
      kind: 'monolith',
      baseUrl: transport.baseUrl,
      daemonToken: result.daemonToken,
    },
  };
  await writeRuntimeRecord(promoted);
  return {
    runtime: promoted,
    client: new DaemonApiClient(
      transport.baseUrl,
      result.daemonToken,
      runtime.agent.publicKey,
      fetchImpl,
    ),
  };
}
