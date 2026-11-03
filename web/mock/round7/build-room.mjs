import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { webProofShims } from '../../../apps/mobile/sources/test/browserProof.ts';
const here=path.dirname(fileURLToPath(import.meta.url));
const mobile=path.resolve(here,'../../../apps/mobile');
const shims=webProofShims(mobile);
Object.assign(shims,{
 'expo-font':'export const useFonts=()=>[true,null];export const isLoaded=()=>true;export const loadAsync=async()=>{};',
 'expo-router':`export const router={push(){},back(){},replace(){}};export const useRouter=()=>router;export const useLocalSearchParams=()=>({});`,
 '@/components/buzz/CodeBlock':'export const CodeBlock=()=>null;',
 '@/buzz/message-link':'export const messageLinkId=()=>null;export const openMessageLink=()=>{};',
 '@/utils/open-external-url':'export const openExternalUrl=()=>{};',
 '@/buzz/speech-input':`export const useSpeechInput=()=>({state:'idle',capability:'unavailable',modelDownloadOffered:false,volumeLevel:0,cancel(){},start(){},stop:async()=>'',declineModelDownload(){},acceptModelDownload(){}});`,
 '@/buzz/client-error-report':'export const reportClientError=()=>{};',
});
shims['react-native-reanimated']+='\nexport const FadeOut=FadeInDown;export const interpolateColor=(_v,_i,o)=>o[o.length-1];';
await build({entryPoints:[path.join(here,'RoomPreview.tsx')],outfile:path.join(here,'room.bundle.js'),bundle:true,minify:true,platform:'browser',jsx:'automatic',mainFields:['browser','module','main'],nodePaths:[path.join(mobile,'node_modules')],resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],loader:{'.js':'jsx','.ttf':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"','process.env.EXPO_OS':'"web"',__DEV__:'false',global:'globalThis'},plugins:[{name:'offline-room-fixture',setup(api){api.onResolve({filter:/.*/},({path:spec})=>{if(spec in shims)return{path:spec,namespace:'shim'};if(spec==='react-native')return{path:path.join(mobile,'node_modules/react-native-web/dist/index.js')};if(spec.startsWith('@/')){const base=path.join(mobile,'sources',spec.slice(2));const target=['','.web.tsx','.web.ts','.tsx','.ts','.json','/index.ts','/index.tsx'].map(e=>base+e).find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());if(target)return{path:target};}});api.onLoad({filter:/.*/,namespace:'shim'},({path:spec})=>({contents:shims[spec],loader:'tsx',resolveDir:mobile}));}}]});
let fonts='';for(const name of ['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold','IBMPlexMono-Regular'])fonts+=`@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${fs.readFileSync(path.join(mobile,'sources/assets/fonts',name+'.ttf')).toString('base64')})}`;
fonts+=`@font-face{font-family:'ionicons';src:url(data:font/ttf;base64,${fs.readFileSync(path.join(mobile,'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf')).toString('base64')})}`;fs.writeFileSync(path.join(here,'fonts.css'),fonts);
const components=['Ledger','TranscriptCard','PrLifecycleCard','IdentityMark','ChannelHeaderTitle','ConversationComposer','ActivityTimeline','ToolOutputSheet','CodeHighlighter','TurnProgressLine','LedgerDisclosure','IndexRow','MonoMarkdown','MonoHull','BeelineMarkSpinner'];fs.writeFileSync(path.join(here,'component-sources.json'),JSON.stringify(components.map(name=>({path:'apps/mobile/sources/components/buzz/'+name+'.tsx',sha256:createHash('sha256').update(fs.readFileSync(path.join(mobile,'sources/components/buzz',name+'.tsx'))).digest('hex')})),null,2)+'\n');
console.log('Built unmodified shared transcript UI, including native tool output, progress and composer');