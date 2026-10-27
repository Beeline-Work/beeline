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
      querySelectorAll: () => [],
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

const downloadEvents = {
  ios: 'tw-rhefr-ri2vz',
  android: 'tw-rhefr-ri2w3',
  macos: 'tw-rhefr-ri2w4',
  windows: 'tw-rhefr-ri2w5',
  linux: 'tw-rhefr-ri2w6',
};

test('each landing tile sends its platform conversion only for X visitors without preventing navigation', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const platforms = [...html.matchAll(/data-platform="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(platforms, Object.keys(downloadEvents));
  const bundle = await readFile(new URL('../web/x-attribution.js', import.meta.url), 'utf8');
  for (const search of ['', '?utm_source=x&twclid=test', '?utm_source=x&code=oauth-secret']) {
    const tiles = platforms.map((platform) => {
      const tile = new EventTarget();
      tile.dataset = { platform };
      return tile;
    });
    const scripts = [];
    const document = {
      cookie: '',
      createElement: () => ({}),
      head: { appendChild: (script) => scripts.push(script) },
      querySelectorAll: (selector) => {
        assert.equal(selector, '[data-platform]');
        return tiles;
      },
    };
    const window = {};
    runInNewContext(bundle, {
      window,
      document,
      location: new URL(`https://usebeeline.app/${search}`),
      URL,
    });
    const tracked = search === '?utm_source=x&twclid=test';
    assert.equal(scripts.length, tracked ? 1 : 0);
    for (const [index, tile] of tiles.entries()) {
      const click = new Event('click', { cancelable: true });
      assert.equal(tile.dispatchEvent(click), true);
      assert.equal(click.defaultPrevented, false);
      if (tracked) {
        const events = window.twq.queue.filter(([command]) => command === 'event');
        assert.equal(events.length, index + 1);
        const platform = platforms[index];
        assert.deepEqual(JSON.parse(JSON.stringify(events[index])), [
          'event',
          downloadEvents[platform],
          { contents: [{ content_id: platform, content_name: platform }] },
        ]);
      } else {
        assert.equal(window.twq, undefined);
      }
    }
    if (tracked) {
      window.twq.exe = () => {
        throw new Error('vendor failure');
      };
      const click = new Event('click', { cancelable: true });
      assert.equal(tiles[0].dispatchEvent(click), true);
      assert.equal(click.defaultPrevented, false);
    }
  }
});
