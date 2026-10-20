import { describe, expect, it } from 'vitest';
import { alphaTenant, app, startCookie, state as fixture, useAuthServerFixture } from './server-test-fixture.js';

describe('install-first native GitHub onboarding', () => {
  useAuthServerFixture();
  it('starts installation, accepts its OAuth callback with browser binding, and issues the native ticket', async () => {
    fixture.githubUserInstallations = [77];
    const start = await app.inject({ method:'GET', headers:{ host:alphaTenant.host },
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
    const start = await app.inject({method:'GET',headers:{host:alphaTenant.host},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'b'.repeat(43)}`});
    const state=new URL(start.headers.location!).searchParams.get('state');
    const callback=await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code&installation_id=77&setup_action=install`});
    expect(callback.headers.location).toContain('error=github_installation_required');
    expect(callback.headers.location).not.toContain('ticket=');
  });
  it('uses OAuth for a returning browser but still verifies personal installation access', async () => {
    const start=await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:'beeline_github_installed=1'},
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
    const start=await app.inject({method:'GET',headers:{host:alphaTenant.host},
      url:`/auth/github/start?onboarding=1&app_redirect=${encodeURIComponent('beeline://beeline/github-callback')}&app_state=${'d'.repeat(43)}`});
    const state=new URL(start.headers.location!).searchParams.get('state');
    const callback=await app.inject({method:'GET',headers:{host:alphaTenant.host,cookie:startCookie(start.headers['set-cookie'])},
      url:`/auth/github/callback?state=${state}&code=github-code`});
    expect(callback.headers.location).toContain('error=github_installation_unavailable');
  });
  it('keeps device approval on the existing OAuth path', async () => {
    const start = await app.inject({ method:'GET', headers:{ host:alphaTenant.host }, url:'/auth/github/start' });
    expect(new URL(start.headers.location!).pathname).toBe('/authorize');
  });
});
