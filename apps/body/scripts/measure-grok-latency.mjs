#!/usr/bin/env node
/**
 * Compare Grok's native one-shot CLI, its raw ACP stdio server, and Beeline's
 * ACP client + draft projection with the same cwd and prompt.
 *
 * Usage:
 *   GROK_HOME=/path/to/isolated/home \
 *     node --import tsx apps/body/scripts/measure-grok-latency.mjs \
 *       --mode native-cli|direct-acp|beeline-acp [--runs 3] [--turns 2] [--cwd /repo]
 *
 * The caller owns GROK_HOME so the probe never mutates the operator's normal
 * Grok session store. The home still needs a usable auth.json.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { newIdentity } from '@beeline/gate';
import { AcpClient } from '../src/acp.js';
import { createDraftStreamer } from '../src/activity.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const runs = Math.max(1, Number.parseInt(option('--runs', '1'), 10) || 1);
const turns = Math.max(1, Number.parseInt(option('--turns', '1'), 10) || 1);
const cwd = resolve(option('--cwd', process.cwd()));
const prompt = option('--prompt', 'Reply with exactly PONG and nothing else.');
const grok = option('--grok', 'grok');
const timeoutMs = Math.max(10_000, Number.parseInt(option('--timeout-ms', '120000'), 10) || 120_000);
const selectedMode = option('--mode', '');
const systemOverride = option('--system-override', '');

if (!process.env.GROK_HOME) {
  throw new Error('Set GROK_HOME to an isolated, authenticated Grok home before running this probe.');
}

const elapsed = (started) => Math.round((performance.now() - started) * 10) / 10;

function summary(samples) {
  const keys = [...new Set(samples.flatMap((sample) => Object.keys(sample)))].filter(
    (key) => key !== 'mode' && key !== 'updateKinds',
  );
  return Object.fromEntries(
    keys.map((key) => {
      const values = samples
        .map((sample) => sample[key])
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
      if (!values.length) return [key, null];
      const total = values.reduce((sum, value) => sum + value, 0);
      return [key, Math.round((total / values.length) * 10) / 10];
    }),
  );
}

async function nativeCli() {
  const started = performance.now();
  const child = spawn(
    grok,
    ['--output-format', 'streaming-json', '--verbatim', '-p', prompt],
    { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const result = { mode: 'native-cli' };
  let buffer = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'thought' && result.firstThoughtMs === undefined) {
        result.firstThoughtMs = elapsed(started);
      }
      if (event.type === 'text' && result.firstTextMs === undefined) {
        result.firstTextMs = elapsed(started);
      }
      if (event.type === 'end') {
        result.inputTokens = event.usage?.input_tokens;
        result.outputTokens = event.usage?.output_tokens;
      }
    }
  });
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  result.completeMs = elapsed(started);
  if (code !== 0) throw new Error(`native grok exited code=${code} signal=${signal}: ${stderr.trim()}`);
  return result;
}

function rawAcpRequest(child, pending, nextId, method, params) {
  const id = nextId.value++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
  });
}

async function directAcp() {
  const processStarted = performance.now();
  const child = spawn(grok, ['agent', 'stdio'], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  const pending = new Map();
  const nextId = { value: 1 };
  const result = { mode: 'direct-acp', updateKinds: [] };
  let promptStarted;
  let activeTurn;
  let buffer = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (!request) continue;
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
        continue;
      }
      if (message.method === 'session/update' && promptStarted !== undefined) {
        const kind = message.params?.update?.sessionUpdate;
        if (typeof kind === 'string' && !result.updateKinds.includes(kind)) result.updateKinds.push(kind);
        if (activeTurn && typeof kind === 'string' && !activeTurn.updateKinds.includes(kind)) {
          activeTurn.updateKinds.push(kind);
        }
        if (activeTurn && activeTurn.firstUpdateMs === undefined) {
          activeTurn.firstUpdateMs = elapsed(promptStarted);
        }
        if (activeTurn && /thought|reasoning|analysis/.test(kind) && activeTurn.firstThoughtMs === undefined) {
          activeTurn.firstThoughtMs = elapsed(promptStarted);
        }
        if (activeTurn && kind === 'agent_message_chunk' && activeTurn.firstTextMs === undefined) {
          activeTurn.firstTextMs = elapsed(promptStarted);
        }
        continue;
      }
      if (message.method && message.id !== undefined) {
        const allow = message.params?.options?.find((entry) => /allow|approve/i.test(entry.optionId ?? ''));
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : {},
          })}\n`,
        );
      }
    }
  });
  try {
    await rawAcpRequest(child, pending, nextId, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    result.initializeMs = elapsed(processStarted);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const session = await rawAcpRequest(child, pending, nextId, 'session/new', {
      cwd,
      mcpServers: [],
      ...(systemOverride ? { _meta: { systemPromptOverride: systemOverride } } : {}),
    });
    result.sessionReadyMs = elapsed(processStarted);
    result.turns = [];
    for (let turn = 1; turn <= turns; turn++) {
      activeTurn = { turn, updateKinds: [] };
      promptStarted = performance.now();
      await rawAcpRequest(child, pending, nextId, 'session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      activeTurn.completeMs = elapsed(promptStarted);
      result.turns.push(activeTurn);
    }
    Object.assign(result, result.turns[0]);
    delete result.turn;
    return result;
  } finally {
    clearTimeout(timer);
    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'shutdown', params: {} })}\n`);
    }
    let exited = false;
    await Promise.race([
      childExit.then(() => {
        exited = true;
      }),
      new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
    ]).catch(() => undefined);
    if (!exited) child.kill('SIGTERM');
    if (result.completeMs === undefined && stderr.trim()) result.stderr = stderr.trim();
  }
}

async function beelineAcp() {
  const processStarted = performance.now();
  const client = new AcpClient({
    agentCommand: grok,
    agentArgs: ['agent', 'stdio'],
    agentEnv: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      GROK_HOME: process.env.GROK_HOME,
      RUST_LOG: 'warn',
    },
    agentCwd: cwd,
    autoApprovePermissions: true,
  });
  const result = { mode: 'beeline-acp', updateKinds: [] };
  let promptStarted;
  let activeTurn;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    if (activeTurn && activeTurn.firstDraftMs === undefined && promptStarted !== undefined) {
      activeTurn.firstDraftMs = elapsed(promptStarted);
    }
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  };
  const identity = newIdentity('grok-latency-probe');
  const onUpdate = (update) => {
    if (promptStarted === undefined) return;
    const kind = update.update?.sessionUpdate;
    if (typeof kind === 'string' && !result.updateKinds.includes(kind)) result.updateKinds.push(kind);
    if (activeTurn && typeof kind === 'string' && !activeTurn.updateKinds.includes(kind)) {
      activeTurn.updateKinds.push(kind);
    }
    if (activeTurn && activeTurn.firstUpdateMs === undefined) activeTurn.firstUpdateMs = elapsed(promptStarted);
    if (activeTurn && /thought|reasoning|analysis/.test(kind) && activeTurn.firstThoughtMs === undefined) {
      activeTurn.firstThoughtMs = elapsed(promptStarted);
    }
  };
  client.on('session/update', onUpdate);
  try {
    await client.start();
    result.initializeMs = elapsed(processStarted);
    const session = await client.sessionNew({
      cwd,
      mcpServers: [],
      systemPrompt: 'You are a Beeline agent. Answer the human directly and keep the response concise.',
      mode: 'readonly',
    });
    result.sessionReadyMs = elapsed(processStarted);
    result.turns = [];
    for (let turn = 1; turn <= turns; turn++) {
      activeTurn = { turn, updateKinds: [] };
      const streamer = createDraftStreamer(
        'latency-probe-room',
        identity,
        'latency-probe-session',
        `latency-probe-request-${turn}`,
      );
      promptStarted = performance.now();
      await client.sessionPrompt(
        session.sessionId,
        prompt,
        timeoutMs,
        (_delta, fullText) => {
          if (activeTurn.firstTextMs === undefined) activeTurn.firstTextMs = elapsed(promptStarted);
          streamer.onChunk(fullText);
        },
      );
      activeTurn.completeMs = elapsed(promptStarted);
      await streamer.finish();
      result.turns.push(activeTurn);
    }
    Object.assign(result, result.turns[0]);
    delete result.turn;
    return result;
  } finally {
    client.off('session/update', onUpdate);
    await client.stop();
    globalThis.fetch = originalFetch;
  }
}

const modeNames = new Map([
  ['native-cli', nativeCli],
  ['direct-acp', directAcp],
  ['beeline-acp', beelineAcp],
]);
const modes = [modeNames.get(selectedMode)].filter(Boolean);
if (!modes.length) {
  throw new Error('Pass --mode native-cli, --mode direct-acp, or --mode beeline-acp.');
}
const samples = [];
for (let run = 1; run <= runs; run++) {
  for (const measure of modes) {
    const sample = await measure();
    sample.run = run;
    samples.push(sample);
    process.stderr.write(`${JSON.stringify(sample)}\n`);
  }
}

const byMode = Object.fromEntries(
  modes.map((measure) => {
    const name = measure.name === 'nativeCli' ? 'native-cli' : measure.name === 'directAcp' ? 'direct-acp' : 'beeline-acp';
    return [name, summary(samples.filter((sample) => sample.mode === name))];
  }),
);
process.stdout.write(`${JSON.stringify({ cwd, prompt, runs, turns, samples, mean: byMode }, null, 2)}\n`);
