import { OidcClient } from './oidc.js';
import type { AuthTenant } from './server.js';

/** Prefer Beeline names while retaining existing operator configuration. */
export function readEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`BEELINE_${suffix}`] ?? env[`BUZZY_${suffix}`];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function authTenantsFromEnvironment(env: NodeJS.ProcessEnv): AuthTenant[] {
  const raw = readEnv(env, 'AUTH_TENANTS_JSON');
  if (!raw)
    throw new Error('BEELINE_AUTH_TENANTS_JSON is required (BUZZY_AUTH_TENANTS_JSON still works)');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed))
    throw new Error(
      'BEELINE_AUTH_TENANTS_JSON (BUZZY_AUTH_TENANTS_JSON still works) must be an array',
    );
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
  const allowInsecure =
    env.NODE_ENV !== 'production' && env.BUZZY_AUTH_ALLOW_INSECURE_OIDC === 'true';
  const oidc = new OidcClient({
    issuer: required(env, 'BUZZY_AUTH_OIDC_ISSUER'),
    authorizationEndpoint: required(env, 'BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT'),
    tokenEndpoint: required(env, 'BUZZY_AUTH_OIDC_TOKEN_ENDPOINT'),
    jwksUri: required(env, 'BUZZY_AUTH_OIDC_JWKS_URI'),
    clientId: required(env, 'BUZZY_AUTH_OIDC_CLIENT_ID'),
    clientSecret: env.BUZZY_AUTH_OIDC_CLIENT_SECRET,
    allowInsecure,
  });
  if (env.NODE_ENV === 'production' && !oidc.config.clientSecret) {
    throw new Error('BUZZY_AUTH_OIDC_CLIENT_SECRET is required in production');
  }
  return oidc;
}
