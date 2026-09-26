import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from './verify-beeline-install.mjs';

test('run keeps stdin open until the requested JSON-RPC reply is complete', async () => {
  const server = String.raw`
    let scheduled = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) + '\n');
      }, 25);
    });
    process.stdin.on('end', () => process.exit(0));
  `;

  const result = await run(process.execPath, ['--input-type=module', '--eval', server], {
    input: '{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n',
    untilAnswered: 2,
    timeoutMs: 1_000,
  });

  const ids = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).id);
  assert.deepEqual(ids, [1, 2]);
});

test('run preserves child stderr when waiting for a reply times out', async () => {
  const server = String.raw`
    process.stderr.write('probe diagnostic from stderr\n');
    process.stdin.resume();
  `;

  await assert.rejects(
    run(process.execPath, ['--input-type=module', '--eval', server], {
      input: '{"jsonrpc":"2.0","id":2}\n',
      untilAnswered: 2,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.match(error.message, /timed out after 1000ms/);
      assert.match(error.message, /probe diagnostic from stderr/);
      return true;
    },
  );
});
