import React from 'react';
import { View, Text } from 'react-native';
export const PixelLoader=()=>null;
export const PixelGateReveal=({children,...props}:any)=><View {...props}>{children}</View>;
export const HullSurface=({strength,children,...props}:any)=><View {...props}>{children}</View>;
export const HullLivePulse=({children}:any)=><>{children}</>;
export const ImpactFeedbackStyle={Light:'Light'};
export const impactAsync=async()=>{};
export const Ionicons=({name,size,color}:any)=><Text style={{fontSize:size,color}}>{name==='add'?'+':'×'}</Text>;
export const KeyboardAvoidingView=({behavior,children,...props}:any)=><View {...props}>{children}</View>;
export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});
export const useLatencyRouteFrame=()=>{};
export const router={replace:()=>{},back:()=>{},canGoBack:()=>true};
export const randomUUID=()=> 'proof-workspace';
export const loadBuzzIdentity=async()=>({publicKey:'proof-viewer',name:'Alex'});
export const saveActiveCommunityId=async()=>{};
export const enterWorkspaceRoom=()=>{};
export const monolithPhoneOperation=async()=>{throw new Error('Could not load this workflow. Check your connection.');};
export function useTextDraft(key:string, initial:any) { const [v,set]=React.useState(key==='create-workspace:name'?'Northstar Lab':initial);return [v,set,{capture:()=>()=>{}}]; }
export const useLocalSearchParams=()=>({workspaceId:'proof',viewerId:'human-dani',connectionId:'cred_vercel',service:'vercel',roomId:'proof-room',name:'launch-planning'});
export const openBrowserAsync=async()=>{throw new Error('External actions disabled in screenshot proof');};
export const SurfaceGlyphLoader=()=>null;

export const useFocusEffect=(effect:any)=>React.useEffect(effect,[effect]);
// The error specimen never renders the successful workflow detail subtree.
export const WorkflowRunLine=()=>null;
