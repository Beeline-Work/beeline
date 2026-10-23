/** Android proof of every approved call site using the production theme runtime. */
import 'react-native-get-random-values';
import React from 'react';
import { registerRootComponent } from 'expo';
import { LogBox, ScrollView, View, Text } from 'react-native';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { useUnistyles } from 'react-native-unistyles';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
require('../sources/unistyles');
import { setAppAppearance } from '../sources/unistyles';
import { Button } from '../sources/components/buzz/Button';
import { approvalCases, approvalCaseElement } from './approval-card-cases';
LogBox.ignoreAllLogs();
function Proof() {
  const [index, setIndex] = React.useState(0);
  const [acted, setActed] = React.useState(false);
  const { theme } = useUnistyles();
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  React.useEffect(() => { if (fonts) void SplashScreen.hideAsync(); }, [fonts]);
  if (!fonts) return null;
  return <GestureHandlerRootView style={{flex:1}}><ScrollView style={{flex:1,backgroundColor:theme.buzz.bgBase}} contentContainerStyle={{paddingTop:64,paddingHorizontal:16,paddingBottom:32,gap:24}}>
    <Text accessibilityLabel={`Variant ${approvalCases[index]}`} style={{...theme.buzz.type.hero,color:theme.buzz.textPrimary}}>{approvalCases[index]}</Text>
    <View style={{flexDirection:'row',gap:8}}>
      <Button label="Bone" onPress={() => setAppAppearance('light', 'medium')} />
      <Button label="Obsidian" onPress={() => setAppAppearance('dark', 'medium')} />
      <Button label="Next" accessibilityLabel="Next variant" onPress={() => {setIndex((index+1)%approvalCases.length);setActed(false);}} />
    </View>
    <View key={`${index}-${theme.buzz.bgBase}`}>{approvalCaseElement(approvalCases[index]!, () => setActed(true))}</View>
    {acted && <Text style={{...theme.buzz.type.meta,color:theme.buzz.textSecondary}}>Action received</Text>}
  </ScrollView></GestureHandlerRootView>;
}
registerRootComponent(Proof);
