import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it('Reproduction sign-in-notice-1: the @agent login command shows on a collapsed failure line at 390px', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/sign-in-notice-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { LedgerSystemLine } from '@/components/buzz/Ledger';
      import { phraseTurnSilence } from '../../../../../packages/api-contract/src/turn-silence';
      import { useUnistyles } from 'react-native-unistyles';
      import regularFont from '@/assets/fonts/SpaceGrotesk-Regular.ttf';
      import mediumFont from '@/assets/fonts/SpaceGrotesk-Medium.ttf';
      import semiboldFont from '@/assets/fonts/SpaceGrotesk-SemiBold.ttf';
      import monoFont from '@/assets/fonts/IBMPlexMono-Regular.ttf';
      const fontStyle = document.createElement('style');
      fontStyle.textContent = [[ 'SpaceGrotesk-Regular', regularFont ], [ 'SpaceGrotesk-Medium', mediumFont ],
        [ 'SpaceGrotesk-SemiBold', semiboldFont ], [ 'IBMPlexMono-Regular', monoFont ]]
        .map(([name, url]) => '@font-face{font-family:' + name + ';src:url(' + url + ')}').join('') + '#result{display:none}';
      document.head.appendChild(fontStyle);
      const subject = { kind: 'agent', id: 'ruby', name: '@ruby' };
      // The line main posted before this change, verbatim.
      const before = { subject, verb: 'could not answer', consequence:
        'the helper could not authenticate with Claude. If its login expired, its owner can send \`@ruby /login\` here, or run \`beeline connect\` on its machine.' };
      const phrase = phraseTurnSilence('@ruby', { kind: 'not-signed-in' }, { login: { handle: 'ruby', harness: 'claude' } });
      const after = { subject, verb: phrase.verb, consequence: phrase.consequence };
      window.sent = [];
      function Proof() {
        const { theme } = useUnistyles();
        document.body.style.background = theme.buzz.bgBase;
        // Headless Chrome keeps a 500px minimum window, so the phone width is set here.
        return <div style={{width: 390, boxSizing: 'border-box', padding: 16}}>
          <p style={{color: theme.buzz.textSecondary, fontFamily: 'SpaceGrotesk-Regular'}}>Before</p>
          <LedgerSystemLine id="before" text="" event={before} stamp="09:41"/>
          <p style={{color: theme.buzz.textSecondary, fontFamily: 'SpaceGrotesk-Regular'}}>After (owner)</p>
          <LedgerSystemLine id="after" text="" event={after} stamp="09:41"
            loginCommand="@ruby login" onSendCommand={text => window.sent.push(text)}/>
          <p style={{color: theme.buzz.textSecondary, fontFamily: 'SpaceGrotesk-Regular'}}>After (member)</p>
          <LedgerSystemLine id="member" text="" event={after} stamp="09:41"/>
        </div>;
      }
      // True when every glyph of the needle lies inside the clamped box.
      function shows(id, needle) {
        const box = document.querySelector('[data-testid="system-line-text-' + id + '"]');
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        let joined = '', nodes = [];
        while (walker.nextNode()) { nodes.push([walker.currentNode, joined.length]); joined += walker.currentNode.data; }
        const at = joined.indexOf(needle);
        if (at < 0) return false;
        const end = at + needle.length - 1;
        const [node, offset] = nodes.filter(([, start]) => start <= end).pop();
        const range = document.createRange();
        range.setStart(node, end - offset);
        range.setEnd(node, end - offset + 1);
        // The clamp keeps two lines; a glyph below them is hidden behind More.
        const lineHeight = parseFloat(getComputedStyle(box).lineHeight);
        return range.getBoundingClientRect().bottom <= box.getBoundingClientRect().top + lineHeight * 2 + 0.5;
      }
      // The app loads its fonts before a Room paints; More is measured on layout.
      document.fonts.load('13px SpaceGrotesk-Regular').then(() =>
        createRoot(document.getElementById('root')).render(<Proof/>));
      setTimeout(() => {
        document.querySelector('[data-testid="system-line-command-after"]')?.click();
        const more = id => Boolean(document.querySelector('[data-testid="system-line-toggle-' + id + '"]'));
        document.getElementById('result').textContent = JSON.stringify({
          afterText: document.querySelector('[data-testid="system-line-text-after"]')?.textContent,
          beforeShowsCommand: shows('before', '@ruby /login'), beforeHasMore: more('before'),
          afterShowsCommand: shows('after', '@ruby login'), afterHasMore: more('after'),
          memberShowsCommand: shows('member', '@ruby login'),
          memberHasTap: Boolean(document.querySelector('[data-testid="system-line-command-member"]')),
          sent: window.sent,
          width: document.querySelector('[data-testid="system-line-after"]').getBoundingClientRect().right });
      }, 1500);`);
    for (const theme of ['obsidian', 'bone']) {
      const shims = webProofShims(mobile);
      shims['expo-router'] = 'export const router = { push() {}, back() {} }; export const useRouter = () => router;';
      shims['@expo/vector-icons'] = 'export const Ionicons = () => null;';
      shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
      const proof = await runBrowserProof({ entry, mobile, width: 390, shims,
        ...(process.env.BEELINE_DESIGN_PROOF_DIR ? {
          screenshotPath: path.join(process.env.BEELINE_DESIGN_PROOF_DIR, `sign-in-notice-${theme}-390.png`),
        } : {}),
      });
      expect(proof.status, proof.stderr).toBe(0);
      const result = JSON.parse(proof.result);
      expect(result.width).toBeLessThanOrEqual(390);
      expect(result).toMatchObject({
        afterText: '@ruby needs a Claude sign-in · send @ruby login here. If that fails, its owner can run `beeline connect` on its machine.',
        beforeShowsCommand: false, beforeHasMore: true,
        afterShowsCommand: true, afterHasMore: true, memberShowsCommand: true, memberHasTap: false,
        sent: ['@ruby login'],
      });
      console.log(`Reproduction sign-in-notice-1 Demonstrated ${theme} 390px: ${JSON.stringify(result)}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
