/**
 * Production-relay proof of true incremental live text streaming (Option B):
 * the agent's reply must materialize on the wire as multiple growing
 * `#t=agent-draft` snapshots while the turn is in flight, not appear once,
 * complete, after the turn finishes. Uses a scripted fake ACP agent (not a
 * real installed runtime) so this test runs deterministically wherever the
 * local relay stack is up — see `npm run stack:up` at the repo root.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BASE_URL, HOST, createChannel, git, newIdentity, setMemberRole } from '@beeline/gate';
import { createBuzzClient, tagValue } from '@beeline/buzz-client';
import { Body } from './body.js';
import { loadBodyConfig } from './config.js';

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

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** Emits several `agent_message_chunk` deltas with real delays between them,
 *  proving the streamed publish is genuinely incremental, not a burst. */
async function fakeStreamingAgentBinary(root: string): Promise<string> {
  const binary = resolve(root, 'fake-streaming-agent.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (text) =>
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'stream-live-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });

lines.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'stream-live-session' } });
  } else if (message.method === 'session/prompt') {
    const words = ['Streaming ', 'this ', 'reply ', 'one ', 'word ', 'at ', 'a ', 'time.'];
    for (const word of words) {
      chunk(word);
      await sleep(300);
    }
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

const live = await reachable();

describe.runIf(live)('production live text streaming contract (Option B)', () => {
  const human = newIdentity('streaming-draft-human');
  const agent = newIdentity('streaming-draft-agent');
  const roomIdPromise = createChannel(human, `streaming-draft-${Date.now()}`);
  let roomId = '';
  let client: ReturnType<typeof createBuzzClient>;

  beforeAll(async () => {
    roomId = await roomIdPromise;
    await setMemberRole(human, roomId, agent.publicKey, 'member');
    workspace = await mkdtemp(resolve(tmpdir(), 'beeline-streaming-draft-'));
    remote = await mkdtemp(resolve(tmpdir(), 'beeline-streaming-draft-remote-'));
    git(workspace, ['init', '-q', '-b', 'main']);
    await writeFile(resolve(workspace, 'README.md'), '# Streaming draft live proof\n');
    git(workspace, ['add', 'README.md']);
    git(workspace, ['commit', '-m', 'seed live proof']);
    git(remote, ['init', '--bare', '-q']);
    git(workspace, ['remote', 'add', 'origin', remote]);
    const seed = git(workspace, ['push', '-u', 'origin', 'main']);
    if (!seed.ok) throw new Error(seed.stderr);

    const fakeAgentBinary = await fakeStreamingAgentBinary(workspace);
    const config = loadBodyConfig({
      workspaceRoot: workspace,
      agent: { kind: 'custom', command: fakeAgentBinary, args: [] },
    });
    body = new Body(config, human, agent);
    client = createBuzzClient({ baseUrl: BASE_URL, identity: human });
    await waitUntil(() => client.isMember(roomId, agent.publicKey));
    await body.provision(roomId, binding());
  }, 60_000);

  afterAll(async () => {
    client?.disconnect();
    if (body) await body.dispose();
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (remote) await rm(remote, { recursive: true, force: true });
  }, 30_000);

  const binding = () => ({
    repo: 'streaming-draft',
    localPath: workspace,
    remoteName: 'origin',
    targetBranch: 'refs/heads/main',
    localOnly: true,
  });

  it('publishes multiple growing draft snapshots while the turn is in flight, then a matching final message', async () => {
    const greeting = await client.messageSubmit(roomId, 'Hey @Agent, say something', {
      mentionAgent: agent.publicKey,
    });
    const turn = body!.pollChannelRequests(roomId, binding());

    const observedDraftTexts: string[] = [];
    while (
      observedDraftTexts.length < 2 &&
      !(await client
        .sessionEventsBackfill(roomId, { limit: 50 })
        .then((events) => events.some((event) => tagValue(event.event, 't') === 'agent-message')))
    ) {
      const drafts = await client.agentDraftBackfill(roomId);
      const text = drafts[0]?.content;
      if (text && observedDraftTexts.at(-1) !== text) observedDraftTexts.push(text);
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    expect(await turn).toBe(0);

    // Proof of true incremental streaming: at least two distinct, strictly
    // growing snapshots were observed mid-turn — a one-shot publish (Option A)
    // would only ever show zero or one.
    expect(observedDraftTexts.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < observedDraftTexts.length; i++) {
      expect(observedDraftTexts[i]!.length).toBeGreaterThan(observedDraftTexts[i - 1]!.length);
      expect(observedDraftTexts[i]!.startsWith(observedDraftTexts[i - 1]!)).toBe(true);
    }

    const events = await client.sessionEventsBackfill(roomId, { limit: 50 });
    const finalMessage = events.find(
      (event) =>
        event.pubkey === agent.publicKey &&
        tagValue(event.event, 't') === 'agent-message' &&
        tagValue(event.event, 'e') === greeting.id,
    );
    expect(finalMessage?.content).toBe('Streaming this reply one word at a time.');
    // Finalization supersedes the replaceable draft with a terminal empty
    // record. A fresh subscriber sees no provisional transcript residue.
    const settledDraft = await client.agentDraftBackfill(roomId);
    expect(settledDraft[0]?.content).toBe('');
    expect(tagValue(settledDraft[0]!.event, 'status')).toBe('closed');
  }, 30_000);
});

if (!live) {
  describe('production live text streaming contract (Option B) (prerequisites)', () => {
    it('SKIPPED — requires the local relay stack only; no LLM credentials are used', () => {
      console.warn('Start with `npm run stack:up` at the repository root.');
    });
  });
}
