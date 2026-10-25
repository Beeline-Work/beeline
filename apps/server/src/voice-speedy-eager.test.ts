import {expect,it,vi} from 'vitest';
import {VoiceEagerReply} from './voice-eager-reply.js';
import {OpenRouterVoiceBrain} from './voice-providers.js';
it.each([0,900])('SPEEDY-EAGER-1: final wait %s ms does not spend committed search budget',async(waitMs)=>{
 vi.useFakeTimers();
 const fetcher=vi.fn<typeof fetch>()
  .mockResolvedValueOnce(new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{function:{name:'search_web',arguments:JSON.stringify({query:'Japan',spoken_line:'Let me look.'})}}]}}]})+'\n\n'))
  .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"Tokyo."}}]}\n\n'));
 const agent={id:'ruby',name:'Ruby',handle:'ruby',soul:'',voice:'luna'};
 const draft=new VoiceEagerReply(new OpenRouterVoiceBrain('test',fetcher),agent,[{role:'user',content:'What is the capital of Japan?'}],[]);
 const search=vi.fn(async()=> {await new Promise(resolve=>setTimeout(resolve,1800)); return 'Tokyo, Japan.';});
 try{
  await vi.advanceTimersByTimeAsync(waitMs);
  expect(search).not.toHaveBeenCalled();
  const pending=draft.consume(()=>{},{agents:[],announce:async()=>{},search},new AbortController().signal);
  await vi.advanceTimersByTimeAsync(2000);
  const result=await pending;
  expect(result).toEqual({text:'Tokyo.',order:false});
 }finally{draft.cancel();vi.useRealTimers();}
});
