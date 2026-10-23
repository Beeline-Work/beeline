// Native proof: the complete production onboarding screen. Account/session
// boundaries are isolated by full-screen.metro.cjs; controls and themes are real.
import 'react-native-get-random-values';
import React, { useEffect, useState } from 'react';
import { Linking, StatusBar } from 'react-native';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { boneTheme, obsidianTheme } from '../../sources/theme';
import { LAYOUT_BREAKPOINTS } from '../../sources/utils/layoutClass';
import { clearOnboardingNotice, noticeForAuthError, publishOnboardingNotice } from '../../sources/auth/onboarding-state';
import { OidcBindError } from '@beeline/buzz-client';
StyleSheet.configure({ themes: {
  bone: boneTheme,
  obsidian: obsidianTheme,
}, breakpoints: LAYOUT_BREAKPOINTS, settings: { initialTheme: 'bone' } });
// Screen modules create themed styles at evaluation time.
const BuzzOnboarding = require('../../sources/app/(app)/beeline/onboarding').default;
function Root() {
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('state=initial&theme=bone');
  useEffect(() => {
    const update = url => {
      if (!url?.includes('onboarding-proof')) return;
      const next = url.split('?')[1] || '';
      const params = new URLSearchParams(next);
      UnistylesRuntime.setTheme(params.get('theme') || 'bone');
      clearOnboardingNotice();
      const code = { cancel: 'browser_canceled', expired: 'ticket_expired', offline: 'offline' }[params.get('state')];
      if (code) publishOnboardingNotice(noticeForAuthError(new OidcBindError(code, code)));
      setQuery(next);
    };
    const subscription = Linking.addEventListener('url', ({ url }) => update(url));
    Linking.getInitialURL().then(update);
    require('expo-splash-screen').hideAsync();
    require('expo-font').loadAsync({
      'SpaceGrotesk-Regular': require('../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
      'SpaceGrotesk-Medium': require('../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
      'SpaceGrotesk-SemiBold': require('../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
      'IBMPlexMono-Regular': require('../../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
    }).then(() => setReady(true));
    return () => subscription.remove();
  }, []);
  return ready ? <SafeAreaProvider><StatusBar barStyle={new URLSearchParams(query).get('theme') === 'obsidian' ? 'light-content' : 'dark-content'} /><BuzzOnboarding key={query} /></SafeAreaProvider> : null;
}
registerRootComponent(Root);
