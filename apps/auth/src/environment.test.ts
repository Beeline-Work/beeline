import { describe, expect, it } from 'vitest';
import { oidcClientFromEnvironment } from './environment.js';

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

describe('OIDC environment migration', () => {
  it.each(['BEELINE_AUTH_OIDC_', 'BUZZY_AUTH_OIDC_'])('starts authorization with %s configuration', (prefix) => {
    const client = oidcClientFromEnvironment(environment(prefix));
    const url = new URL(client.authorizationUrl({ state: 'state', nonce: 'nonce', codeChallenge: 'challenge', redirectUri: 'https://server.usebeeline.app/auth/oidc/callback' }));
    expect(url.origin + url.pathname).toBe(settings.AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe(settings.CLIENT_ID);
    expect(client.config.clientSecret).toBe(settings.CLIENT_SECRET);
    expect(client.config.issuer).toBe(settings.ISSUER);
    expect(client.config.tokenEndpoint).toBe(settings.TOKEN_ENDPOINT);
    expect(client.config.jwksUri).toBe(settings.JWKS_URI);
  });

  it('prefers every new setting over a conflicting legacy setting', () => {
    const legacy = Object.fromEntries(Object.keys(settings).map((key) => ['BUZZY_AUTH_OIDC_' + key, 'https://legacy.example']));
    expect(oidcClientFromEnvironment({ ...legacy, ...environment('BEELINE_AUTH_OIDC_') }).config)
      .toEqual(oidcClientFromEnvironment(environment('BEELINE_AUTH_OIDC_')).config);
  });

  it('falls back per setting when a new name is absent', () => {
    const env = environment('BUZZY_AUTH_OIDC_');
    env.BEELINE_AUTH_OIDC_CLIENT_ID = 'new-client';
    const client = oidcClientFromEnvironment(env);
    expect(client.config.clientId).toBe('new-client');
    expect(client.config.clientSecret).toBe(settings.CLIENT_SECRET);
  });

  it('rejects an explicitly empty new required setting rather than using the old value', () => {
    expect(() => oidcClientFromEnvironment({ ...environment('BUZZY_AUTH_OIDC_'), BEELINE_AUTH_OIDC_CLIENT_ID: '' }))
      .toThrow('BEELINE_AUTH_OIDC_CLIENT_ID is required');
  });

  it('requires a production secret under the new name', () => {
    const env = environment('BEELINE_AUTH_OIDC_');
    delete env.BEELINE_AUTH_OIDC_CLIENT_SECRET;
    expect(() => oidcClientFromEnvironment(env)).toThrow('BEELINE_AUTH_OIDC_CLIENT_SECRET is required in production');
  });
});
