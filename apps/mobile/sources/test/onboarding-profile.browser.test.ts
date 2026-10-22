import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { beelineThemes } from '@/buzz/groknight';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

describe.skipIf(!existsSync(CHROME))('onboarding identity and controls', () => {
  it.each(['obsidian','bone'])('R-onb-2/3/4/5/6: fits the name and aligns controls in %s', async theme => {
    const mobile=process.cwd();
    const directory=await mkdtemp(path.join(mobile,'sources/test/onboarding-profile-proof-'));
    const output=process.env.ONBOARDING_EVIDENCE_DIR??'/tmp/jellybean-onboarding';
    mkdirSync(output,{recursive:true});
    try {
      const entry=path.join(directory,'proof.jsx');
      await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';
        import {Text,View} from 'react-native';
        import {YouStep} from '@/components/buzz/YouStep';import {Button} from '@/components/buzz/Button';
        import {useAutoFitText} from '@/buzz/use-autofit-text';import {useUnistyles} from 'react-native-unistyles';
        function App(){const {theme}=useUnistyles();const ref=useAutoFitText('Welcome, lunchboxfortwo-with-a-long-name');
          return <View style={{height:'100%',backgroundColor:theme.buzz.bgBase}}>
            <View style={{paddingHorizontal:theme.buzz.space.lg}}>
              <Text ref={ref} numberOfLines={1} style={{...theme.buzz.type.hero,color:theme.buzz.textPrimary}} testID="fit-welcome">Welcome, lunchboxfortwo-with-a-long-name</Text>
            </View>
            <YouStep seed={'f'.repeat(64)} handle="lunchboxfortwo-with-a-long-name" onConfirm={async()=>{}} onEntered={()=>{}}/>
            <View style={{padding:theme.buzz.space.lg,gap:theme.buzz.space.sm}}>
              <Button label="Create Workspace" disabled testID="disabled"/>
              <Button label="Continue with GitHub" variant="${process.env.ONBOARDING_BASELINE ? 'secondary' : 'provider'}" testID="provider"/>
            </View>
          </View>}
        createRoot(document.getElementById('root')).render(<App/>);
        setTimeout(async()=>{await document.fonts.ready;setTimeout(()=>{
          const name=document.querySelector('[data-testid="onboarding-you-handle"]');
          const welcome=document.querySelector('[data-testid="fit-welcome"]');
          const grid=document.querySelector('[data-testid="onboarding-face-grid"]');
          const button=document.querySelector('[data-testid="disabled"]');
          const provider=document.querySelector('[data-testid="provider"]');
          const bounds=n=>n.getBoundingClientRect();
          document.getElementById('result').textContent=JSON.stringify({
            fits:name.scrollWidth<=name.clientWidth+1,welcomeFits:welcome.scrollWidth<=welcome.clientWidth+1,
            gridLeft:bounds(grid).left,nameLeft:bounds(name).left,gridRight:bounds(grid).right,nameRight:bounds(name).right,
            hint:!!document.querySelector('[data-testid="onboarding-you-source"]'),
            disabled:getComputedStyle(button).opacity,fill:getComputedStyle(button).backgroundColor,border:getComputedStyle(button).borderTopColor,
            label:getComputedStyle(button.firstElementChild).color,
            provider:getComputedStyle(provider).backgroundColor});
        },200)},600);`);
      const base=webProofShims(mobile);
      const fonts=['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold','IBMPlexMono-Regular'].map(font=>
        `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile,'sources/assets/fonts',font+'.ttf')).toString('base64')})}`).join('');
      const result=await runBrowserProof({entry,mobile,width:390,height:1100,budgetMs:5000,
        screenshotPath:path.join(output,`profile-${theme}.png`),
        head:`<style>${fonts}html,body,#root{height:100%;width:390px}#result{display:none}</style>`,
        shims:{...base,
          ...(process.env.ONBOARDING_BASELINE ? {'@/buzz/use-autofit-text':`import {useRef} from 'react';export const useAutoFitText=()=>useRef(null);`} : {}),
          'react-native-unistyles':base['react-native-unistyles'].replace('beelineThemes.obsidian',`beelineThemes.${theme}`),
          './HullDialog':`import React from 'react';import {TextInput} from 'react-native';export const HullDialogInput=props=><TextInput {...props}/>;`,
        }});
      expect(result.status,result.stderr).toBe(0);
      const proof=JSON.parse(result.result);console.log(JSON.stringify(proof));
      expect(proof.fits).toBe(true);expect(proof.welcomeFits).toBe(true);
      expect(proof.gridLeft).toBeCloseTo(proof.nameLeft,0);expect(proof.gridRight).toBeCloseTo(proof.nameRight,0);
      expect(proof.hint).toBe(false);expect(proof.disabled).toBe('1');expect(proof.fill).toBe(proof.border);
      const palette = beelineThemes[theme as 'bone' | 'obsidian'];
      const rgb = (hex: string) => `rgb(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
      expect(proof.fill).toBe(rgb(palette.bgPressed));
      expect(proof.label).toBe(rgb(palette.textDisabled));
      expect(proof.provider).toBe('rgb(255, 255, 255)');
    } finally {await rm(directory,{recursive:true,force:true});}
  }, 120_000);
});
