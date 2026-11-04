import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

test('helper consumer includes all owned adapters but no unrelated route registry', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    stdin: { contents: ['helper-codecs', 'helper-activation-codecs', 'helper-turn-codecs']
      .map(name => `export * from './packages/net/src/${name}.ts';`).join('\n'),
      resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
    bundle: true, platform: 'browser', format: 'esm', minify: true, write: false, metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes('packages/net/src/generated-helper-shapes.ts'));
  for (const name of ['helper-codecs', 'helper-activation-codecs', 'helper-turn-codecs'])
    assert.ok(inputs.includes(`packages/net/src/${name}.ts`));
  for (const file of inputs) assert.doesNotMatch(file, /generated-wire-shapes|generated-phone-input-shapes|(?<!helper-)route-codecs\.ts$|private\//);
  const bytes = result.outputFiles[0].contents;
  assert.ok(bytes.length <= 64 * 1024, `helper consumer bundle grew to ${bytes.length} bytes`);
  assert.ok(gzipSync(bytes).length <= 16 * 1024, 'helper consumer gzip budget exceeded');
});
