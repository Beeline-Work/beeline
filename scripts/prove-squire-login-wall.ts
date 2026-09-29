#!/usr/bin/env node
/**
 * Live proof for the Squire login-wall handoff, on a real local server in
 * the Beeline Review Workspace.
 *
 * The scenario: an agent's in-task Squire call hits a stale/logged-out
 * Google session (`needs_user.wall === 'google_session'`) — a FAKE wall
 * posted straight to `postSquireLoginWall`, exactly the structured shape
 * `resource-mcp-facade.ts` reads off a real Squire MCP result. No real
 * Google, Squire, or captain sign-in is touched anywhere in this script —
 * only a real local HTTP server, a real embedded Postgres, and the Room-view
 * projection a phone would read.
 *
 * Shows: the reconnect card lands in the SAME Room, carries no "Add" ask
 * (it starts `connecting` with its connectorId already set — what already
 * drives the phone's in-app "Continue sign-in" ceremony screen), the
 * connector is re-armed with `force_relogin_provider` for Squire's own
 * `--force-relogin`, and once the helper's connected report lands
 * (`installConnector` — standing in for a real reconnect ceremony finishing)
 * the card settles and the SAME paused agent turn gets a `resume` command —
 * the existing connector-offer settle-in-place and hidden resume path,
 * unchanged.
 *
 * Local invocation:
 *   npm run prove:squire-login-wall
 */
import type { AddressInfo } from 'node:net';
import { createAgentCommand, claimAgentCommand } from '../apps/server/src/agent-command.js';
import { migrate } from '../apps/server/src/database.js';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { GitHubOperations } from '../apps/server/src/github-operations.js';
import {
  ensureReviewWorkspace,
  REVIEW_WORKSPACE_ID,
} from '../apps/server/src/review-proof-fixture.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

const OWNER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const ROOM = '22222222-2222-4222-8222-222222222222';

function line(label: string, value: string): void {
  process.stdout.write(`${label}: ${value}\n`);
}

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Review Owner','reviewowner'),($2,'agent','Ronnie','ronnie')`,
    [OWNER, AGENT],
  );
  await database.query(
    `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
     VALUES('github','proof-owner',$1,'https://github.com','beeline','reviewowner')`,
    [OWNER],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
  await ensureReviewWorkspace(database, OWNER);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,visibility) VALUES($1,$2,$3,'stuck task','public')`,
    [ROOM, REVIEW_WORKSPACE_ID, OWNER],
  );
  for (const who of [OWNER, AGENT])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`,
      [REVIEW_WORKSPACE_ID, ROOM, who, who === OWNER ? 'owner' : 'member'],
    );
  // Squire is ALREADY connected for this owner/agent — the scenario is a live
  // task hitting a stale session in the shared browser, not a missing tool.
  const connector = (
    await database.query<{ id: string }>(
      `INSERT INTO workspace_connectors(
         id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,status
       ) VALUES(gen_random_uuid(),$1,$2,'trusty-squire',$3,'proof-machine','connected')
       RETURNING id`,
      [REVIEW_WORKSPACE_ID, OWNER, AGENT],
    )
  ).rows[0]!;

  const auth = new TokenAuth(database, async () => ({
    subject: 'proof-owner',
    login: 'reviewowner',
    name: 'Review Owner',
  }));
  const app = {} as unknown as GitHubAppClient;
  const github = new GitHubOperations(database, {} as GitHubOAuthClient, app, 'client-secret');
  const phone = new PhoneService(database, 'http://placeholder', github);
  const live = new LiveHub();
  const daemon = new DaemonService(database, live);
  const server = createBeelineServer({
    database,
    auth,
    phone,
    daemon,
    live,
    mediaMaximumBytes: 1024 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const accessToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
  const exchange = await auth.createDaemonExchange(AGENT);
  const daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;

  const call = async (path: string, token: string, payload: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method: path.includes('phone/rooms/') && !path.includes('operations') ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(path.includes('phone/rooms/') && !path.includes('operations')
        ? {}
        : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${text}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  const daemonOperation = (name: string, payload: unknown) =>
    call(`/v1/daemon/operations/${name}`, daemonToken, payload);
  const readRoom = () =>
    call(`/v1/phone/rooms/${ROOM}`, accessToken, undefined) as Promise<{
      messages: Array<{
        connectorOffer?: Record<string, unknown>;
        text: string;
        systemEvent?: Record<string, unknown>;
      }>;
    }>;

  // The stuck agent turn: a message tagging Ronnie, and its claimed command —
  // the exact context a live Squire tool call runs inside.
  const sourceMessageId = 'f'.repeat(64);
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,'@ronnie sign up for the harmless test site','message')`,
    [sourceMessageId, ROOM, OWNER],
  );
  const command = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: AGENT,
    sourceMessageId,
    turnRequestId: 'proof-turn',
    reason: 'proof',
  });
  if (!command) fail('could not create the agent command the proof needs');
  await claimAgentCommand(database, ROOM, AGENT, command.id, 'proof-generation');

  line('setup', `Beeline Review Workspace room, Squire already connected (${connector.id})`);

  // The FAKE wall: exactly resource-mcp-facade.ts's squireLoginWallFromMcp
  // shape for needs_user.wall === 'google_session' — no real Squire call.
  const posted = (await daemonOperation('postSquireLoginWall', {
    roomId: ROOM,
    requestId: 'proof-turn',
    generationId: 'proof-generation',
    wall: 'google_session',
    message: 'no live Google session on the harmless-test-site.example signup page',
  })) as { cardPosted: boolean; offerId: string };
  if (!posted.cardPosted) fail('the google_session wall produced no card');
  line('posted', `card ${posted.offerId} (cardPosted=${posted.cardPosted})`);

  const afterPost = await readRoom();
  const card = afterPost.messages.find((message) => message.connectorOffer);
  if (!card?.connectorOffer) fail('no connector-offer card is visible in the Room view');
  const offer = card.connectorOffer;
  if (offer.status !== 'connecting' || offer.intent !== 'reconnect' || offer.provider !== 'google')
    fail(`card is not a straight-to-connecting reconnect offer: ${JSON.stringify(offer)}`);
  if (!offer.connectorId) fail('card carries no connectorId — the phone has nothing to continue');
  line('card', `status=${offer.status} intent=${offer.intent} provider=${offer.provider} connectorId=${offer.connectorId}`);
  line('card consequence', String(offer.consequence));
  line(
    'phone action',
    'no Add tap exists (status is already connecting) — only "Continue sign-in ›", opening the ceremony overlay (in-app WebView / WebBrowser.openBrowserAsync) exactly like an accepted connector offer',
  );

  const armed = await database.query<{ status: string; force_relogin_provider: string | null }>(
    `SELECT status,force_relogin_provider FROM workspace_connectors WHERE id=$1::uuid`,
    [connector.id],
  );
  if (armed.rows[0]?.status !== 'installing' || armed.rows[0]?.force_relogin_provider !== 'google')
    fail(`connector was not re-armed for a scoped Google reconnect: ${JSON.stringify(armed.rows[0])}`);
  line('connector re-armed', `status=${armed.rows[0]!.status} force_relogin_provider=${armed.rows[0]!.force_relogin_provider}`);

  const assignments = (await daemonOperation('getConnectorAssignments', {})) as {
    assignments: Array<{ kind: string; connectorId: string; forceReloginProvider?: string }>;
  };
  const install = assignments.assignments.find((entry) => entry.kind === 'install');
  if (install?.forceReloginProvider !== 'google')
    fail(`helper's install assignment did not carry --force-relogin=google: ${JSON.stringify(install)}`);
  line('helper assignment', `kind=install forceReloginProvider=${install.forceReloginProvider} (this is what installSquire turns into npx ... connect --target=codex --json --force-relogin=google)`);

  const before = await database.query(
    `SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action='resume'`,
    [ROOM, AGENT],
  );
  if (before.rowCount) fail('a resume command already exists before the ceremony completed');

  // Stand-in for the helper's real connect ceremony finishing (never a real
  // Google/Squire sign-in): the same daemon operation installSquire's success
  // path already calls.
  await daemonOperation('installConnector', { connectorId: connector.id });

  const settled = await readRoom();
  const settledCard = settled.messages.find((message) => message.connectorOffer);
  if (settledCard?.connectorOffer?.status !== 'accepted')
    fail(`card did not settle to accepted: ${JSON.stringify(settledCard?.connectorOffer)}`);
  line('card settled', `status=${settledCard.connectorOffer.status}`);

  const clearedFlag = await database.query<{ force_relogin_provider: string | null }>(
    `SELECT force_relogin_provider FROM workspace_connectors WHERE id=$1::uuid`,
    [connector.id],
  );
  if (clearedFlag.rows[0]?.force_relogin_provider !== null)
    fail('force_relogin_provider was not cleared after the ceremony settled');
  line('force_relogin_provider cleared', 'true — never sticks to a later, unrelated reconnect');

  const resume = await database.query<{ action: string; state: string }>(
    `SELECT action,state FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action='resume'`,
    [ROOM, AGENT],
  );
  if (resume.rows.length !== 1 || resume.rows[0]!.state !== 'pending')
    fail(`the stuck agent turn was not resumed: ${JSON.stringify(resume.rows)}`);
  line('agent resumed', 'agent_commands carries one pending resume command for Ronnie — the existing connector-offer settle-in-place and hidden resume path');

  server.close();
  line(
    'observable',
    'a Squire google_session wall posts a reconnect card in the SAME Room with no Add step, the connector is force-relogin re-armed, and the helper reporting connected settles the card and resumes the exact stuck turn',
  );
}

void main();
