import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'beeline-cli-stdout-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function run(mode: 'closed' | 'open' | 'EIO') {
  // Stub only transport and Sentry; execute the actual CLI command in a child.
  const transport = `export async function activateDaemonTransport() {
    return { client: { async execute(operation, input) {
      if (operation !== 'getRoomGitHubToken' || input.roomId !== 'fixture-room') throw new Error('unexpected request');
      await new Promise(resolve => { process.once('message', resolve); process.send('ready'); });
      process.disconnect();
      return { token: 'synthetic-test-value' };
    } } };
  }`;
  const sentry = `export function captureHelperError() { console.error('SENTRY_CAPTURE'); }
    export async function flushHelperErrors() {}`;
  await writeFile(join(root, 'loader.mjs'), `
    export async function resolve(specifier, context, next) {
      let source;
      if (specifier.includes('daemon-api-client.') && (context.parentURL?.includes('/cli.ts') || context.parentURL?.includes('/cli.js'))) source = ${JSON.stringify(transport)};
      if (specifier.includes('/sentry.')) source = ${JSON.stringify(sentry)};
      if (source) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      return next(specifier, context);
    }
  `);
  await writeFile(join(root, 'bootstrap.mjs'), `
    import { register } from 'node:module';
    register('./loader.mjs', import.meta.url);
    if (process.env.STDOUT_TEST_MODE === 'EIO') {
      process.stdout.write = () => {
        queueMicrotask(() => process.stdout.emit('error', Object.assign(new Error('synthetic write EIO'), { code: 'EIO' })));
        return false;
      };
    }
  `);
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--import', join(root, 'bootstrap.mjs'),
    fileURLToPath(new URL(process.env.BEELINE_TEST_BUILT_CLI === '1' ? '../dist/cli.js' : './cli.ts', import.meta.url)),
    'corner-read-token', '--config', join(root, 'unused-config'), '--room', 'fixture-room',
  ], {
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, STDOUT_TEST_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
  child.on('message', () => {
    if (mode === 'closed') {
      child.stdout.destroy();
      child.stdout.once('close', () => child.send('write'));
    } else child.send('write');
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 12_000);
  try {
    const [code, signal] = await once(child, 'close');
    // Assert a boolean so even failing assertions never print the token.
    return { code, signal, normalOutput: output === 'synthetic-test-value\n', errors };
  } finally { clearTimeout(timeout); }
}

test('HELPER-4: a closed stdout reader exits cleanly without a fatal report', async () => {
  const result = await run('closed');
  expect(result.code, result.errors).toBe(0);
  expect(result.signal).toBe(null);
  expect(result.errors).toBe('');
});

test('stdout errors other than EPIPE still surface', async () => {
  const result = await run('EIO');
  expect(result.code).not.toBe(0);
  expect(result.errors).toContain('synthetic write EIO');
});

test('an open reader receives the unchanged token and newline', async () => {
  const result = await run('open');
  expect(result.code, result.errors).toBe(0);
  expect(result.normalOutput).toBe(true);
  expect(result.errors).toBe('');
});
