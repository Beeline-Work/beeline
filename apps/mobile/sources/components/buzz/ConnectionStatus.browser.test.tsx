import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

describe.skipIf(!existsSync(CHROME))('ConnectionStatus rendered stand-in', () => {
  it.each(['bone', 'obsidian'])('shows the disconnected glyph on both screens in %s', async (theme) => {
    const mobile = process.cwd();
    const output = process.env.CONNECTION_STATUS_PROOF_DIR ?? path.join(mobile, 'evidence/connection-status');
    mkdirSync(output, { recursive: true });
    const shims = webProofShims(mobile);
    shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
    shims['@/sync/transport/live-connection'] = `export const sharedLiveConnection = () => ({
      connectionStatus: () => 'disconnected', subscribeConnectionStatus: () => () => undefined, reconnectNow: () => undefined,
    });`;
    shims['@expo/vector-icons'] = `import React from 'react'; export const Ionicons = (props) => <svg data-testid={props.testID} aria-label={props.accessibilityLabel} width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth="2"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5 17.5 6.5"/></svg>;`;
    shims['./IndexRow'] = `import { View } from 'react-native'; export const InlineRow = ({ children, style, ...props }) => <View {...props} style={[{ alignItems: 'center', flexDirection: 'row' }, style]}>{children}</View>;`;
    shims['./Button'] = `export const Button = ({ label, testID }) => <button data-testid={testID}>{label}</button>;`;
    const font = readFileSync(path.join(mobile, 'sources/assets/fonts/SpaceGrotesk-Regular.ttf')).toString('base64');
    const proof = await runBrowserProof({
      entry: path.join(mobile, 'scripts/connection-status-browser-proof.tsx'),
      mobile,
      shims,
      width: 430,
      height: 420,
      query: `?theme=${theme}`,
      head: `<style>body{background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}#result{display:none}[data-testid="connection-status-disconnected"] span{color:${theme === 'bone' ? '#171310' : '#f0f0f3'}!important}[data-testid="connection-status-disconnected"] button{color:${theme === 'bone' ? '#8a6323' : '#b08a4a'}!important}@font-face{font-family:SpaceGrotesk-Regular;src:url(data:font/ttf;base64,${font})}</style>`,
      screenshotPath: path.join(output, `rendered-standin-${theme}.png`),
    });
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.result, proof.stderr).toContain('PASS: Room list and Room screen render the shared disconnected glyph.');
  }, 90_000);
});
