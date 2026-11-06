import React from 'react';
import {Stack} from 'expo-router';
import {StyleSheet} from 'react-native-unistyles';
import {boneTheme,obsidianTheme} from '../../../../sources/theme';
import {useFonts} from 'expo-font';
StyleSheet.configure({themes:{bone:boneTheme,obsidian:obsidianTheme},settings:{initialTheme:(process.env.EXPO_PUBLIC_PROOF_THEME==='bone'||(typeof location!=='undefined'&&location.search.includes('theme=bone')))?'bone':'obsidian'},breakpoints:{xs:0,sm:576,md:768,lg:992,xl:1200}});
export default function Layout(){ const [ready]=useFonts({'SpaceGrotesk-Regular':require('../../../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../../../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),'SpaceGrotesk-SemiBold':require('../../../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),'IBMPlexMono-Regular':require('../../../../sources/assets/fonts/IBMPlexMono-Regular.ttf')}); return ready?<Stack screenOptions={{headerShown:false,animation:'none'}}/>:null; }
