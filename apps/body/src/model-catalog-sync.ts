/**
 * Daemon-side model catalog publication. On each activation the daemon
 * probes its harness once (`fetchAgentModelCatalog`, the same allow-list +
 * credential filtered view the connect wizard offers) and posts the result
 * through `postAgentModelCatalog` together with the selection sessions will
 * actually use — the server's human selection when one exists, otherwise the
 * runtime record's. The phone's MODEL / EFFORT rows read that row verbatim.
 *
 * Bounded by design: one probe per activation, a hard timeout, a persisted
 * hash so an unchanged catalog is never re-posted, and every failure is one
 * logged line — never a thrown error into the Room loop.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { AgentCommand } from './agent-command.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { fetchAgentModelCatalog } from './model-catalog.js';
import type { AgentModelConfigOption } from './model-types.js';

type Input<Name extends keyof DaemonOperationMap> = DaemonOperationMap[Name]['input'];

export const MODEL_CATALOG_PROBE_TIMEOUT_MS = 30_000;
export const MODEL_CATALOG_HASH_FILE = 'model-catalog.sha256';

type Selection = { model?: string; effort?: string };
type CatalogFetcher = (
  agent: Pick<AgentCommand, 'command' | 'args'> & Partial<Pick<AgentCommand, 'kind'>>,
  agentEnv: Record<string, string>,
  selection?: Selection,
) => Promise<{ catalog: AgentModelConfigOption[] }>;

export interface ModelCatalogSyncInput {
  api: Pick<DaemonApiClient, 'execute'>;
  agent: Pick<AgentCommand, 'command' | 'args'> & Partial<Pick<AgentCommand, 'kind'>>;
  agentEnv: Record<string, string>;
  agentId: string;
  workspaceId: string;
  runtimeDir: string;
  runtimeSelection?: Selection;
  fetchCatalog?: CatalogFetcher;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export type ModelCatalogSyncResult = 'posted' | 'unchanged' | 'failed';

export function modelCatalogHash(
  options: readonly AgentModelConfigOption[],
  selection: Selection | undefined,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ options, selection: selection ?? null }))
    .digest('hex');
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
    // A probe that outlives the deadline still cleans itself up; its outcome
    // is simply no longer reported.
    work.catch(() => undefined);
  }
}

/** Probe the harness once and publish its catalog when it differs from the last post. */
export async function syncAgentModelCatalog(
  input: ModelCatalogSyncInput,
): Promise<ModelCatalogSyncResult> {
  const log = input.log ?? ((line: string) => console.log(line));
  const fetchCatalog = input.fetchCatalog ?? fetchAgentModelCatalog;
  const hashPath = resolve(input.runtimeDir, MODEL_CATALOG_HASH_FILE);
  try {
    // The server scopes this read to the authenticated agent; no Room is
    // needed and naming one the agent has left would fail the access check.
    const configuration = await input.api.execute('getAgentConfiguration', {
      agentId: input.agentId,
    } as Input<'getAgentConfiguration'>);
    const selection: Selection | undefined =
      configuration.model || configuration.effort
        ? {
            ...(configuration.model ? { model: configuration.model } : {}),
            ...(configuration.effort ? { effort: configuration.effort } : {}),
          }
        : input.runtimeSelection;
    const { catalog } = await withTimeout(
      fetchCatalog(input.agent, input.agentEnv, selection),
      input.timeoutMs ?? MODEL_CATALOG_PROBE_TIMEOUT_MS,
      'model catalog probe',
    );
    const hash = modelCatalogHash(catalog, selection);
    const previous = await readFile(hashPath, 'utf8').catch(() => '');
    if (previous.trim() === hash) return 'unchanged';
    await input.api.execute('postAgentModelCatalog', {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      // `fetchAgentModelCatalog` already applied the category allow-list.
      options: catalog as Input<'postAgentModelCatalog'>['options'],
      ...(selection ? { selection } : {}),
    });
    await writeFile(hashPath, `${hash}\n`, { mode: 0o600 });
    log(
      `[body] model catalog posted: ${catalog.length} axis(es)` +
        (selection?.model ? `, model ${selection.model}` : '') +
        (selection?.effort ? `, effort ${selection.effort}` : ''),
    );
    return 'posted';
  } catch (error) {
    log(
      `[body] model catalog not posted this activation: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }
}
