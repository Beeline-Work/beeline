import { PostgresDatabase, migrate } from './database.js';
import { TokenAuth, verifierFromEnvironment } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { BackgroundLeader, PushDeliveryLoop, runMaintenance } from './background.js';
import { createFirebasePushSender } from './firebase-push.js';
import { createBeelineServer, DEFAULT_MEDIA_MAXIMUM_BYTES } from './server.js';
import { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { GitHubOperations } from './github-operations.js';
import { createMonolithAuth } from './monolith-auth.js';
import type { MonolithAuthMount } from './monolith-auth.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
async function main() {
  const database = new PostgresDatabase(
    required('DATABASE_URL'),
    Number(process.env.DATABASE_POOL_MAX ?? '5'),
  );
  await migrate(database);
  const publicOrigin =
    process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? '8080'}`;
  const live = new LiveHub();
  const githubConfigured =
    process.env.GITHUB_CLIENT_ID &&
    process.env.GITHUB_CLIENT_SECRET &&
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY &&
    process.env.GITHUB_APP_SLUG;
  const githubClients = githubConfigured
    ? {
        oauth: new GitHubOAuthClient({
          clientId: process.env.GITHUB_CLIENT_ID!,
          clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        }),
        app: new GitHubAppClient({
          appId: process.env.GITHUB_APP_ID!,
          privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
          slug: process.env.GITHUB_APP_SLUG!,
        }),
        ...(process.env.GITHUB_WEBHOOK_SECRET
          ? { webhookSecret: process.env.GITHUB_WEBHOOK_SECRET }
          : {}),
      }
    : undefined;
  let mountedAuth!: MonolithAuthMount;
  let github: GitHubOperations | undefined;
  const auth = new TokenAuth(
    database,
    verifierFromEnvironment(async (ticket) => {
      if (!mountedAuth) throw new Error('monolith auth is not ready');
      return mountedAuth.verifyGitHubTicket(ticket);
    }),
  );
  const processGitHubWebhook = async (event: string, payload: unknown) => {
    if (!github) throw new Error('GitHub webhook processor is unavailable');
    await github.processWebhook(event, payload);
  };
  mountedAuth = await createMonolithAuth(
    database,
    publicOrigin,
    githubClients ? { ...githubClients, onWebhook: processGitHubWebhook } : undefined,
    {
      createDaemonExchange: (agentId, transaction) =>
        auth.createDaemonExchange(agentId, transaction),
    },
  );
  github = githubClients
    ? new GitHubOperations(
        database,
        githubClients.oauth,
        githubClients.app,
        process.env.GITHUB_CLIENT_SECRET!,
        mountedAuth.sealedGitHubUserToken,
      )
    : undefined;
  const pushSender =
    process.env.PUSH_DELIVERY_ENABLED === 'true'
      ? createFirebasePushSender(process.env.GOOGLE_CLOUD_PROJECT)
      : undefined;
  const push = pushSender ? new PushDeliveryLoop(database, pushSender) : undefined;
  const sendPushTest = pushSender
    ? async (identityId: string) => {
        const devices = await database.query<{ token: string }>(
          `SELECT token FROM push_devices WHERE identity_id=$1`,
          [identityId],
        );
        for (const device of devices.rows)
          await pushSender.send(device.token, {
            messageId: 'test',
            roomId: 'test',
            text: 'Beeline notifications are ready.',
          });
      }
    : undefined;
  const phone = new PhoneService(database, publicOrigin, github, sendPushTest);
  const daemon = new DaemonService(database, live);
  const server = createBeelineServer({
    database,
    auth,
    phone,
    daemon,
    live,
    mediaMaximumBytes: Number(process.env.MEDIA_MAX_BYTES ?? String(DEFAULT_MEDIA_MAXIMUM_BYTES)),
    authHandler: mountedAuth.handle,
    github: {
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
      ...(github
        ? {
            roomToken: async (_identityId: string, roomId: string) => github.roomToken(roomId),
            onWebhook: processGitHubWebhook,
            completeInstallation: (state: string, installationId: number) =>
              github.completeInstallation(state, installationId),
          }
        : {}),
    },
  });
  const leader = new BackgroundLeader(
    database,
    async () => {
      if (push) await push.runOnce();
      await runMaintenance(database);
    },
    Number(process.env.BACKGROUND_INTERVAL_MS ?? '1000'),
  );
  void leader.run();
  const port = Number(process.env.PORT ?? '8080');
  const host = process.env.HOST ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  console.log(`[server] listening on ${host}:${port}; store=postgres; background=advisory-lock`);
  const stop = async () => {
    leader.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mountedAuth.close();
    await database.close();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}
main().catch((error) => {
  console.error('[server] startup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
