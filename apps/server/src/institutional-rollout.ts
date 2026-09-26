import type { SqlDatabase } from './database.js';

export type InstitutionalRolloutStage = 'off' | 'shadow' | 'pilot' | 'live' | 'paused';

/**
 * Institutional memory is ON by default: a Workspace with no rollout row is
 * live, and only an explicit `off`/`paused` stage withholds it. The staged
 * `shadow`/`pilot` values remain readable (an operator can still narrow a
 * single Workspace) but nothing starts there; the release migration advances
 * existing rows to `live`.
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

/** A missing row is the default: live. Only `off`/`paused` withhold serving. */
export function rolloutAllowsLive(stage: InstitutionalRolloutStage | undefined): boolean {
  return stage === undefined || stage === 'pilot' || stage === 'live';
}

/** A missing row is the default: live. Only `off`/`paused` withhold host jobs. */
export function rolloutAllowsJobs(stage: InstitutionalRolloutStage | undefined): boolean {
  return (
    stage === undefined || stage === 'shadow' || stage === 'pilot' || stage === 'live'
  );
}
