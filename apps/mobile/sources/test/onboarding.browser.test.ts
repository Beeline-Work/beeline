import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

describe.skipIf(!existsSync(CHROME))('onboarding painted layout', () => {
  it.each([[320, 640], [390, 844], [768, 1024], [1280, 900]])('R-onb-7/8/9: keeps the frame and Next fixed at %s×%s', async (width, height) => {
    const mobile = process.cwd();
    const directory = await mkdtemp(path.join(mobile, 'sources/test/onboarding-proof-'));
    const output = process.env.ONBOARDING_EVIDENCE_DIR ?? '/tmp/jellybean-onboarding';
    mkdirSync(output, { recursive: true });
    try {
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(entry, `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { WelcomeCards } from '@/components/buzz/WelcomeCards';
        const root=createRoot(document.getElementById('root'));
        root.render(<WelcomeCards visible onDone={() => {}} />);
        const bounds = node => { const r=node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}; };
        const records=[];
        async function measure() {
          await document.fonts.ready;
          const button=document.querySelector('[data-testid="welcome-next"]');
          if(!button) {setTimeout(measure,100); return;}
          const scene=document.querySelector('[data-testid^="welcome-"][data-testid$="-scene"]');
          const composer=scene?.querySelector('[data-testid="welcome-composer"]');
          const messages=scene?.querySelectorAll('[data-testid^="welcome-message-"]');
          const last=messages?.[messages.length-1];
          records.push({button:bounds(button),scene:bounds(scene), overlap: Boolean(last && composer && bounds(last).bottom > bounds(composer).y)});
          if(records.length<4) {button.click();setTimeout(measure,200);}
          else {
            document.getElementById('result').textContent=JSON.stringify(records);
            root.render(<WelcomeCards key="capture" visible onDone={() => {}} />);
            let remaining=${Number(process.env.ONBOARDING_CAPTURE_STEP ?? 0)};
            function capture(){
              if(remaining-- > 0){document.querySelector('[data-testid="welcome-next"]').click();setTimeout(capture,100);}
            }
            setTimeout(capture,100);
          }
        }
        setTimeout(measure,500);`);
      const result = await runBrowserProof({ entry, mobile, width, height, budgetMs: 6000,
        screenshotPath: path.join(output, `carousel-${width}-${process.env.ONBOARDING_CAPTURE_STEP ?? 0}.png`),
        head: `<style>${['SpaceGrotesk-Regular', 'SpaceGrotesk-Medium', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'].map(font =>
          `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', font + '.ttf')).toString('base64')})}`).join('')}
          html,body,#root{height:100%;overflow:hidden}html,body{width:${width}px}#result{display:none}</style>`,
        shims: { ...webProofShims(mobile),
          'react-native-safe-area-context': `import React from 'react'; import { View } from 'react-native';
            export const SafeAreaProvider=({children})=><View style={{flex:1}}>{children}</View>;
            export const useSafeAreaInsets=()=>({top:0,bottom:32,left:0,right:0});`,
          'expo-router': 'export const router={push(){},replace(){}}; export const usePathname=()=>"/beeline/channels"; export const useLocalSearchParams=()=>({});',
          '@/buzz/welcome-cards': 'export const completeWelcomeCards=async()=>({due:false});',
          './HullDialog': `import React from 'react'; import { View } from 'react-native';
            export const HullModal=({children})=><View style={{flex:1}}>{children}</View>;`,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const records = JSON.parse(result.result);
      console.log(JSON.stringify({ width, records }));
      expect(records).toHaveLength(4);
      expect(new Set(records.map((r: any) => r.button.y)).size).toBe(1);
      expect(new Set(records.map((r: any) => r.scene.height)).size).toBe(1);
      expect(new Set(records.map((r: any) => r.scene.y)).size).toBe(1);
      expect(records.every((r: any) => r.button.bottom <= height - 32)).toBe(true);
      expect(records.every((r: any) => !r.overlap)).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 120_000);
});
