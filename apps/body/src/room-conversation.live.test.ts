/** Production-relay proof for Room conversation, explicit work, and parent status. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  createBuzzClient,
  tagValue,
  WRITE_PERMISSION_REQUEST_TAG,
} from '@beeline/buzz-client';
import { Body } from './body.js';
import { loadBodyConfig } from './config.js';
import { resolveAgentCommand, type AgentKind } from './agent-command.js';
import { waitForWritePermissionPrompt } from './write-permission.live-helper.js';

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
    expect(
      (await messages()).some((event) =>
        event.event.tags.some(
          (tag) => tag[0] === 't' && tag[1] === WRITE_PERMISSION_REQUEST_TAG,
        ),
      ),
    ).toBe(false);

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

  it('opens explicitly authorized work directly without a permission prompt', async () => {
    const request = await client.messageSubmit(
      roomId,
      'open a new corner to do work: add a FEATURE.md',
    );

    expect(await body!.pollChannelRequests(roomId, binding())).toBe(1);
    expect(await client.listSubchannels(roomId)).toHaveLength(1);
    const requestEvents = (await messages()).filter((event) =>
      event.event.tags.some((tag) => tag[0] === 'request' && tag[1] === request.id),
    );
    expect(
      requestEvents.some((event) =>
        event.event.tags.some((tag) => tag[0] === 't' && tag[1] === WRITE_PERMISSION_REQUEST_TAG),
      ),
    ).toBe(false);

    await body!.waitForAgentTasks();
    const info = [...body!.getSubchannels().values()].find(
      (candidate) => candidate.request?.eventId === request.id,
    );
    expect(info).toBeDefined();
    expect(await readFile(resolve(info!.worktreePath, 'FEATURE.md'), 'utf8')).not.toHaveLength(0);
    expect(git(info!.worktreePath, ['status', '--porcelain']).stdout).toBe('');
    console.log('[room-conversation] explicit-corner=DIRECT permission=NONE feature=COMMITTED');
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
    expect(await client.listSubchannels(roomId)).toHaveLength(1);
    console.log('[room-conversation] multi-party-unmentioned=IGNORED named-agent=REPLIED');
  }, 180_000);

  it('keeps implicit work behind ALLOW, while DENY leaves the Room read-only', async () => {
    const request = await client.messageSubmit(
      roomId,
      'Create LIVE-WORK.txt containing room-work-proof and commit it.',
      { mentionAgent: agent.publicKey },
    );
    const allowedPoll = body!.pollChannelRequests(roomId, binding());
    const permission = await waitForWritePermissionPrompt(client, roomId, request.id);
    expect(tagValue(permission.event, 'agent')).toBe(agent.publicKey);
    expect(tagValue(permission.event, 'request')).toBe(request.id);
    expect(tagValue(permission.event, 'status')).toBe('pending');
    expect(await client.listSubchannels(roomId)).toHaveLength(1);
    await client.respondToWritePermission(
      roomId,
      tagValue(permission.event, 'permission')!,
      request.id,
      agent.publicKey,
      'allow',
    );
    expect(await allowedPoll).toBe(1);
    expect(await client.listSubchannels(roomId)).toHaveLength(2);
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
      { mentionAgent: agent.publicKey },
    );
    const failurePoll = body!.pollChannelRequests(roomId, binding());
    const failurePermission = await waitForWritePermissionPrompt(client, roomId, failure.id);
    await client.respondToWritePermission(
      roomId,
      tagValue(failurePermission.event, 'permission')!,
      failure.id,
      agent.publicKey,
      'allow',
    );
    expect(await failurePoll).toBe(1);
    expect(await client.listSubchannels(roomId)).toHaveLength(3);
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

    const denied = await client.messageSubmit(
      roomId,
      'Create LIVE-DENIED.txt containing should-not-exist.',
      { mentionAgent: agent.publicKey },
    );
    const deniedPoll = body!.pollChannelRequests(roomId, binding());
    const deniedPermission = await waitForWritePermissionPrompt(client, roomId, denied.id);
    expect(await client.listSubchannels(roomId)).toHaveLength(3);
    await client.respondToWritePermission(
      roomId,
      tagValue(deniedPermission.event, 'permission')!,
      denied.id,
      agent.publicKey,
      'deny',
    );
    expect(await deniedPoll).toBe(0);
    expect(await client.listSubchannels(roomId)).toHaveLength(3);
    console.log(
      '[room-conversation] chat=NO-CORNER first-write=PROMPT allow=ONE-CORNER deny=NO-CORNER',
    );
  }, 300_000);
});
