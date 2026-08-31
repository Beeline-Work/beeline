/**
 * Reads an ACP agent's own live model/effort catalog by briefly starting the
 * exact selected command and inspecting `session/new`'s advertised
 * `configOptions` or standard `models` state — the same data `Body.applyModelConfigForSession`
 * (`body.ts`) captures on every real session. Used both to validate
 * `--model`/`--effort` against reality (`cli.ts`'s `validateModelSelection`)
 * and to drive the interactive picker (`agent-settings-prompts.ts`), so a
 * flag and a picker pick can never disagree about what's valid.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AgentModelConfigOption } from '@beeline/buzz-client';
import { AcpClient } from './acp.js';
import type { AgentCommand } from './agent-command.js';
import {
  applyAgentModelSelection,
  agentArgsWithModelSelection,
  filterAllowedModelConfigOptions,
  filterModelOptionsByCredentials,
  isGrokAgentCommand,
  parseAdvertisedConfigOptions,
} from './model-config.js';

type ModelCatalogAgent = Pick<AgentCommand, 'command' | 'args'> &
  Partial<Pick<AgentCommand, 'kind'>>;

async function withAgentModelCatalog<T>(
  agent: ModelCatalogAgent,
  agentEnv: Record<string, string>,
  selection: { model?: string; effort?: string } | undefined,
  inspect: (input: {
    client: AcpClient;
    sessionId: string;
    raw: AgentModelConfigOption[];
    catalog: AgentModelConfigOption[];
  }) => Promise<T>,
): Promise<T> {
  const scratchCwd = await mkdtemp(resolve(tmpdir(), 'beeline-pair-model-check-'));
  const client = new AcpClient({
    agentCommand: agent.command,
    agentArgs: agentArgsWithModelSelection(agent, selection),
    agentEnv,
    agentCwd: scratchCwd,
  });
  try {
    await client.start();
    const { sessionId, raw: sessionRaw } = await client.sessionNew({ cwd: scratchCwd });
    const raw = parseAdvertisedConfigOptions(
      sessionRaw,
      selection?.model,
      isGrokAgentCommand(agent),
    );
    const catalog = filterModelOptionsByCredentials(filterAllowedModelConfigOptions(raw), agentEnv);
    return await inspect({ client, sessionId, raw, catalog });
  } finally {
    await client.stop().catch(() => undefined);
    await rm(scratchCwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `raw` is the unfiltered ACP catalog retained for diagnostics; `catalog` is
 * the allow-list + credential filtered view
 * (#223's `filterAllowedModelConfigOptions`/`filterModelOptionsByCredentials`)
 * a human should actually be offered.
 */
export async function fetchAgentModelCatalog(
  agent: ModelCatalogAgent,
  agentEnv: Record<string, string>,
  selection?: { model?: string; effort?: string },
): Promise<{ raw: AgentModelConfigOption[]; catalog: AgentModelConfigOption[] }> {
  return withAgentModelCatalog(agent, agentEnv, selection, async ({ raw, catalog }) => ({
    raw,
    catalog,
  }));
}

/**
 * Validate and exercise a selection against one live ACP session. Exact
 * catalog membership rejects unknown identifiers before the setter is called;
 * the setter then gets the final word on entries a provider has retired while
 * still advertising them, preserving its recovery guidance in the thrown
 * `ModelSelectionUnavailableError`.
 */
export async function validateAgentModelSelection(
  agent: ModelCatalogAgent,
  agentEnv: Record<string, string>,
  selection: { model?: string; effort?: string },
): Promise<{ raw: AgentModelConfigOption[]; catalog: AgentModelConfigOption[] }> {
  return withAgentModelCatalog(
    agent,
    agentEnv,
    selection,
    async ({ client, sessionId, raw, catalog }) => {
      await applyAgentModelSelection(client, sessionId, catalog, selection);
      return { raw, catalog };
    },
  );
}
