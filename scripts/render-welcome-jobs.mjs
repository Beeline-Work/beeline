// Browser surface stand-in: real choice plates and stored game from the built service proof.
import {build} from 'esbuild';
const {chromium}=await import(process.env.PLAYWRIGHT_CORE_PATH ?? 'playwright-core');
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(), mobile=path.join(root,'apps/mobile'), output=process.env.WELCOME_PROOF_OUTPUT ?? '/tmp/beeline-welcome-jobs';
const card=JSON.parse(await readFile(output+'/welcome.json','utf8')).messages.find(m=>m.choice).choice;
const {identityFaceDataUri}=await import(root+'/apps/server/dist/identity-face.js');
const face=await identityFaceDataUri({id:card.agent.pubkey,kind:'agent',face_id:card.agent.face??null});
const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{View,Text,Pressable,Image}from'react-native';import{TranscriptCardChoicePlate}from'${mobile}/sources/components/buzz/ChoicePlate';
const card=${JSON.stringify(card)};
createRoot(document.getElementById('root')).render(<View style={{margin:12,padding:16,borderWidth:1,borderColor:'#C9BBA0',borderRadius:10,backgroundColor:'#ECE4D5',gap:8}}><View style={{flexDirection:'row',alignItems:'center',gap:8,marginBottom:8}}><Image source={{uri:${JSON.stringify(face)}}} style={{width:26,height:26}}/><Text style={{fontFamily:'SpaceGrotesk-Regular',fontSize:16,fontWeight:'600',marginBottom:8}}>{card.prompt}</Text></View>{card.options.map(o=><TranscriptCardChoicePlate key={o.optionId} closed={false} choice={{id:o.optionId,letter:o.optionId,label:o.label,consequence:o.consequence,onPress:()=>document.body.dataset.pick=o.optionId}}/>)}<Pressable accessibilityRole="button" onPress={()=>document.body.dataset.pick='skip'} style={{alignSelf:'flex-end',padding:12}}><Text style={{fontFamily:'SpaceGrotesk-Regular',fontSize:16}}>Skip</Text></Pressable></View>);`;
const shims={'./MonoHull':'export const PixelLoader=()=>null;', 'react-native-unistyles':`import{beelineThemes}from'${mobile}/sources/buzz/groknight';const theme={buzz:beelineThemes.bone};export const StyleSheet={create:f=>typeof f==='function'?f(theme):f,hairlineWidth:1};export const useUnistyles=()=>({theme});`};
await build({stdin:{contents:entry,resolveDir:mobile,loader:'tsx'},outfile:output+'/card.js',bundle:true,platform:'browser',jsx:'automatic',mainFields:['browser','module','main'],resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],loader:{'.js':'jsx'},define:{'process.env.NODE_ENV':'"production"',__DEV__:'false',global:'globalThis'},plugins:[{name:'native',setup(b){b.onResolve({filter:/.*/},({path:p})=>{if(p in shims)return{path:p,namespace:'shim'};if(p==='react-native')return{path:mobile+'/node_modules/react-native-web/dist/index.js'};});b.onLoad({filter:/.*/,namespace:'shim'},({path:p})=>({contents:shims[p],loader:'tsx',resolveDir:mobile}));}}]});
const fonts=await Promise.all(['SpaceGrotesk-Regular','SpaceGrotesk-SemiBold','IBMPlexMono-Regular'].map(async name=>`@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${(await readFile(mobile+'/sources/assets/fonts/'+name+'.ttf')).toString('base64')})}`));
await writeFile(output+'/card.html',`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#F3EEE4;color:#171310}${fonts.join('')}</style><div id="root"></div><script src="card.js"></script>`);
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox'],headless:true});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
for(const [name,w,h]of[['phone',390,844],['wide',1080,720]]){
await page.setViewportSize({width:w,height:h});await page.goto('file://'+output+'/card.html');await page.getByRole('button',{name:/A\. Make a welcome/}).waitFor();await page.screenshot({path:output+'/card-'+name+'.png',fullPage:true});
if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('card overflow');
await page.getByRole('button',{name:/B\. Play/}).click();if(await page.evaluate(()=>document.body.dataset.pick)!=='B')throw Error('B tap failed');
await page.goto('file://'+output+'/game.html');await page.locator('#board').waitFor();await page.screenshot({path:output+'/game-'+name+'.png',fullPage:true});await page.getByRole('button',{name:'Square 1',exact:true}).click();await page.waitForTimeout(1100);if(await page.locator('.cell:not(:empty)').count()<2)throw Error('game did not respond');await page.screenshot({path:output+'/game-playing-'+name+'.png',fullPage:true});
if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('game overflow');
}
await browser.close();if(errors.length)throw Error(errors.join('\n'));console.log('Real ChoicePlate + built server DTO renders and taps, stored game move/reply, phone/wide layouts PASS.');
