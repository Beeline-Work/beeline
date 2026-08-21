import { buildAuthServer, type AuthTenant } from './server.js';
import { createGitHubRoomTokenAuthority } from './github-room-authority.js';
import { OidcClient } from './oidc.js';
import { AuthStore, PostgresDatabase } from './store.js';
import { GitHubAppClient, GitHubOAuthClient } from './github.js';
import { githubEnvironmentConfig } from './github-config.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function tenantsFromEnvironment(): AuthTenant[] {
  const raw = required('BUZZY_AUTH_TENANTS_JSON');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('BUZZY_AUTH_TENANTS_JSON must be an array');
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid auth tenant');
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.host !== 'string' ||
      typeof candidate.community !== 'string' ||
      typeof candidate.roomCommunityId !== 'string' ||
      typeof candidate.origin !== 'string'
    ) {
      throw new Error(
        'each auth tenant needs host, community, roomCommunityId, and origin strings',
      );
    }
    if (process.env.NODE_ENV === 'production' && new URL(candidate.origin).protocol !== 'https:') {
      throw new Error('production auth tenant origins must use https');
    }
    return {
      host: candidate.host,
      community: candidate.community,
      roomCommunityId: candidate.roomCommunityId,
      origin: candidate.origin,
    };
  });
}

async function main(): Promise<void> {
  const database = new PostgresDatabase(required('DATABASE_URL'));
  const store = new AuthStore(database);
  await store.migrate();
  const allowInsecure =
    process.env.NODE_ENV !== 'production' && process.env.BUZZY_AUTH_ALLOW_INSECURE_OIDC === 'true';
  const oidc = new OidcClient({
    issuer: required('BUZZY_AUTH_OIDC_ISSUER'),
    authorizationEndpoint: required('BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT'),
    tokenEndpoint: required('BUZZY_AUTH_OIDC_TOKEN_ENDPOINT'),
    jwksUri: required('BUZZY_AUTH_OIDC_JWKS_URI'),
    clientId: required('BUZZY_AUTH_OIDC_CLIENT_ID'),
    clientSecret: process.env.BUZZY_AUTH_OIDC_CLIENT_SECRET,
    allowInsecure,
  });
  if (process.env.NODE_ENV === 'production' && !oidc.config.clientSecret) {
    throw new Error('BUZZY_AUTH_OIDC_CLIENT_SECRET is required in production');
  }

  const githubConfig = githubEnvironmentConfig(process.env);
  const github = githubConfig
    ? {
        oauth: new GitHubOAuthClient({
          clientId: githubConfig.BEELINE_GITHUB_CLIENT_ID,
          clientSecret: githubConfig.BEELINE_GITHUB_CLIENT_SECRET,
        }),
        app: new GitHubAppClient({
          appId: githubConfig.BEELINE_GITHUB_APP_ID,
          slug: githubConfig.BEELINE_GITHUB_APP_SLUG,
          privateKey: githubConfig.BEELINE_GITHUB_APP_PRIVATE_KEY,
        }),
      }
    : undefined;

  const app = buildAuthServer({
    store,
    oidc,
    ...(github
      ? { github: { ...github, webhookSecret: githubConfig!.BEELINE_GITHUB_WEBHOOK_SECRET } }
      : {}),
    tenants: tenantsFromEnvironment(),
    authorizeGitHubRoomToken: createGitHubRoomTokenAuthority(),
    logger: true,
  });
  const port = Number(process.env.PORT ?? '8789');
  const host = process.env.BUZZY_AUTH_HOST ?? '127.0.0.1';
  await app.listen({ port, host });

  const shutdown = async () => {
    await app.close();
    await store.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('[auth] startup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
