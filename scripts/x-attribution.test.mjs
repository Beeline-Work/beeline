import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

test('committed landing tracking bundle matches its source and only loads X for ad visits', async () => {
  const result = await build({
    entryPoints: ['web/x-attribution-source.ts'],
    bundle: true,
    format: 'iife',
    minify: true,
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const committed = await readFile(new URL('../web/x-attribution.js', import.meta.url), 'utf8');
  assert.equal(committed, result.outputFiles[0].text);
  for (const [search, count] of [
    ['', 0],
    ['?twclid=click&utm_source=x&utm_campaign=campaign&utm_content=clip&utm_term=audience', 1],
  ]) {
    const scripts = [];
    const document = {
      cookie: '',
      createElement: () => ({}),
      head: { appendChild: (value) => scripts.push(value) },
    };
    const window = {};
    runInNewContext(committed, {
      window,
      document,
      location: new URL(`https://usebeeline.app/${search}`),
      URL,
    });
    assert.equal(scripts.length, count);
    if (count) {
      assert.equal(scripts[0].src, 'https://static.ads-twitter.com/uwt.js');
      assert.match(document.cookie, /Domain=usebeeline.app; Secure/);
      assert.equal(window.twq.queue[0][1], 'rhefr');
    }
  }
});
