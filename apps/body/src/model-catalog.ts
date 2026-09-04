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
import type { AgentModelConfigOption } from './model-types.js';
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

/**
 * A catalog read needs the selected provider, not the operator's normal Goose
 * session profile. Goose loads every enabled extension from its config during
 * `session/new`; a slow or wedged stdio extension therefore used to make the
 * connect wizard hang even though no tools are needed to enumerate models.
 * `GOOSE_PATH_ROOT` is Goose's supported per-process config/data/state root,
 * so a probe gets a clean disposable profile without touching the operator's
 * config or changing any other harness.
 */
export function modelCatalogProbeEnvironment(
  agent: ModelCatalogAgent,
  agentEnv: Record<string, string>,
  scratchCwd: string,
): Record<string, string> {
  if (agent.kind !== 'goose') return agentEnv;
  return {
    ...agentEnv,
    GOOSE_PATH_ROOT: resolve(scratchCwd, 'goose'),
  };
}

/**
 * Goose's advertised `vendor/model` values are model identifiers routed by
 * the one selected provider (OpenRouter in the connect path), not evidence
 * that the operator holds a separate Anthropic/Google/etc. credential. The
 * generic credential filter is correct for Pi's multi-provider catalog but
 * made Goose reject at finish the exact model the wizard had just offered.
 */
export function filterAgentModelCatalog(
  agent: ModelCatalogAgent,
  raw: AgentModelConfigOption[],
  agentEnv: Record<string, string>,
): AgentModelConfigOption[] {
  const allowed = filterAllowedModelConfigOptions(raw);
  return agent.kind === 'goose' ? allowed : filterModelOptionsByCredentials(allowed, agentEnv);
}

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
  const probeEnv = modelCatalogProbeEnvironment(agent, agentEnv, scratchCwd);
  const client = new AcpClient({
    agentCommand: agent.command,
    agentArgs: agentArgsWithModelSelection(agent, selection),
    agentEnv: probeEnv,
    agentCwd: scratchCwd,
    // The wizard probe runs on the human's own machine for a few seconds —
    // inherit the caller's environment so harness launchers resolve (`pi`,
    // `pi-acp`, `claude-agent-acp`'s `env node`) and fnm/homebrew toolchains
    // work. Daemon sessions keep the allowlisted-env boundary; only this
    // probe opts in.
    inheritProcessEnv: true,
  });
  try {
    await client.start();
    const { sessionId, raw: sessionRaw } = await client.sessionNew({ cwd: scratchCwd });
    const raw = parseAdvertisedConfigOptions(
      sessionRaw,
      selection?.model,
      isGrokAgentCommand(agent),
    );
    const catalog = filterAgentModelCatalog(agent, raw, probeEnv);
    return await inspect({ client, sessionId, raw, catalog });
  } finally {
    await client.stop().catch(() => undefined);
    await rm(scratchCwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `raw` is the unfiltered ACP catalog retained for diagnostics; `catalog` is
 * the harness-aware safe view a human should actually be offered. Pi applies
 * #223's credential filter; Goose keeps its provider-routed model identifiers.
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
