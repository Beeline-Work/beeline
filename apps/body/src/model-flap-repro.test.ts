/**
 * End-to-end regression coverage for the Claude model-availability flap (P2,
 * 2026-09-29): Claude agents intermittently failed turns with "the selected
 * model isn't available" or "isn't signed in to her provider" and recovered
 * on their own with no change. Production evidence (2026-09-29T22:02Z) found
 * two distinct, compounding causes:
 *
 *  1. TRANSIENT masking: a genuinely transient provider condition (a 529
 *     overload from `session/set_config_option`, or a 401 from
 *     claude-agent-acp's own OAuth token mid-refresh on `session/new`) was
 *     indistinguishable, by the code, from a permanent configuration
 *     problem — both collapsed into the same standing, non-retryable Room
 *     copy. Fixed by `isTransientProviderText`/`isAuthShapedFault`
 *     (`transient-provider-error.ts`, `@beeline/api-contract`'s
 *     `turn-silence.ts`) rethrowing instead of wrapping in
 *     `ModelSelectionUnavailableError`, and by `distillTurnFailureReason`
 *     reporting every auth-shaped failure as an ordinary retryable hiccup
 *     (escalated to the standing not-signed-in verdict only once the
 *     existing bounded hiccup retries are exhausted — see
 *     `turn-silence-notice.test.ts`'s "escalates an exhausted auth-shaped
 *     hiccup" case for that half).
 *  2. RETIREMENT: Niglet's actual `opus[1m]` selection had been genuinely
 *     dropped from claude-agent-acp's own catalog (not a bug — a real
 *     provider-side alias removal), which correctly set the durable
 *     `model_unavailable` flag but then bricked the agent with no automatic
 *     recovery. Fixed by `resolveModelFamilyFallback`
 *     (`model-config.ts`) substituting a same-family replacement so the
 *     turn still succeeds; see `model-config.test.ts` for synthetic-catalog
 *     coverage of the fallback/effort-drop/no-family-match cases.
 *
 * The two tests below drive REAL fake ACP harnesses end to end (spawn,
 * `session/new`, the real `applyAgentModelSelection`/`distillTurnFailureReason`
 * pipeline) to prove cases 1 and 2 no longer produce the bug's standing,
 * misleading Room copy.
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

/**
 * Mimics claude-agent-acp genuinely dropping `opus[1m]` from its own live
 * catalog (case 2, production-verified for Niglet): `session/new` advertises
 * `model`/`sonnet`/`opus` but no `[1m]` variant at all, and
 * `session/set_config_option` succeeds for whatever id it is actually asked
 * to apply.
 */
async function fakeClaudeAgentAcpRetiredAlias(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'buzzy-acp-retired-alias-'));
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
            options: [{ id: 'sonnet', name: 'Sonnet 5.5' }, { id: 'opus', name: 'Opus 5.5' }],
          },
        ],
      },
    });
  } else if (message.method === 'session/set_config_option') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: message.params.value,
            options: [{ id: 'sonnet', name: 'Sonnet 5.5' }, { id: 'opus', name: 'Opus 5.5' }],
          },
        ],
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

describe('model-flap fix: transient provider errors no longer read as standing conditions', () => {
  it('a 529 overload on set_config_option retries as an ordinary hiccup, not a standing "model unavailable" verdict', async () => {
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

    // No longer collapsed into the typed, non-retryable unavailability error...
    expect(turnError).not.toBeInstanceOf(ModelSelectionUnavailableError);
    expect((turnError as Error).message).toContain('overloaded_error');

    // ...so the daemon's own turn-failure distillation reports it as an
    // ordinary hiccup, which the server retries with backoff instead of
    // telling the owner to pick another model.
    const distilled = distillTurnFailureReason(turnError);
    expect(distilled.kind).toBe('hiccup');
    expect(distilled.text).toContain('overloaded_error');
  });

  it("a 401 mid-token-refresh on session/new retries as an ordinary hiccup, not a standing \"not signed in\" verdict", async () => {
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

    expect(turnError).not.toBeInstanceOf(ModelSelectionUnavailableError);
    const distilled = distillTurnFailureReason(turnError);
    // No longer text-matched straight into the standing not-signed-in verdict:
    // the server's bounded hiccup retries (see turn-silence-notice.test.ts's
    // "escalates an exhausted auth-shaped hiccup" case) now get a chance to
    // clear the race before it settles into that copy.
    expect(distilled.kind).toBe('hiccup');
  });
});

describe('model-flap fix: a retired model alias falls back instead of bricking the agent', () => {
  it('opus[1m] dropped from the live catalog falls back to opus and the turn still succeeds', async () => {
    const client = new AcpClient({
      agentCommand: await fakeClaudeAgentAcpRetiredAlias(),
      agentLabel: 'claude-agent-acp',
      agentEnv: {},
    });
    await client.start();
    try {
      const opened = await client.sessionNew({ cwd: tmpdir() });
      const options = filterAllowedModelConfigOptions(
        parseAdvertisedConfigOptions(opened.raw, 'opus[1m]'),
      );
      const applied = await applyAgentModelSelection(client, opened.sessionId, options, {
        model: 'opus[1m]',
      });
      expect(applied.appliedSelection.model).toBe('opus');
    } finally {
      await client.stop();
    }
  });
});
