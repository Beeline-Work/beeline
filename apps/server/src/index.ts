import { requiredServerSetting as required } from './server-configuration.js';
import { DISPLAY_DEADLINE_KEY } from './deadline-expiry-source.js';
import { backgroundDatabaseCut } from './background-deadline-clock.js';
import { BackgroundRecordDeadlines, backgroundSourceFamilies, repairDeadlineFamilies, registerBackgroundDeadlineFamilies, subscribeBackgroundFamilies } from './background-deadlines.js';
import { sentryEligibilityKey } from './sentry-wake-source.js';
import { PENDING_ATTACHMENT_DUE_KEY } from './pending-attachment-source.js';
import { AGENT_SCHEDULE_DUE_KEY } from './agent-schedule-source.js';
import { ConnectorOfferExpiryLoop, CONNECTOR_OFFER_DUE_KEY } from './connector-offer-expiry.js';
import { StarterOnboardingService } from './starter-onboarding-run.js';
import { NextDayCheckin } from './next-day-checkin.js';
import { RoomsMcp } from './rooms-mcp.js';
import { RoomsMcpOAuth } from './rooms-mcp-oauth.js';
import { runMcpWebhookDelivery } from './rooms-mcp-members.js';
import { deliverXSignups, nextXSignupDeliveryAt } from './x-ads.js';
import { deliverOperatorSystemDmBatch,subscribeOperatorSystemDmDeliveries } from './operator-system-dm.js';
import { captureServerError, flushServerErrors } from './sentry.js';

// Expected voice failures are handled at their task boundary. Report any escape.
process.on('unhandledRejection', error => {
  captureServerError(error, { surface: 'unhandled-rejection' });
  console.error('[unhandled-rejection]', error instanceof Error ? error.name : 'Unknown rejection');
});
import { sentryTelegramFromEnv } from './sentry-telegram.js';
import { runSentryWakeDeadline, sentryWakeAgentFromEnv } from './sentry-wake.js';
import { randomUUID } from 'node:crypto';
import { assertSchemaCurrent, markSchemaCurrent, migrate, migrateData, PostgresDatabase } from './database.js';
import { runMigrationStep } from './migration-steps.js';
import { databaseConnectionBudget } from './database-budget.js';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import { TokenAuth, verifierFromEnvironment } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import {
  BackgroundJobRunner,
  createPushTestSender,
  MediaExpiryLoop,
  PushDeliveryLoop,
} from './background.js';
import { mediaTtlHours, MEDIA_SWEEP_INTERVAL_MS } from './media-ttl.js';
import { PendingAttachmentCleanupLoop } from './pending-attachment-cleanup.js';
import { BackgroundLeader } from './background-leader.js';
import { startBackgroundWork, BackgroundWork } from './background-work.js';
import { OperationOutcomes, startOperationOutcomeFlush } from './operation-outcomes.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { ChoiceExpiryLoop } from './choice-expiry.js';
import { subscribeCommandCompletion } from './command-completion.js';
import { DeadlineExpiry } from './deadline-expiry.js';
import { ConnectionPresence } from './connection-presence.js';
import { clearStalePhoneViews } from './phone-viewing.js';
import { createFirebasePushSender } from './firebase-push.js';
import { createApnsPushSender } from './apns-push.js';
import { createBeelineServer, DEFAULT_MEDIA_MAXIMUM_BYTES } from './server.js';
import { objectStorageFromEnv } from './object-storage.js';
import { ObjectService } from './object-service.js';
import { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { GitHubOperations } from './github-operations.js';
import { createMonolithAuth } from './monolith-auth.js';
import { ComposioApps } from './composio-apps.js';
import { LinkAgentWallet } from './link-agent-wallet.js';
import { cdpWebhookSecretsFromEnv } from './wallet-webhooks.js';
import { McpRegistryClient } from './mcp-registry.js';
import { RegistryMcpOAuth } from './registry-mcp-oauth.js';
import { ReviewAccess } from './review-access.js';
import { ReleaseNotifier } from './release-notify.js';
import { speechTranscriberFromEnv } from './speech-transcription.js';
import { VoiceService, voiceConfigFromEnv } from './voice-service.js';
import { createWebPushSender } from './web-push.js';
import type { MonolithAuthMount } from './monolith-auth.js';
import { PostgresLiveListener } from './postgres-live.js';
import { listenAfterBestEffortRecovery } from './startup.js';
import { INSTITUTIONAL_MEMORY_ON } from './institutional-memory-shadow.js';
import {
  backfillInstitutionalMemoryEmbeddingsOnce,
  warnIfEmbeddingKeyMissing,
} from './institutional-memory-embeddings.js';
import type { InstitutionalSkillAnchorSource } from './institutional-skill-anchors.js';
import { retireWelcomeWorkspace, welcomeRetirementPreflight } from './welcome-retirement.js';
import { feedbackConfigFromEnv } from './feedback.js';
import { FeedbackGitHub } from './feedback-github.js';
import { startComputerExpirySweep } from './computer-session.js';
import {
  addFreeAgentToWorkspace,
  FreeAgentService,
  freeAgentConfigFromEnv,
} from './free-agents.js';
import { FlyMachines } from './fly-machines.js';

async function runReleaseMigration(): Promise<void> {
  const database = new PostgresDatabase(required('MIGRATION_DATABASE_URL'), 1, {
    mode: 'migration',
  });
  try {
    await migrate(database, { deferData: true });
    await runMigrationStep('auth schema', async () => {
      await new AuthStore(database as unknown as TransactionalDatabase).migrate();
    });
    await migrateData(database);
    // Armed only by the release owner, once the create-or-join onboarding is
    // live on every supported client (docs/welcome-retirement.md).
    const greeterAgentId = process.env.BEELINE_RETIRE_WELCOME_GREETER_ID?.trim();
    if (greeterAgentId) {
      await runMigrationStep('welcome retirement', async () => {
        const retirement = await retireWelcomeWorkspace(database, { greeterAgentId });
        console.log(`[migration] welcome retirement: ${JSON.stringify(retirement)}`);
      });
    }
    // This is deliberately last: boot may proceed only after both schema owners
    // and every data backfill completed successfully.
    await runMigrationStep('schema marker', () => markSchemaCurrent(database));
    console.log('[migration] server and auth schemas are current');
  } finally {
    await database.close();
  }
}

async function main() {
  const connectionString = required('DATABASE_URL');
  const healthDatabase = new PostgresDatabase(connectionString, 1, { mode: 'diagnostics' });
  let budget: ReturnType<typeof databaseConnectionBudget>;
  try {
    const capacity = await healthDatabase.query<{ max_connections: string }>('SHOW max_connections');
    budget = databaseConnectionBudget(
      Number(capacity.rows[0]?.max_connections),
      Number(process.env.BEELINE_SERVER_MACHINES ?? '2'),
      Number(process.env.DATABASE_POOL_MAX ?? '5'),
    );
  } catch (error) {
    await healthDatabase.close();
    throw error;
  }
  const database = new PostgresDatabase(
    connectionString,
    budget.app,
  );
  try {
    await assertSchemaCurrent(database);
  } catch (error) {
    await database.close();
    await healthDatabase.close();
    throw error;
  }
  const enrichmentDatabase = new PostgresDatabase(connectionString, budget.enrichment, { mode: 'enrichment' });
  const jobsDatabase = new PostgresDatabase(connectionString, budget.jobs, { mode: 'long-running' });
  // One-time sweep at server start — never on an interval; fire-and-forget so
  // it never delays this machine coming up and serving requests. Its session
  // lock lets only one machine run it; the other logs `skipped:true`.
  warnIfEmbeddingKeyMissing();
  void backfillInstitutionalMemoryEmbeddingsOnce(jobsDatabase)
    .then((counts) => console.log(`[startup] institutional memory embedding backfill: ${JSON.stringify(counts)}`))
    .catch((error) => console.error('[startup] institutional memory embedding backfill failed:', error));
  console.log(`[database] connection budget ${JSON.stringify(budget)}`);
  const publicOrigin =
    process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? '8080'}`;
  const live = new LiveHub();
  const liveListener = PostgresLiveListener.forConnectionString(
    process.env.DATABASE_LISTENER_URL ?? required('DATABASE_URL'),
    database,
    live,
  );
  // Listener expands one presence NOTIFY across memberships; writers must not
  // also run broadcastAgentPresence against the same LiveHub.
  live.useListenerPresenceFanout();
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
    () => new Date(),
    (ticket) => mountedAuth.verifyGoogleTicket(ticket),
  );
  const processGitHubWebhook = async (event: string, payload: unknown, deliveryId?: string) => {
    if (!github) throw new Error('GitHub webhook processor is unavailable');
    await github.processWebhook(event, payload, deliveryId);
  };
  const webAppOrigins = (process.env.BEELINE_WEB_APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  mountedAuth = await createMonolithAuth(
    database,
    publicOrigin,
    githubClients ? { oauth: githubClients.oauth, app: githubClients.app } : undefined,
    {
      createDaemonExchange: (agentId, transaction) =>
        auth.createDaemonExchange(agentId, transaction),
      webAppOrigins,
      completeRepositoryInstallation: async (state, installationId, code, callbackUri) => {
        if (!github) throw new Error('GitHub installation service is unavailable');
        return github.completeInstallation(state, installationId, code, callbackUri);
      },
    },
  );
  const institutionalMemory = INSTITUTIONAL_MEMORY_ON;
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
  const githubJobs = githubClients
    ? new GitHubOperations(
        jobsDatabase,
        githubClients.oauth,
        githubClients.app,
        process.env.GITHUB_CLIENT_SECRET!,
        mountedAuth.sealedGitHubUserToken,
        (roomId) => live.publish({ type: 'invalidate', roomId, reason: 'github' }),
      )
    : undefined;
  // Generated procedures are anchored to real code, so the curator's staleness
  // pass needs an installation token and the repository's default branch. With
  // no GitHub App configured there is no anchor to check and no contradiction to
  // record, so the pass is skipped rather than guessed at.
  const institutionalAnchors: InstitutionalSkillAnchorSource | undefined =
    githubClients && githubJobs
      ? {
          resolveRoomRepository: (roomId) => githubJobs.roomAnchorTarget(roomId),
          // The anchored repository is the one content is compared in — the
          // token is what comes from the Room. A Room later pointed at another
          // repository still gets asked about the code the procedure was
          // actually written against.
          fileBlobSha: (input) =>
            githubClients.app.fileBlobSha({
              accessToken: input.token,
              fullName: input.repository,
              path: input.path,
              ref: input.ref,
            }),
        }
      : undefined;
  const pushSender =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
      ? await createFirebasePushSender(process.env)
      : undefined;
  const apnsPushSender = createApnsPushSender(process.env);
  const webPushSender = createWebPushSender(jobsDatabase, process.env);
  const push = pushSender || webPushSender
    ? new PushDeliveryLoop(jobsDatabase, pushSender, apnsPushSender, webPushSender)
    : undefined;
  const schedules = new AgentScheduleLoop(jobsDatabase, (roomId) =>
    live.publish({ type: 'invalidate', roomId, reason: 'schedule' }),
  );
  // Each process is its own lease holder: a restarted machine is a new
  // instance, and the old one's connections expire with its lease.
  const connectionPresence = new ConnectionPresence(database, live, undefined, undefined, {
    instanceId: `${process.env.FLY_MACHINE_ID ?? 'local'}:${randomUUID()}`,
  });
  const mediaExpiryMediaMaximumBytes = Number(
    process.env.MEDIA_MAX_BYTES ?? String(DEFAULT_MEDIA_MAXIMUM_BYTES),
  );
  const objectStorage = objectStorageFromEnv();
  const objectService = new ObjectService(
    database,
    objectStorage,
    publicOrigin,
    mediaExpiryMediaMaximumBytes,
  );
  const composio = process.env.BEELINE_COMPOSIO_API_KEY
    ? new ComposioApps(process.env.BEELINE_COMPOSIO_API_KEY)
    : undefined;
  const linkWallet = process.env.BEELINE_LINK_CLIENT_ID &&
    process.env.BEELINE_LINK_CLIENT_SECRET && process.env.BEELINE_LINK_PUBLISHABLE_KEY &&
    process.env.BEELINE_LINK_TOKEN_KEY
    ? new LinkAgentWallet(database, process.env.BEELINE_LINK_CLIENT_ID,
        process.env.BEELINE_LINK_CLIENT_SECRET, process.env.BEELINE_LINK_PUBLISHABLE_KEY,
        publicOrigin, process.env.BEELINE_LINK_TOKEN_KEY)
    : undefined;
  const mcpRegistry = new McpRegistryClient();
  const registryMcpOAuth = new RegistryMcpOAuth(database, publicOrigin);
  const mediaExpiry = objectStorage
    ? new MediaExpiryLoop(jobsDatabase, mediaTtlHours(), MEDIA_SWEEP_INTERVAL_MS, {
        storage: objectStorage,
        service: objectService,
      })
    : new MediaExpiryLoop(jobsDatabase);
  const choiceExpiry = new ChoiceExpiryLoop(jobsDatabase);
  const connectorOfferExpiry = new ConnectorOfferExpiryLoop(jobsDatabase);
  const pendingAttachmentCleanup = new PendingAttachmentCleanupLoop(jobsDatabase);
  const deadlineExpiry = new DeadlineExpiry(jobsDatabase);
  const sendPushTest = pushSender || webPushSender
    ? createPushTestSender(database, pushSender, apnsPushSender, webPushSender)
    : undefined;
  const phone = new PhoneService(
    database,
    publicOrigin,
    github,
    sendPushTest,
    live,
    false,
    enrichmentDatabase,
    objectService,
    undefined,
    mcpRegistry,
    composio,
    linkWallet,
  );
  const daemon = new DaemonService(
    database,
    live,
    github ? (roomId) => github!.roomToken(roomId) : undefined,
    Number(process.env.MEDIA_MAX_BYTES ?? String(DEFAULT_MEDIA_MAXIMUM_BYTES)),
    false,
    undefined,
    process.env.LIVE_PAINT_DIAGNOSTICS === 'true',
    process.env.FLY_MACHINE_ID,
    github ? (input, confirmZeroChecks) => github!.prChecksStatus(input, confirmZeroChecks) : undefined,
    undefined,
    institutionalMemory,
    mcpRegistry,
    registryMcpOAuth,
    composio,
    {
      config: feedbackConfigFromEnv(),
      ...(githubClients ? { pullRequests: new FeedbackGitHub(database, githubClients.app) } : {}),
    },
    objectService,
    linkWallet,
    github ? (cornerId) => github!.refreshStaleMergeability(cornerId) : undefined,
    github ? (cornerId, onBlocked) => github!.landCornerOutcome(cornerId, onBlocked) : undefined,
    github ? (cornerId) => github!.closeCornerPullRequest(cornerId) : undefined,
    github ? (cornerId) => github!.readCornerPullRequest(cornerId) : undefined,
    `${publicOrigin}/v1/connectors/events/composio`,
    github,
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
  const releaseNotify = new ReleaseNotifier(jobsDatabase, {
    live,
    ...(process.env.BEELINE_RELEASE_NOTIFY_SECRET
      ? { secret: process.env.BEELINE_RELEASE_NOTIFY_SECRET }
      : {}),
  });
  const speechTranscriber = speechTranscriberFromEnv();
  const voiceConfig = voiceConfigFromEnv();
  const voice = voiceConfig ? new VoiceService(database, live, { ...voiceConfig, objects: objectService }) : undefined;
  const freeAgentConfig = freeAgentConfigFromEnv(process.env, publicOrigin);
  const freeAgents = freeAgentConfig && process.env.FLY_FREE_AGENT_API_TOKEN
    ? new FreeAgentService(
        database,
        freeAgentConfig,
        new FlyMachines(
          process.env.FLY_FREE_AGENT_API_TOKEN,
          process.env.FLY_FREE_AGENT_APP || 'beeline-free-agents',
          fetch,
          process.env.FLY_FREE_AGENT_API_ORIGIN || undefined,
        ),
        (agentId, transaction) => auth.createDaemonExchange(agentId, transaction),
      )
    : undefined;
  if (freeAgents) phone.setFreeAgents(freeAgents);
  const freeAgentModel = freeAgentConfig && process.env.BEELINE_FREE_AGENT_MODEL_KEY
    ? {
        database,
        config: freeAgentConfig,
        upstreamKey: process.env.BEELINE_FREE_AGENT_MODEL_KEY,
        ...(process.env.BEELINE_FREE_AGENT_MODEL_UPSTREAM
          ? { upstreamBaseUrl: process.env.BEELINE_FREE_AGENT_MODEL_UPSTREAM }
          : {}),
      }
    : undefined;
  const starterOnboarding = new StarterOnboardingService(database, freeAgentModel);
  phone.setStarterOnboarding(starterOnboarding);
  daemon.setStarterOnboarding(starterOnboarding);
  const backgroundJobs = new BackgroundJobRunner();
  const operationOutcomes = new OperationOutcomes();
  const sentryWakeAgentId = sentryWakeAgentFromEnv();
  liveListener.setServerLeaseEvidence((instance, renewedAt, removed) => {
    connectionPresence.observeServerLease(instance, renewedAt, removed);
  });
  const server = createBeelineServer({
    operationOutcomes,
    roomsMcp: new RoomsMcp(new RoomsMcpOAuth(database, publicOrigin, auth, undefined, () => liveListener.projectionHealth().connected), phone, live, daemon, objectService, undefined, () => liveListener.projectionHealth().connected),
    sentryWakeAgentId,
    database,
    sentryTelegram: sentryTelegramFromEnv(),
    ...(process.env.BEELINE_SENTRY_CLIENT_SECRET ? { sentryWakeSecret: process.env.BEELINE_SENTRY_CLIENT_SECRET } : {}),
    cdpWebhookSecrets: cdpWebhookSecretsFromEnv(),
    databaseBudget: budget,
    enrichmentDatabase,
    jobsDatabase,
    databasePools: { app: database, enrichment: enrichmentDatabase, diagnostics: healthDatabase, jobs: jobsDatabase },
    linkWallet,
    registryMcpOAuth,
    healthDatabase,
    backgroundHealth: () => backgroundJobs.snapshot(),
    liveBridgeHealth: () => liveListener.projectionHealth(),
    readiness: () => liveListener.projectionHealth().connected,
    auth,
    phone,
    daemon,
    composio,
    composioReceiverUrl: `${publicOrigin}/v1/connectors/events/composio`,
    live,
    connectionPresence,
    ...(freeAgents ? { freeAgents } : {}),
    ...(freeAgentModel ? { freeAgentModel } : {}),
    review,
    releaseNotify,
    ...(speechTranscriber ? { speechTranscriber } : {}),
    ...(voice ? { voice } : {}),
    dashboardSecret: process.env.BEELINE_DASHBOARD_SECRET,
    livePaintDiagnostics: process.env.LIVE_PAINT_DIAGNOSTICS === 'true',
    mediaMaximumBytes: mediaExpiryMediaMaximumBytes,
    objectService,
    authHandler: mountedAuth.handle,
    webAppOrigins,
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
  const work = new BackgroundWork();
  let checkinClock=new Date();
  let checkinCut:string|undefined;
  const nextDayCheckin = new NextDayCheckin(jobsDatabase, webAppOrigins[0] ?? 'https://web.usebeeline.app', undefined, ()=>checkinClock, publicOrigin);
  let nextDayCheckinRunning: Promise<unknown> | undefined;
  let nextDayCheckinPending = false;
  work.addDeadline('next-day-checkin', async () => {
    if (nextDayCheckinRunning) { nextDayCheckinPending = true; return; }
    nextDayCheckinRunning = backgroundJobs.run('next-day-checkin', async () => {
      checkinCut=await backgroundDatabaseCut(jobsDatabase);checkinClock=new Date(checkinCut);await nextDayCheckin.runOnce();
    })
      .then(async outcome => {
        if (outcome.ok) work.schedule('next-day-checkin', await nextDayCheckin.nextDelayMs(checkinCut));
      }).catch(error => captureServerError(error,{background_job:'next-day-checkin'}))
      .finally(() => {
        nextDayCheckinRunning = undefined;
        if(nextDayCheckinPending){nextDayCheckinPending=false;work.wake('next-day-checkin','committed-during-flight');}
        leader.wake();
      });
  });
  if (push) work.addDeadline('push', async () => {
    const dispatched=await backgroundJobs.run('push', async () => {
      const cut=await backgroundDatabaseCut(jobsDatabase);await push.runOnce();return cut;
    });
    if(!dispatched.ok)return;
    const due = await backgroundJobs.run('push-next-due', () => push.nextDelayMs(dispatched.value));
    if (due.ok) return due.value;
  });
  work.addDeadline('pending-attachment-cleanup', async () => {
    const swept = await backgroundJobs.run('pending-attachment-cleanup', () => pendingAttachmentCleanup.runOnce());
    if (!swept.ok) return;
    const due = await backgroundJobs.run('pending-attachment-next-due', () => pendingAttachmentCleanup.nextDelayMs());
    if (due.ok) return due.value;
  });
  work.addDeadline('schedules', async () => {
    const fired = await backgroundJobs.run('schedules', () => schedules.runOnce());
    if (!fired.ok) return;
    const due = await backgroundJobs.run('schedule-next-due', () => schedules.nextDelayMs());
    if (due.ok) return due.value;
  });
  work.addDeadline('sentry', async () => {
    const due = await backgroundJobs.run('sentry-wakes', () => runSentryWakeDeadline(jobsDatabase, sentryWakeAgentId));
    if (due.ok) return due.value;
  });
  work.addDeadline('connector-offer-expiry', async () => {
    const due = await backgroundJobs.run('connector-offer-expiry', () => connectorOfferExpiry.runOnce());
    if (due.ok) return due.value;
  });
  work.addDeadline('choices', async () => {
    const due = await backgroundJobs.run('choice-expiry', () => choiceExpiry.runOnce());
    if (due.ok) return due.value;
  });
  work.addDeadline('deadlines', async (newLeader) => {
    const due = await backgroundJobs.run('deadline-expiry', () => deadlineExpiry.runOnce(newLeader));
    if (due.ok && due.value !== null) return Math.max(0, due.value);
  });
  if (freeAgents) work.addDeadline('free-agents', async () => {
    const acted=await backgroundJobs.run('free-agents', async () => {
      const cut=await backgroundDatabaseCut(jobsDatabase);await freeAgents.sweep();return cut;
    });
    if(!acted.ok)return;
    const due=await backgroundJobs.run('free-agents-next-due',()=>freeAgents.nextDelayMs(acted.value));
    if(due.ok)return due.value;
  });
  // A committed signup row owns delivery. Vendor report/balance observations
  // are explicit operator demand and never background calendar jobs.
  work.addDeadline('x-conversions', async () => {
    const delivered=await backgroundJobs.run('x-signup-conversions', () => deliverXSignups(jobsDatabase));
    if(!delivered.ok)return;
    const due=await backgroundJobs.run('x-signup-next-due',()=>nextXSignupDeliveryAt(jobsDatabase));
    if(due.ok && due.value)return Math.max(0,due.value.getTime()-Date.now());
  });
  work.addDeadline('operator-system-dms',async()=>{
    const delivered=await backgroundJobs.run('operator-system-dms',()=>deliverOperatorSystemDmBatch(jobsDatabase));
    if(delivered.ok)return delivered.value;
  });
  // One startup observation per leader epoch, including when it fails.
  // Later uncertainty needs an actual GitHub event or explicit review command.
  if (githubJobs) work.addDeadline('repository.startupRepair', async () => {
    await backgroundJobs.run('github-mergeability', () => githubJobs.refreshStaleMergeability());
  });
  const voiceDeadlines=new BackgroundRecordDeadlines('voice-call-recovery',work,()=>leader.wake());
  const stopVoiceDeadlines=voiceDeadlines.subscribe();
  registerBackgroundDeadlineFamilies(work,repairDeadlineFamilies(jobsDatabase,{
    live,phone,mediaExpiry,institutionalMemory,institutionalAnchors,voice,voiceDeadlines,
  }),(name,run)=>backgroundJobs.run(name,run),jobsDatabase);
  const leader = new BackgroundLeader(jobsDatabase, (newLeader, signal) => work.run(newLeader, signal));
  const wakeWork = (name: string, source = name) => { work.wake(name, source); leader.wake(); };
  const stopBackgroundSources=subscribeBackgroundFamilies(jobsDatabase,live,backgroundSourceFamilies(),name=>wakeWork(name,'committed-family-source'));
  const wakeSystemDms=()=>wakeWork('operator-system-dms','committed-system-dm');
  const wakeConnectorOffers = () => wakeWork('connector-offer-expiry', 'connector-offer-source');
  const stopConnectorOfferWake = subscribeCommandCompletion(CONNECTOR_OFFER_DUE_KEY, wakeConnectorOffers);
  const stopConnectorOfferRecovery = jobsDatabase.onRecovery(wakeConnectorOffers);
  const stopConnectorOfferResync = live.subscribeResync(wakeConnectorOffers);
  const wakeDisplayDeadlines = () => wakeWork('deadlines', 'display-deadline');
  const stopDisplayDeadline = subscribeCommandCompletion(DISPLAY_DEADLINE_KEY, wakeDisplayDeadlines);
  const stopDisplayRecovery = jobsDatabase.onRecovery(wakeDisplayDeadlines);
  const stopDisplayResync = live.subscribeResync(wakeDisplayDeadlines);
  const wakeSentry = () => wakeWork('sentry', 'sentry-eligibility');
  const stopSentryRecipient = subscribeCommandCompletion(sentryEligibilityKey(sentryWakeAgentId), wakeSentry);
  const stopSentryRoom = subscribeCommandCompletion(sentryEligibilityKey('sentry'), wakeSentry);
  const stopSentryRecovery = jobsDatabase.onRecovery(wakeSentry);
  const stopSentryResync = live.subscribeResync(wakeSentry);
  const wakeChoices = () => wakeWork('choices', 'choice-expiry');
  const wakeAttachments = () => wakeWork('pending-attachment-cleanup', 'attachment-source');
  const stopAttachmentWake = subscribeCommandCompletion(PENDING_ATTACHMENT_DUE_KEY, wakeAttachments);
  const stopAttachmentRecovery = jobsDatabase.onRecovery(wakeAttachments);
  const stopAttachmentResync = live.subscribeResync(wakeAttachments);
  const wakeSchedules = () => wakeWork('schedules', 'schedule-source');
  const stopScheduleWake = subscribeCommandCompletion(AGENT_SCHEDULE_DUE_KEY, wakeSchedules);
  const stopScheduleRecovery = jobsDatabase.onRecovery(wakeSchedules);
  const stopScheduleResync = live.subscribeResync(wakeSchedules);
  const stopChoiceWake = subscribeCommandCompletion({ principal: 'choice', operation: 'expiry', commandId: 'pending' }, wakeChoices);
  const stopChoiceRecovery = jobsDatabase.onRecovery(wakeChoices);
  const stopSystemDmWake=subscribeOperatorSystemDmDeliveries(wakeSystemDms);
  const stopSystemDmRecovery=jobsDatabase.onRecovery(wakeSystemDms);
  if (push) liveListener.setPushWake(() => wakeWork('push'));
  liveListener.setXSignupDeliveryWake(()=>wakeWork('x-conversions','signup-delivery'));
  liveListener.setOwedWake((source) => { if (source === 'sentry') wakeWork('sentry', source); });
  // Receiver latency must not block unrelated leader jobs. Existing atomic
  // per-delivery claims serialize overlapping instances and rolling versions.
  const mcpWork = new BackgroundWork();
  const mcpStop = new AbortController();
  mcpWork.addDeadline('mcp-webhooks', async () => {
    const result = await backgroundJobs.run('mcp-webhooks', () => runMcpWebhookDelivery(jobsDatabase, undefined, 50, mcpStop.signal));
    if (result.ok) return result.value;
  });
  const stopMcpWebhooks = startBackgroundWork(mcpWork, run => {
    const wake = () => { mcpWork.wake('mcp-webhooks'); run(); };
    liveListener.setMcpWebhookWake(wake);
    const recovery = jobsDatabase.onRecovery(wake);
    const resync = live.subscribeResync(wake);
    return () => { recovery(); resync(); liveListener.setMcpWebhookWake(() => {}); };
  });
  // A committed wake for a sleeping free agent starts its Machine at once;
  // the leader sweep retries anything this misses.
  const stopFreeAgentWake = freeAgents?.subscribeToWakes(live);
  const port = Number(process.env.PORT ?? '8080');
  const host = process.env.HOST ?? '127.0.0.1';
  await listenAfterBestEffortRecovery(server, async () => {
    await clearStalePhoneViews(database, connectionPresence.instanceId);
    await connectionPresence.renewLease();
    await connectionPresence.start();
  }, port, host);
  void leader.run();
  const stopOperationOutcomes = startOperationOutcomeFlush(jobsDatabase, operationOutcomes, backgroundJobs, wake => jobsDatabase.onRecovery(wake));
  const stopComputerExpiry = startComputerExpirySweep(database, live);
  console.log(`[server] listening on ${host}:${port}; store=postgres; background=advisory-lock`);
  const stop = async () => {
    mcpStop.abort();
    const mcpStopped = stopMcpWebhooks();
    stopSystemDmWake();stopSystemDmRecovery();
    stopConnectorOfferWake();stopConnectorOfferRecovery();stopConnectorOfferResync();
    stopSentryRecipient();stopSentryRoom();stopSentryRecovery();stopSentryResync();
    stopChoiceWake();stopChoiceRecovery();
    stopAttachmentRecovery();stopAttachmentResync();stopAttachmentWake();
    stopScheduleRecovery();stopScheduleResync();stopScheduleWake();
    await leader.stop();
    stopBackgroundSources();
    stopVoiceDeadlines();
    // The provider flight intentionally does not block unrelated leader jobs.
    // Once leadership admissions stop, drain its final receipt before pools close.
    await nextDayCheckinRunning;
    await mcpStopped;
    stopComputerExpiry();
    stopDisplayDeadline();stopDisplayRecovery();stopDisplayResync();
    stopFreeAgentWake?.();
    await voice?.close();
    await connectionPresence.stop();
    await liveListener.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopOperationOutcomes();
    await mountedAuth.close();
    await Promise.all([github?.stopCheckRefreshes(), githubJobs?.stopCheckRefreshes()]);
    await Promise.all([
      database.close(),
      enrichmentDatabase.close(),
      healthDatabase.close(),
      jobsDatabase.close(),
    ]);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

/** Operator creation or release-time warming, using the normal free-agent service. */
async function runFreeAgentOperation(refresh: boolean, workspaceId: string | undefined): Promise<void> {
  if (!refresh && !workspaceId) throw new Error('--add-free-agent requires a Workspace id');
  const config = freeAgentConfigFromEnv(process.env, required('PUBLIC_ORIGIN'));
  if (!config) throw new Error('free agents are not configured on this server');
  const database = new PostgresDatabase(required('DATABASE_URL'), 1, { mode: 'long-running' });
  try {
    const service = new FreeAgentService(
      database,
      config,
      new FlyMachines(
        required('FLY_FREE_AGENT_API_TOKEN'),
        process.env.FLY_FREE_AGENT_APP || 'beeline-free-agents',
        fetch,
        process.env.FLY_FREE_AGENT_API_ORIGIN || undefined,
      ),
      async () => {
        throw new Error('bootstrap is served by the running server');
      },
    );
    if (refresh) {
      await service.refreshSleepingMachines();
      return;
    }
    const agentId = await addFreeAgentToWorkspace(database, service, workspaceId!);
    console.log(agentId
      ? `[free-agents] added free agent ${agentId} to Workspace ${workspaceId}`
      : `[free-agents] Workspace ${workspaceId} already has a free agent, or its owner is at the limit`);
  } finally {
    await database.close();
  }
}

async function runWelcomeRetirementPreflight(): Promise<void> {
  const database = new PostgresDatabase(required('MIGRATION_DATABASE_URL'), 1, {
    mode: 'long-running',
  });
  try {
    console.log(JSON.stringify(await welcomeRetirementPreflight(database), null, 2));
  } finally {
    await database.close();
  }
}

const migrationMode =
  process.argv[2] === '--migrate' || process.argv[2] === '--welcome-retirement-preflight' ||
  process.argv[2] === '--add-free-agent' || process.argv[2] === '--refresh-free-agents';
(process.argv[2] === '--welcome-retirement-preflight'
  ? runWelcomeRetirementPreflight()
  : process.argv[2] === '--add-free-agent' || process.argv[2] === '--refresh-free-agents'
    ? runFreeAgentOperation(process.argv[2] === '--refresh-free-agents', process.argv[3])
  : migrationMode
    ? runReleaseMigration()
    : main()
).catch(async (error) => {
  console.error(
    migrationMode ? '[migration] failed:' : '[server] startup failed:',
    error instanceof Error ? error.message : String(error),
    (error as { code?: unknown } | null)?.code ?? '',
  );
  captureServerError(error);
  await flushServerErrors();
  process.exitCode = 1;
});
