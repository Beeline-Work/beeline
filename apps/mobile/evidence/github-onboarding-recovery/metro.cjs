const fs=require('fs'),path=require('path');const config=require('../../metro.config');const original=config.resolver.resolveRequest;
const dir=path.resolve(__dirname,'../../.scratch/github-proof');fs.mkdirSync(dir,{recursive:true});
const shims={
 '@/buzz/onboarding-rollout':'export const useRepositoryOnboarding=()=>true;',
 'expo-router':'export const useLocalSearchParams=()=>({});',
 '@/sync/transport/monolith-operation':`export const monolithPhoneOperation=async(name,input)=>{const response=await fetch('http://10.0.2.2:18767',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,input})});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;};`
};const map={};for(const [name,source]of Object.entries(shims)){const file=path.join(dir,Object.keys(map).length+'.js');fs.writeFileSync(file,source);map[name]=file;}
config.resolver.resolveRequest=(context,name,platform)=>{const key=Object.keys(map).find(key=>key===name||(key.startsWith('@/')&&(name.endsWith(key.slice(1))||name.endsWith(key.slice(1)+'.ts'))));if(key)return{type:'sourceFile',filePath:map[key]};return original?original(context,name,platform):context.resolveRequest(context,name,platform);};module.exports=config;
