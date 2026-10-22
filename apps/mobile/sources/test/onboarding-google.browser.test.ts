import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from './browserProof';

describe.skipIf(!existsSync(CHROME))('Google browser handoff recovery', () => {
  it('R-onb-1: completes the same attempt after interrupted reads instead of showing offline', async () => {
    const mobile=process.cwd();
    const directory=await mkdtemp(path.join(mobile,'sources/test/onboarding-google-proof-'));
    const output=process.env.ONBOARDING_EVIDENCE_DIR??'/tmp/jellybean-onboarding';mkdirSync(output,{recursive:true});
    try {
      const entry=path.join(directory,'proof.jsx');
      await writeFile(entry,`import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
        import {View,Text} from 'react-native';import {Button} from '@/components/buzz/Button';
        import {runGoogleSignIn,clearPendingGoogleSignIn} from '@/auth/google-auth-session';
        import {noticeForAuthError} from '@/auth/onboarding-state';import {useUnistyles} from 'react-native-unistyles';
        let reads=0;globalThis.fetch=async()=>{reads++;if(reads===1)throw new TypeError('Network request failed');
          if(reads===2){await new Promise(r=>setTimeout(r,11000));throw new TypeError('Network request failed');}
          return new Response('{}',{status:reads===3?503:200});};
        function App(){const {theme}=useUnistyles();const [notice,setNotice]=useState(null);
          useEffect(()=>{runGoogleSignIn({state:'s'.repeat(43),recoveryToken:'r'.repeat(43),
            openAuthSession:async()=>({type:'opened'}),subscribeToUrls:()=>({remove(){}})})
            .then(()=>{setNotice({title:'Google proof recovered',message:'The first attempt recovered without restarting sign-in.'});
              document.getElementById('result').textContent=JSON.stringify({recovered:true,reads});})
            .catch(error=>{setNotice(noticeForAuthError(error));document.getElementById('result').textContent=JSON.stringify({recovered:false,code:error.code,reads});})
            .finally(()=>clearPendingGoogleSignIn());},[]);
          return <View style={{height:'100%',justifyContent:'center',padding:theme.buzz.space.lg,gap:theme.buzz.space.lg,backgroundColor:theme.buzz.bgBase}}>
            <Text style={{...theme.buzz.type.hero,color:theme.buzz.textPrimary}}>Continue with Google</Text>
            {notice&&<View><Text style={{...theme.buzz.type.bodyStrong,color:theme.buzz.textPrimary}}>{notice.title}</Text>
              <Text style={{...theme.buzz.type.body,color:theme.buzz.textSecondary}}>{notice.message}</Text></View>}
            <Button variant="provider" label="Continue with Google"/>
          </View>}
        createRoot(document.getElementById('root')).render(<App/>);`);
      const shims={...webProofShims(mobile),
        'expo-linking':`export const createURL=path=>'https://web.usebeeline.app/'+path;`,
        '@/auth/desktop-auth-redirect':`export const desktopAuthRedirectUri=(_,fallback)=>fallback;`,
        '@/buzz/runtime-config':`export const getBuzzRuntimeConfig=()=>({monolithUrl:'https://fixture.test'});`,
        '@react-native-async-storage/async-storage':`const map=new Map();export default {getItem:async k=>map.get(k)??null,setItem:async(k,v)=>{map.set(k,v)},removeItem:async k=>{map.delete(k)}};`,
      };
      const fonts=['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold'].map(font=>
        `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile,'sources/assets/fonts',font+'.ttf')).toString('base64')})}`).join('');
      const result=await runBrowserProof({entry,mobile,shims,width:390,height:844,budgetMs:20000,
        screenshotPath:path.join(output,'google-recovery.png'),head:`<style>${fonts}html,body,#root{height:100%;width:390px}#result{display:none}</style>`});
      expect(result.status,result.stderr).toBe(0);const proof=JSON.parse(result.result);console.log(JSON.stringify(proof));
      expect(proof.recovered).toBe(true);expect(proof.reads).toBe(4);
    } finally {await rm(directory,{recursive:true,force:true});}
  }, 120_000);
});
