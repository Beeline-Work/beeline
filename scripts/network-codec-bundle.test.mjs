import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

test('phone shadow observation does not bundle daemon or response schemas or pass factories', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['packages/net/src/phone-inputs.ts'],
    bundle: true, platform: 'browser', format: 'esm', minify: true, write: false, metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes('packages/net/src/generated-phone-input-shapes.ts'));
  for (const file of inputs) assert.doesNotMatch(file, /generated-wire-shapes|route-codecs|private\//);
  const bytes = result.outputFiles[0].contents;
  // Measured initial projection: ~26 KiB / ~5 KiB gzip. This guard prevents
  // accidentally returning to the ~197 KiB full registry in the phone owner.
  assert.ok(bytes.length <= 32 * 1024, `phone input bundle grew to ${bytes.length} bytes`);
  assert.ok(gzipSync(bytes).length <= 8 * 1024, 'phone input gzip budget exceeded');
});


test('trusted phone owner excludes daemon/response registries within its bundle budget', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['packages/net/src/private/phone-owner.ts'],
    bundle: true, platform: 'browser', format: 'esm', minify: true, write: false, metafile: true,
  });
  for (const file of Object.keys(result.metafile.inputs))
    assert.doesNotMatch(file, /generated-wire-shapes|generated-phone-input-shapes|route-codecs|routes\.ts$/);
  assert.ok(Object.keys(result.metafile.inputs).includes('packages/net/src/private/generated-owner-input-shapes.ts'));
  const bytes = result.outputFiles[0].contents;
  assert.ok(bytes.length <= 64 * 1024, `owner bundle grew to ${bytes.length} bytes`);
  assert.ok(gzipSync(bytes).length <= 16 * 1024, 'owner gzip budget exceeded');
});


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
