import { OidcClient } from './oidc.js';
import type { AuthTenant } from './server.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function authTenantsFromEnvironment(env: NodeJS.ProcessEnv): AuthTenant[] {
  const parsed = JSON.parse(required(env, 'BUZZY_AUTH_TENANTS_JSON')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('BUZZY_AUTH_TENANTS_JSON must be an array');
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid auth tenant');
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.host !== 'string' ||
      typeof candidate.community !== 'string' ||
      !Array.isArray(candidate.roomCommunityIds) ||
      candidate.roomCommunityIds.length === 0 ||
      candidate.roomCommunityIds.some((value) => typeof value !== 'string') ||
      typeof candidate.origin !== 'string'
    ) {
      throw new Error(
        'each auth tenant needs host, community, non-empty roomCommunityIds, and origin',
      );
    }
    if (env.NODE_ENV === 'production' && new URL(candidate.origin).protocol !== 'https:') {
      throw new Error('production auth tenant origins must use https');
    }
    return {
      host: candidate.host,
      community: candidate.community,
      roomCommunityIds: candidate.roomCommunityIds as string[],
      origin: candidate.origin,
    };
  });
}

export function oidcClientFromEnvironment(env: NodeJS.ProcessEnv): OidcClient {
  const oidcEnv = { ...env };
  for (const suffix of ['ISSUER', 'AUTHORIZATION_ENDPOINT', 'TOKEN_ENDPOINT', 'JWKS_URI', 'CLIENT_ID', 'CLIENT_SECRET']) {
    const name = `BEELINE_AUTH_OIDC_${suffix}`;
    oidcEnv[name] = env[name] ?? env[`BUZZY_AUTH_OIDC_${suffix}`];
  }
  const allowInsecure =
    env.NODE_ENV !== 'production' && env.BUZZY_AUTH_ALLOW_INSECURE_OIDC === 'true';
  const oidc = new OidcClient({
    issuer: required(oidcEnv, 'BEELINE_AUTH_OIDC_ISSUER'),
    authorizationEndpoint: required(oidcEnv, 'BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT'),
    tokenEndpoint: required(oidcEnv, 'BEELINE_AUTH_OIDC_TOKEN_ENDPOINT'),
    jwksUri: required(oidcEnv, 'BEELINE_AUTH_OIDC_JWKS_URI'),
    clientId: required(oidcEnv, 'BEELINE_AUTH_OIDC_CLIENT_ID'),
    clientSecret: oidcEnv.BEELINE_AUTH_OIDC_CLIENT_SECRET,
    allowInsecure,
  });
  if (env.NODE_ENV === 'production' && !oidc.config.clientSecret) {
    throw new Error('BEELINE_AUTH_OIDC_CLIENT_SECRET is required in production');
  }
  return oidc;
}
