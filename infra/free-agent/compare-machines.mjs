#!/usr/bin/env node
// Explicit opt-in: this creates and destroys ten disposable Fly Machines.
// FLY_API_TOKEN must already exist in the backend environment; never fetch it
// into chat. Registry tags must have been pushed before invoking this script.
// Usage: node infra/free-agent/compare-machines.mjs <image-sha> [--task]
import { readFile, writeFile } from 'node:fs/promises';
const sha = process.argv[2];
if (!/^[a-f0-9]{7,40}$/.test(sha ?? '')) throw new Error('expected image commit SHA');
if (!process.env.FLY_API_TOKEN) throw new Error('FLY_API_TOKEN is required in the backend environment');
const task = process.argv.includes('--task');
if (task && (!process.env.MODEL_BASE_URL || !process.env.BEELINE_FREE_AGENT_MODEL_TOKEN))
  throw new Error('task mode requires a backend model route and scoped token');
const base = 'https://api.machines.dev/v1/apps/beeline-free-agents/machines';
const runner = await readFile(new URL('./compare-harness.mjs', import.meta.url));
const results = [];
const cleanupFailed = [];
const pause = () => new Promise((accept) => setTimeout(accept, 500));
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method,
    headers: { Authorization: `Bearer ${process.env.FLY_API_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  // Never log upstream bodies, which can echo a Machine's backend env.
  if (!response.ok) throw new Error(`Fly ${method} ${path}: HTTP ${response.status}`);
  const text = await response.text(); return text ? JSON.parse(text) : undefined;
}
try {
  // Alternate order to reduce temporal bias. Every sample gets a fresh rootfs.
  for (let sample = 1; sample <= 5; sample++) {
    for (const harness of sample % 2 ? ['opencode', 'pi'] : ['pi', 'opencode']) {
      let id;
      try {
        const image = `registry.fly.io/beeline-free-agents:cmp-${harness}-${sha}`;
        const env = { COMPARISON_KEEP_ALIVE: '1',
          ...(task ? { MODEL_BASE_URL: process.env.MODEL_BASE_URL,
            BEELINE_FREE_AGENT_MODEL_TOKEN: process.env.BEELINE_FREE_AGENT_MODEL_TOKEN } : {}) };
        const machine = await api('', 'POST', { name: `cmp-${harness}-${sha.slice(0, 7)}-${sample}-${Date.now().toString(36)}`,
          region: 'iad', skip_launch: true, config: { image,
            init: { exec: ['node', '/opt/compare-harness.mjs', harness, ...(task ? [] : ['--boot'])] },
            env, files: [{ guest_path: '/opt/compare-harness.mjs', raw_value: runner.toString('base64') }],
            guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 2048 }, restart: { policy: 'no' },
            metadata: { purpose: 'd14835c5-harness-comparison' } } });
        id = machine.id;
        let startRequestedAt;
        const startDeadline = Date.now() + 120_000;
        for (;;) {
          startRequestedAt = Date.now();
          try { await api(`/${id}/start`, 'POST', {}); break; }
          catch (error) {
            // A newly created Machine can still be preparing its rootfs.
            // Start timing at the accepted request, not failed preconditions.
            if (!/HTTP 412/.test(error.message) || Date.now() >= startDeadline) throw error;
            await pause();
          }
        }
        const deadline = Date.now() + (task ? 420_000 : 120_000);
        let result;
        while (Date.now() < deadline) {
          try {
            const read = await api(`/${id}/exec`, 'POST', {
              command: ['node', '-e', 'process.stdout.write(require("fs").readFileSync("/tmp/beeline-harness-comparison/result.json","utf8"))'], timeout: 5 });
            if (read.exit_code === 0 && read.stdout) { result = JSON.parse(read.stdout); break; }
          } catch (error) {
            if (!/HTTP (408|412|429|500|502|503|504)/.test(error.message)) throw error;
          }
          await pause();
        }
        if (!result) throw new Error('comparison timed out');
        // Start-request -> initialize includes API latency and guest startup.
        // It excludes image provisioning, because create used skip_launch.
        const row = { sample, image, machineId: id, startRequestedAt, ...result,
          machineStartToInitializeMs: result.initializeAnsweredAt ? result.initializeAnsweredAt - startRequestedAt : null };
        results.push(row);
        console.log(JSON.stringify(row));
        if (result.error || (task && (!result.taskPassed || !result.usageObserved))) throw new Error(`${harness} comparison failed`);
      } finally {
        if (id) {
          try { await api(`/${id}?force=true`, 'DELETE'); }
          catch { cleanupFailed.push(id); }
        }
      }
    }
  }
} finally {
  const summary = { definition: 'Fly start request dispatched to ACP initialize response; excludes image provisioning; includes API latency',
    task, results, cleanupFailed, mediansMs: {} };
  for (const harness of ['opencode', 'pi']) {
    const values = results.filter((row) => row.harness === harness && Number.isFinite(row.machineStartToInitializeMs))
      .map((row) => row.machineStartToInitializeMs).sort((a, b) => a - b);
    summary.mediansMs[harness] = values.length === 5 ? values[2] : null;
  }
  await writeFile(process.env.COMPARISON_OUTPUT ?? '/tmp/beeline-harness-comparison-results.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ mediansMs: summary.mediansMs, samples: results.length, cleanupFailed }));
  if (cleanupFailed.length) throw new Error(`cleanup required for ${cleanupFailed.join(', ')}`);
}
