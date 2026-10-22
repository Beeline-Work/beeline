import {existsSync,mkdirSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {CHROME,runBrowserProof,webProofShims} from './browserProof';
it.skipIf(!existsSync(CHROME))('R-onb-12/13/16: a Google user sees the repository card and Connect GitHub',async()=>{
 const mobile=process.cwd(),directory=await mkdtemp(path.join(mobile,'sources/test/onboarding-repository-proof-'));
 try {
 const entry=path.join(directory,'proof.jsx');
 await writeFile(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{View,Text}from'react-native';import{RepositoryOnboardingCard}from'@/app/(app)/beeline/chat/RepositoryOnboardingCard';
 createRoot(document.getElementById('root')).render(<View style={{padding:24,gap:24,backgroundColor:'#141310',minHeight:'100%'}}><Text style={{color:'#fff',fontSize:28}}>#general</Text><Text style={{color:'#ddd',fontSize:16}}>Beebee · Choose a repository to start working together.</Text><RepositoryOnboardingCard viewerId={'a'.repeat(64)} card={{id:'b'.repeat(64),roomId:'11111111-1111-4111-8111-111111111111',agentId:'c'.repeat(64),requesterId:'a'.repeat(64),kind:'repository',canLink:true,state:'install_missing',status:'open',defaultName:'new-project',githubLinked:false,repositories:[],starters:[]}}/></View>);
 setTimeout(()=>document.getElementById('result').textContent=JSON.stringify({label:document.querySelector('[data-testid="repo-card-install"]')?.textContent}),800);`);
 const output=process.env.ONBOARDING_EVIDENCE_DIR??'/tmp/jellybean-onboarding';mkdirSync(output,{recursive:true});
 const result=await runBrowserProof({entry,mobile,width:390,height:844,budgetMs:4000,screenshotPath:path.join(output,'repository.png'),head:'<style>html,body,#root{height:100%;width:390px}#result{display:none}</style>',shims:{...webProofShims(mobile),'react-native-reanimated':webProofShims(mobile)['react-native-reanimated']+'\nexport const FadeOut = FadeInDown; export const interpolateColor = (_,range,colors)=>colors[0];','@/buzz/onboarding-rollout':'export const useRepositoryOnboarding=()=>true;','@/sync/transport/monolith-operation':'export const monolithPhoneOperation=async()=>({});'}});
 expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.result).label).toBe('Connect GitHub');
 }finally{await rm(directory,{recursive:true,force:true});}
},120_000);
