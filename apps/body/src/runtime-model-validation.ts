import type { AgentCommand } from './agent-command.js';
import type { BodyConfig } from './config.js';
import { ModelSelectionUnavailableError } from './model-config.js';
import { validateAgentModelSelection } from './model-catalog.js';
import { modelUnavailableState, type ModelUnavailableState } from './model-availability.js';

type Selection = { model?: string; effort?: string };
type LiveValidator = (
  agent: Pick<AgentCommand, 'command' | 'args'>,
  agentEnv: Record<string, string>,
  selection: Selection,
) => Promise<unknown>;

/**
 * Daemon-start gate for persisted runtime.json selections. Returning a state
 * (rather than crashing the daemon) lets Body keep machine-readable presence
 * and turn status alive while refusing every ordinary ACP activation.
 */
export async function revalidateRuntimeModelSelection(
  agent: Pick<AgentCommand, 'command' | 'args'>,
  agentEnv: Record<string, string>,
  selection: Selection,
  validate: LiveValidator = validateAgentModelSelection,
  refreshAdapter?: () => Promise<unknown>,
): Promise<ModelUnavailableState | undefined> {
  if (!selection.model && !selection.effort) return undefined;
  try {
    await validate(agent, agentEnv, selection);
    return undefined;
  } catch (error) {
    const selectedModelMissing =
      error instanceof ModelSelectionUnavailableError &&
      error.label === 'model' &&
      (error.reason === 'axis-missing' || error.reason === 'not-advertised');
    if (selectedModelMissing && refreshAdapter) {
      try {
        await refreshAdapter();
      } catch {
        // Keep the precise missing-model state. The daemon-start refresh log
        // carries the adapter installation failure without leaking it into a
        // Room-facing model diagnostic.
        return modelUnavailableState(selection, error);
      }
      try {
        await validate(agent, agentEnv, selection);
        return undefined;
      } catch (retryError) {
        return modelUnavailableState(selection, retryError);
      }
    }
    return modelUnavailableState(selection, error);
  }
}

/** Wire the startup result onto the exact BodyConfig ThinDaemonCore receives. */
export async function applyRuntimeModelPreflight(
  config: Pick<BodyConfig, 'agentEnv' | 'modelSelection' | 'modelUnavailable'>,
  agent: Pick<AgentCommand, 'command' | 'args'>,
  selection: Selection,
  validate: LiveValidator = validateAgentModelSelection,
  refreshAdapter?: () => Promise<unknown>,
): Promise<void> {
  config.modelSelection = selection;
  config.modelUnavailable = await revalidateRuntimeModelSelection(
    agent,
    config.agentEnv,
    selection,
    validate,
    refreshAdapter,
  );
}
