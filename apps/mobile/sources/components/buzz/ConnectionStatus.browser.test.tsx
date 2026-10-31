import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('ConnectionStatus real-surface browser proof', () => {
  it.each(['bone', 'obsidian'])(
    'renders both actual screen fixtures in every state in %s',
    async (theme) => {
      const mobile = process.cwd();
      const output =
        process.env.CONNECTION_STATUS_PROOF_DIR ?? path.join(mobile, 'evidence/connection-status');
      mkdirSync(output, { recursive: true });
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
        'beelineThemes.obsidian',
        `beelineThemes.${theme}`,
      );
      shims['@/sync/transport/live-connection'] =
        `let calls = 0; const states = ['connected','connected','connecting','connecting','disconnected','disconnected']; export const useConnectionState = () => states[calls++]; export const reconnectNow = () => { window.__reconnects = (window.__reconnects || 0) + 1; };`;
      shims['@expo/vector-icons'] =
        `import React from 'react'; export const Ionicons = (props) => <svg data-testid={props.testID} aria-label={props.accessibilityLabel} width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth="2"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5 17.5 6.5"/></svg>;`;
      const font = readFileSync(
        path.join(mobile, 'sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
      ).toString('base64');
      const proof = await runBrowserProof({
        entry: path.join(mobile, 'scripts/connection-status-browser-proof.tsx'),
        mobile,
        shims,
        width: 760,
        height: 1420,
        head: `<style>body{background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}#result{display:none}@font-face{font-family:SpaceGrotesk-Regular;src:url(data:font/ttf;base64,${font})}</style>`,
        screenshotPath: path.join(output, `room-list-and-room-${theme}.png`),
      });
      expect(proof.status, proof.stderr).toBe(0);
      expect(proof.result, proof.stderr).toContain(
        'PASS: actual Room list and Room fixtures retain saved content',
      );
    },
    90_000,
  );
});
