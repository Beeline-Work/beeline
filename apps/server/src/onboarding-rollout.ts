import { repositoryOnboardingEnabled } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';

export async function onboardingEnabledForViewer(database: SqlDatabase, viewerId: string): Promise<boolean> {
  if (process.env.BEELINE_REPOSITORY_ONBOARDING !== '1') return false;
  const row = (await database.query<{ subject: string | null }>(
    `SELECT COALESCE(i.github_subject,(SELECT l.subject FROM identity_external_links l
     WHERE l.identity_id=i.id AND l.provider='github' LIMIT 1)) subject FROM identities i WHERE i.id=$1`,
    [viewerId],
  )).rows[0];
  return (process.env.BEELINE_REPOSITORY_ONBOARDING_IDENTITY_IDS ?? '').split(',').map(id => id.trim()).includes(viewerId) || repositoryOnboardingEnabled(row?.subject, process.env);
}
