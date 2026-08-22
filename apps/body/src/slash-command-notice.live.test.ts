/**
 * Live proof for the unknown-slash-command boundary, driven against the real
 * relay stack and the real harness (default: codex).
 *
 * Reported by the captain: sending `/loop` to a Room agent silently executed
 * it with the HARNESS's meaning — nothing on Beeline's side marks the text,
 * and the collision between Beeline's composer vocabulary and the harness's
 * own `/verb` vocabulary was invisible. The fix marks such messages visibly
 * (`postSlashCommandNotice`) while still delivering them as ordinary prose.
 *
 * Separated here:
 * - trigger: an addressed message whose first token is a slash verb Beeline
 *   does not define (`/loop` is not in `BEELINE_SLASH_COMMANDS`);
 * - masking condition: no Beeline layer consumes or marks the token, so the
 *   harness/model answers with its own command semantics (observed live:
 *   codex replies "What should I loop, how often, and when should I stop?");
 * - visible symptom of the fix: a `slash-command-notice` system card naming
 *   `/loop`, listing Beeline's commands, stating the text was passed through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BASE_URL, HOST, createChannel, git, newIdentity, setMemberRole } from '@beeline/gate';
import { createBuzzClient } from '@beeline/buzz-client';
import { Body } from './body.js';
import { loadBodyConfig } from './config.js';
import { resolveAgentCommand, type AgentKind } from './agent-command.js';

const selectedKind = (process.env.BUZZY_LIVE_AGENT_KIND ?? 'codex') as AgentKind;
let workspace = '';
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

describe.runIf(live)('unknown slash commands are marked, not silently executed', () => {
  const human = newIdentity('slash-live-human');
  const agent = newIdentity('slash-live-agent');
  let roomId = '';
  let client: ReturnType<typeof createBuzzClient>;

  beforeAll(async () => {
    roomId = await createChannel(human, `slash-live-${Date.now()}`);
    await setMemberRole(human, roomId, agent.publicKey, 'member');
    workspace = await mkdtemp(resolve(tmpdir(), 'beeline-slash-live-'));
    git(workspace, ['init', '-q', '-b', 'main']);
    await writeFile(resolve(workspace, 'README.md'), '# slash command live proof\n');
    git(workspace, ['add', 'README.md']);
    git(workspace, ['commit', '-m', 'seed live proof']);
    const config = loadBodyConfig({
      workspaceRoot: workspace,
      agent: resolveAgentCommand({ kind: selectedKind }),
    });
    body = new Body(config, human, agent);
    client = createBuzzClient({ baseUrl: BASE_URL, identity: human });
    await waitUntil(() => client.isMember(roomId, agent.publicKey));
    await body.provision(roomId, {
      repo: 'slash-live',
      localPath: workspace,
      remoteName: 'origin',
      targetBranch: 'refs/heads/main',
      localOnly: true,
    });
  }, 120_000);

  afterAll(async () => {
    client?.disconnect();
    if (body) await body.dispose();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }, 30_000);

  const binding = () => ({
    repo: 'slash-live',
    localPath: workspace,
    remoteName: 'origin',
    targetBranch: 'refs/heads/main',
    localOnly: true,
  });

  async function events() {
    return client.sessionEventsBackfill(roomId, { limit: 500 });
  }

  const notices = () =>
    events().then((all) =>
      all.filter((entry) =>
        entry.event.tags.some((tag) => tag[0] === 't' && tag[1] === 'slash-command-notice'),
      ),
    );

  it('marks /loop as a passed-through unknown verb and still completes the turn', async () => {
    const sent = await client.messageSubmit(roomId, '/loop', {
      mentionAgent: agent.publicKey,
    });

    // Drive the delivery loop by hand (no push loop in this test) until the
    // turn lifecycle has fully landed.
    await waitUntil(async () => {
      await body!.pollChannelRequests(roomId, binding());
      return (await events()).some(
        (entry) =>
          entry.event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-turn') &&
          entry.event.tags.some((tag) => tag[0] === 'request' && tag[1] === sent.id) &&
          entry.event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'complete'),
      );
    });

    const roomNotices = await notices();
    expect(roomNotices).toHaveLength(1);
    expect(roomNotices[0]!.event.tags).toContainEqual(['command', 'loop']);
    expect(roomNotices[0]!.content).toContain('/loop is not a Beeline command');
    expect(roomNotices[0]!.content).toContain('/open-corner');
    expect(roomNotices[0]!.content).toContain('passed to the agent as an ordinary request');
    // The turn itself was never blocked: the agent answered the request.
    const reply = (await events()).find(
      (entry) =>
        entry.event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-message') &&
        entry.event.tags.some(
          (tag) => tag[0] === 'e' && tag[1] === sent.id,
        ),
    );
    expect(reply?.content).toBeTruthy();
    // No corner may open from this — the escalation path needs a human ALLOW
    // on a mutating request, and regardless the text is now visibly marked.
    expect(await client.listSubchannels(roomId)).toHaveLength(0);
  }, 170_000);

  it('never marks prose that merely starts with a slash', async () => {
    const sent = await client.messageSubmit(
      roomId,
      '/etc/hosts is a file — what usually lives in it?',
      { mentionAgent: agent.publicKey },
    );

    await waitUntil(async () => {
      await body!.pollChannelRequests(roomId, binding());
      return (await events()).some(
        (entry) =>
          entry.event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-turn') &&
          entry.event.tags.some((tag) => tag[0] === 'request' && tag[1] === sent.id) &&
          entry.event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'complete'),
      );
    });

    // Still exactly the one notice from the previous test — prose got none.
    expect(await notices()).toHaveLength(1);
  }, 170_000);
});
