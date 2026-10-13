import React from 'react';
import {MockWorkbenchSource, VERCEL_CONNECTION} from '@/buzz/workbench-source.mock';
const source = new MockWorkbenchSource();
export function useSharedWorkbench() {
  const [value, setValue] = React.useState<any>(null);
  React.useEffect(() => { void source.readWorkbench({workspaceId:'proof', viewerId:'human-dani'}).then(setValue); }, []);
  return {value, error:null, refresh:async()=>{}};
}
export function useSharedConnectionDetail() {
  return {value:VERCEL_CONNECTION, address:null, error:null, refresh:async()=>{}};
}
export const publishConnectionDetail=async()=>{};
export const getWorkbenchSource=()=>({revokeAllGrants:async()=>{throw new Error('Commands disabled in screenshot proof');}});
