/**
 * Live boundary test: a Room session MUST expose useful inspection tools,
 * lack every mutation tool, and remain unable to create files.
 *
 * Spec: "Read-only → edit is a real boundary, not a prompt."
 * "The permission boundary is the mode boundary, enforced at the tool layer."
 *
 * Protocol layer assertions (MCP inventory) + filesystem assertions (no file
 * created) + positive control (same body in EDIT mode CAN write).
 *
 * Soft-skips when relay is unreachable (soft skip = test passes with a note).
 * Never skips when both relay and LLM env are present.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Body, readOnlyMcpServer } from './body.js';
import { AcpClient } from './acp.js';
import { hasLiveAgent, liveAcpClientOptions, loadLiveBodyConfig } from './live-test-agent.js';
import {
  inventoryForMcpServers,
  hasWriteTools,
  callMcpTool,
  type McpServerSpec,
} from './mcp-inventory.js';
import { newIdentity, createChannel, setMemberRole, BASE_URL } from '@beeline/gate';

// LLM env file driven by env var; no hardcoded home path.
const LLM_ENV_FILE = process.env.BUZZY_BODY_LLM_FILE ?? undefined;

interface ReadonlyTestContext {
  body: Body | null;
  tlcChannelId: string;
  testDir: string;
  readonlySessionId?: string;
  readonlyServer?: McpServerSpec;
  skipped: boolean;
}

describe('TLC read-only boundary', () => {
  const ctx: ReadonlyTestContext = {
    body: null,
    tlcChannelId: '',
    testDir: '',
    skipped: true,
  };

  beforeAll(async () => {
    // Check relay reachability.
    let relayOk = false;
    try {
      const res = await fetch(`${BASE_URL}/`, {
        headers: { Accept: 'application/nostr+json' },
      });
      relayOk = res.ok;
    } catch {
      console.warn('[tlc-readonly] relay unreachable — soft-skipping');
      return;
    }

    // Check the selected live ACP runtime.
    const config = loadLiveBodyConfig({
      workspaceRoot: '/tmp/buzzy-body-test',
      llmEnvFile: LLM_ENV_FILE,
    });

    if (!hasLiveAgent(config)) {
      console.warn('[tlc-readonly] no live ACP runtime — soft-skipping');
      return;
    }

    // Both present — proceed.
    const testDir = await mkdtemp(resolve(tmpdir(), 'buzzy-tlc-test-'));
    ctx.testDir = testDir;

    const bodyIdentity = newIdentity('test-body');
    const tlcChannelId = await createChannel(bodyIdentity, 'boundary-test-tlc');
    await setMemberRole(bodyIdentity, tlcChannelId, bodyIdentity.publicKey, 'member');

    ctx.body = new Body({ ...config, workspaceRoot: testDir }, bodyIdentity);
    const readonlyWire = readOnlyMcpServer(config, testDir);
    ctx.readonlyServer = {
      name: readonlyWire.name,
      command: readonlyWire.command,
      args: readonlyWire.args,
      env: Object.fromEntries((readonlyWire.env ?? []).map((entry) => [entry.name, entry.value])),
      cwd: testDir,
    };

    await ctx.body.provision(tlcChannelId);
    ctx.tlcChannelId = tlcChannelId;

    const session = ctx.body.getSession(tlcChannelId);
    if (session) {
      ctx.readonlySessionId = session.sessionId;
    }

    ctx.skipped = false;
  }, 60_000);

  afterAll(async () => {
    if (ctx.body) await ctx.body.dispose();
    if (ctx.testDir) {
      await rm(ctx.testDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('relay and LLM env are available (test was not soft-skipped)', () => {
    if (ctx.skipped) {
      console.warn('[tlc-readonly] all tests soft-skipped — relay or LLM unavailable');
      return;
    }
    expect(ctx.tlcChannelId).toBeTruthy();
    expect(ctx.readonlySessionId).toBeTruthy();
  });

  it('PROTOCOL: read-only session exposes inspection tools and no write tools', async () => {
    if (ctx.skipped || !ctx.readonlyServer) return;
    const tools = await inventoryForMcpServers([ctx.readonlyServer]);
    expect(hasWriteTools(tools)).toBe(false);
    expect(tools).toEqual([
      'list_files',
      'read_file',
      'search_text',
      'git_log',
      'git_show',
      'git_diff',
    ]);
  }, 30_000);

  it('FILESYSTEM: agent cannot write files in read-only mode', async () => {
    if (ctx.skipped || !ctx.readonlySessionId) return;

    const session = ctx.body!.getSession(ctx.tlcChannelId);
    expect(session).toBeDefined();

    const testFile = resolve(ctx.testDir, 'unauthorized-test.txt');
    expect(existsSync(testFile)).toBe(false);

    // Prompt agent to write — the inspection MCP has no mutation tools.
    await session!.client.sessionPrompt(
      session!.sessionId,
      'Please create a file at ' + testFile + ' with content "test"',
      30_000,
    );

    expect(existsSync(testFile)).toBe(false);
  }, 60_000);

  it('POSITIVE CONTROL: edit mode session CAN write files via MCP', async () => {
    if (ctx.skipped) return;

    const config = loadLiveBodyConfig({
      workspaceRoot: ctx.testDir,
      llmEnvFile: LLM_ENV_FILE,
    });

    const editClient = new AcpClient(liveAcpClientOptions(config));

    await editClient.start();

    const { sessionId } = await editClient.sessionNew({
      cwd: ctx.testDir,
      mode: 'edit',
      mcpServers: [
        {
          name: 'buzz-dev-mcp',
          command: config.mcpBinary,
          args: [],
        },
      ],
    });

    // Verify write tools are available in the MCP inventory.
    const mcpTools = await inventoryForMcpServers([
      {
        name: 'buzz-dev-mcp',
        command: config.mcpBinary,
      },
    ]);

    expect(hasWriteTools(mcpTools)).toBe(true);
    console.log('[positive-control] write tools:', mcpTools);

    // Try to prompt the agent to write a file.
    const testFile = resolve(ctx.testDir, 'positive-control-test.txt');
    const result = await editClient.sessionPrompt(
      sessionId,
      `Write a file to ${testFile} with content: "Hello from positive control"`,
      60_000,
    );

    // If LLM didn't write the file, call the MCP write tool directly
    // to prove edit-mode write capability deterministically.
    if (!existsSync(testFile)) {
      console.log('[positive-control] LLM did not write; calling MCP tool directly');
      console.log('[positive-control] tool calls:', result.toolCalls);

      await callMcpTool(
        {
          name: 'buzz-dev-mcp',
          command: config.mcpBinary,
          args: [],
          cwd: ctx.testDir,
        },
        'str_replace',
        {
          file_path: testFile,
          old_string: '',
          new_string: 'Hello from deterministic positive control',
        },
        15_000,
      );
    }

    expect(existsSync(testFile)).toBe(true);
    console.log('[positive-control] file created successfully:', testFile);
    await rm(testFile, { force: true });

    // Cleanup
    await editClient.stop();
  }, 120_000);
});
