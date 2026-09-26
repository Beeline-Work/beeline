import type { SqlDatabase } from './database.js';

export type InstitutionalRolloutStage = 'off' | 'shadow' | 'pilot' | 'live' | 'paused';

/**
 * An absent row preserves the global feature-flag behavior used by phases 0-3.
 * Once a Workspace is enrolled, its stage becomes the narrower authority.
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
  return stage === undefined || stage === 'pilot' || stage === 'live';
}

export function rolloutAllowsJobs(stage: InstitutionalRolloutStage | undefined): boolean {
  return stage === undefined || stage === 'shadow' || stage === 'pilot' || stage === 'live';
}
