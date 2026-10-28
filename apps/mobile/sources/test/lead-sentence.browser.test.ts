import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

// Ruby's message from #beeline whose bold lead rendered as `**1.` / `Fixes dispatched.**`.
const RUBY_MESSAGE =
  '**1. Fixes dispatched.** Items 2–9 are in 3 corners. All go to Jellybean, one PR each.\n' +
  '- **review-loop-fixes:** items 2, 4, 5. Idle alerts on corners waiting for review or checks.\n' +
  '- **tool-schema-truth:** items 3, 7. Search and read limits now match what the tools accept.\n\n' +
  '**3. Sentry.** One corner, **sentry-four-errors**, assigned to Jellybean.';

it.skipIf(!existsSync(CHROME))('Reproduction lead-split-1: a bold lead renders without literal asterisks', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/lead-sentence-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { LedgerEntry } from '@/components/buzz/Ledger';
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
      function Proof() {
        const { theme } = useUnistyles();
        document.body.style.background = theme.buzz.bgBase;
        return <div style={{padding: 16}}>
          <LedgerEntry itemId="ruby" luminous chronological bodyText={${JSON.stringify(RUBY_MESSAGE)}}
            bodyTestID="ruby-body" byline={{name: 'ruby', role: 'opus 5.5', stamp: '09:41'}}/>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<Proof/>);
      setTimeout(() => {
        const lead = document.querySelector('[data-testid="ruby-body-lead"]');
        const row = document.querySelector('[data-testid="chat-message-ruby"]');
        document.getElementById('result').textContent = JSON.stringify({
          lead: lead?.textContent, text: row?.textContent });
      }, 1500);`);
    for (const theme of ['bone', 'obsidian']) {
      const shims = webProofShims(mobile);
      shims['expo-router'] = 'export const router = { push() {}, back() {} }; export const useRouter = () => router;';
      shims['@expo/vector-icons'] = 'export const Ionicons = () => null;';
      shims['react-native-unistyles'] = shims['react-native-unistyles']!.replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
      const proof = await runBrowserProof({ entry, mobile, width: 390, shims,
        ...(process.env.BEELINE_DESIGN_PROOF_DIR ? {
          screenshotPath: path.join(process.env.BEELINE_DESIGN_PROOF_DIR, `lead-sentence-${theme}.png`),
        } : {}),
      });
      expect(proof.status, proof.stderr).toBe(0);
      const result = JSON.parse(proof.result);
      expect(result.lead).toBe('1. Fixes dispatched.');
      expect(result.text).toContain('Items 2–9 are in 3 corners.');
      expect(result.text).not.toContain('*');
      console.log(`Reproduction lead-split-1 Demonstrated ${theme}: ${JSON.stringify(result.lead)}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
