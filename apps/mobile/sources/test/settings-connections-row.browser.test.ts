import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

function fontsCss(mobile: string) {
  return ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'IBMPlexMono-Regular']
    .map((font) => path.join(mobile, 'sources/assets/fonts', `${font}.ttf`))
    .filter(existsSync)
    .map((file) => `@font-face{font-family:'${path.basename(file, '.ttf')}';src:url(data:font/ttf;base64,${readFileSync(file).toString('base64')})}`)
    .join('');
}

/**
 * The Settings Connectors row in real layout: the owner's phone cut the
 * title to "Your connecti…" beside "10 connections · 101 keys". The row
 * renders here with its count from `workbenchSummary` and the shipped
 * SettingsRow, at phone widths and the Medium and Large text sizes.
 */
describe.skipIf(!existsSync(CHROME))('Settings Your connections row', () => {
  it.each([
    [360, 1], [390, 1], [412, 1], [360, 1.2], [390, 1.2], [412, 1.2],
  ])('shows the whole title at %spx, text scale %s', async (width, scale) => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/connections-row-proof-'));
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
        import { View } from 'react-native';
        import { SettingsRow } from '@/components/buzz/SettingsRow';
        import { workbenchSummary } from '@/buzz/connectors-model';
        // The owner's view: one Squire machine, nine key services holding 101 keys.
        const services = ['tiktok', 'dsers', 'shopify', 'kaggle', 'kagi', 'cal', 'craigslist', 'askul', 'stripe'];
        const view = { connectors: [], apps: [],
          helpers: [{ id: 'machine', name: 'squire', online: true, squire: { status: 'connected', reportedAt: 1 } }],
          connections: Array.from({ length: 101 }, (_, index) => ({ ref: 'key-' + index, name: 'default',
            service: services[index % services.length], hosts: [], state: 'active', ownerId: 'owner' })) };
        const summary = workbenchSummary(view, 'owner');
        const row = (testID, props) => React.createElement(View, { testID, style: { width: ${width} - 32, marginLeft: 16 } },
          React.createElement(SettingsRow, { title: 'Your connections', chevron: 'right', onPress() {}, ...props }));
        createRoot(document.getElementById('root')).render(React.createElement(View, null,
          row('before', { value: '10 connections · 101 keys' }),
          row('after', { value: summary.value, wholeTitle: true }),
          row('long', { value: '1000 connected and more words than fit', wholeTitle: true })));
        // Cut: the title ellipsizes, or the value paints over it.
        const cut = (scope) => {
          const leaves = [...document.querySelectorAll('[data-testid="' + scope + '"] div')]
            .filter((node) => !node.children.length && node.textContent);
          const title = leaves.find((node) => node.textContent === 'Your connections');
          const value = leaves.find((node) => node !== title);
          if (!title || !value) return 'NOT RENDERED';
          return title.scrollWidth > title.clientWidth + 0.5 ||
            title.getBoundingClientRect().right > value.getBoundingClientRect().left + 0.5;
        };
        const whole = (scope) => [...document.querySelectorAll('[data-testid="' + scope + '"] div')]
          .filter((node) => !node.children.length && node.textContent && node.textContent !== 'Your connections')
          .every((node) => node.scrollWidth <= node.clientWidth + 0.5);
        setTimeout(() => { document.getElementById('result').textContent = JSON.stringify({
          value: summary.value, before: cut('before'), after: cut('after'), long: cut('long'),
          valueWhole: whole('after') }); }, 600);`);
      const base = webProofShims(mobile);
      const result = await runBrowserProof({ entry, mobile, width, budgetMs: 4000,
        head: `<style>${fontsCss(mobile)}</style>`,
        screenshotPath: `/tmp/settings-connections-row-${width}-${scale}.png`,
        shims: { ...base,
          'react-native-unistyles': base['react-native-unistyles'].replace(
            'const theme = { buzz: beelineThemes.obsidian };',
            `const source = beelineThemes.obsidian;
            const theme = { buzz: { ...source, type: Object.fromEntries(Object.entries(source.type).map(([name, role]) =>
              [name, { ...role, fontSize: role.fontSize * ${scale}, lineHeight: role.lineHeight * ${scale} }])) } };`),
        } });
      expect(result.status, result.stderr).toBe(0);
      const proof = JSON.parse(result.result);
      expect(proof.value).toBe('10 connected');
      expect(proof.after).toBe(false);
      expect(proof.long).toBe(false);
      // At Medium text the count shows in full too; at Large on 360px it may yield.
      if (scale === 1) expect(proof.valueWhole).toBe(true);
      console.log(`Settings row at ${width}px, text scale ${scale}: old value cuts title=${proof.before}; "${proof.value}" cuts title=${proof.after}, value whole=${proof.valueWhole}; long value cuts title=${proof.long}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
