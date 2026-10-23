// Isolated Android proof entry. Production components and return monitor stay real;
// repository responses are deterministic because this server change is not deployed.
import 'react-native-get-random-values';
import React,{useEffect,useState} from 'react';
import {Linking,View,Text,AppState} from 'react-native';
import {registerRootComponent} from 'expo';
import {StyleSheet,UnistylesRuntime,useUnistyles} from 'react-native-unistyles';
import {beelineThemes} from '../../sources/buzz/groknight';
import {ErrorBanner} from '../../sources/components/buzz/ErrorBanner';
import {noticeForAuthError} from '../../sources/auth/onboarding-state';
import {githubConnectionErrorNotice} from '../../sources/auth/github-connection-error';
import {OidcBindError} from '@beeline/buzz-client';
import {RepositoryOnboardingCard} from '../../sources/app/(app)/beeline/chat/RepositoryOnboardingCard';
StyleSheet.configure({themes:{obsidian:{buzz:beelineThemes.obsidian,dark:true},bone:{buzz:beelineThemes.bone,dark:false}},settings:{initialTheme:'bone'}});
const card={id:'b'.repeat(64),roomId:'11111111-1111-4111-8111-111111111111',agentId:'c'.repeat(64),requesterId:'a'.repeat(64),kind:'repository',canLink:true,state:'install_missing',status:'open',defaultName:'new-project',githubLinked:true,repositories:[{id:43,fullName:'proof-org/onboarding-proof',installationId:174210678,defaultBranch:'main',current:false}],starters:[]};
function Root(){
 const [query,setQuery]=useState('state=expired');const[loaded,setLoaded]=useState(false);
 useEffect(()=>{const update=url=>{if(!url?.includes('onboarding-proof'))return;const q=url.split('?')[1]||'';const p=new URLSearchParams(q);UnistylesRuntime.setTheme(p.get('theme')||'bone');setQuery(q);console.log('ONBOARDING_PROOF',q);};
 const sub=Linking.addEventListener('url',({url})=>update(url));Linking.getInitialURL().then(update);
 require('expo-splash-screen').hideAsync();require('expo-font').loadAsync({'SpaceGrotesk-Regular':require('../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),'SpaceGrotesk-SemiBold':require('../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),'IBMPlexMono-Regular':require('../../sources/assets/fonts/IBMPlexMono-Regular.ttf')}).then(()=>setLoaded(true));return()=>sub.remove();},[]);
 return loaded?<Scene key={query} query={query}/>:null;
}
function Scene({query}){
 const {theme}=useUnistyles();const p=new URLSearchParams(query);const state=p.get('state')||'expired';
 const notices={expired:noticeForAuthError(new OidcBindError('ticket_expired','expired')),cancel:noticeForAuthError(new OidcBindError('browser_canceled','cancel')),offline:noticeForAuthError(new OidcBindError('offline','offline')),ownership:githubConnectionErrorNotice('github_account_already_linked'),return:{title:'Continue connecting GitHub',description:'Return to your Room to refresh repositories and finish setup.'},github:githubConnectionErrorNotice('unknown')};
 const notice=notices[state];const label=state==='return'||state==='ownership'||state==='github'?'Back to Room':state==='offline'?'Try again':'Continue with GitHub';
 return <View style={{flex:1,backgroundColor:theme.buzz.bgTerminal,padding:24,paddingTop:70,justifyContent:'center',gap:24}}>
 <Text style={{...theme.buzz.type.meta,color:theme.buzz.textMuted}}>Android stand-in · {state==='picker'?'repository response fixture':'shared production error components'}</Text>
 {state==='picker'?<RepositoryOnboardingCard card={card} viewerId={'a'.repeat(64)}/>:<ErrorBanner title={notice.title} description={notice.description||notice.message} retryLabel={label} retryVariant="primary" onRetry={()=>{}}/>}
 </View>;
}
registerRootComponent(Root);
