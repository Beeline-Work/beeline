import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

for (const theme of ['bone', 'obsidian'])
  for (const width of [390, 1280]) {
    it.skipIf(!existsSync(CHROME))(
      `preserves corner actions: ${theme} ${width}px`,
      async () => {
        const mobile = process.cwd();
        const shims = webProofShims(mobile);
        shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
          'beelineThemes.obsidian',
          `beelineThemes.${theme}`,
        );
        shims['./HullActionSheet'] =
          'export const HullActionSheetCancel = () => null; export const HullActionSheetModal = () => null; export const HullActionSheetRow = () => null;';
        const entry = path.join(mobile, 'scripts/.corner-actions-appearance-proof.tsx');
        const screenshotDir = process.env.CONTROL_APPEARANCE_SCREENSHOT_DIR;
        if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
        // Reference: main's approved link, including its original target and alignment.
        writeFileSync(
          entry,
          `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { CornerObjectiveLine } from '@/components/buzz/CornerObjectiveLine';
function Proof() {
 const { theme } = useUnistyles();
 const control = { minWidth: 44, minHeight: 44, flexShrink: 0, alignItems: 'flex-end', justifyContent: 'center' };
 const label = { ...theme.buzz.type.meta, color: theme.buzz.accent };
 const run = { runId: 'proof', workflowSlug: 'feedback-triage', state: 'running', status: 'live' };
 return <View style={{ width: ${width}, backgroundColor: theme.buzz.bgBase }}>
  <View style={{ paddingHorizontal: 16, flexDirection: 'row', gap: 8 }}>
   <Pressable testID="main-more" style={control}><Text style={label}>+1 running</Text></Pressable>
   <Pressable testID="main-brief" style={control}><Text style={label}>Read brief</Text></Pressable>
  </View>
  <CornerObjectiveLine objective="Unify system rows" onOpenBrief={() => { window.openedBrief = true; }} workflow={run} onOpenWorkflow={() => {}} otherLiveRuns={[run]} />
  <CornerObjectiveLine desktop objective="Unify system rows" onOpenBrief={() => {}} testID="desktop" />
 </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const get = id => document.querySelector('[data-testid="'+id+'"]');
async function main() {
 await document.fonts.ready; await new Promise(r => setTimeout(r, 80));
 const measurements = [];
 for (const [reference, id] of [['main-brief','corner-objective-line-brief'],['main-more','corner-objective-line-workflow-more'],['main-brief','desktop-brief']]) {
  const a = get(reference), b = get(id);
  const aText = a.querySelector('[dir="auto"]'), bText = b.querySelector('[dir="auto"]');
  const aa = getComputedStyle(aText), bb = getComputedStyle(bText);
  for (const p of ['fontSize','fontFamily','lineHeight','letterSpacing','color','textAlign']) if (aa[p] !== bb[p]) throw Error(id+': '+p+' '+aa[p]+' → '+bb[p]);
  const ab = a.getBoundingClientRect(), br = b.getBoundingClientRect();
  for (const p of ['width','height']) if (Math.abs(ab[p]-br[p]) > 0.1) throw Error(id+': '+p+' '+ab[p]+' → '+br[p]);
  const aInset = ab.right-aText.getBoundingClientRect().right, bInset = br.right-bText.getBoundingClientRect().right;
  if (Math.abs(aInset-bInset) > 0.1) throw Error(id+': lost right alignment');
  measurements.push({id,fontSize:bb.fontSize,color:bb.color,width:br.width,height:br.height,rightInset:bInset});
 }
 get('corner-objective-line-brief').click();
 if (!window.openedBrief) throw Error('Read brief did not invoke its action');
 document.getElementById('result').textContent = 'PASS CORNER ACTION APPEARANCE '+JSON.stringify(measurements);
}
main().catch(error => { document.getElementById('result').textContent = 'FAIL '+error.stack; });
`,
        );
        const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium'];
        const head = `<style>#result{display:none}body{background:${theme === 'bone' ? '#F3EEE4' : '#14091A'}}${fonts.map((font) => `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${font}.ttf`)).toString('base64')})}`).join('')}</style>`;
        try {
          const proof = await runBrowserProof({
            entry,
            mobile,
            shims,
            width,
            height: 400,
            head,
            screenshotPath: screenshotDir
              ? path.join(screenshotDir, `corner-actions-${width}-${theme}.png`)
              : undefined,
          });
          expect(proof.status, proof.stderr).toBe(0);
          expect(proof.result, proof.stderr).toContain('PASS CORNER ACTION APPEARANCE');
          if (screenshotDir)
            writeFileSync(
              path.join(screenshotDir, `corner-actions-${width}-${theme}.json`),
              proof.result,
            );
        } finally {
          rmSync(entry, { force: true });
        }
      },
      90_000,
    );
  }
