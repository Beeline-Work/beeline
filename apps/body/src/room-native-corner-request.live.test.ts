/**
 * Live proofs for both harness corner-open transports. The native case drives
 * the installed permission-capable adapter directly. The pi case drives a
 * real Room, real pi-acp model turn, text-marker extraction, and relay child
 * creation without replacing any Body method.
 *
 * Soft-skips when codex-acp or its model credentials are unavailable. Once a
 * prompt completes successfully, failing to request a mutating tool is a real
 * regression rather than a skip.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BASE_URL, HOST, createChannel, git, newIdentity, setMemberRole } from '@beeline/gate';
import { createBuzzClient } from '@beeline/buzz-client';
import { AcpClient, isMutatingPermissionRequest, type AcpPermissionRequest } from './acp.js';
import { Body, roomEditPolicyInstructions } from './body.js';
import { loadBodyConfig } from './config.js';
import { resolveAgentCommand } from './agent-command.js';

const ADAPTER = process.env.BUZZY_LIVE_CORNER_ADAPTER ?? 'codex-acp';
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

describe('native edit-corner request against a real permission-capable harness', () => {
  it('turns a plain change request into session/request_permission without a text sentinel', async () => {
    const permissions: AcpPermissionRequest[] = [];
    const client = new AcpClient({
      agentCommand: ADAPTER,
      agentLabel: ADAPTER,
      agentEnv: {},
      inheritProcessEnv: true,
      autoApprovePermissions: false,
      permissionHandler: async (request) => {
        permissions.push(request);
        return 'reject';
      },
    });

    let agentText = '';
    try {
      await client.start();
      const session = await client.sessionNew({
        cwd: REPO_ROOT,
        mode: 'readonly',
        systemPrompt: [
          'You are a coding assistant in a read-only Room.',
          'The current checkout must remain unchanged until a human approves an edit corner.',
          ...roomEditPolicyInstructions('repository', ADAPTER),
        ].join('\n'),
      });
      const result = await client.sessionPrompt(
        session.sessionId,
        'Add a short native-corner-request proof note to README.md. Do the requested work.',
        180_000,
      );
      agentText = result.agentText;
    } catch (error) {
      if (permissions.length === 0) {
        console.warn(
          `[live] ${ADAPTER} or its credentials unavailable; skipping native corner proof (${String(error)})`,
        );
        return;
      }
      // A harness may report the rejected operation as a failed turn. The
      // permission event is still the end-to-end fact this test exercises.
    } finally {
      await client.stop();
    }

    const mutation = permissions.find(isMutatingPermissionRequest);
    expect(mutation).toBeDefined();
    expect(agentText).not.toContain('CORNER_REQUEST:');
    console.info(
      `[live] human: Add a short native-corner-request proof note to README.md. Do the requested work.\n` +
        `[live] ACP session/request_permission: ${mutation?.toolCall?.title ?? mutation?.toolCall?.kind ?? 'mutation'}\n` +
        `[live] agent: ${agentText.trim() || '(adapter ended after the host rejected the in-Room mutation)'}`,
    );
  }, 240_000);
});

async function relayReachable(): Promise<boolean> {
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

function piRuntimeAvailable(): boolean {
  try {
    resolveAgentCommand({ kind: 'pi' });
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 180_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

const piLive = (await relayReachable()) && piRuntimeAvailable();

describe.runIf(piLive)('pi text-fallback edit-corner request against real pi-acp', () => {
  const human = newIdentity('pi-corner-live-human');
  const agent = newIdentity('pi-corner-live-agent');
  let workspace = '';
  let remote = '';
  let roomId = '';
  let body: Body | undefined;
  let client: ReturnType<typeof createBuzzClient>;

  const binding = () => ({
    repo: 'pi-corner-live',
    localPath: workspace,
    remoteName: 'origin',
    targetBranch: 'refs/heads/main',
    localOnly: true,
  });

  beforeAll(async () => {
    roomId = await createChannel(human, `pi-corner-live-${Date.now()}`);
    await setMemberRole(human, roomId, agent.publicKey, 'member');
    workspace = await mkdtemp(resolve(tmpdir(), 'beeline-pi-corner-live-'));
    remote = await mkdtemp(resolve(tmpdir(), 'beeline-pi-corner-remote-'));
    await git(workspace, ['init', '-q', '-b', 'main']);
    await writeFile(resolve(workspace, 'README.md'), '# Real pi corner proof\n');
    await git(workspace, ['add', 'README.md']);
    await git(workspace, ['commit', '-m', 'seed real pi proof']);
    await git(remote, ['init', '--bare', '-q']);
    await git(workspace, ['remote', 'add', 'origin', remote]);
    const seeded = await git(workspace, ['push', '-u', 'origin', 'main']);
    if (!seeded.ok) throw new Error(seeded.stderr);

    body = new Body(
      loadBodyConfig({
        workspaceRoot: workspace,
        agent: resolveAgentCommand({ kind: 'pi' }),
      }),
      human,
      agent,
    );
    client = createBuzzClient({ baseUrl: BASE_URL, identity: human });
    await waitUntil(() => client.isMember(roomId, agent.publicKey));
    await body.provision(roomId, binding());
  }, 60_000);

  afterAll(async () => {
    client?.disconnect();
    if (body) await body.dispose();
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (remote) await rm(remote, { recursive: true, force: true });
  }, 60_000);

  it('emits CORNER_REQUEST and creates the requested relay corner', async () => {
    const requestCorner = vi.spyOn(body as never, 'handleAgentCornerRequest' as never);
    const rawPrompts = vi.spyOn(AcpClient.prototype, 'sessionPrompt');
    const request = await client.messageSubmit(
      roomId,
      'Read README.md, then create PI-CORNER-PROOF.md with one sentence confirming the live pi corner path and commit it.',
      { mentionAgent: agent.publicKey },
    );

    expect(await body!.pollChannelRequests(roomId, binding())).toBe(0);
    const roomPromptIndex = rawPrompts.mock.calls.findIndex(
      (call) =>
        String(call[1]).includes('CORNER_REQUEST: <one-sentence task objective>') &&
        String(call[1]).includes('create PI-CORNER-PROOF.md'),
    );
    expect(roomPromptIndex).toBeGreaterThanOrEqual(0);
    const rawRoomResult = await rawPrompts.mock.results[roomPromptIndex]!.value;
    expect(rawRoomResult.agentText).toContain('CORNER_REQUEST:');
    await waitUntil(async () => requestCorner.mock.calls.length === 1, 60_000);
    expect(requestCorner).toHaveBeenCalledWith(
      roomId,
      binding(),
      expect.objectContaining({ eventId: request.id }),
      expect.stringMatching(/PI-CORNER-PROOF\.md/i),
    );
    await requestCorner.mock.results[0]!.value;
    expect(await client.listSubchannels(roomId)).toHaveLength(1);

    const roomEvents = await client.sessionEventsBackfill(roomId, { limit: 200 });
    const reply = roomEvents.find(
      (event) =>
        event.pubkey === agent.publicKey &&
        event.tags.some((tag) => tag[0] === 'e' && tag[1] === request.id),
    );
    expect(reply?.content).toBeTruthy();
    expect(reply?.content).not.toContain('CORNER_REQUEST:');

    await body!.waitForAgentTasks();
    const corner = [...body!.getSubchannels().values()].find(
      (candidate) => candidate.request?.eventId === request.id,
    );
    expect(corner).toBeDefined();
    expect(
      await readFile(resolve(corner!.worktreePath, 'PI-CORNER-PROOF.md'), 'utf8'),
    ).not.toHaveLength(0);
    console.info(
      `[live] pi-acp marker objective: ${String(requestCorner.mock.calls[0]?.[3])}\n` +
        `[live] relay corner: ${corner!.subchannelId}\n` +
        '[live] result: real pi marker stripped, corner created, edit committed',
    );
  }, 300_000);
});
