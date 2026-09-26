import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The `open_corner` wire, driven exactly as grok drives it.
 *
 * Grok routes every MCP tool through its own `use_tool`, so a refusal reaches
 * the model as "Tool `beeline-agent__open_corner` failed via `use_tool`: …"
 * with whatever the server said appended. When the server answered a refusal
 * with a JSON-RPC PROTOCOL error and a sentence about "single spaces", that
 * was the whole story the agent got, and the same turn died twice (C90).
 *
 * The frames below are the ones captured from a live `grok agent stdio`
 * session against this very server.
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOM = '11111111-1111-4111-8111-111111111111';
const CORNER = '22222222-2222-4222-8222-222222222222';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((done) => server.close(() => done(undefined)))),
  );
});

/** A stub daemon door that records what `createCorner` was actually sent. */
async function daemonDoor(
  repository: Record<string, unknown> = {
    resolution: 'repository',
    key: 'owner/widgets',
    remote: 'https://github.com/owner/widgets.git',
    targetBranch: 'main',
  },
  conversationItems: Record<string, unknown>[] = [
    {
      id: 'message-1',
      cursor: `123,${'a'.repeat(64)}`,
      authorId: 'agent',
      createdAt: 123,
      type: 'message',
      body: 'Tests pending',
      attachments: [],
    },
  ],
): Promise<{ origin: string; calls: Record<string, unknown>[] }> {
  const calls: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
      const operation = (request.url ?? '').split('/').pop();
      calls.push({ operation, ...body });
      const payload =
        operation === 'getRoomRepositoryState'
          ? repository
          : operation === 'listRoomCorners'
            ? { corners: [{ cornerId: CORNER, parentRoomId: ROOM }] }
            : operation === 'getCornerRestoreState'
              ? {
                  cornerId: CORNER,
                  objective: 'Ship the endpoint',
                  lifecycle: {
                    lifecycle: 'in-review',
                    checks: 'pending',
                    pr: {
                      number: 42,
                      url: 'https://github.com/owner/widgets/pull/42',
                      title: 'Ship endpoint',
                      headSha: 'b'.repeat(40),
                      mergeability: 'clean',
                    },
                  },
                }
              : operation === 'getPrChecksStatus'
                ? {
                    checks: 'pending',
                    headSha: 'b'.repeat(40),
                    approvalPending: true,
                    reviewer: '@reviewer',
                    reviewerExists: true,
                    reviewerIsAuthor: false,
                    reviewerWake: { status: 'waiting', detail: 'checks pending' },
                  }
                : operation === 'getRoomConversation'
                  ? { items: conversationItems }
                  : operation === 'createCorner'
                    ? { cornerId: CORNER }
                    : operation === 'upgradeCornerLane'
                      ? {
                          cornerId: CORNER,
                          lane: 'code',
                          featureBranch: 'feature/corner-222222222222',
                        }
                      : { ok: true };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  servers.push(server);
  await new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(undefined)));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

/** One `tools/call` against the real server process, over real stdio. */
async function callTool(
  origin: string,
  args: Record<string, unknown>,
  options: {
    name?: string;
    cornerId?: string;
    agentMayCloseCorner?: boolean;
    agentMayUpgradeCorner?: boolean;
    toolCallId?: string;
  } = {},
): Promise<{ result?: ToolResult; error?: { code: number; message: string } }> {
  const entrypoint = fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'command-mcp-test-'));
  const context = join(root, 'command.json');
  await writeFile(
    context,
    JSON.stringify({
      roomId: options.cornerId ?? ROOM,
      requestId: 'command-request',
      generationId: 'g1',
    }),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    env: {
      ...process.env,
      BEELINE_TURN_CONTEXT_FILE: context,
      BEELINE_MCP_SURFACE: 'agent',
      BEELINE_DAEMON_BASE_URL: origin,
      BEELINE_DAEMON_TOKEN: 'daemon-token',
      BEELINE_DAEMON_ROOM_ID: ROOM,
      BEELINE_DAEMON_CORNER_ID: options.cornerId ?? '',
      BEELINE_CORNER_AGENT_CLOSE: options.agentMayCloseCorner ? '1' : '',
      BEELINE_CORNER_CAN_UPGRADE: options.agentMayUpgradeCorner ? '1' : '',
      BEELINE_AGENT_DM: '0',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const answer = new Promise<{ result?: ToolResult; error?: { code: number; message: string } }>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tools/call timed out')), 20_000);
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
        const message = JSON.parse(line) as {
          id?: number;
          result?: ToolResult;
          error?: { code: number; message: string };
        };
        if (message.id !== 2) return;
        clearTimeout(timer);
        resolve({
          ...(message.result ? { result: message.result } : {}),
          ...(message.error ? { error: message.error } : {}),
        });
      });
    },
  );
  // Grok's own handshake, verbatim: a string protocolVersion, then the call.
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'grok-shell-beeline-agent', version: '1.0.13' },
      },
    })}\n`,
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        _meta: {
          progressToken: 1,
          ...(options.toolCallId ? { beelineToolCallId: options.toolCallId } : {}),
        },
        name: options.name ?? 'open_corner',
        arguments: args,
      },
    })}\n`,
  );
  try {
    return await answer;
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

describe('open_corner over the grok wire', () => {
  it('gives separate calls in one turn independent idempotency keys', async () => {
    const door = await daemonDoor();
    await callTool(
      door.origin,
      { name: 'First fix', objective: 'Fix the first independent problem' },
      { toolCallId: 'call-first' },
    );
    await callTool(
      door.origin,
      { name: 'Second fix', objective: 'Fix the second independent problem' },
      { toolCallId: 'call-second' },
    );
    await callTool(
      door.origin,
      { name: 'First fix', objective: 'Fix the first independent problem' },
      { toolCallId: 'call-first' },
    );

    const creates = door.calls.filter((call) => call.operation === 'createCorner');
    expect(creates).toHaveLength(3);
    expect(creates[0]?.requestId).toBe('command-request');
    expect(creates[1]?.requestId).toBe('command-request');
    expect(creates[0]?.idempotencyKey).toEqual(expect.any(String));
    expect(creates[1]?.idempotencyKey).toEqual(expect.any(String));
    expect(creates[1]?.idempotencyKey).not.toBe(creates[0]?.idempotencyKey);
    expect(creates[2]?.idempotencyKey).toBe(creates[0]?.idempotencyKey);
  }, 30_000);

  it('opens a corner from the multi-line brief that used to be refused', async () => {
    const door = await daemonDoor();
    const { result, error } = await callTool(door.origin, {
      name: 'corner name',
      objective:
        'Ship the corner name parameter.\nMake grok able to open a corner.\nUpdate every surface that draws the title.',
    });
    expect(error).toBeUndefined();
    expect(result?.isError).toBeUndefined();
    expect(JSON.parse(result!.content[0]!.text)).toEqual({
      cornerId: CORNER,
      name: 'corner name',
      objective:
        'Ship the corner name parameter. Make grok able to open a corner. Update every surface that draws the title.',
      lane: 'code',
      status: 'starting',
    });
    const created = door.calls.find((call) => call.operation === 'createCorner');
    expect(created).toMatchObject({
      roomId: ROOM,
      name: 'corner name',
      lane: 'code',
      repository: 'owner/widgets',
      targetBranch: 'main',
    });
    // The server creates the objective command inside createCorner.
    expect(door.calls.some((call) => call.operation === 'postRoomMessage')).toBe(false);
    expect(created).toMatchObject({ requestId: 'command-request', generationId: 'g1' });
  }, 30_000);

  it('opens a chat-only corner without inventing repository fields', async () => {
    const door = await daemonDoor({ resolution: 'none' });
    const { result, error } = await callTool(door.origin, {
      name: 'Render clip',
      objective: 'Generate a short video clip and attach it here',
    });

    expect(error).toBeUndefined();
    expect(result?.isError).toBeUndefined();
    expect(JSON.parse(result!.content[0]!.text)).toMatchObject({
      cornerId: CORNER,
      status: 'starting',
    });
    const created = door.calls.find((call) => call.operation === 'createCorner');
    expect(created).toMatchObject({
      roomId: ROOM,
      name: 'Render clip',
      objective: 'Generate a short video clip and attach it here',
    });
    expect(created).not.toHaveProperty('repository');
    expect(created).not.toHaveProperty('targetBranch');
    // A Room with no repository has no code lane to take, so what comes back
    // says so rather than echoing the default the caller never chose.
    expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ lane: 'no_code' });
  }, 30_000);

  it('carries the no-code lane of a repository Room through to createCorner', async () => {
    const door = await daemonDoor();
    const { result, error } = await callTool(door.origin, {
      name: 'Market scan',
      objective: 'Survey the five nearest competitors and write it up',
      lane: 'no_code',
    });

    expect(error).toBeUndefined();
    expect(result?.isError).toBeUndefined();
    expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ lane: 'no_code' });
    // The repository is still recorded: the corner belongs to that Room and can
    // read it. The lane is what keeps it off the branch-and-merge path.
    expect(door.calls.find((call) => call.operation === 'createCorner')).toMatchObject({
      lane: 'no_code',
      repository: 'owner/widgets',
    });
  }, 30_000);

  it('carries the research lane with its repository binding', async () => {
    const door = await daemonDoor();
    const { result, error } = await callTool(door.origin, {
      name: 'Market scan',
      objective: 'Investigate repository performance and report findings',
      lane: 'research',
    });

    expect(error).toBeUndefined();
    expect(result?.isError).toBeUndefined();
    expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ lane: 'research' });
    expect(door.calls.find((call) => call.operation === 'createCorner')).toMatchObject({
      lane: 'research',
      repository: 'owner/widgets',
    });
  }, 30_000);

  it('refuses a lane it does not know instead of silently opening a code corner', async () => {
    const door = await daemonDoor();
    const { result } = await callTool(door.origin, {
      name: 'Market scan',
      objective: 'Survey the five nearest competitors and write it up',
      lane: 'chat',
    });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toBe('lane must be "code", "no_code", or "research"');
    expect(door.calls.some((call) => call.operation === 'createCorner')).toBe(false);
  }, 30_000);

  it('refuses agent closure for a no-code corner', async () => {
    const door = await daemonDoor({ resolution: 'none' });
    const { result, error } = await callTool(
      door.origin,
      {},
      {
        name: 'close_corner',
        cornerId: CORNER,
      },
    );

    expect(error).toBeUndefined();
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toBe('this corner stays open until a human closes it');
    expect(door.calls.some((call) => call.operation === 'archiveCorner')).toBe(false);
  }, 30_000);

  it('closes a repository corner through that same operation', async () => {
    const door = await daemonDoor();
    const { result, error } = await callTool(
      door.origin,
      {},
      {
        name: 'close_corner',
        cornerId: CORNER,
        agentMayCloseCorner: true,
      },
    );

    expect(error).toBeUndefined();
    expect(result?.isError).toBeUndefined();
    expect(JSON.parse(result!.content[0]!.text)).toEqual({ cornerId: CORNER, status: 'closed' });
    expect(door.calls).toContainEqual(
      expect.objectContaining({ operation: 'archiveCorner', cornerId: CORNER }),
    );
    // The repository shape of the parent Room is not consulted at all: who may
    // archive is the server's opener check, not a question about the Room.
    expect(door.calls.some((call) => call.operation === 'getRoomRepositoryState')).toBe(false);
  }, 30_000);

  it('upgrades only an eligible corner through the active human command context', async () => {
    const door = await daemonDoor();
    const { result, error } = await callTool(
      door.origin,
      {},
      {
        name: 'upgrade_corner_to_code',
        cornerId: CORNER,
        agentMayUpgradeCorner: true,
      },
    );

    expect(error).toBeUndefined();
    expect(result?.isError).toBeUndefined();
    expect(JSON.parse(result!.content[0]!.text)).toEqual({
      cornerId: CORNER,
      lane: 'code',
      featureBranch: 'feature/corner-222222222222',
    });
    expect(door.calls).toContainEqual(
      expect.objectContaining({
        operation: 'upgradeCornerLane',
        cornerId: CORNER,
        roomId: CORNER,
        requestId: 'command-request',
        generationId: 'g1',
      }),
    );
  }, 30_000);

  it('refuses the upgrade tool when this session is not an upgradeable no-code corner', async () => {
    const door = await daemonDoor();
    const { result } = await callTool(
      door.origin,
      {},
      {
        name: 'upgrade_corner_to_code',
        cornerId: CORNER,
      },
    );

    expect(result?.isError).toBe(true);
    expect(door.calls.some((call) => call.operation === 'upgradeCornerLane')).toBe(false);
  }, 30_000);

  it('refuses close_corner outside a corner instead of archiving something else', async () => {
    const door = await daemonDoor();
    const { result } = await callTool(door.origin, {}, { name: 'close_corner' });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('BEELINE_DAEMON_CORNER_ID');
    expect(door.calls.some((call) => call.operation === 'archiveCorner')).toBe(false);
  }, 30_000);

  it('answers a genuine refusal as a tool result the model reads, not a protocol error', async () => {
    const door = await daemonDoor();
    const { result, error } = await callTool(door.origin, {
      name: 'corner name',
      objective: Array.from({ length: 61 }, (_, index) => `word${index}`).join(' '),
    });
    expect(error).toBeUndefined();
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toBe('the objective is 61 words; the limit is 24');
    expect(door.calls.some((call) => call.operation === 'createCorner')).toBe(false);
  }, 30_000);

  it('refuses a missing name in a sentence that says what to do', async () => {
    const door = await daemonDoor();
    const { result } = await callTool(door.origin, { objective: 'Ship the widget' });
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toBe('the name is required; give a title of at most 3 words');
  }, 30_000);
});

describe('relay tools', () => {
  it('posts a steer through the active Room command', async () => {
    const door = await daemonDoor();
    const response = await callTool(
      door.origin,
      { cornerId: CORNER, text: 'Change the endpoint' },
      { name: 'steer_corner' },
    );
    expect(response.result?.isError).not.toBe(true);
    expect(door.calls).toContainEqual({
      operation: 'postRoomMessage',
      roomId: ROOM,
      requestId: 'command-request',
      generationId: 'g1',
      text: 'Change the endpoint',
      relay: { fromRoomId: ROOM, toRoomId: CORNER, direction: 'down' },
    });
  });
  it('asks for exactly one linked reply through the active Room command', async () => {
    const door = await daemonDoor();
    const response = await callTool(
      door.origin,
      { cornerId: CORNER, text: 'What is blocking the endpoint?' },
      { name: 'ask_corner' },
    );
    expect(response.result?.isError).not.toBe(true);
    expect(door.calls).toContainEqual({
      operation: 'postRoomMessage',
      roomId: ROOM,
      requestId: 'command-request',
      generationId: 'g1',
      text: 'What is blocking the endpoint?',
      relay: { fromRoomId: ROOM, toRoomId: CORNER, direction: 'down', reply: 'once' },
    });
  });
  it('reads a listed member corner without posting a message', async () => {
    const door = await daemonDoor();
    const response = await callTool(door.origin, { cornerId: CORNER }, { name: 'inspect_corner' });
    expect(response.result?.isError).not.toBe(true);
    expect(JSON.parse(response.result!.content[0]!.text)).toEqual({
      cornerId: CORNER,
      state: 'in-review',
      pr: { number: 42, url: 'https://github.com/owner/widgets/pull/42', title: 'Ship endpoint' },
      head: 'b'.repeat(40),
      checks: 'pending',
      verdict: {
        approvalPending: true,
        reviewer: '@reviewer',
        reviewerExists: true,
        reviewerIsAuthor: false,
        reviewerWake: { status: 'waiting', detail: 'checks pending' },
      },
      merge: { mergeability: 'clean', authorization: 'check pr_checks_status in the corner' },
    });
    expect(door.calls.map((call) => call.operation)).toEqual([
      'listRoomCorners',
      'getCornerRestoreState',
      'getPrChecksStatus',
    ]);
  });
  it('passes a transcript cursor only after listing the member corner', async () => {
    const door = await daemonDoor();
    const response = await callTool(
      door.origin,
      {
        cornerId: CORNER,
        mode: 'transcript',
        after: '123,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      { name: 'inspect_corner' },
    );
    expect(response.result?.isError).not.toBe(true);
    expect(door.calls.find((call) => call.operation === 'getRoomConversation')).toMatchObject({
      roomId: CORNER,
      limit: 9,
      after: '123,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });
  it('caps a transcript page and carries a cursor to its remaining rows', async () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      id: `message-${index}`,
      cursor: `${index + 1},${'a'.repeat(64)}`,
      authorId: 'agent',
      createdAt: index,
      type: 'message',
      body: 'x'.repeat(50000),
      attachments: [],
    }));
    const door = await daemonDoor(undefined, items);
    const response = await callTool(
      door.origin,
      { cornerId: CORNER, mode: 'transcript' },
      { name: 'inspect_corner' },
    );
    const raw = response.result!.content[0]!.text;
    const page = JSON.parse(raw);
    expect(raw.length).toBeLessThan(12000);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ bodyContinues: true, body: 'x'.repeat(1000) });
    expect(page.next).toEqual({ offset: 1000 });
    expect(door.calls.find((call) => call.operation === 'getRoomConversation')).toMatchObject({
      limit: 9,
      window: 'earliest',
    });
    const continuation = await callTool(
      door.origin,
      { cornerId: CORNER, mode: 'transcript', ...page.next },
      { name: 'inspect_corner' },
    );
    expect(JSON.parse(continuation.result!.content[0]!.text).items[0]).toMatchObject({
      id: 'message-0',
      bodyOffset: 1000,
      body: 'x'.repeat(1000),
    });
  });
  it('pages past eight complete messages without skipping the ninth', async () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      id: `message-${index}`,
      cursor: `${index + 1},${'a'.repeat(64)}`,
      authorId: 'agent',
      createdAt: index,
      type: 'message',
      body: 'short',
      attachments: [],
    }));
    const door = await daemonDoor(undefined, items);
    const response = await callTool(
      door.origin,
      { cornerId: CORNER, mode: 'transcript' },
      { name: 'inspect_corner' },
    );
    const page = JSON.parse(response.result!.content[0]!.text);
    expect(page.items).toHaveLength(8);
    expect(page.next).toEqual({ after: items[7]!.cursor });
  });
  it('finishes a split message before advancing to the following message', async () => {
    const items = [
      {
        id: 'long',
        cursor: `1,${'a'.repeat(64)}`,
        authorId: 'agent',
        createdAt: 1,
        type: 'message',
        body: 'x'.repeat(1500),
        attachments: [],
      },
      {
        id: 'next',
        cursor: `2,${'a'.repeat(64)}`,
        authorId: 'agent',
        createdAt: 2,
        type: 'message',
        body: 'done',
        attachments: [],
      },
    ];
    const door = await daemonDoor(undefined, items);
    const first = await callTool(
      door.origin,
      { cornerId: CORNER, mode: 'transcript' },
      { name: 'inspect_corner' },
    );
    const next = JSON.parse(first.result!.content[0]!.text).next;
    const second = await callTool(
      door.origin,
      { cornerId: CORNER, mode: 'transcript', ...next },
      { name: 'inspect_corner' },
    );
    const page = JSON.parse(second.result!.content[0]!.text);
    expect(page.items.map((item: { id: string }) => item.id)).toEqual(['long', 'next']);
    expect(page.items[0]).toMatchObject({ bodyOffset: 1000, body: 'x'.repeat(500) });
    expect(page.next).toBeUndefined();
  });
  it('caps escaped transcript JSON as well as raw message characters', async () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      id: `message-${index}`,
      cursor: `${index + 1},${'a'.repeat(64)}`,
      authorId: 'agent',
      createdAt: index,
      type: 'message',
      body: '\u0000'.repeat(1000),
      attachments: [],
    }));
    const door = await daemonDoor(undefined, items);
    const response = await callTool(
      door.origin,
      { cornerId: CORNER, mode: 'transcript' },
      { name: 'inspect_corner' },
    );
    const raw = response.result!.content[0]!.text;
    expect(raw.length).toBeLessThanOrEqual(12000);
    expect(JSON.parse(raw).next).toBeDefined();
  });
  it('refuses steering from a corner turn', async () => {
    const door = await daemonDoor();
    const steer = await callTool(
      door.origin,
      { text: 'No', cornerId: CORNER },
      { name: 'steer_corner', cornerId: CORNER },
    );
    expect(steer.result?.isError ?? Boolean(steer.error)).toBe(true);
    expect(door.calls).toHaveLength(0);
  });
});

describe('avatar skill tools over MCP', () => {
  it('sends generated geometry with active command authority and reads back refinement context', async () => {
    const { origin, calls } = await daemonDoor();
    const drawing = [{ type: 'circle', cx: 50, cy: 50, r: 30, fill: 'bone' }];
    const saved = await callTool(origin, { drawing }, { name: 'set_avatar' });
    expect(saved.error).toBeUndefined();
    expect(saved.result?.isError).not.toBe(true);
    expect(calls).toContainEqual({
      operation: 'postAgentAvatar',
      roomId: ROOM,
      requestId: 'command-request',
      generationId: 'g1',
      drawing,
    });
    await callTool(origin, {}, { name: 'get_avatar' });
    expect(calls).toContainEqual({ operation: 'getAgentAvatar', roomId: ROOM });
  });
});
