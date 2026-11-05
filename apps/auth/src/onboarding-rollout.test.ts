import { afterEach, expect, it, vi } from 'vitest';
import { onboardingCookie, onboardingCookieSubject } from './onboarding-rollout.js';

afterEach(() => vi.unstubAllEnvs());
it('requires a signed, current subject before an identity exists', () => {
  const now = 1_000_000_000;
  const value = onboardingCookie('296966200','test-secret',now);
  expect(onboardingCookieSubject(`beeline_onboarding=${value}`,'test-secret',now)).toBe('296966200');
  expect(onboardingCookieSubject(`beeline_onboarding=${value}`,'wrong-secret',now)).toBeUndefined();
  expect(onboardingCookieSubject(`beeline_onboarding=${value}`,'test-secret',now-1)).toBeUndefined();
  expect(onboardingCookieSubject(`beeline_onboarding=${value}`,'test-secret',now+86_400_001)).toBeUndefined();
  expect(onboardingCookieSubject(`beeline_onboarding=${onboardingCookie('123','test-secret',now)}`,'test-secret',now)).toBe('123');
});

import { createHash as m3_createHash } from 'node:crypto';

import { onboardingCookie as m3_onboardingCookie } from "./onboarding-rollout.js";

import { afterEach as m3_afterEach, describe as m3_describe, expect as m3_expect, it as m3_it, vi as m3_vi } from 'vitest';

import { alphaTenant as m3_alphaTenant, app as m3_app, database as m3_database, startCookie as m3_startCookie, state as m3_fixture, useAuthServerFixture as m3_useAuthServerFixture } from "./server-test-fixture.js";
import { describe as mergedDescribe3 } from 'vitest';
mergedDescribe3("server-github-onboarding.test.ts", () => {


m3_describe('installation-aware native GitHub onboarding', () => {
  m3_useAuthServerFixture();
  m3_afterEach(() => m3_vi.unstubAllEnvs());
  const cookie = () => `beeline_onboarding=${m3_onboardingCookie('123', 'github-secret', Date.now())}`;
  m3_it('skips installation for an existing personal installation and issues the native ticket', async () => {
    m3_fixture.githubUserInstallations = [77];
    const start = await m3_app.inject({ method:'GET', headers:{ host:m3_alphaTenant.host, cookie:cookie() },
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'a'.repeat(43)}` });
    const installation = new URL(start.headers.location!);
    m3_expect(installation.pathname).toBe('/authorize');
    const state = installation.searchParams.get('state');
    m3_expect(state).not.toMatch(/^onboarding_/);
    const callback = await m3_app.inject({ method:'GET', headers:{ host:m3_alphaTenant.host, cookie:m3_startCookie(start.headers['set-cookie']) },
      url:`/auth/github/callback?state=${state}&code=github-code` });
    m3_expect(callback.statusCode).toBe(302);
    m3_expect(callback.headers.location).toContain('beeline://beeline/github-callback');
    m3_expect(callback.headers.location).toContain('ticket=');
  });
  m3_it('refuses a supplied installation id when the user token cannot prove personal All repositories access', async () => {
    m3_fixture.githubUserInstallations = [];
    const start = await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:cookie()},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'b'.repeat(43)}`});
    const state=new URL(start.headers.location!).searchParams.get('state');
    const callback=await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:m3_startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code&installation_id=77&setup_action=install`});
    m3_expect(callback.statusCode).toBe(400);
    m3_expect(callback.headers.location).toBeUndefined();
  });
  m3_it('uses OAuth for a returning browser but still verifies personal installation access', async () => {
    const start=await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:`beeline_github_installed=1; ${cookie()}`},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'c'.repeat(43)}`});
    m3_expect(new URL(start.headers.location!).pathname).toBe('/authorize');
    const state=new URL(start.headers.location!).searchParams.get('state');
    const callback=await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:m3_startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code`});
    m3_expect(callback.statusCode).toBe(200);
    m3_expect(callback.body).toContain('Connect your GitHub repositories');
  });
  m3_it('returns GitHub verification errors to Beeline instead of a raw browser error page', async () => {
    m3_fixture.githubUserInstallations = new Error('GitHub temporarily unavailable');
    const start=await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:cookie()},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'d'.repeat(43)}`});
    const state=new URL(start.headers.location!).searchParams.get('state');
    const callback=await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:m3_startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code`});
    m3_expect(callback.headers.location).toContain('error=github_installation_unavailable');
  });
  m3_it('identifies any first-time user before showing install UI or issuing a native ticket', async () => {
    m3_fixture.githubUserInstallations = [];
    const start = await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'e'.repeat(43)}`});
    m3_expect(new URL(start.headers.location!).pathname).toBe('/authorize');
    const state = new URL(start.headers.location!).searchParams.get('state');
    const callback = await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:m3_startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code`});
    m3_expect(callback.statusCode).toBe(200);
    m3_expect(callback.body).toContain('Connect your GitHub repositories');
    m3_expect(callback.body).toContain('All repositories');
    m3_expect(callback.headers.location).toBeUndefined();
    const installState = callback.body.match(/state=([^"&]+)/)?.[1];
    m3_expect(installState).toMatch(/^onboarding_/);
    m3_fixture.githubUserInstallations = [77];
    const cookieHeader = (callback.headers['set-cookie'] as string[]).filter(c => !c.includes('Max-Age=0')).map(c => c.split(';')[0]).join('; ');
    const installed = await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:cookieHeader},
      url:`/auth/github/callback?state=${installState}&code=install-code`});
    m3_expect(installed.statusCode).toBe(302);
    m3_expect(installed.headers.location).toContain('ticket=');
  });
  m3_it('R1: moves the Android recovery challenge to the install continuation and recovers after install', async () => {
    m3_fixture.githubUserInstallations = [];
    const recoveryToken = 'r'.repeat(43);
    const recoveryChallenge = m3_createHash('sha256').update(recoveryToken).digest('hex');
    const start = await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'g'.repeat(43)}&app_recovery_challenge=${recoveryChallenge}`});
    const state = new URL(start.headers.location!).searchParams.get('state');
    const callback = await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:m3_startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code`});
    m3_expect(callback.statusCode).toBe(200);
    m3_expect(callback.body).toContain('Connect your GitHub repositories');
    const installState = callback.body.match(/state=([^"&]+)/)?.[1];
    const holders = await m3_database.query<{ state_hash: string }>(
      `SELECT state_hash FROM beeline_oidc_flows WHERE app_recovery_hash = $1`, [recoveryChallenge]);
    m3_expect(holders.rows.map(row => row.state_hash)).toEqual([m3_createHash('sha256').update(installState!).digest('hex')]);
    m3_fixture.githubUserInstallations = [77];
    const cookieHeader = (callback.headers['set-cookie'] as string[]).filter(c => !c.includes('Max-Age=0')).map(c => c.split(';')[0]).join('; ');
    const installed = await m3_app.inject({method:'GET',headers:{host:m3_alphaTenant.host,cookie:cookieHeader},
      url:`/auth/github/callback?state=${installState}&code=install-code`});
    m3_expect(installed.statusCode).toBe(302);
    m3_expect(installed.headers.location).toContain('completed=1');
    const recovered = await m3_app.inject({method:'POST',url:'/auth/github/completion',headers:{host:m3_alphaTenant.host},
      payload:{recoveryToken}});
    m3_expect(recovered.statusCode).toBe(200);
    m3_expect(recovered.json()).toMatchObject({ ticket: recoveryToken, subject: '123' });
  });
  m3_it('advertises repository onboarding to every user without an eligibility cookie', async () => {
    for (const cookieValue of ['', 'beeline_onboarding=123.forged', cookie()]) {
      const caps = await m3_app.inject({method:'GET',url:'/auth/capabilities',headers:{host:m3_alphaTenant.host,cookie:cookieValue}});
      m3_expect(caps.json()).toHaveProperty('repositoryOnboarding', true);
    }
  });
  m3_it('keeps device approval on the existing OAuth path', async () => {
    const start = await m3_app.inject({ method:'GET', headers:{ host:m3_alphaTenant.host, cookie:cookie() }, url:'/auth/github/start' });
    m3_expect(new URL(start.headers.location!).pathname).toBe('/authorize');
  });

  m3_it('skips installation setup when an administered organization already covers the user', async () => {
    m3_fixture.githubUserInstallations = [88];
    m3_fixture.githubOrganizationAdmins = ['acme'];
    const start = await m3_app.inject({ method: 'GET', headers: { host: m3_alphaTenant.host, cookie: cookie() },
      url: `/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'f'.repeat(43)}` });
    m3_expect(new URL(start.headers.location!).pathname).toBe('/authorize');
    const state = new URL(start.headers.location!).searchParams.get('state');
    const callback = await m3_app.inject({ method: 'GET', headers: { host: m3_alphaTenant.host, cookie: m3_startCookie(start.headers['set-cookie']) },
      url: `/auth/github/callback?state=${state}&code=github-code` });
    m3_expect(callback.statusCode).toBe(302);
    m3_expect(callback.headers.location).toContain('ticket=');
  });

});
});
