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
async function daemonDoor(): Promise<{ origin: string; calls: Record<string, unknown>[] }> {
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
          ? { resolution: 'repository', key: 'owner/widgets', targetBranch: 'main' }
          : operation === 'createCorner'
            ? { cornerId: CORNER }
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
): Promise<{ result?: ToolResult; error?: { code: number; message: string } }> {
  const entrypoint = fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    env: {
      ...process.env,
      BEELINE_MCP_SURFACE: 'agent',
      BEELINE_DAEMON_BASE_URL: origin,
      BEELINE_DAEMON_TOKEN: 'daemon-token',
      BEELINE_DAEMON_ROOM_ID: ROOM,
      BEELINE_DAEMON_CORNER_ID: '',
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
        resolve({ ...(message.result ? { result: message.result } : {}), ...(message.error ? { error: message.error } : {}) });
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
      params: { _meta: { progressToken: 1 }, name: 'open_corner', arguments: args },
    })}\n`,
  );
  try {
    return await answer;
  } finally {
    child.kill();
  }
}

describe('open_corner over the grok wire', () => {
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
      status: 'starting',
    });
    const created = door.calls.find((call) => call.operation === 'createCorner');
    expect(created).toMatchObject({
      roomId: ROOM,
      name: 'corner name',
      repository: 'owner/widgets',
      targetBranch: 'main',
    });
    // The corner's opening line is still the objective, unchanged in job.
    expect(door.calls.find((call) => call.operation === 'postRoomMessage')).toMatchObject({
      roomId: CORNER,
      text: 'Ship the corner name parameter. Make grok able to open a corner. Update every surface that draws the title.',
    });
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
    expect(result?.content[0]?.text).toBe(
      'the name is required; give a title of at most 3 words',
    );
  }, 30_000);
});
