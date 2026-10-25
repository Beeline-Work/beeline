import { webProofShims } from '../sources/test/browserProof';

export function cardButtonShims(mobile: string, theme: string) {
  const shims = webProofShims(mobile);
  shims['react-native-unistyles'] = shims['react-native-unistyles'].replace(
    'beelineThemes.obsidian',
    `beelineThemes.${theme}`,
  );
  shims['react-native-reanimated'] +=
    `\nconst builder=new Proxy({},{get:()=>()=>builder}); export const FadeOut=builder; export const interpolateColor=(_v,_i,o)=>o[o.length-1];`;
  shims['react-native-gesture-handler'] = 'export const Swipeable = props => props.children;';
  shims['@/auth/monolith-session'] =
    'export const monolithSession={}; export const MONOLITH_REQUEST_TIMEOUT_MS=15000;';
  shims['expo-clipboard'] += ' export const setImageAsync=async()=>{};';
  return shims;
}
