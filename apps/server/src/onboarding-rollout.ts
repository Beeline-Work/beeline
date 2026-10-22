import type { SqlDatabase } from './database.js';

export async function onboardingEnabledForViewer(_database: SqlDatabase, _viewerId: string): Promise<boolean> {
  return process.env.BEELINE_REPOSITORY_ONBOARDING === '1';
}
