import { PostgresDatabase, migrate } from './database.js';
import { TokenAuth, verifierFromEnvironment } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import {
  BackgroundLeader,
  MediaExpiryLoop,
  PushDeliveryLoop,
  runMaintenance,
} from './background.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { ConnectionPresence } from './connection-presence.js';
import { createFirebasePushSender } from './firebase-push.js';
import { createBeelineServer, DEFAULT_MEDIA_MAXIMUM_BYTES } from './server.js';
import { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { GitHubOperations } from './github-operations.js';
import { createMonolithAuth } from './monolith-auth.js';
import { ReviewAccess } from './review-access.js';
import { ReleaseNotifier } from './release-notify.js';
import type { MonolithAuthMount } from './monolith-auth.js';
import { PostgresLiveListener } from './postgres-live.js';

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
  const liveListener = PostgresLiveListener.forConnectionString(
    process.env.DATABASE_LISTENER_URL ?? required('DATABASE_URL'),
    database,
    live,
  );
  void liveListener.run();
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
    githubClients ? { oauth: githubClients.oauth, app: githubClients.app } : undefined,
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
        (roomId) => live.publish({ type: 'invalidate', roomId, reason: 'github' }),
      )
    : undefined;
  const pushSender =
    process.env.PUSH_DELIVERY_ENABLED === 'true'
      ? await createFirebasePushSender(process.env)
      : undefined;
  const push = pushSender ? new PushDeliveryLoop(database, pushSender) : undefined;
  const schedules = new AgentScheduleLoop(database, (roomId) =>
    live.publish({ type: 'invalidate', roomId, reason: 'schedule' }),
  );
  const connectionPresence = new ConnectionPresence(database, live);
  await connectionPresence.start();
  const mediaExpiry = new MediaExpiryLoop(database);
  const sendPushTest = pushSender
    ? async (identityId: string) => {
        const devices = await database.query<{ token: string }>(
          `SELECT token FROM push_devices WHERE identity_id=$1`,
          [identityId],
        );
        for (const device of devices.rows)
          await pushSender.send(device.token, {
            messageId: 'test',
            type: 'test',
            text: 'Beeline notifications are ready.',
          });
      }
    : undefined;
  const phone = new PhoneService(database, publicOrigin, github, sendPushTest, live);
  const daemon = new DaemonService(
    database,
    live,
    github ? (roomId) => github!.roomToken(roomId) : undefined,
    Number(process.env.MEDIA_MAX_BYTES ?? String(DEFAULT_MEDIA_MAXIMUM_BYTES)),
    false,
    undefined,
    process.env.LIVE_PAINT_DIAGNOSTICS === 'true',
    process.env.FLY_MACHINE_ID,
  );
  // The Google Play review link. Absent secret = the endpoint refuses like any
  // wrong secret; rotating the value revokes every future use of the link.
  const review = new ReviewAccess({
    ...(process.env.BEELINE_REVIEW_SECRET ? { secret: process.env.BEELINE_REVIEW_SECRET } : {}),
    mint: () => auth.exchangeReviewIdentity(),
  });
  // The release pipeline's one caller (unified-release.yml's delivery_report
  // job) posts a release-announcement DM to every person once a release is
  // confirmed delivered. Absent secret = the endpoint refuses like any wrong
  // secret, same as the Play review link above.
  const releaseNotify = new ReleaseNotifier(database, {
    ...(process.env.BEELINE_RELEASE_NOTIFY_SECRET
      ? { secret: process.env.BEELINE_RELEASE_NOTIFY_SECRET }
      : {}),
  });
  const server = createBeelineServer({
    database,
    auth,
    phone,
    daemon,
    live,
    connectionPresence,
    review,
    releaseNotify,
    livePaintDiagnostics: process.env.LIVE_PAINT_DIAGNOSTICS === 'true',
    mediaMaximumBytes: Number(process.env.MEDIA_MAX_BYTES ?? String(DEFAULT_MEDIA_MAXIMUM_BYTES)),
    authHandler: mountedAuth.handle,
    webAppOrigins: (process.env.BEELINE_WEB_APP_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
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
  let lastReconciliationAt = Number.NEGATIVE_INFINITY;
  const reconciliationMs = Number(process.env.BACKGROUND_RECONCILIATION_MS ?? '60000');
  const leader = new BackgroundLeader(
    database,
    async () => {
      if (push) await push.runOnce();
      await schedules.runOnce();
      const now = Date.now();
      if (now - lastReconciliationAt >= reconciliationMs) {
        lastReconciliationAt = now;
        await mediaExpiry.runOnce(now);
        await runMaintenance(database);
      }
      const nextDue = await schedules.nextDueAt();
      return nextDue ? nextDue.getTime() - Date.now() : reconciliationMs;
    },
    reconciliationMs,
  );
  const stopBackgroundWake = live.subscribeAll((event) => {
    if (
      event.type === 'invalidate' &&
      (event.reason === 'postgres:messages' || event.reason === 'postgres:agent_schedules')
    )
      leader.wake();
  });
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
    stopBackgroundWake();
    await connectionPresence.stop();
    await liveListener.stop();
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
