import 'react-native-get-random-values';
import React, { useEffect, useState } from 'react';
import { Linking, ScrollView, Text } from 'react-native';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { boneTheme, obsidianTheme } from '../../sources/theme';
import { LAYOUT_BREAKPOINTS } from '../../sources/utils/layoutClass';
import { resumeInitialGitHubInstallation, githubInstallationReturnPath, completeGitHubInstallationRoute } from '../../sources/auth/github-auth-session';
StyleSheet.configure({ themes: { bone: boneTheme, obsidian: obsidianTheme }, breakpoints: LAYOUT_BREAKPOINTS, settings: { initialTheme: 'bone' } });
const { RepositoryOnboardingCard } = require('../../sources/app/(app)/beeline/chat/RepositoryOnboardingCard');
const { Button } = require('../../sources/components/buzz/Button');
const viewer = 'a'.repeat(64);
const card = { id:'b'.repeat(64), roomId:'11111111-1111-4111-8111-111111111111', agentId:'c'.repeat(64), requesterId:viewer,
  kind:'repository', canLink:true, state:'install_missing', githubLinked:false, status:'open', defaultName:'proof-project',
  repositories:[{ id:42, fullName:'proof/connected', installationId:77, defaultBranch:'main', current:false }], starters:[] };
function Root() {
  const [ready,setReady]=useState(false), [generation,setGeneration]=useState(0), [result,setResult]=useState('Connect GitHub, then simulate a cold start.'), [theme,setTheme]=useState('bone');
  useEffect(()=>{
    const update=url=>{if(!url?.includes('installation-proof'))return;const p=new URLSearchParams(url.split('?')[1]); const next=p.get('theme')||'bone';UnistylesRuntime.setTheme(next);setTheme(next);globalThis.proofCancel=p.get('mode')==='cancel';setGeneration(n=>n+1);setResult('Connect GitHub, then simulate a cold start.');};
    const listener=Linking.addEventListener('url',({url})=>update(url));Linking.getInitialURL().then(update);
    require('expo-splash-screen').hideAsync();
    require('expo-font').loadAsync({'SpaceGrotesk-Regular':require('../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),'SpaceGrotesk-SemiBold':require('../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),'IBMPlexMono-Regular':require('../../sources/assets/fonts/IBMPlexMono-Regular.ttf')}).then(()=>setReady(true));
    return ()=>listener.remove();
  },[]);
  const coldStart=async()=>{
    const pending=await githubInstallationReturnPath();
    const resumed=await resumeInitialGitHubInstallation(async()=>null);
    let rejected=false;try{await completeGitHubInstallationRoute('1');}catch{rejected=true;}
    setGeneration(n=>n+1);
    setResult(!pending&&!resumed&&rejected?'PASS: no stale return, no cold-start picker, unrelated callback refused.':'FAIL: stale installation state survived.');
  };
  return ready?<SafeAreaProvider><ScrollView contentContainerStyle={{padding:24,paddingTop:64,gap:24,backgroundColor:theme==='bone'?'#f5f2eb':'#171717',flexGrow:1}}>
    <RepositoryOnboardingCard key={generation} card={card} viewerId={viewer}/>
    <Button label="Simulate cold start" variant="primary" onPress={()=>void coldStart()}/>
    <Text style={{color:theme==='bone'?'#171717':'#ffffff'}}>{result}</Text>
  </ScrollView></SafeAreaProvider>:null;
}
registerRootComponent(Root);
