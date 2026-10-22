import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';
it.skipIf(!existsSync(CHROME)).each([[390,844],[1280,900]])('R1: a failed welcome save keeps recovery visible at %s×%s', async(width,height)=>{
  const mobile=process.cwd();
  const directory=await mkdtemp(path.join(mobile,'sources/test/shared-onboarding-'));
  try {
    const entry=path.join(directory,'entry.jsx');
    await writeFile(entry,`import React from'react';import{createRoot}from'react-dom/client';import{WelcomeCards}from'@/components/buzz/WelcomeCards';
    createRoot(document.getElementById('root')).render(<WelcomeCards visible onDone={()=>{throw new Error('must not enter')}}/>);
    let presses=0;function advance(){const button=document.querySelector('[data-testid="welcome-next"]');if(!button){setTimeout(advance,100);return;}button.click();if(++presses<4)setTimeout(advance,100);else setTimeout(()=>{const banner=document.querySelector('[role="alert"]');const r=button.getBoundingClientRect();document.getElementById('result').textContent=JSON.stringify({error:banner?.textContent,buttonBottom:r.bottom,buttonTop:r.top,bannerBottom:banner?.getBoundingClientRect().bottom,disabled:button.getAttribute('aria-disabled')});},300);}setTimeout(advance,500);`);
    const shims=webProofShims(mobile);
    const result=await runBrowserProof({entry,mobile,width,height,shims:{...shims,
      'expo-router': 'export const router={push(){},replace(){}};export const usePathname=()=>"/beeline/channels";',
      '@/buzz/welcome-cards':`export const completeWelcomeCards=async()=>{throw new Error('Offline')};`,
      'react-native-safe-area-context':`import React from'react';import{View}from'react-native';export const SafeAreaProvider=({children})=><View style={{flex:1}}>{children}</View>;export const useSafeAreaInsets=()=>({top:0,bottom:32,left:0,right:0});`,
      './HullDialog':`import React from'react';import{View}from'react-native';export const HullModal=({children})=><View style={{flex:1}}>{children}</View>;`,
    },head:`<style>html,body,#root{height:100%;width:${width}px;margin:0}#result{display:none}</style>`});
    expect(result.status,result.stderr).toBe(0);
    const proof=JSON.parse(result.result);
    expect(proof.error).toBe('Could not save your welcome progress. Try again.');
    expect(proof.disabled).not.toBe('true');
    expect(proof.buttonBottom).toBeLessThanOrEqual(height-32);
    expect(proof.bannerBottom).toBeLessThanOrEqual(proof.buttonTop);
  }finally{await rm(directory,{recursive:true,force:true});}
},60_000);
