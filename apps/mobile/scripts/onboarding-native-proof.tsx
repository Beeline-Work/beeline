import React, { useEffect, useState } from 'react';
import { Linking, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useFonts } from 'expo-font';
import { useUnistyles } from 'react-native-unistyles';
import { WelcomeCards } from '../sources/components/buzz/WelcomeCards';
import { YouStep } from '../sources/components/buzz/YouStep';
import { Button } from '../sources/components/buzz/Button';
import { SettingsRow } from '../sources/components/buzz/SettingsRow';
import { runGitHubInstallationSession, githubInstallationRedirectUri } from '../sources/auth/github-auth-session';
import { runGoogleSignIn, clearPendingGoogleSignIn } from '../sources/auth/google-auth-session';
import { noticeForAuthError } from '../sources/auth/onboarding-state';

export default function OnboardingNativeProof() {
  const [mode, setMode] = useState('google');
  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({url}) => {
      const next = new URL(url).searchParams.get('proof');
      if (next) setMode(next);
    });
    return () => subscription.remove();
  }, []);
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return <SafeAreaProvider><KeyboardProvider><Scene mode={mode} /></KeyboardProvider></SafeAreaProvider>;
}
function Scene({ mode }: { mode: string }) {
  const {theme} = useUnistyles();
  const insets = useSafeAreaInsets();
  const [linked, setLinked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const google = async () => {
    if (googleBusy) return;
    setGoogleBusy(true);
    setNotice(null);
    const originalFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = async (input, init) => {
      if (!String(input).includes('/auth/oidc/completion')) return originalFetch(input, init);
      if (String(input).endsWith('/cancel')) return new Response(null, {status:204});
      reads++;
      if (reads === 1) throw new TypeError('Network request failed');
      if (reads === 2) {
        await new Promise(resolve => setTimeout(resolve, 11_000));
        throw new TypeError('Network request failed');
      }
      return new Response('{}', {status: reads === 3 ? 503 : 200});
    };
    try {
      await runGoogleSignIn({state:'s'.repeat(43),recoveryToken:'r'.repeat(43),
        openAuthSession:async()=>({type:'opened'}),subscribeToUrls:()=>({remove(){}})});
      setNotice('Google proof recovered. The first attempt recovered without restarting sign-in.');
    } catch (error) {setNotice(noticeForAuthError(error).message);}
    finally {globalThis.fetch=originalFetch;await clearPendingGoogleSignIn();setGoogleBusy(false);}
  };
  const connect = async () => {
    try {
      await runGitHubInstallationSession({returnPath:'/beeline/settings/identity',
        startInstallation:async()=>'https://github.com/apps/beeline/installations/new',
        openAuthSession:async()=>({type:'success',url:githubInstallationRedirectUri()+'?installed=1'}),
        subscribeToUrls:()=>({remove(){}}),subscribeToAppState:()=>({remove(){}}),
        refreshRepositories:async()=>{setLinked(true);},onRefreshPhase:()=>{},
      });
    } catch(error) {setNotice(error instanceof Error ? error.message : String(error));}
  };
  return <View style={{flex:1,backgroundColor:theme.buzz.bgBase,paddingTop:insets.top,paddingBottom:insets.bottom}}>
    <StatusBar barStyle="dark-content" />
    {mode === 'welcome' ? <WelcomeCards visible onDone={()=>{}} /> : mode === 'google' ?
      <View style={{flex:1,justifyContent:'center',padding:theme.buzz.space.lg,gap:theme.buzz.space.lg}}>
        <Text style={{...theme.buzz.type.hero,color:theme.buzz.textPrimary}}>Continue with Google</Text>
        {notice ? <Text style={{...theme.buzz.type.body,color:theme.buzz.textSecondary}}>{notice}</Text> : null}
        <Button label="Continue with Google" variant="provider" loading={googleBusy} onPress={()=>void google()} />
      </View> : mode === 'account' ?
      <View style={{padding:theme.buzz.space.lg,gap:theme.buzz.space.lg}}>
        <Text style={{...theme.buzz.type.hero,color:theme.buzz.textPrimary}}>Settings</Text>
        <Text style={{...theme.buzz.type.meta,color:theme.buzz.textSecondary}}>Notifications: network error reaching the push gateway</Text>
        <Button label="Retry notifications" variant="secondary" />
        <SettingsRow title="Google" value="Linked" />
        <SettingsRow title="GitHub" value={linked?'Linked':'Connect'} onPress={()=>void connect()} testID="settings-provider-github" />
        {notice ? <Text style={{...theme.buzz.type.meta,color:theme.buzz.dialogDanger}}>{notice}</Text> : null}
      </View> : mode === 'avatar' ?
      <YouStep seed={'f'.repeat(64)} handle="lunchboxfortwo" name="lunchboxfortwo" onConfirm={async()=>{}} onEntered={()=>{}} /> :
      <View style={{padding:theme.buzz.space.lg,gap:theme.buzz.space.lg}}>
        <Text style={{...theme.buzz.type.hero,color:theme.buzz.textPrimary}}>Name your Workspace</Text>
        <Button label="Create Workspace" disabled />
        <Button label="Continue with GitHub" variant="provider" />
        <Button label="Continue with Google" variant="provider" />
      </View>}
  </View>;
}
