import { buildAuthServer } from './server.js';
import { createGitHubRoomTokenAuthority } from './github-room-authority.js';
import { AuthStore, PostgresDatabase } from './store.js';
import { GitHubAppClient, GitHubOAuthClient } from './github.js';
import { checkGitHubAppDriftBestEffort } from './github-manifest.js';
import { githubEnvironmentConfig } from './github-config.js';
import { authTenantsFromEnvironment, oidcClientFromEnvironment } from './environment.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const database = new PostgresDatabase(required('DATABASE_URL'));
  const store = new AuthStore(database);
  await store.migrate();
  const oidc = oidcClientFromEnvironment(process.env);

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
    // Operator-only shared secret for the GitHub App manifest setup page and
    // the on-demand drift endpoint; unset disables both surfaces.
    githubSetupToken: process.env.BUZZY_AUTH_SETUP_TOKEN,
    tenants: authTenantsFromEnvironment(process.env),
    authorizeGitHubRoomToken: createGitHubRoomTokenAuthority(store),
    logger: true,
  });
  const port = Number(process.env.PORT ?? '8789');
  const host = process.env.BUZZY_AUTH_HOST ?? '127.0.0.1';
  await app.listen({ port, host });

  if (github) {
    // Would have caught the empty-events gap ("events": []) immediately.
    void checkGitHubAppDriftBestEffort(github.app, (line) => app.log.info(line));
  }

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
