import { afterEach, expect, it, vi } from 'vitest';
import { onboardingCookie, onboardingCookieSubject } from './onboarding-rollout.js';

afterEach(() => vi.unstubAllEnvs());
it('requires a signed, current, allowlisted subject before an identity exists', () => {
  vi.stubEnv('BEELINE_REPOSITORY_ONBOARDING','1');
  const now = 1_000_000_000;
  const value = onboardingCookie('296966200','test-secret',now);
  expect(onboardingCookieSubject(`beeline_onboarding=${value}`,'test-secret',now)).toBe('296966200');
  expect(onboardingCookieSubject(`beeline_onboarding=${value}`,'wrong-secret',now)).toBeUndefined();
  expect(onboardingCookieSubject(`beeline_onboarding=${value}`,'test-secret',now-1)).toBeUndefined();
  expect(onboardingCookieSubject(`beeline_onboarding=${value}`,'test-secret',now+86_400_001)).toBeUndefined();
  expect(onboardingCookieSubject(`beeline_onboarding=${onboardingCookie('123','test-secret',now)}`,'test-secret',now)).toBeUndefined();
  vi.stubEnv('BEELINE_REPOSITORY_ONBOARDING','0');
  expect(onboardingCookieSubject(`beeline_onboarding=${value}`,'test-secret',now)).toBeUndefined();
});
