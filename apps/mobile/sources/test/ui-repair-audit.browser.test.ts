import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';
const out = process.env.UI_AUDIT_DIR;
for (const state of process.env.UI_AUDIT_FIXED ? ['fixed'] : ['before', 'after'])
  for (const section of [
    'rail',
    'turn',
    'corner',
    'repo',
    'artifact',
    'desktopArtifact',
    'usage',
    'buttons',
    'roster',
    'composer',
    'voice',
    'update',
    'composeMenu',
    'needs',
    'error',
    'modelRows',
    'trayFooter',
    'connectorLong',
    'workflow',
    'attachment',
    'inspector',
    'repositoryChoice',
    'viewer',
    'close',
    'destinations',
    'rows',
    'symbols',
    'signin',
    'model',
    'usageStates',
    'connectorActions',
    'repoPending',
    'failure',
    'ended',
  ]) {
    it.skipIf(!out)(
      `${state} ${section}`,
      async () => {
        const mobile =
          state === 'before' ? process.env.UI_AUDIT_BEFORE_MOBILE! : process.env.UI_AUDIT_MOBILE!;
        const shims = webProofShims(mobile);
        shims['react-native-reanimated'] +=
          '\nexport const FadeOut=FadeInDown;export const FadeOutDown=FadeInDown;export const FadeIn=FadeInDown;export const FadeInUp=FadeInDown;export const FadeOutUp=FadeInDown;export const LinearTransition=FadeInDown;export const withSpring=v=>v;export const interpolateColor=(_v,_i,o)=>o[o.length-1];';
        shims['expo-router'] =
          'export const router={};export const useRouter=()=>({});export const useLocalSearchParams=()=>({repositoryPicker:"proof"});';
        shims['@/sync/transport/monolith-operation'] =
          'export const phoneOperationFailureReason=()=>"unavailable";export const monolithPhoneOperation=async()=>({access:"proof.9999999999999"});';
        shims['react-native-view-shot'] = 'export const captureRef=async()=>"";export default {};';
        shims['expo-clipboard'] =
          'export const getStringAsync=async()=>"";export const setStringAsync=async()=>true;export const setImageAsync=async()=>true;';
        shims['@/hooks/useUpdates'] =
          'export const useUpdates=()=>({promptVisible:true,reloadApp:()=>{},dismissPrompt:()=>{}});';
        shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
          'const theme = { buzz: beelineThemes.obsidian };',
          `import { obsidianTheme } from '${path.join(mobile, 'sources/theme')}'; const theme = { ...obsidianTheme, buzz: beelineThemes.obsidian };`,
        );
        shims['./HullDialog'] =
          'import React from "react";import {View} from "react-native";export const HullModal=({children,visible=true})=>visible?<View>{children}</View>:null;export const HullFloatingSurface=({children})=><View>{children}</View>;export const HullDialog=({children})=><View>{children}</View>;';
        shims['./HullDialog'] +=
          `export {HullDialogActions,HullDialogInput} from '${path.join(mobile, 'sources/components/buzz/HullDialog')}';`;
        shims['@/buzz/onboarding-rollout'] = 'export const useRepositoryOnboarding=()=>true;';
        const fonts = [
          'SpaceGrotesk-Regular',
          'SpaceGrotesk-Medium',
          'SpaceGrotesk-SemiBold',
          'IBMPlexMono-Regular',
          'IBMPlexMono-SemiBold',
        ]
          .map(
            (font) =>
              `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', `${font}.ttf`)).toString('base64')})}`,
          )
          .join('');
        mkdirSync(out!, { recursive: true });
        const r = await runBrowserProof({
          mobile,
          shims,
          entry: path.join(mobile, 'scripts/ui-repair-audit-proof.tsx'),
          width: 390,
          height: section === 'usageStates' ? 1500 : 900,
          query: `?state=${state === 'fixed' ? 'after' : state}&fixed=${state === 'fixed' ? '1' : '0'}&section=${section}`,
          head: `<script>window.process={env:{}};window.addEventListener('error',e=>document.getElementById('result').textContent='ERROR '+e.message);</script><style>${fonts}#result{display:none}body{background:#14091A}</style>`,
          screenshotPath: path.join(out!, `${section}-${state}.png`),
        });
        writeFileSync(path.join(out!, `${section}-${state}.json`), r.result);
        expect(r.status, r.stderr).toBe(0);
        expect(r.result).not.toMatch(/ERROR|PENDING|FAIL/);
        const data = JSON.parse(r.result);
        expect(data.text.length, JSON.stringify(data.errors)).toBeGreaterThan(20);
        if (state === 'fixed') {
          const metric = (id: string) => data.metrics.find((m: any) => m.id === id);
          if (section === 'viewer') {
            const open = metric('computer-session-open-browser'),
              close = metric('computer-session-close');
            expect(open.y + open.height / 2).toBe(close.y + close.height / 2);
          }
          if (section === 'connectorLong')
            expect(
              Math.abs(
                metric('connector-offer-proof-continue').y -
                  metric('connector-offer-proof-connecting').y,
              ),
            ).toBeLessThan(1);
          if (section === 'trayFooter') expect(metric('audit-tray-footer').height).toBe(15);
        }
      },
      90000,
    );
  }
