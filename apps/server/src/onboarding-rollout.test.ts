import { afterEach, expect, it, vi } from 'vitest';
import { repositoryOnboardingEnabled } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { onboardingEnabledForViewer } from './onboarding-rollout.js';

afterEach(() => vi.unstubAllEnvs());
it('defaults OFF, including for the initial test account', () => {
  expect(repositoryOnboardingEnabled('296966200', {})).toBe(false);
  expect(repositoryOnboardingEnabled('296966200', { BEELINE_REPOSITORY_ONBOARDING:'0' })).toBe(false);
});
it('keeps the separate install-first browser preview eligibility unchanged', () => {
  const env = { BEELINE_REPOSITORY_ONBOARDING:'1' };
  expect(repositoryOnboardingEnabled('296966200',env)).toBe(true);
  for (const subject of [undefined,null,'','123','methoxine-debug']) expect(repositoryOnboardingEnabled(subject,env)).toBe(false);
  expect(repositoryOnboardingEnabled('296966200',{...env,BEELINE_REPOSITORY_ONBOARDING_GITHUB_IDS:''})).toBe(false);
});
it('R-onb-12: does not require a GitHub link or identity allowlist', async () => {
  const query=vi.fn(async()=>({rows:[]}));
  const db={query} as unknown as SqlDatabase;
  vi.stubEnv('BEELINE_REPOSITORY_ONBOARDING','0');
  expect(await onboardingEnabledForViewer(db,'viewer')).toBe(false);
  expect(query).not.toHaveBeenCalled();
  vi.stubEnv('BEELINE_REPOSITORY_ONBOARDING','1');
  expect(await onboardingEnabledForViewer(db,'viewer')).toBe(true);
});
