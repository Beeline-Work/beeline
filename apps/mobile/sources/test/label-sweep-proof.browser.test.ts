import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

// Opt-in full-size captures of real components against the prior and current source.
const captureRoot = process.env.LABEL_PROOF_DIR;
for (const state of ['before', 'after']) for (const theme of ['bone', 'obsidian']) {
 for (const section of ['model', 'viewer', 'close', 'destinations', 'rows', 'symbols', 'signin']) {
  it.skipIf(!captureRoot)(`${state} ${theme} ${section}`, async () => {
   const mobile = state === 'before' ? process.env.LABEL_BASELINE_MOBILE! : process.cwd();
   const shims = webProofShims(mobile);
   shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`);
   shims['react-native-reanimated'] += '\nexport const FadeOut = FadeInDown; export const FadeOutDown = FadeInDown; export const FadeIn = FadeInDown; export const FadeInUp = FadeInDown; export const FadeOutUp = FadeInDown; export const LinearTransition = FadeInDown; export const withSpring = v => v; export const interpolateColor = (_v,_i,o) => o[o.length-1];';
   shims['expo-router'] = 'export const router = {}; export const useRouter = () => ({}); export const useLocalSearchParams = () => ({});';
   shims['@/sync/transport/monolith-operation'] = 'export const monolithPhoneOperation = async () => ({access:"proof.9999999999999"});';
   shims['react-native-view-shot'] = "export const captureRef = async () => ''; export default {};";
   const fonts = ['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold','IBMPlexMono-Regular','IBMPlexMono-SemiBold'].map(font => `@font-face{font-family:'${font}';src:url(data:font/ttf;base64,${readFileSync(path.join(mobile,'sources/assets/fonts',`${font}.ttf`)).toString('base64')})}`).join('');
   mkdirSync(captureRoot!, { recursive: true });
   const result = await runBrowserProof({mobile, shims, entry:path.join(mobile,'scripts/label-sweep-components-proof.tsx'),width:390,height:section === 'destinations' ? 1000 : 600,query:`?state=${state}&section=${section}`,head:`<script>window.process={env:{}};window.addEventListener("error",e=>{document.getElementById("result").textContent="ERROR "+e.message});</script><style>${fonts}#result{display:none}body{background:${theme==='bone'?'#F3EEE4':'#14091A'}}</style>`,screenshotPath:path.join(captureRoot!,`${section}-${theme}-${state}.png`)});
   expect(result.status,result.stderr).toBe(0);
   expect(result.result,result.stderr).toBe(`PASS ${section}`);
  }, 90000);
 }
}
