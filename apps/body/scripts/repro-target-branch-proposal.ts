#!/usr/bin/env -S node --import tsx
/**
 * End-to-end repro of the chat-native target-branch flow, from the exact live
 * phrasing that used to fall through it.
 *
 *   npm run repro:target-branch -w @beeline/body
 *
 * Half one (here): drive a real `Body`'s Room turn with
 * "from now on land changes to a branch called staging instead of master"
 * against a stubbed relay, and capture what it publishes. Nothing is mocked
 * about the daemon's own decision path — the intent recognizer, the
 * current-target re-read, and `postControlMessage` all run for real.
 *
 * Half two: hand the CAPTURED event to the mobile client's typed read-model
 * parser and projection and print the card it renders.
 *
 * Exits non-zero if either half fails, so it is usable as a check.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '@beeline/gate';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { Body, type BodyConfig } from '../src/body.js';

const LIVE_PHRASING = 'from now on land changes to a branch called staging instead of master';
const ROOM_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const REPOSITORY_KEY = 'repo-key-target-branch';
const KIND_CHANNEL_ADMINS = 39_001;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const admin = newIdentity('target-branch-admin');

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Room state as it really sits on the relay: master today, admin-authored. */
function roomRepositoryEvent(): NostrEvent {
  return signEvent(
    {
      pubkey: admin.publicKey,
      created_at: 1_700_000_500,
      kind: 30_078,
      tags: [
        ['d', `buzz-room-repository:${ROOM_ID}`],
        ['h', ROOM_ID],
        ['t', 'buzz-room-repository'],
      ],
      content: JSON.stringify({
        key: REPOSITORY_KEY,
        name: 'buzzy',
        remote: 'https://github.com/lunchboxfortwo/buzzy',
        localOnly: false,
        targetBranch: 'master',
      }),
    },
    admin.secretKey,
  );
}

const published: NostrEvent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).endsWith('/events')) {
    published.push(JSON.parse(String(init?.body)) as NostrEvent);
    return json({ accepted: true });
  }
  const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
  const kind = (filter.kinds as number[] | undefined)?.[0];
  if (kind === 30_078) return json([roomRepositoryEvent()]);
  if (kind === KIND_CHANNEL_ADMINS) {
    return json([
      signEvent(
        {
          pubkey: admin.publicKey,
          created_at: 1_700_000_000,
          kind: KIND_CHANNEL_ADMINS,
          tags: [
            ['d', ROOM_ID],
            ['p', admin.publicKey, '', 'admin'],
          ],
          content: '',
        },
        admin.secretKey,
      ),
    ]);
  }
  return json([]);
}) as typeof fetch;

const workspaceRoot = mkdtempSync(join(tmpdir(), 'repro-target-branch-'));
const config: BodyConfig = {
  agentBinary: '/nonexistent',
  mcpBinary: '/nonexistent',
  agentEnv: {},
  workspaceRoot,
  relayBaseUrl: 'http://relay.test',
  relayHost: 'relay.test',
  relayScheme: 'http',
  relayWsUrl: 'ws://relay.test',
  autoApprovePermissions: true,
};

let failed = false;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
  if (!ok) failed = true;
}

try {
  const body = new Body(config);
  console.log(
    `\n[1] Room turn — a person says, in a Room that lands to master:\n    "${LIVE_PHRASING}"\n`,
  );

  const handled = (await Reflect.get(body, 'replyInRoom').call(
    body,
    ROOM_ID,
    { repo: 'buzzy', repositoryKey: REPOSITORY_KEY, targetBranch: 'refs/heads/master' },
    {
      eventId: 'live-request',
      authorPubkey: admin.publicKey,
      content: LIVE_PHRASING,
      createdAt: 1,
    },
  )) as { openedCorner: boolean; producedReply: boolean };

  const cards = published.filter((event) =>
    (event.tags ?? []).some((tag) => tag[0] === 't' && tag[1] === 'buzz-target-branch-proposal'),
  );
  check('the turn opened no corner and started no work', handled.openedCorner === false);
  check('the daemon published exactly one proposal control event', cards.length === 1);
  check(
    "and authored NO Room→repository binding (that is the admin key's alone)",
    published.filter((event) => event.kind === 30_078).length === 0,
  );
  const card = cards[0];
  if (!card) throw new Error('no proposal control event was published');
  console.log('\n    published control event:');
  console.log(
    JSON.stringify(
      { kind: card.kind, pubkey: card.pubkey, content: card.content, tags: card.tags },
      null,
      2,
    )
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  );

  const capturePath = join(workspaceRoot, 'proposal-event.json');
  writeFileSync(capturePath, JSON.stringify(card));

  console.log("\n[2] Client — the same event through the mobile app's own projection:\n");
  const client = spawnSync(
    join(repoRoot, 'apps/mobile/node_modules/.bin/tsx'),
    [join(repoRoot, 'apps/mobile/scripts/repro-target-branch-card.ts'), capturePath],
    { cwd: join(repoRoot, 'apps/mobile'), stdio: 'inherit' },
  );
  check('the client renders a target-branch proposal card from it', client.status === 0);
} finally {
  rmSync(workspaceRoot, { recursive: true, force: true });
}

console.log(failed ? '\nREPRO FAILED\n' : '\nREPRO OK\n');
process.exit(failed ? 1 : 0);
