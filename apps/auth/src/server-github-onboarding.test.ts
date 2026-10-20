import { onboardingCookie } from './onboarding-rollout.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alphaTenant, app, startCookie, state as fixture, useAuthServerFixture } from './server-test-fixture.js';

describe('install-first native GitHub onboarding', () => {
  useAuthServerFixture();
  beforeEach(() => {
    vi.stubEnv('BEELINE_REPOSITORY_ONBOARDING', '1');
    vi.stubEnv('BEELINE_REPOSITORY_ONBOARDING_GITHUB_IDS', '123');
  });
  afterEach(() => vi.unstubAllEnvs());
  const cookie = () => `beeline_onboarding=${onboardingCookie('123', 'github-secret', Date.now())}`;
  it('starts installation, accepts its OAuth callback with browser binding, and issues the native ticket', async () => {
    fixture.githubUserInstallations = [77];
    const start = await app.inject({ method:'GET', headers:{ host:alphaTenant.host, cookie:cookie() },
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'a'.repeat(43)}` });
    const installation = new URL(start.headers.location!);
    expect(installation.pathname).toBe('/apps/beeline/installations/new');
    const state = installation.searchParams.get('state');
    expect(state).toMatch(/^onboarding_/);
    const callback = await app.inject({ method:'GET', headers:{ host:alphaTenant.host, cookie:startCookie(start.headers['set-cookie']) },
      url:`/auth/github/callback?state=${state}&code=github-code&installation_id=77&setup_action=install` });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('beeline://beeline/github-callback');
    expect(callback.headers.location).toContain('ticket=');
  });
  it('refuses a supplied installation id when the user token cannot prove personal All repositories access', async () => {
    fixture.githubUserInstallations = [];
    const start = await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:cookie()},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'b'.repeat(43)}`});
    const state=new URL(start.headers.location!).searchParams.get('state');
    const callback=await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code&installation_id=77&setup_action=install`});
    expect(callback.headers.location).toContain('error=github_installation_required');
    expect(callback.headers.location).not.toContain('ticket=');
  });
  it('uses OAuth for a returning browser but still verifies personal installation access', async () => {
    const start=await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:`beeline_github_installed=1; ${cookie()}`},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'c'.repeat(43)}`});
    expect(new URL(start.headers.location!).pathname).toBe('/authorize');
    const state=new URL(start.headers.location!).searchParams.get('state');
    const callback=await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code`});
    expect(callback.headers.location).toContain('error=github_installation_required');
    expect(String(callback.headers['set-cookie'])).toContain('beeline_github_installed=;');
  });
  it('returns GitHub verification errors to Beeline instead of a raw browser error page', async () => {
    fixture.githubUserInstallations = new Error('GitHub temporarily unavailable');
    const start=await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:cookie()},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'d'.repeat(43)}`});
    const state=new URL(start.headers.location!).searchParams.get('state');
    const callback=await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code`});
    expect(callback.headers.location).toContain('error=github_installation_unavailable');
  });
  it('identifies an allowlisted first-time user before showing install UI or issuing a native ticket', async () => {
    fixture.githubUserInstallations = [];
    const start = await app.inject({method:'GET',headers:{host:alphaTenant.host},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'e'.repeat(43)}`});
    expect(new URL(start.headers.location!).pathname).toBe('/authorize');
    const state = new URL(start.headers.location!).searchParams.get('state');
    const callback = await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code`});
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain('Connect your GitHub repositories');
    expect(callback.body).toContain('All repositories');
    expect(callback.headers.location).toBeUndefined();
    const installState = callback.body.match(/state=([^"&]+)/)?.[1];
    expect(installState).toMatch(/^onboarding_/);
    fixture.githubUserInstallations = [77];
    const cookieHeader = (callback.headers['set-cookie'] as string[]).filter(c => !c.includes('Max-Age=0')).map(c => c.split(';')[0]).join('; ');
    const installed = await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:cookieHeader},
      url:`/auth/github/callback?state=${installState}&code=install-code`});
    expect(installed.statusCode).toBe(302);
    expect(installed.headers.location).toContain('ticket=');
  });
  it('keeps a non-allowlisted first-time account on the existing sign-in path when the flag is ON', async () => {
    vi.stubEnv('BEELINE_REPOSITORY_ONBOARDING_GITHUB_IDS', '296966200');
    const start = await app.inject({method:'GET',headers:{host:alphaTenant.host},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'g'.repeat(43)}`});
    const state = new URL(start.headers.location!).searchParams.get('state');
    const callback = await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code`});
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('ticket=');
    expect(String(callback.headers['set-cookie'])).not.toContain('beeline_onboarding=');
  });
  it('keeps sign-in unchanged when OFF even with onboarding requested and an eligibility cookie', async () => {
    vi.stubEnv('BEELINE_REPOSITORY_ONBOARDING', '0');
    const start = await app.inject({ method:'GET',headers:{host:alphaTenant.host,cookie:cookie()},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'f'.repeat(43)}` });
    expect(new URL(start.headers.location!).pathname).toBe('/authorize');
    expect(new URL(start.headers.location!).searchParams.get('state')).not.toMatch(/^onboarding_/);
    const caps = await app.inject({method:'GET',url:'/auth/capabilities',headers:{host:alphaTenant.host,cookie:cookie()}});
    expect(caps.json()).not.toHaveProperty('repositoryOnboarding');
  });
  it('does not accept a forged eligibility cookie or a non-allowlisted subject', async () => {
    for (const cookieValue of ['beeline_onboarding=123.forged', `beeline_onboarding=${onboardingCookie('456','github-secret',Date.now())}`]) {
      const caps=await app.inject({method:'GET',url:'/auth/capabilities',headers:{host:alphaTenant.host,cookie:cookieValue}});
      expect(caps.json()).not.toHaveProperty('repositoryOnboarding');
    }
  });
  it('keeps device approval on the existing OAuth path', async () => {
    const start = await app.inject({ method:'GET', headers:{ host:alphaTenant.host, cookie:cookie() }, url:'/auth/github/start' });
    expect(new URL(start.headers.location!).pathname).toBe('/authorize');
  });
});
