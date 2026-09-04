import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpPromptBlock } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { identityFromKey, type AgentRuntimeRecord } from './runtime.js';
import { SOUL_HOUSE_RULE } from './response-directives.js';
import { SessionScheduler } from './session-scheduler.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const AGENT_HEX = '11'.repeat(32);
const HUMAN = '22'.repeat(32);
const PHOTO = {
  url: 'https://server.example/v1/media/photo-id',
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 3,
};
const PDF = {
  url: 'https://server.example/v1/media/pdf-id',
  name: 'spec.pdf',
  mimeType: 'application/pdf',
  size: 4,
};
const JPEG = Buffer.from('jpg');

const OPENROUTER_MODEL = 'z-ai/glm-5.3-flash';
const ENDPOINTS_URL = `https://openrouter.ai/api/v1/models/${OPENROUTER_MODEL}/endpoints`;

/** One tool-capable endpoint, so the answer probe never runs in this test. */
function endpointsPayload(inputModalities: string[]) {
  return {
    data: {
      id: OPENROUTER_MODEL,
      architecture: { input_modalities: inputModalities },
      endpoints: [
        {
          tag: 'baseten/fp8',
          uptime_last_30m: 100,
          context_length: 98304,
          supported_parameters: ['tools'],
        },
      ],
    },
  };
}

/** One Room turn for a human message carrying a photo and a PDF; returns what the harness was prompted with. */
async function runTurn(acceptsImages: boolean, modelInputModalities?: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'beeline-room-attachments-'));
  roots.push(root);
  const identity = identityFromKey(AGENT_HEX, 'Bee');
  const agent = {
    name: 'Bee',
    publicKey: identity.publicKey,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
  };
  const runtime = {
    agent,
    rooms: [],
    supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'token' },
    agentBinary: '/fake-agent',
    agentKind: 'codex',
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
  } as unknown as AgentRuntimeRecord;
  const agentHomeRoot = join(root, 'agent-home');
  const config: BodyConfig = {
    agentBinary: '/fake-agent',
    agentKind: 'codex',
    agentCommand: '/fake-agent',
    agentArgs: [],
    mcpBinary: '/fake-dev-mcp',
    readonlyMcpCommand: '/fake-beeline-mcp',
    agentEnv: {},
    workspaceRoot: join(root, 'room'),
    autoApprovePermissions: true,
    accessPolicy: 'everyone',
    agentHomeRoot,
    operatorHome: join(root, 'operator-home'),
    ...(modelInputModalities
      ? {
          agentEnv: { OPENROUTER_API_KEY: '' },
          openRouterRoutingCacheDir: join(root, 'routing-cache'),
        }
      : {}),
  } as BodyConfig;
  // An empty key still identifies the provider without buying an answer probe.
  if (modelInputModalities) config.agentEnv.OPENROUTER_API_KEY = 'k';
  let inboxReads = 0;
  const execute = vi.fn(async (name: string) => {
    if (name === 'getAgentConfiguration')
      return modelInputModalities ? { model: OPENROUTER_MODEL } : {};
    if (name === 'getRoomRepositoryState') return { resolution: 'none' };
    if (name === 'getWorkspaceRoster') {
      return {
        members: [
          { identityId: agent.publicKey, kind: 'agent', name: 'Bee', role: 'member' },
          { identityId: HUMAN, kind: 'human', name: 'Captain', role: 'owner' },
        ],
      };
    }
    if (name === 'getRoomInbox') {
      inboxReads += 1;
      if (inboxReads === 2) {
        return {
          items: [
            {
              id: 'msg-photo',
              authorId: HUMAN,
              createdAt: 1,
              type: 'message',
              body: 'What is in this photo and does the spec match?',
              mentionIds: [agent.publicKey],
              attachments: [PHOTO, PDF],
            },
          ],
          cursor: 'msg-photo',
        };
      }
      return { items: [], cursor: 'latest' };
    }
    if (name === 'getRoomConversation') return { items: [], cursor: 'latest' };
    if (name === 'getRoomAuthority') return { member: true, principalKind: 'human' };
    return { id: 'write-id', createdAt: 1 };
  });
  const api = {
    execute,
    connection: () => ({
      baseUrl: 'https://server.example',
      daemonToken: 'daemon-token',
      agentId: agent.publicKey,
    }),
  } as unknown as DaemonApiClient;
  const acp = new AcpClient({ agentBinary: '/fake-agent', agentEnv: {} });
  vi.spyOn(acp, 'start').mockResolvedValue(undefined);
  vi.spyOn(acp, 'sessionNew').mockResolvedValue({
    sessionId: 'room-session',
    raw: modelInputModalities
      ? {
          configOptions: [
            {
              id: 'model',
              category: 'model',
              options: [{ value: OPENROUTER_MODEL, name: 'GLM 5.3 Flash' }],
            },
          ],
        }
      : {},
  });
  vi.spyOn(acp, 'setConfigOption').mockResolvedValue(undefined);
  vi.spyOn(acp, 'canPromptWithImages').mockReturnValue(acceptsImages);
  const sessionPrompt = vi.spyOn(acp, 'sessionPrompt').mockResolvedValue({
    stopReason: 'end_turn',
    updates: [],
    agentText: 'A photo of a bee.',
    toolCalls: [],
  });
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === ENDPOINTS_URL)
      return new Response(JSON.stringify(endpointsPayload(modelInputModalities ?? ['text'])));
    if (url === PHOTO.url) return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    if (url === PDF.url)
      return new Response('%PDF', { headers: { 'content-type': 'application/pdf' } });
    throw new Error('unexpected fetch');
  }) as unknown as typeof fetch;
  const scheduler = new SessionScheduler({ maxLiveSessions: 2 });
  const abort = new AbortController();
  const loop = new MonolithRoomTurnLoop({
    roomId: 'room-id',
    workspaceId: 'workspace',
    cwd: config.workspaceRoot,
    runtime,
    config,
    api,
    scheduler,
    health: { poll: vi.fn(), failure: vi.fn(), presence: vi.fn() },
    signal: abort.signal,
    pollMs: 10,
    createAcpClient: () => acp,
    fetchImpl,
  }).run();
  await vi.waitFor(() => expect(sessionPrompt).toHaveBeenCalled(), { timeout: 5_000 });
  abort.abort();
  await loop;
  await scheduler.dispose();
  const scratch = join(agentHomeRoot, 'tmp', 'beeline-attachments', 'msg-photo');
  return { prompt: sessionPrompt.mock.calls[0]![1], scratch, execute };
}

describe('Room turn voice', () => {
  it('carries the shared house rule even when the Workspace grants no persona', async () => {
    // `getAgentConfiguration` returns no soul here — the switched-off case.
    // The house rule is said once and stands on its own.
    const { prompt } = await runTurn(false);
    expect(String(prompt)).toContain(SOUL_HOUSE_RULE);
    expect(String(prompt)).not.toContain('Soul instructions:');
  });
});

describe('Room turn attachment delivery', () => {
  it('downloads the files into the session scratch dir, names the local paths, and sends the photo inline to a multimodal harness', async () => {
    const { prompt, scratch, execute } = await runTurn(true);
    expect(Array.isArray(prompt)).toBe(true);
    const blocks = prompt as AcpPromptBlock[];
    expect(blocks.map((block) => block.type)).toEqual(['text', 'image']);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(`local file ${join(scratch, 'photo.jpg')}`);
    expect(text).toContain(`local file ${join(scratch, 'spec.pdf')}`);
    expect(text).toContain(`(source ${PHOTO.url})`);
    expect(text).not.toContain('capability URL');
    expect(blocks[1]).toEqual({
      type: 'image',
      data: JPEG.toString('base64'),
      mimeType: 'image/jpeg',
    });
    expect(await readFile(join(scratch, 'photo.jpg'))).toEqual(JPEG);
    expect((await readFile(join(scratch, 'spec.pdf'))).toString()).toBe('%PDF');
    expect(execute).toHaveBeenCalledWith(
      'postRoomMessage',
      expect.objectContaining({ text: 'A photo of a bee.' }),
    );
  });

  it('sends text with local paths only when the harness rejects image blocks', async () => {
    const { prompt, scratch } = await runTurn(false);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain(`local file ${join(scratch, 'photo.jpg')}`);
    expect(prompt).toContain(`local file ${join(scratch, 'spec.pdf')}`);
    expect(await readFile(join(scratch, 'photo.jpg'))).toEqual(JPEG);
  });

  // C87. Without the image, the turn must carry the REASON, so the agent says
  // it in one plain sentence in the same turn instead of improvising a
  // description or waiting on a picture that is not coming.
  it('names the unseen photo in the prompt when the harness rejects image blocks', async () => {
    const { prompt } = await runTurn(false);
    const text = String(prompt);
    expect(text).toContain('NOT shown to you as an image: this session cannot take image content');
    expect(text).toContain('say that in one plain sentence rather than describing an image you cannot see');
    // The PDF is not a picture and is never described as one.
    expect(text.split('\n').find((line) => line.includes('spec.pdf'))).not.toContain(
      'NOT shown to you',
    );
  });

  it('says nothing about unseen pictures when the photo did ride inline', async () => {
    const { prompt } = await runTurn(true);
    const text = ((prompt as AcpPromptBlock[])[0] as { text: string }).text;
    expect(text).not.toContain('NOT shown to you');
    expect(text).not.toContain('You were not shown the picture itself');
  });

  // C87. The harness advertising `promptCapabilities.image` is only half the
  // question: a text-only model behind it drops the picture anyway, so the
  // turn must neither ship the bytes nor pretend the agent was shown one.
  it('withholds the image block and names the reason when the pinned model takes no images', async () => {
    const { prompt } = await runTurn(true, ['text']);
    expect(typeof prompt).toBe('string');
    expect(String(prompt)).toContain('NOT shown to you as an image');
  });

  it('sends the photo inline when the pinned model is the vision-capable one', async () => {
    const { prompt } = await runTurn(true, ['text', 'image', 'video']);
    const blocks = prompt as AcpPromptBlock[];
    expect(blocks.map((block) => block.type)).toEqual(['text', 'image']);
    expect((blocks[0] as { text: string }).text).not.toContain('NOT shown to you');
  });
});
