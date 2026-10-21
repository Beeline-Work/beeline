import React from 'react';
export const viewer='a'.repeat(64), agentId='d'.repeat(64), workspaceId='11111111-1111-4111-8111-111111111111';
export let agent:any = {
 workspaceId,agent:{identity:{pubkey:agentId,kind:'agent',name:'Jellybean',handle:'jellybean'},role:'member'},
 owner:{pubkey:viewer,kind:'human',name:'Viewer',handle:'viewer'},soul:{name:'Jellybean',instructions:'Keep the tests green.',avatarSeed:agentId},
 catalog:[{id:'model',category:'model',currentValue:'codex',options:[{id:'auto',name:'Auto (default)'},{id:'codex',name:'Codex'},{id:'opus',name:'Claude Opus'}]}, {id:'effort',category:'reasoning_effort',currentValue:'high',options:[{id:'low'},{id:'high'}]}, {id:'fast-mode',category:'model_config',options:[{id:'off'},{id:'on'}]}],
 selected:{model:'codex',effort:'high'},fastMode:false,yolo:{enabled:false,canChange:true},access:{policy:'creator',owner:{id:viewer,name:'Viewer',handle:'viewer'},canChange:true},recentWork:[],watchFilters:[]
};
export const workspace:any={workspace:{id:workspaceId,name:'Builders',visibility:'invite-only',role:'owner',createdAt:1,updatedAt:1},members:[],agents:[agent.agent],peopleTotal:1,agentTotal:1,membersTruncated:false,agentsTruncated:false,viewer:{identity:{pubkey:viewer,kind:'human',name:'Viewer'},role:'owner',permissions:{send:true,manage:true}},watchFilters:[]};
const listeners=new Set<()=>void>();
export const surfaceAddress=(_r:any,_v:any,endpoint:any,params:any)=>({endpoint,params});
export const mobileSurfaceCache={read:async(a:any)=>a.endpoint.includes('agents')?agent:workspace,peek:(a:any)=>a.endpoint.includes('agents')?agent:workspace,fetch:async(a:any,_g:any,request:any)=>request(),write:async(a:any,v:any)=>{if(a.endpoint.includes('agents'))agent=v;listeners.forEach(f=>f())},observe:()=>()=>{},subscribe:()=>()=>{},fenceEndpoint:()=>1};
export function useSurfaceSnapshot(a:any){const [,bump]=React.useState(0);React.useEffect(()=>{const f=()=>bump(x=>x+1);listeners.add(f);return()=>{listeners.delete(f)}},[]);return !a?null:a.endpoint.includes('agents')?agent:workspace;}
export const loadBuzzIdentity=async()=>({publicKey:viewer,secretKey:new Uint8Array(32)});
export const getEffectiveRelayUrl=async()=> 'http://127.0.0.1:18889';
export const useLocalSearchParams=()=>({communityId:workspaceId,workspaceId,agentId,viewerId:viewer});
export const router={back:()=>{},replace:()=>{},push:()=>{},navigate:()=>{}};
export const useNavigation=()=>({addListener:()=>()=>{},dispatch:()=>{}});
export const useFocusEffect=(fn:any)=>React.useEffect(fn,[fn]);
export const useLatencyRouteFrame=()=>{};
export const sharedLiveConnection=()=>({register:async()=>()=>{}});
export const watchWorkspace=()=>()=>{};
export const workspaceRecordScope=()=>null, useWorkspaceRecords=()=>{}, workspaceRows=()=>[],workspacePage=()=>null,recordWorkspacePage=()=>{},recordWorkspaceRemoval=()=>{},recordWorkspacePageRemoval=()=>{};
export class RoomViewClient {agent=async()=>agent;workspace=async()=>workspace;workspaceMembers=async()=>({items:[],query:'',nextCursor:null});agentVoices=async()=>({currentVoiceId:null,canChange:false,choices:[]});}
export class BuzzRigTransport {ensureClient=async()=>({surfaceSubscribe:async()=>()=>{},setAgentModelConfig:async(_w:any,_a:any,input:any)=>({...agent,selected:{...agent.selected,...input},...(typeof input.fastMode==='boolean'?{fastMode:input.fastMode}:{})})});}
export const useActiveCommunityId=()=>workspaceId;
const companies={hasConnections:false,suggestions:[{providerId:'github',name:'GitHub',purpose:'Code and pull requests',providerName:'GitHub',domain:'github.com'},{providerId:'linear',name:'Linear',purpose:'Issues',providerName:'Linear',domain:'linear.app'}],rows:[]};
export const useSharedWorkbench=()=>({value:{companies},error:null,refresh:async()=>{}});
export const useConnectCompanyApp=()=>({busy:null,error:null,connect:async()=>{},open:async()=>{}});
export const connectionViewState=()=> 'connected';

export const loadBuzzViewerPubkey=async()=>viewer;
