import { useEffect } from 'react';
export let navigate = () => {};
export const setNavigate = fn => { navigate=fn; };
export const router = { push: href => navigate(href.pathname), back: () => navigate('menu') };
export const useLocalSearchParams = () => ({roomId:'dm-fixture',workspaceId:'workspace-fixture',subscriptionId:'e5997c6a-fixture'});
export const useFocusEffect = callback => useEffect(callback,[callback]);
export const useSharedSurface = () => ({value:{
 isDirectMessage:true,roomName:null,agentNames:[['ruby','Ruby']],schedules:[],subscriptions:[{
 id:'e5997c6a-fixture',roomId:'dm-fixture',agentId:'ruby',source:'webhook',event:'webhook.called',
 title:'Grok Bot results',when:'On webhook call',prompt:'Receive Grok Bot results.',
 firedCount:0,createdAt:1792800000,
 webhook:{url:'https://beeline.test/hooks/e5997c6a-fixture',tokenSuffix:'test',tokenCreatedAt:1792800000},recentCalls:[]
 }]},address:null,loading:false,error:null,setError:()=>{},refresh:async()=>{}});
export class MonolithPhoneOperationError extends Error {}
export const monolithPhoneOperation = async () => { throw new Error('This visual fixture never reveals a real token.'); };
