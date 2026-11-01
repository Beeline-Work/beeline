import {StyleSheet as NativeStyleSheet} from 'react-native';
import {beelineThemes} from '../sources/buzz/groknight';
const theme={buzz:beelineThemes.bone};
export const StyleSheet={...NativeStyleSheet,create:factory=>typeof factory==='function'?factory(theme,{insets:{top:24,bottom:24,left:0,right:0},screen:{width:412,height:915}}):factory};
export const useUnistyles=()=>({theme,rt:{insets:{top:24,bottom:24,left:0,right:0}}});
export const UnistylesRuntime={themeName:'bone',setTheme(){},setAdaptiveThemes(){}};
