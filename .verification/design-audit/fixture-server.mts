/**
 * A local Beeline monolith, seeded with one Workspace of readable content, so
 * every signed-in phone and desktop surface can be opened and photographed
 * without a production account.
 *
 * It reuses the server's own test-support Postgres (PGlite) and the same
 * wiring `apps/server/src/integration.test.ts` builds, then writes rows that
 * exercise the surfaces DESIGN.md governs: a Room index with several kinds of
 * row, a transcript carrying every message presentation, a corner with an
 * objective, agents with server-assigned faces, and a Members roster.
 *
 * Run:  node --import tsx .verification/design-audit/fixture-server.mts
 * It prints one JSON line with the origin and the session tokens the browser
 * needs in sessionStorage, then stays up until killed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

import { migrate } from '../../apps/server/src/database.js';
import { MemoryObjectStorage, PgliteDatabase } from '../../apps/server/src/test-support.js';
import { ObjectService } from '../../apps/server/src/object-service.js';
import { TokenAuth } from '../../apps/server/src/auth.js';
import { PhoneService } from '../../apps/server/src/phone-service.js';
import { DaemonService } from '../../apps/server/src/daemon-service.js';
import { LiveHub } from '../../apps/server/src/live.js';
import { createBeelineServer } from '../../apps/server/src/server.js';
import { GitHubOperations } from '../../apps/server/src/github-operations.js';
import { createMonolithAuth } from '../../apps/server/src/monolith-auth.js';
import { ReviewAccess } from '../../apps/server/src/review-access.js';
import {
  ensureConnectorDirectMessageRoom,
  connectorIdentityId,
} from '../../apps/server/src/workbench.js';
import { ensureSystemDirectMessageRoom } from '../../apps/server/src/system-line.js';
import { SYSTEM_IDENTITY_ID } from '../../packages/api-contract/src/system-identity.js';

const WEB_ORIGIN = process.env.AUDIT_WEB_ORIGIN ?? 'http://localhost:8081';
const PORT = Number(process.env.AUDIT_SERVER_PORT ?? 4310);

const uuid = () => randomUUID();
const messageId = (seed: string) => createHash('sha256').update(seed).digest('hex');

const database = new PgliteDatabase();
await migrate(database);

const objectStorage = new MemoryObjectStorage();
await objectStorage.listen();
const objectService = new ObjectService(
  database,
  objectStorage.asStorage(),
  'http://placeholder',
  1024 * 1024,
);

const auth = new TokenAuth(database, async (proof) => {
  const login = proof === 'proof' ? 'lunchboxfortwo' : proof;
  return { subject: login, login, name: login === 'lunchboxfortwo' ? 'Alan' : login };
});

const githubOperations = new GitHubOperations(
  database,
  {
    authorizationUrl: () => 'https://github.test/authorize',
    exchangeCode: async () => ({
      issuer: 'https://github.com' as const,
      audience: 'oauth-client-id',
      subject: 'lunchboxfortwo',
      login: 'lunchboxfortwo',
      displayName: 'Alan',
      accessToken: 'github-user-token',
    }),
  } as never,
  {
    deleteBranch: async () => undefined,
    mergePullRequest: async () => undefined,
    installationToken: async () => ({ token: 't', expiresAt: '2030-01-01T00:00:00Z' }),
    readCommitCheckRollup: async () => ({ state: 'passed', total: 3, failing: [], checks: [] }),
  } as never,
  'github-client-secret',
);

const phone = new PhoneService(
  database,
  'http://placeholder',
  githubOperations,
  async () => undefined,
  undefined,
  false,
  database,
  objectService,
);
const live = new LiveHub();
const daemon = new DaemonService(database, live, async () => ({
  token: 'github-room-token',
  expiresAt: Date.now() + 60_000,
}));

const mountedAuth = await createMonolithAuth(database, `http://127.0.0.1:${PORT}`, undefined, {
  createDaemonExchange: (agentId, transaction) => auth.createDaemonExchange(agentId, transaction),
  env: {
    NODE_ENV: 'test',
    BUZZY_AUTH_TENANTS_JSON: JSON.stringify([
      {
        host: `127.0.0.1:${PORT}`,
        community: 'design-audit',
        roomCommunityIds: ['design-audit'],
        origin: `http://127.0.0.1:${PORT}`,
      },
    ]),
    BUZZY_AUTH_OIDC_ISSUER: 'https://accounts.example',
    BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
    BUZZY_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
    BUZZY_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
    BUZZY_AUTH_OIDC_CLIENT_ID: 'test-client',
  },
});

// The phone has no way to finish a real GitHub browser round trip against a
// fixture, so the audit device signs in through the product's own
// `/review/<secret>` route. The redeemed identity is the seeded viewer rather
// than the Play reviewer, so the device lands in the Workspace this file wrote.
const REVIEW_SECRET = 'design-audit-review-secret-0001';
const review = new ReviewAccess({
  secret: REVIEW_SECRET,
  mint: () => auth.exchangeGitHubOidc('proof'),
  // The walk signs in far more often than a store reviewer would; the
  // production limiter (10 per 10 minutes) locks the audit out mid-sweep.
  maxAttemptsPerWindow: 10_000,
});

const server = createBeelineServer({
  database,
  auth,
  review,
  phone,
  daemon,
  live,
  authHandler: mountedAuth.handle,
  mediaMaximumBytes: 1024 * 1024,
  objectService,
  webAppOrigins: [WEB_ORIGIN, 'http://127.0.0.1:8081'],
  github: {
    webhookSecret: 'webhook-secret',
    roomToken: async () => ({ token: 'github-room-token', expiresAt: Date.now() + 60_000 }),
    completeInstallation: async () => 'beeline://buzz/github-installation?installed=1',
    onWebhook: async () => undefined,
  },
} as never);

const BIND = process.env.AUDIT_SERVER_BIND ?? '127.0.0.1';
const REACHABLE_HOST = process.env.AUDIT_SERVER_HOST ?? '127.0.0.1';
await new Promise<void>((resolve) => server.listen(PORT, BIND, resolve));
const origin = `http://${REACHABLE_HOST}:${(server.address() as AddressInfo).port}`;
(phone as unknown as { publicOrigin: string }).publicOrigin = origin;
(objectService as unknown as { publicOrigin: string }).publicOrigin = origin;

// ---- identities -----------------------------------------------------------
// The browser also holds a local nostr key, and the two must be the same
// identity or the viewer reads their own messages as somebody else's. Pin the
// GitHub link to the key the audit driver seeds so the exchange reuses it.
const VIEWER_PUBKEY =
  process.env.AUDIT_VIEWER_PUBKEY ??
  'b474ab43ee923b99ff8dd9e47e67a81fcc8f3ea514475b9739e958bbf1122cbc';
await database.query(
  `INSERT INTO identities(id,kind,name,handle,face_id)
   VALUES($1,'human','Alan','lunchboxfortwo','bear') ON CONFLICT(id) DO NOTHING`,
  [VIEWER_PUBKEY],
);
await database.query(
  `INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
   VALUES('github','lunchboxfortwo',$1,'https://github.com','oauth-client-id','lunchboxfortwo')
   ON CONFLICT(provider,subject) DO NOTHING`,
  [VIEWER_PUBKEY],
);

const tokens = await auth.exchangeGitHubOidc('proof');
const VIEWER = tokens.identityId;
const PEER = (await auth.exchangeGitHubOidc('chloropine')).identityId;
const VIEWER_ROLE = process.env.AUDIT_VIEWER_ROLE === 'member' ? 'member' : 'owner';
const PEER_ROLE = VIEWER_ROLE === 'owner' ? 'member' : 'owner';
const AGENT_OWNER = process.env.AUDIT_AGENT_OWNER === 'peer' ? PEER : VIEWER;

const AGENT_NIGLET = 'a'.repeat(64);
const AGENT_SOL = 'b'.repeat(64);
await database.query(
  `INSERT INTO identities(id,kind,name,handle,face_id)
   VALUES($1,'agent','Niglet','niglet','fox'),
         ($2,'agent','Sol','sol','owl')
   ON CONFLICT(id) DO NOTHING`,
  [AGENT_NIGLET, AGENT_SOL],
);
await database.query(
  `INSERT INTO agents(agent_id,owner_id,selected_model,selected_effort)
   VALUES($1,$3,'claude-opus-5','high'),($2,$3,'claude-sonnet-5','medium')
   ON CONFLICT(agent_id) DO NOTHING`,
  [AGENT_NIGLET, AGENT_SOL, AGENT_OWNER],
);

// ---- workspace, rooms -----------------------------------------------------
const WORKSPACE = uuid();
const ROOM = uuid();
const ROOM_QUIET = uuid();
const CORNER = uuid();
const DM = uuid();

await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline')`, [WORKSPACE]);
await database.query(
  `INSERT INTO rooms(id,workspace_id,created_by,name,about,repository_name,repository_resolution,visibility)
   VALUES($1,$3,$4,'ship-the-slab',NULL,'lunchboxfortwo/beeline','repository','public'),
         ($2,$3,$4,'design-notes',NULL,NULL,'none','public')`,
  [ROOM, ROOM_QUIET, WORKSPACE, VIEWER],
);
await database.query(
  `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,direct_participants)
   VALUES($1,$2,$3,'direct','public',$4::jsonb)`,
  [DM, WORKSPACE, VIEWER, JSON.stringify([VIEWER, PEER].sort())],
);
await database.query(
  `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name,visibility)
   VALUES($1,$2,$3,$4,'audit-every-surface','public')`,
  [CORNER, WORKSPACE, ROOM, VIEWER],
);

const members: [string, string | null, string, string][] = [
  [WORKSPACE, null, VIEWER, VIEWER_ROLE],
  [WORKSPACE, null, PEER, PEER_ROLE],
  [WORKSPACE, null, AGENT_NIGLET, 'member'],
  [WORKSPACE, null, AGENT_SOL, 'member'],
  [WORKSPACE, ROOM, VIEWER, 'owner'],
  [WORKSPACE, ROOM, PEER, 'member'],
  [WORKSPACE, ROOM, AGENT_NIGLET, 'member'],
  [WORKSPACE, ROOM, AGENT_SOL, 'member'],
  [WORKSPACE, ROOM_QUIET, VIEWER, 'owner'],
  [WORKSPACE, CORNER, VIEWER, 'owner'],
  [WORKSPACE, CORNER, AGENT_NIGLET, 'member'],
  [WORKSPACE, DM, VIEWER, 'owner'],
  [WORKSPACE, DM, PEER, 'member'],
];
for (const [workspace, room, identity, role] of members) {
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`,
    [workspace, room, identity, role],
  );
}

// AUDIT_AGENT_PROFILES=1 adds the three agent profiles the captain photographed:
// Candy and Charles owned by the viewer (the owner's edit view), BBC owned by
// the peer (a Workspace manager's view). Charles runs Cursor, whose own catalog
// carries GPT models beside Claude ones — enough rows to prove the bounded list.
if (process.env.AUDIT_AGENT_PROFILES === '1') {
  const [candy, bbc, charles] = ['c', 'd', 'e'].map((char) => char.repeat(64));
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,face_id)
     VALUES($1,'agent','Candy','candy','cat'),($2,'agent','BBC','bbc','heron'),
           ($3,'agent','Charles','charles','bear')
     ON CONFLICT(id) DO NOTHING`,
    [candy, bbc, charles],
  );
  const catalog = (ids: string[], current: string) =>
    JSON.stringify([
      {
        id: 'model',
        category: 'model',
        currentValue: current,
        options: ids.map((id) => ({ id, name: id })),
      },
      {
        id: 'reasoning_effort',
        category: 'reasoning_effort',
        currentValue: 'high',
        options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
      },
    ]);
  const cursorModels = [
    'claude-opus-5-thinking-high',
    'claude-sonnet-5',
    ...['High', 'High Fast', 'Extra High', 'Extra High Fast', 'None', 'None Fast', 'Low'].map(
      (effort) => `GPT-5.6 Sol 1M ${effort}`,
    ),
    'GPT-5.6 Luna 1M High',
    'GPT-5.6 Sol 1M',
    'GPT-5.6 Sol 1M Max',
  ];
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model,selected_effort,model_catalog)
     VALUES($1,$4,'claude-opus-5','high',$5::jsonb),
           ($2,$6,'gpt-5.6-sol','high',$7::jsonb),
           ($3,$4,'claude-opus-5-thinking-high','high',$8::jsonb)
     ON CONFLICT(agent_id) DO NOTHING`,
    [
      candy,
      bbc,
      charles,
      VIEWER,
      catalog(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], 'claude-opus-5'),
      PEER,
      catalog(['gpt-5.6-sol', 'gpt-5.6-luna'], 'gpt-5.6-sol'),
      catalog(cursorModels, 'claude-opus-5-thinking-high'),
    ],
  );
  for (const agent of [candy, bbc, charles])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')
       ON CONFLICT DO NOTHING`,
      [WORKSPACE, agent],
    );
}

// The profile's read-only grant ledger shows the profiled member's settled
// grants: a repository grant is Workspace-visible, a personal-resource grant
// only to the agent's owner. One standing, one yolo-approved with an expiry,
// and one consumed `once`, so the row's provenance vocabulary is exercised.
await database.query(
  `INSERT INTO agent_grants(
     id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,decided_by,decided_at,expires_at,auto
   ) VALUES
     ($1,$4,$5,'repository','lunchboxfortwo/beeline','ship the profile audit',$6,$7,'approved',$8,now() - interval '2 days',NULL,false),
     ($2,$4,$5,'repository','Beeline-Work/beeline-web','open the docs PR without another card',$6,$7,'approved',$8,now() - interval '1 hour',now() + interval '6 hours',true),
     ($3,$4,$5,'repository','lunchboxfortwo/scratch','run the one-off migration once',$6,$7,'once',$8,now() - interval '30 minutes',NULL,false)`,
  [uuid(), uuid(), uuid(), AGENT_NIGLET, WORKSPACE, PEER, ROOM, VIEWER],
);

// ---- transcript -----------------------------------------------------------
type Row = {
  room: string;
  author: string;
  text: string;
  presentation?: 'message' | 'system' | 'activity' | 'card';
  activity?: unknown;
  cardType?: string;
  card?: unknown;
  systemEvent?: unknown;
  minutesAgo: number;
};

const rows: Row[] = [
  {
    room: ROOM,
    author: VIEWER,
    text: 'Audit every mobile and desktop surface against DESIGN.md. @niglet take it.',
    minutesAgo: 64,
  },
  {
    room: ROOM,
    author: AGENT_NIGLET,
    text: 'On it. I will walk the Room index, the transcript, the corners list, Members, and both Settings screens, then the desktop second pane.\n\nThe first pass is the index rows — state column, sigil, preview attribution, age stamp.',
    minutesAgo: 62,
  },
  {
    room: ROOM,
    author: AGENT_NIGLET,
    text: 'Walking the tokens first.',
    presentation: 'activity',
    // `phone-guards.activity` is the shape the client accepts: an ARRAY of
    // steps, kind in thinking|tool|output|summary, and every payload field a
    // plain string. Anything else fails `isRoomView` and blanks the surface.
    activity: [
      { kind: 'thinking', title: 'Reading the design tokens', thoughtMs: 6_000 },
      {
        kind: 'tool',
        title: 'npm run typecheck',
        operation: 'ran',
        command: 'npm run typecheck',
        output: 'Tasks:    7 successful, 7 total\nTime:    41.2s',
        status: 'success',
      },
      {
        kind: 'tool',
        title: 'apps/mobile/sources/buzz/groknight.ts',
        operation: 'read',
        command: 'apps/mobile/sources/buzz/groknight.ts',
        output: 'export const groknight = { radius: 3, ... }',
        status: 'success',
      },
      {
        kind: 'tool',
        title: 'npx vitest run sources/buzz/calm-lint --reporter=verbose --coverage',
        operation: 'ran',
        command: 'npx vitest run sources/buzz/calm-lint --reporter=verbose --coverage',
        output:
          'FAIL  sources/buzz/calm-lint.design.test.ts\nbaseline count grew for _chat-surface.tsx',
        status: 'error',
      },
    ],
    minutesAgo: 60,
  },
  {
    room: ROOM,
    author: AGENT_NIGLET,
    text: 'Here is the token the whole slab hangs off:\n\n```ts\nexport const groknight = {\n  radius: 3,\n  canvas: "#14091A",\n  brass: "#b08a4a",\n};\n```\n\nEverything else is built from it.',
    minutesAgo: 56,
  },
  {
    room: ROOM,
    author: PEER,
    text: 'Does the corners door still read at the same mark-size as the overflow dots?',
    minutesAgo: 40,
  },
  {
    room: ROOM,
    author: PEER,
    text: 'That was the September 20 captain note.',
    minutesAgo: 39,
  },
  {
    room: ROOM,
    author: AGENT_SOL,
    text: 'It does — the sigil takes the body role rather than the metadata role, so the two 44pt boxes read as siblings.',
    minutesAgo: 37,
  },
  {
    room: ROOM,
    author: VIEWER,
    text: 'Good. Keep the audit to what actually renders.',
    minutesAgo: 20,
  },
];

let index = 0;
for (const row of rows) {
  index += 1;
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,activity,created_at)
     VALUES($1,$2,$3,$4,$5,$6,now() - ($7 || ' minutes')::interval)`,
    [
      messageId(`audit-${index}`),
      row.room,
      row.author,
      row.text,
      row.presentation ?? 'message',
      row.activity ? JSON.stringify(row.activity) : null,
      String(row.minutesAgo),
    ],
  );
}

await database.query(
  `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
   VALUES($1,$2,$3,$4,'message',now() - interval '3 days')`,
  [messageId('dm-1'), DM, PEER, 'Can you look at the Bone canvas before the release?'],
);
await database.query(
  `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
   VALUES($1,$2,$3,$4,'message',now() - interval '12 minutes')`,
  [
    messageId('corner-1'),
    CORNER,
    AGENT_NIGLET,
    'Opened the corner and started the surface walk. The Room index and the transcript are photographed; Members and Settings are next.',
  ],
);

const botRooms: Record<string, string> = {};
for (const kind of [
  'trusty-squire',
  'wallet',
  'tailscale',
  'google-gmail',
  'google-calendar',
  'google-drive',
  'google-youtube',
] as const) {
  const roomId = await ensureConnectorDirectMessageRoom(database, WORKSPACE, kind, VIEWER);
  botRooms[kind] = roomId;
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
     VALUES($1,$2,$3,$4,'message',now() - interval '1 minute')`,
    [
      messageId(`bot-${kind}`),
      roomId,
      connectorIdentityId(kind),
      kind === 'trusty-squire'
        ? 'Deployment finished.\nreceipt: Vercel · deploy · via Trusty Squire on squire-box · grant audit · 2 calls · 2.1 kB'
        : kind === 'wallet'
          ? 'Wallet is connected.\nreceipt: Coinbase Wallet · connect · via Wallet · 1 call'
          : `${kind} connection is ready.\nreceipt: ${kind} · connect · 1 call`,
    ],
  );
}
botRooms.system = await ensureSystemDirectMessageRoom(database, WORKSPACE, VIEWER);
await database.query(
  `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
   VALUES($1,$2,$3,$4,'message',now())`,
  [messageId('bot-system'), botRooms.system, SYSTEM_IDENTITY_ID, 'Workspace setup is complete.'],
);

const session = JSON.stringify(
  {
    origin,
    webOrigin: WEB_ORIGIN,
    identityId: VIEWER,
    viewerNsec:
      process.env.AUDIT_VIEWER_NSEC ??
      'nsec1444s5f36tte8gh457erxwr427kcwh3uqphrvhp4llmv4cgpglwysx7unnq',
    refreshToken: tokens.refreshToken,
    reviewSecret: REVIEW_SECRET,
    workspaceId: WORKSPACE,
    roomId: ROOM,
    quietRoomId: ROOM_QUIET,
    cornerId: CORNER,
    dmId: DM,
    botRooms,
    agents: { niglet: AGENT_NIGLET, sol: AGENT_SOL },
    viewerRole: VIEWER_ROLE,
  },
  null,
  2,
);
await writeFile(process.env.AUDIT_SESSION_FILE ?? '/tmp/audit-session.json', session);
console.log(session);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
await new Promise(() => {});
