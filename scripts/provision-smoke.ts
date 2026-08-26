#!/usr/bin/env node
/**
 * Provision a Buzz identity + Workspace-linked Room + long transcript for the emulator smoke test.
 */
import {
  createBuzzClient,
  createIdentity,
  identityNsec,
  identityNpub,
  KIND_AGENT_PRESENCE,
  loadIdentityFromNsec,
  TAG_AGENT_PRESENCE,
} from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const RELAY = process.env.RELAY_URL || 'https://usebeeline.app';
const FIXTURE_STATE_VERSION = 1;

type SmokeFixtureState = {
  version: typeof FIXTURE_STATE_VERSION;
  ownerNsec: string;
  workspaceId: string;
  switchWorkspaceId: string;
};

function fixtureStatePath(): string {
  if (process.env.MAESTRO_SMOKE_FIXTURE_STATE_FILE) {
    return process.env.MAESTRO_SMOKE_FIXTURE_STATE_FILE;
  }
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(stateRoot, 'beeline', 'maestro-smoke-fixture.json');
}

function parseFixtureState(raw: string, path: string): SmokeFixtureState {
  const parsed = JSON.parse(raw) as Partial<SmokeFixtureState>;
  if (
    parsed.version !== FIXTURE_STATE_VERSION ||
    !parsed.ownerNsec ||
    !parsed.workspaceId ||
    !parsed.switchWorkspaceId
  ) {
    throw new Error(`invalid Maestro smoke fixture state: ${path}`);
  }
  return parsed as SmokeFixtureState;
}

async function loadOrCreateFixtureState(): Promise<SmokeFixtureState> {
  const path = fixtureStatePath();
  try {
    return parseFixtureState(await readFile(path, 'utf8'), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const state: SmokeFixtureState = {
    version: FIXTURE_STATE_VERSION,
    ownerNsec: identityNsec(createIdentity('buzzy-smoke-fixture-owner')),
    workspaceId: randomUUID(),
    switchWorkspaceId: randomUUID(),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
    } finally {
      await file.close();
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return parseFixtureState(await readFile(path, 'utf8'), path);
  }
}

async function ensureCommunity(
  client: ReturnType<typeof createBuzzClient>,
  communityId: string,
  name: string,
  ownerPubkey: string,
): Promise<void> {
  const existing = await client.getCommunity(communityId);
  if (existing) {
    if (existing.ownerPubkey !== ownerPubkey) {
      throw new Error(`fixed smoke Workspace ${communityId} is owned by an unexpected key`);
    }
    return;
  }
  await client.createCommunity(name, { communityId });
  await client.waitUntilMember(communityId, ownerPubkey);
}

async function main() {
  // 1. Keep the device identity ephemeral, but reuse one runner-local fixture
  // owner and two fixed Workspace ids. Repeated smoke/canary runs may create
  // fresh Rooms, but they never mint another Workspace. The state file is a
  // test-only credential, created mode 0600 outside the checkout.
  const fixture = await loadOrCreateFixtureState();
  const identity = createIdentity('buzzy-smoke');
  const ownerIdentity = loadIdentityFromNsec(fixture.ownerNsec, 'buzzy-smoke-fixture-owner');
  console.log('Identity:');
  console.log('  NSEC:', identityNsec(identity));
  console.log('  NPUB:', identityNpub(identity));
  console.log('  Pubkey:', identity.publicKey);
  console.log('');

  // 2. Connect to relay
  const ownerClient = createBuzzClient({ baseUrl: RELAY, identity: ownerIdentity });
  await ownerClient.connect();
  await ensureCommunity(
    ownerClient,
    fixture.workspaceId,
    'Buzzy Maestro Smoke Workspace',
    ownerIdentity.publicKey,
  );
  await ensureCommunity(
    ownerClient,
    fixture.switchWorkspaceId,
    'Buzzy Maestro Switch Workspace',
    ownerIdentity.publicKey,
  );
  await ownerClient.addMember(fixture.workspaceId, identity.publicKey, 'member');
  await ownerClient.addMember(fixture.switchWorkspaceId, identity.publicKey, 'member');

  const client = createBuzzClient({ baseUrl: RELAY, identity });
  await client.connect();
  await client.waitUntilMember(fixture.workspaceId, identity.publicKey);
  await client.waitUntilMember(fixture.switchWorkspaceId, identity.publicKey);
  console.log('Connected to relay:', RELAY);

  // 3. Create the same Workspace → Room shape that the mobile list renders.
  // The Room stays per-run so identical device messages cannot collide across
  // canaries; both Workspaces above remain stable relay fixtures.
  const workspaceId = fixture.workspaceId;
  const switchWorkspaceId = fixture.switchWorkspaceId;
  const channelId = await ownerClient.createChannel('Buzzy Maestro Smoke Room', {
    communityId: workspaceId,
  });
  const switchChannelId = await ownerClient.createChannel('Buzzy Maestro Switch Room', {
    communityId: switchWorkspaceId,
  });
  await client.waitUntilMember(channelId, identity.publicKey);
  await client.waitUntilMember(switchChannelId, identity.publicKey);
  console.log('Workspace ready:', workspaceId);
  console.log('Switch-target Workspace ready:', switchWorkspaceId);
  console.log('Room created:', channelId);

  // A genuine registered agent participant gives the UI flow a mention target
  // and a current presence lease.
  const agentIdentity = createIdentity('buzzy-smoke-agent');
  const agentClient = createBuzzClient({ baseUrl: RELAY, identity: agentIdentity });
  await agentClient.connect();
  await ownerClient.addMember(workspaceId, agentIdentity.publicKey, 'member');
  await agentClient.waitUntilMember(workspaceId, agentIdentity.publicKey);
  await agentClient.createAgent(workspaceId, { displayName: 'Beebee' });
  await ownerClient.setAgentSoul(workspaceId, agentIdentity.publicKey, {
    name: 'Beebee',
    soul: 'Relay fixture. Verify mobile message delivery.',
    avatarSeed: 'smoke-beebee',
  });
  await ownerClient.addMember(channelId, agentIdentity.publicKey, 'member');
  await agentClient.waitUntilMember(channelId, agentIdentity.publicKey);
  const cornerId = await agentClient.createSubchannel(channelId, 'Smoke agent corner', {
    communityId: workspaceId,
  });
  await agentClient.messageSubmit(channelId, 'Beebee opened a corner for the smoke session.', {
    extraTags: [
      ['t', 'body-control'],
      ['subchannel', cornerId],
      ['session', 'smoke-corner-session'],
      ['agent', agentIdentity.publicKey],
      ['mode', 'edit'],
      ['status', 'working'],
    ],
  });
  await agentClient.messageSubmit(cornerId, 'I am ready for a steering message.');
  // Beebee's current lease renders a filled presence light. Add a separate
  // offline Agent so the device fixture also proves the hollow state without
  // relying on an unknown/not-yet-loaded presence record.
  const offlineAgentIdentity = createIdentity('buzzy-smoke-offline-agent');
  const offlineAgentClient = createBuzzClient({ baseUrl: RELAY, identity: offlineAgentIdentity });
  await offlineAgentClient.connect();
  await ownerClient.addMember(workspaceId, offlineAgentIdentity.publicKey, 'member');
  await offlineAgentClient.waitUntilMember(workspaceId, offlineAgentIdentity.publicKey);
  await offlineAgentClient.createAgent(workspaceId, { displayName: 'Milo' });
  await ownerClient.setAgentSoul(workspaceId, offlineAgentIdentity.publicKey, {
    name: 'Milo',
    soul: 'Offline relay fixture. Verify offline presence rendering.',
    avatarSeed: 'smoke-milo',
  });
  await ownerClient.addMember(channelId, offlineAgentIdentity.publicKey, 'member');
  await offlineAgentClient.waitUntilMember(channelId, offlineAgentIdentity.publicKey);
  const presenceAt = Math.floor(Date.now() / 1_000);
  await agentClient.publish(
    signEvent(
      {
        pubkey: agentIdentity.publicKey,
        created_at: presenceAt,
        kind: KIND_AGENT_PRESENCE,
        tags: [
          ['d', `${TAG_AGENT_PRESENCE}:${channelId}`],
          ['h', channelId],
          ['t', TAG_AGENT_PRESENCE],
          ['agent', agentIdentity.publicKey],
          ['status', 'online'],
        ],
        content: '',
      },
      agentIdentity.secretKey,
    ),
  );
  await offlineAgentClient.publish(
    signEvent(
      {
        pubkey: offlineAgentIdentity.publicKey,
        created_at: presenceAt,
        kind: KIND_AGENT_PRESENCE,
        tags: [
          ['d', `${TAG_AGENT_PRESENCE}:${channelId}`],
          ['h', channelId],
          ['t', TAG_AGENT_PRESENCE],
          ['agent', offlineAgentIdentity.publicKey],
          ['status', 'offline'],
        ],
        content: '',
      },
      offlineAgentIdentity.secretKey,
    ),
  );
  console.log('Agent and corner created:', cornerId);

  // 4. Post enough messages to overflow the compact emulator. This makes the
  // opening-position assertion exercise the real FlatList tail, rather than a
  // transcript where every message happens to fit on screen.
  for (let index = 1; index <= 14; index += 1) {
    await client.messageSubmit(channelId, `Smoke history ${index}: retained transcript message.`);
  }
  // Relay ordering is second-granular. Put the tail marker in the next second
  // so the chat-open assertion tests scrolling, not an arbitrary same-second
  // ordering of the seeded history.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const latestMessage = await client.messageSubmit(
    channelId,
    'SMOKE LATEST MESSAGE — chat opened at the end',
  );
  console.log('Smoke transcript posted.');

  // 5. Verify by backfilling
  const events = await client.sessionEventsBackfill(channelId, { limit: 5 });
  console.log(`Backfilled ${events.length} events:`);
  for (const e of events) {
    console.log(`  [${e.kind}] ${e.content?.slice(0, 60)}`);
  }

  console.log('\n--- Provisioning complete ---');
  console.log('Import this NSEC into the app:');
  console.log(identityNsec(identity));
  console.log('');
  console.log('Set relay URL to:', RELAY);
  console.log('');
  // Keep the human-friendly transcript above while giving the Maestro runner
  // stable values to pass through without parsing prose.
  console.log(`MAESTRO_SMOKE_NSEC=${identityNsec(identity)}`);
  // Hosted handles are globally unique. Tie this valid suggestion to the
  // freshly generated smoke identity so repeated governor runs cannot collide.
  console.log(`MAESTRO_SMOKE_HANDLE=smoke-${identity.publicKey.slice(0, 12)}`);
  console.log(`MAESTRO_SMOKE_WORKSPACE_ID=${workspaceId}`);
  console.log(`MAESTRO_SMOKE_SWITCH_WORKSPACE_ID=${switchWorkspaceId}`);
  console.log(`MAESTRO_SMOKE_SWITCH_ROOM_ID=${switchChannelId}`);
  console.log(`MAESTRO_SMOKE_ROOM_ID=${channelId}`);
  console.log(`MAESTRO_SMOKE_AGENT_NSEC=${identityNsec(agentIdentity)}`);
  console.log(`MAESTRO_SMOKE_CORNER_ID=${cornerId}`);
  console.log(`MAESTRO_SMOKE_LATEST_MESSAGE_ID=${latestMessage.id}`);

  client.disconnect();
  ownerClient.disconnect();
  offlineAgentClient.disconnect();
  agentClient.disconnect();
}

main().catch((err) => {
  console.error('Provisioning failed:', err);
  process.exit(1);
});
