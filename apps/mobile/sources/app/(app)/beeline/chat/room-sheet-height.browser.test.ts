import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

const chat = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');

// Measuring the row alone misses the original 24pt sibling spacer.
// Render the real schedules JSX and the source-owned siblings before Delete.
function schedulesSection() {
  const anchor = chat.indexOf('label="Schedules and subscriptions"');
  const start = chat.lastIndexOf('<HullActionSheetRow', anchor);
  const end = chat.indexOf('/>', anchor) + 2;
  const deleteAnchor = chat.indexOf('testID="delete-room-action"', end);
  const deleteStart = chat.lastIndexOf('<HullActionSheetRow', deleteAnchor);
  const siblings = chat.slice(end, deleteStart)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\)\}/g, '')
    .replace(/\{canManageWorkspace && \(/g, '');
  const row = chat.slice(start, end)
    .replace(/onPress=\{\(\) => \{[\s\S]*?\}\}/, 'onPress={() => {}}');
  const gap = chat.match(/roomLifecycleGap:\s*(\{[^}]*\})/)?.[1];
  return `import React from 'react';
    import { View } from 'react-native';
    import { HullActionSheetRow } from '@/components/buzz/HullActionSheet';
    import { beelineThemes } from '@/buzz/groknight';
    const groknight = beelineThemes.obsidian;
    const styles = { roomLifecycleGap: ${gap ?? '{}'} };
    const ROOM_LABEL = 'Room';
    export const SchedulesSection = () => <>${row}${siblings}</>;`;
}

describe.skipIf(!existsSync(CHROME))('Room sheet row heights', () => {
  for (const appearance of ['obsidian', 'bone'] as const) {
    it(`matches navigation rows and removes empty space below schedules in ${appearance}`, async () => {
      const mobile = process.cwd();
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${appearance}`);
      shims['room-sheet-section'] = schedulesSection();
      shims['./HullDialog'] = `import React from 'react'; import { View } from 'react-native';
        export const HullFloatingSurface = ({ children, ...props }) => <View {...props}>{children}</View>;
        export const HullModal = () => null;`;
      shims['@/utils/responsive'] = 'export const useIsDesktop = () => false;';
      const proof = await runBrowserProof({
        mobile, shims, width: 390,
        entry: path.join(mobile, 'scripts/room-sheet-height-proof.tsx'),
        head: `<style>#result{display:none}html,body{overflow:hidden;background:${appearance === 'obsidian' ? '#14091A' : '#F3EEE4'}}${['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold'].map(name => `@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${name}.ttf`)).toString('base64')})}`).join('')}</style>`,
        screenshotPath: process.env.ROOM_SHEET_SCREENSHOT && appearance === 'obsidian' ? process.env.ROOM_SHEET_SCREENSHOT : undefined,
      });
      expect(proof.status, proof.stderr).toBe(0);
      const result = JSON.parse(proof.result);
      if (process.env.PRINT_PROOF) console.log(result);
      expect(result.heights).toEqual([52, 52, 52, 52, 52]);
      expect(result.schedulesFootprint).toBe(result.heights[0]);
      expect(result.gapAfterSchedules).toBe(0);
      expect(result.muteHeight).toBeGreaterThan(result.heights[0]);
      expect(result.chevron).toBe(true);
    });
  }
});
