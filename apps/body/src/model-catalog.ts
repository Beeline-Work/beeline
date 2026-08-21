/**
 * Reads an ACP agent's own live model/effort catalog by briefly starting the
 * exact selected command and inspecting `session/new`'s advertised
 * `configOptions` — the same data `Body.applyModelConfigForSession`
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
  filterAllowedModelConfigOptions,
  filterModelOptionsByCredentials,
  parseAdvertisedConfigOptions,
} from './model-config.js';

/**
 * `raw` is the unfiltered catalog (what `unadvertisedModelSelectionValues`
 * checks against); `catalog` is the allow-list + credential filtered view
 * (#223's `filterAllowedModelConfigOptions`/`filterModelOptionsByCredentials`)
 * a human should actually be offered.
 */
export async function fetchAgentModelCatalog(
  agent: AgentCommand,
  agentEnv: Record<string, string>,
): Promise<{ raw: AgentModelConfigOption[]; catalog: AgentModelConfigOption[] }> {
  const scratchCwd = await mkdtemp(resolve(tmpdir(), 'beeline-pair-model-check-'));
  const client = new AcpClient({
    agentCommand: agent.command,
    agentArgs: agent.args,
    agentEnv,
    agentCwd: scratchCwd,
  });
  try {
    await client.start();
    const { raw: sessionRaw } = await client.sessionNew({ cwd: scratchCwd });
    const raw = parseAdvertisedConfigOptions(sessionRaw);
    const catalog = filterModelOptionsByCredentials(filterAllowedModelConfigOptions(raw), agentEnv);
    return { raw, catalog };
  } finally {
    await client.stop().catch(() => undefined);
    await rm(scratchCwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
