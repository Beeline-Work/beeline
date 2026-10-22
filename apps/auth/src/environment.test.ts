import { describe, expect, it } from 'vitest';
import { authTenantsFromEnvironment, oidcClientFromEnvironment } from './environment.js';

const settings = {
  ISSUER: 'https://accounts.google.com',
  AUTHORIZATION_ENDPOINT: 'https://accounts.google.com/o/oauth2/v2/auth',
  TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token',
  JWKS_URI: 'https://www.googleapis.com/oauth2/v3/certs',
  CLIENT_ID: 'beeline-client',
  CLIENT_SECRET: 'test-secret',
};
const environment = (prefix: string): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [prefix + key, value])),
});

describe('OIDC environment', () => {
  it('starts authorization with BEELINE_AUTH_OIDC_ configuration', () => {
    const client = oidcClientFromEnvironment(environment('BEELINE_AUTH_OIDC_'));
    const url = new URL(client.authorizationUrl({ state: 'state', nonce: 'nonce', codeChallenge: 'challenge', redirectUri: 'https://server.usebeeline.app/auth/oidc/callback' }));
    expect(url.origin + url.pathname).toBe(settings.AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe(settings.CLIENT_ID);
    expect(client.config.clientSecret).toBe(settings.CLIENT_SECRET);
    expect(client.config.issuer).toBe(settings.ISSUER);
    expect(client.config.tokenEndpoint).toBe(settings.TOKEN_ENDPOINT);
    expect(client.config.jwksUri).toBe(settings.JWKS_URI);
  });

  it('ignores legacy BUZZY_AUTH_OIDC_ names', () => {
    expect(() => oidcClientFromEnvironment(environment('BUZZY_AUTH_OIDC_')))
      .toThrow('BEELINE_AUTH_OIDC_ISSUER is required');
  });

  it('requires a production secret', () => {
    const env = environment('BEELINE_AUTH_OIDC_');
    delete env.BEELINE_AUTH_OIDC_CLIENT_SECRET;
    expect(() => oidcClientFromEnvironment(env)).toThrow('BEELINE_AUTH_OIDC_CLIENT_SECRET is required in production');
  });
});


describe('insecure OIDC development opt-in', () => {
  it.each([
    [{ BEELINE_AUTH_ALLOW_INSECURE_OIDC: 'true' }, true],
    [{ BUZZY_AUTH_ALLOW_INSECURE_OIDC: 'true' }, false],
    [{ BEELINE_AUTH_ALLOW_INSECURE_OIDC: 'false' }, false],
  ])('reads only the Beeline name (%j)', (flags, expected) => {
    const client = oidcClientFromEnvironment({ ...environment('BEELINE_AUTH_OIDC_'), NODE_ENV: 'test', ...flags });
    expect(client.config.allowInsecure).toBe(expected);
  });

  it('never enables insecure OIDC in production', () => {
    const client = oidcClientFromEnvironment({ ...environment('BEELINE_AUTH_OIDC_'), BEELINE_AUTH_ALLOW_INSECURE_OIDC: 'true' });
    expect(client.config.allowInsecure).toBe(false);
  });
});

const tenants = [
  {
    host: 'localhost',
    community: 'fixture',
    roomCommunityIds: ['fixture'],
    origin: 'http://localhost',
  },
];
it('loads auth tenants from BEELINE_AUTH_TENANTS_JSON only', () => {
  expect(
    authTenantsFromEnvironment({ BEELINE_AUTH_TENANTS_JSON: JSON.stringify(tenants) }),
  ).toEqual(tenants);
  expect(() => authTenantsFromEnvironment({ BUZZY_AUTH_TENANTS_JSON: JSON.stringify(tenants) })).toThrow(
    'BEELINE_AUTH_TENANTS_JSON is required',
  );
});
