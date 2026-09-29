/**
 * Local reproduction for the Claude model-availability flap (P2, 2026-09-29):
 * Claude agents intermittently fail turns with "the selected model isn't
 * available" or "isn't signed in to her provider" and recover on their own
 * with no change.
 *
 * Both fake harnesses below answer with a TRANSIENT provider condition (a 529
 * overloaded response from `session/set_config_option`, and a 401 mid-refresh
 * response from `session/new`) — never a genuinely wrong model id or missing
 * credential. Both still produce the exact standing-condition Room copy a
 * human reads as permanent, because:
 *
 *  - `applyAgentModelSelectionWithUpdatedCatalog` (model-config.ts) wraps ANY
 *    `setConfigOption`/`setModel` rejection into `ModelSelectionUnavailableError`
 *    with `reason: 'provider-refused'`, discarding whether the provider said
 *    "that model doesn't exist" or "try again in a second".
 *  - `distillTurnFailureReason` (turn-failure-reason.ts) special-cases EVERY
 *    `ModelSelectionUnavailableError` to the fixed text `'model selection
 *    unavailable'` before the real (transient) message is even looked at.
 *  - `classifyTurnSilence`/`phraseTurnSilence` (api-contract's turn-silence.ts)
 *    then render the fixed, non-retryable "wrong-model" or "not-signed-in"
 *    copy. Neither kind is in `shouldRestartHiccup`'s retry set, so the turn
 *    fails outright instead of being retried as a hiccup — the daemon's next,
 *    unrelated activation just happens to succeed, which reads as "recovered
 *    on its own with no change".
 *
 * Evidence only — no production code is changed by this file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { AcpClient } from './acp.js';
import {
  applyAgentModelSelection,
  filterAllowedModelConfigOptions,
  parseAdvertisedConfigOptions,
  ModelSelectionUnavailableError,
} from './model-config.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { classifyTurnSilence, phraseTurnSilence } from '@beeline/api-contract/daemon';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Mimics claude-agent-acp: `session/new` advertises a `model` configOptions
 * axis including `opus[1m]` (the 1M-context tier id), then
 * `session/set_config_option` for that exact advertised value answers with a
 * JSON-RPC error carrying the raw Anthropic 529 overloaded body — the
 * provider momentarily refusing the request, not retiring the model.
 */
async function fakeClaudeAgentAcpTransientOverload(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-529-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'claude-agent-acp.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'sess-1',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'sonnet',
            options: [{ id: 'sonnet', name: 'Sonnet 5.5' }, { id: 'opus[1m]', name: 'Opus 5.5 1M' }],
          },
        ],
      },
    });
  } else if (message.method === 'session/set_config_option' && message.params.value === 'opus[1m]') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: 'Internal error',
        data: {
          details:
            '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        },
      },
    });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

/**
 * Mimics claude-agent-acp mid-OAuth-refresh: `session/new` itself fails with
 * a transient 401 while the harness's own token refresh is in flight — not a
 * missing/expired credential requiring `beeline connect`.
 */
async function fakeClaudeAgentAcpAuthRefreshRace(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-401-refresh-'));
  temporaryDirectories.push(directory);
  const binary = resolve(directory, 'claude-agent-acp.mjs');
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: 'Internal error',
        data: {
          details:
            '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token refresh in progress, retry"}}',
        },
      },
    });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

describe('model-flap repro: transient provider errors read as standing conditions', () => {
  it('a 529 overload on set_config_option renders as "the selected model isn\'t available"', async () => {
    const client = new AcpClient({
      agentCommand: await fakeClaudeAgentAcpTransientOverload(),
      agentLabel: 'claude-agent-acp',
      agentEnv: {},
    });
    await client.start();
    let turnError: unknown;
    try {
      const opened = await client.sessionNew({ cwd: tmpdir() });
      const options = filterAllowedModelConfigOptions(
        parseAdvertisedConfigOptions(opened.raw, 'opus[1m]'),
      );
      try {
        await applyAgentModelSelection(client, opened.sessionId, options, { model: 'opus[1m]' });
      } catch (error) {
        turnError = error;
      }
    } finally {
      await client.stop();
    }

    // The thrown error still carries the real, transient cause...
    expect(turnError).toBeInstanceOf(ModelSelectionUnavailableError);
    const modelError = turnError as ModelSelectionUnavailableError;
    expect(modelError.reason).toBe('provider-refused');
    expect(modelError.guidance).toContain('overloaded_error');

    // ...but the daemon's own turn-failure distillation throws it away:
    const distilled = distillTurnFailureReason(turnError);
    expect(distilled.text).toBe('model selection unavailable');
    expect(distilled.kind).toBe('model-selection-unavailable');

    // ...and the Room copy reads as a permanent, non-retryable configuration
    // problem with the actual "provider said 529" detail gone entirely.
    const classified = classifyTurnSilence(distilled.text, distilled.kind);
    expect(classified.kind).toBe('wrong-model');
    const phrase = phraseTurnSilence('Niglet', classified);
    expect(phrase.consequence).toBe(
      "the selected model isn't available. Pick another in the agent's settings.",
    );
  });

  it('a 401 mid-token-refresh on session/new renders as "isn\'t signed in to the provider"', async () => {
    const client = new AcpClient({
      agentCommand: await fakeClaudeAgentAcpAuthRefreshRace(),
      agentLabel: 'claude-agent-acp',
      agentEnv: {},
    });
    await client.start();
    let turnError: unknown;
    try {
      await client.sessionNew({ cwd: tmpdir() });
    } catch (error) {
      turnError = error;
    } finally {
      await client.stop();
    }

    // This never goes through model-config at all — session/new itself
    // failed, so the raw harness message is all the daemon has.
    expect(turnError).not.toBeInstanceOf(ModelSelectionUnavailableError);
    const distilled = distillTurnFailureReason(turnError);

    // Text-matched straight into the same non-retryable standing-condition
    // bucket as a genuinely expired/missing credential.
    const classified = classifyTurnSilence(distilled.text, distilled.kind);
    expect(classified.kind).toBe('not-signed-in');
    const phrase = phraseTurnSilence('Niglet', classified);
    expect(phrase.consequence).toBe(
      "the helper isn't signed in to the provider. Run `beeline connect` on the helper's machine.",
    );
  });
});
