import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');

// Render the real DM sheet body from the chat surface, with its state stubbed.
function dmSheetBody() {
  const anchor = chat.indexOf('testID="dm-actions-sheet"');
  const start = chat.indexOf('>', chat.indexOf('visible={dmActionsVisible}', anchor)) + 1;
  const end = chat.indexOf('</HullActionSheetModal>', start);
  const style = (name: string) => chat.match(new RegExp(`\\n    ${name}: (\\{[\\s\\S]*?\\n    \\}),`))?.[1];
  return `import React from 'react';
    import { View, Text } from 'react-native';
    import { HullActionSheetRow, HullActionSheetCancel, HULL_SHEET_INSET } from '@/components/buzz/HullActionSheet';
    import { beelineThemes } from '@/buzz/groknight';
    import { Typography } from '@/constants/Typography';
    const groknight = beelineThemes.obsidian;
    const theme = { buzz: groknight };
    const styles = { membershipError: ${style('membershipError')}, membershipErrorText: ${style('membershipErrorText')} };
    export const DmSheetBody = ({ muted, error }) => {
      const pushMuted = muted, pushMuteWorking = false, membershipError = error;
      const togglePushMute = async () => {}, setDmActionsVisible = () => {};
      return <>${chat.slice(start, end)}</>;
    };`;
}

describe.skipIf(!existsSync(CHROME))('DM actions sheet', () => {
  for (const appearance of ['obsidian', 'bone'] as const) {
    it(`renders the mute switch, persisted state and write failure in ${appearance}`, async () => {
      const mobile = process.cwd();
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${appearance}`);
      shims['dm-sheet-body'] = dmSheetBody().replace('beelineThemes.obsidian', `beelineThemes.${appearance}`);
      shims['@/utils/responsive'] = 'export const useIsDesktop = () => false;';
      const run = (query: string, screenshot?: string) =>
        runBrowserProof({
          mobile, shims, width: 390, height: 420, query,
          entry: path.join(mobile, 'scripts/dm-sheet-proof.tsx'),
          head: `<style>#result{display:none}html,body{overflow:hidden;background:${appearance === 'obsidian' ? '#14091A' : '#F3EEE4'}}</style>`,
          screenshotPath: screenshot && process.env.DM_SHEET_SCREENSHOT ? `${process.env.DM_SHEET_SCREENSHOT}-${appearance}-${screenshot}.png` : undefined,
        });
      const muted = await run('?muted=1', 'muted');
      expect(muted.status, muted.stderr).toBe(0);
      const mutedResult = JSON.parse(muted.result);
      expect(mutedResult.switchOn).toBe(true);
      expect(mutedResult.text).toContain('Mute notifications');
      expect(mutedResult.text).not.toContain('Tags and replies still notify you.');
      expect(mutedResult.muteHeight).toBe(52);
      expect(mutedResult.alert).toBeNull();
      expect(mutedResult.cancel).toBe(true);
      const failed = await run(`?error=${encodeURIComponent('Could not update notifications: Error: offline')}`, 'failed');
      expect(failed.status, failed.stderr).toBe(0);
      const failedResult = JSON.parse(failed.result);
      expect(failedResult.switchOn).toBe(false);
      expect(failedResult.alert).toContain('Could not update notifications');
    }, 120_000);
  }
});
