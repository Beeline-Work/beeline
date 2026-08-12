/** Production-relay proof for Room conversation, explicit work, and parent status. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BASE_URL,
  HOST,
  createChannel,
  git,
  newIdentity,
  setMemberRole,
} from '@beeline/gate';
import { createBuzzClient } from '@beeline/buzz-client';
import { AGENT_REQUEST_TAG, Body } from './body.js';
import { loadBodyConfig } from './config.js';
import { resolveAgentCommand, type AgentKind } from './agent-command.js';

const selectedKind = (process.env.BUZZY_LIVE_AGENT_KIND ?? 'codex') as AgentKind;
let workspace = '';
let remote = '';
let body: Body | undefined;

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/health`, {
      headers: { host: HOST },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function runtimeAvailable(): boolean {
  try {
    resolveAgentCommand({ kind: selectedKind });
    return selectedKind !== 'reference';
  } catch {
    return false;
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

const live = (await reachable()) && runtimeAvailable();

describe.runIf(live)('production Room conversation contract', () => {
  const human = newIdentity('room-conversation-human');
  const agent = newIdentity('room-conversation-agent');
  const colleague = newIdentity('room-conversation-colleague');
  const roomIdPromise = createChannel(human, `room-conversation-${Date.now()}`);
  let roomId = '';
  let client: ReturnType<typeof createBuzzClient>;

  beforeAll(async () => {
    roomId = await roomIdPromise;
    await setMemberRole(human, roomId, agent.publicKey, 'member');
    workspace = await mkdtemp(resolve(tmpdir(), 'beeline-room-conversation-'));
    remote = await mkdtemp(resolve(tmpdir(), 'beeline-room-remote-'));
    git(workspace, ['init', '-q', '-b', 'main']);
    await writeFile(resolve(workspace, 'README.md'), '# Room conversation live proof\n');
    git(workspace, ['add', 'README.md']);
    git(workspace, ['commit', '-m', 'seed live proof']);
    git(remote, ['init', '--bare', '-q']);
    git(workspace, ['remote', 'add', 'origin', remote]);
    const seed = git(workspace, ['push', '-u', 'origin', 'main']);
    if (!seed.ok) throw new Error(seed.stderr);

    const config = loadBodyConfig({
      workspaceRoot: workspace,
      agent: resolveAgentCommand({ kind: selectedKind }),
    });
    body = new Body(config, human, agent);
    client = createBuzzClient({ baseUrl: BASE_URL, identity: human });
    await waitUntil(() => client.isMember(roomId, agent.publicKey));
    await body.provision(roomId, {
      repo: 'room-conversation',
      localPath: workspace,
      remoteName: 'origin',
      targetBranch: 'refs/heads/main',
      localOnly: true,
    });
  }, 60_000);

  afterAll(async () => {
    client?.disconnect();
    if (body) await body.dispose();
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (remote) await rm(remote, { recursive: true, force: true });
  }, 30_000);

  const binding = () => ({
    repo: 'room-conversation',
    localPath: workspace,
    remoteName: 'origin',
    targetBranch: 'refs/heads/main',
    localOnly: true,
  });

  async function messages() {
    return client.sessionEventsBackfill(roomId, { limit: 500 });
  }

  it('replies to chat and architecture questions in the Room with zero corners', async () => {
    const greeting = await client.messageSubmit(roomId, "Hey @Agent what's up", {
      mentionAgent: agent.publicKey,
    });
    expect(await body!.pollChannelRequests(roomId, binding())).toBe(0);
    await waitUntil(async () =>
      (await messages()).some(
        (event) =>
          event.pubkey === agent.publicKey &&
          event.event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message') &&
          event.event.tags.some((tag) => tag[0] === 'e' && tag[1] === greeting.id),
      ),
    );
    expect(await client.listSubchannels(roomId)).toHaveLength(0);

    const architecture = await client.messageSubmit(
      roomId,
      'In one sentence, what is the purpose of a repository Room?',
    );
    expect(await body!.pollChannelRequests(roomId, binding())).toBe(0);
    await waitUntil(async () =>
      (await messages()).some((event) =>
        event.event.tags.some((tag) => tag[0] === 'e' && tag[1] === architecture.id),
      ),
    );
    expect(await client.listSubchannels(roomId)).toHaveLength(0);
    console.log('[room-conversation] greeting=REPLIED architecture=REPLIED corners=0');
  }, 240_000);

  it('ignores unmentioned multi-party chat and answers only a named mention', async () => {
    await setMemberRole(human, roomId, colleague.publicKey, 'member');
    await waitUntil(() => client.isMember(roomId, colleague.publicKey));
    const before = (await messages()).filter((event) => event.pubkey === agent.publicKey).length;
    await client.messageSubmit(roomId, 'General note for the people in this Room.');
    expect(await body!.pollChannelRequests(roomId, binding())).toBe(0);
    expect((await messages()).filter((event) => event.pubkey === agent.publicKey)).toHaveLength(
      before,
    );

    const mentioned = await client.messageSubmit(roomId, '@Agent please reply briefly.', {
      mentionAgent: agent.publicKey,
    });
    expect(await body!.pollChannelRequests(roomId, binding())).toBe(0);
    await waitUntil(async () =>
      (await messages()).some((event) =>
        event.event.tags.some((tag) => tag[0] === 'e' && tag[1] === mentioned.id),
      ),
    );
    expect(await client.listSubchannels(roomId)).toHaveLength(0);
    console.log('[room-conversation] multi-party-unmentioned=IGNORED named-agent=REPLIED');
  }, 180_000);

  it('opens exactly one explicit work corner and mirrors ready and delivery failure', async () => {
    const request = await client.messageSubmit(
      roomId,
      'Create LIVE-WORK.txt containing room-work-proof and commit it.',
      {
        mentionAgent: agent.publicKey,
        extraTags: [['t', AGENT_REQUEST_TAG]],
      },
    );
    expect(await body!.pollChannelRequests(roomId, binding())).toBe(1);
    expect(await client.listSubchannels(roomId)).toHaveLength(1);
    await body!.waitForAgentTasks();
    const firstEvents = await messages();
    const firstStatuses = firstEvents
      .filter((event) =>
        event.event.tags.some((tag) => tag[0] === 'request' && tag[1] === request.id),
      )
      .map((event) => event.event.tags.find((tag) => tag[0] === 'status')?.[1]);
    expect(firstStatuses).toContain('working');
    expect(firstStatuses).toContain('ready');

    const hook = resolve(remote, 'hooks', 'pre-receive');
    await mkdir(resolve(remote, 'hooks'), { recursive: true });
    await writeFile(hook, '#!/bin/sh\necho delivery-rejected >&2\nexit 1\n');
    await chmod(hook, 0o755);
    const failure = await client.messageSubmit(
      roomId,
      'Create LIVE-FAILURE.txt containing delivery-failure-proof and commit it.',
      {
        mentionAgent: agent.publicKey,
        extraTags: [['t', AGENT_REQUEST_TAG]],
      },
    );
    expect(await body!.pollChannelRequests(roomId, binding())).toBe(1);
    expect(await client.listSubchannels(roomId)).toHaveLength(2);
    await body!.waitForAgentTasks();
    const failureEvents = (await messages()).filter((event) =>
      event.event.tags.some((tag) => tag[0] === 'request' && tag[1] === failure.id),
    );
    expect(
      failureEvents.some((event) =>
        event.event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'failed'),
      ),
    ).toBe(true);
    expect(failureEvents.some((event) => event.content.includes('Delivery failed'))).toBe(true);
    console.log('[room-conversation] explicit-work=ONE-CORNER ready=VISIBLE failure=VISIBLE');
  }, 300_000);
});
