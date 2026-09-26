import type { SqlDatabase } from './database.js';

export type InstitutionalRolloutStage = 'off' | 'shadow' | 'pilot' | 'live' | 'paused';

/**
 * A Workspace with no row is not enrolled. Its stage is the only authority for
 * both serving memory and running host jobs, so the global feature flag can
 * neither enable live memory everywhere at once nor spend host model sessions
 * on a Workspace no turn can read memory from.
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
  return stage === 'shadow' || stage === 'pilot' || stage === 'live';
}
