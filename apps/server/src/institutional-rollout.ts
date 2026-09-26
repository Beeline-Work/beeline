import type { SqlDatabase } from './database.js';

export type InstitutionalRolloutStage = 'off' | 'shadow' | 'pilot' | 'live' | 'paused';

/**
 * A Workspace with no row is not enrolled. Its stage is the only authority for
 * serving memory, so the global feature flag can never enable live memory
 * everywhere at once.
 */
export async function institutionalWorkspaceRolloutStage(
  database: SqlDatabase,
  workspaceId: string,
): Promise<InstitutionalRolloutStage | undefined> {
  return (
    await database.query<{ stage: InstitutionalRolloutStage }>(
      `SELECT stage FROM institutional_memory_workspace_rollouts WHERE workspace_id=$1`,
      [workspaceId],
    )
  ).rows[0]?.stage;
}

export function rolloutAllowsLive(stage: InstitutionalRolloutStage | undefined): boolean {
  return stage === 'pilot' || stage === 'live';
}

export function rolloutAllowsJobs(stage: InstitutionalRolloutStage | undefined): boolean {
  return stage === undefined || stage === 'shadow' || stage === 'pilot' || stage === 'live';
}
