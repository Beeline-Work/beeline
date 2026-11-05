import { describe } from 'vitest';
import { OpenRouterVoiceBrain } from './voice-providers.js';
import { expect, it, vi } from 'vitest';
import { VoiceEagerReply } from './voice-eager-reply.js';
import type { VoiceBrain, VoiceSearchContext } from './voice-providers.js';
const agent = { id: 'ruby', name: 'Ruby', handle: 'ruby', soul: '', voice: 'luna' };
const history = [{ role: 'user' as const, content: 'Hello there' }];
const context = (): VoiceSearchContext => ({ agents: [], search: vi.fn(async () => 'result'), announce: vi.fn(async () => {}) });

it('overlaps 150ms of brain work with the final-turn wait without extra calls', async () => {
  vi.useFakeTimers();
  try {
    const run = async (early: boolean) => {
      const brain: VoiceBrain = { answer: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 200)); return { text: 'Hello.', order: false };
      }) };
      const draft = early ? new VoiceEagerReply(brain, agent, history, []) : undefined;
      await vi.advanceTimersByTimeAsync(150);
      const end = Date.now();
      let elapsed = -1;
      const result = (draft ? draft.consume(() => {}, context(), new AbortController().signal) :
        brain.answer(agent, history, () => {}, new AbortController().signal)).then(() => { elapsed = Date.now() - end; });
      await vi.advanceTimersByTimeAsync(200); await result;
      expect(brain.answer).toHaveBeenCalledOnce();
      return elapsed;
    };
    expect(await run(false)).toBe(200);
    expect(await run(true)).toBe(50);
  } finally { vi.useRealTimers(); }
});

it.each([false, true])('gates search and announcement until final, or cancels both (%s)', async cancel => {
  const final = context();
  let announce!: Promise<void>;
  const brain: VoiceBrain = { answer: async (_agent, _history, _delta, signal, search) => {
    announce = search!.announce('Looking.'); void announce.catch(() => {});
    await search!.search({name:'search_history',query:'hello'},signal);
    await announce; return {text:'Found it.',order:false};
  } };
  const draft = new VoiceEagerReply(brain, agent, history, []);
  await Promise.resolve();
  expect(final.search).not.toHaveBeenCalled(); expect(final.announce).not.toHaveBeenCalled();
  if(cancel) { draft.cancel(); await expect(announce).rejects.toMatchObject({name:'AbortError'}); }
  else { await draft.consume(() => {}, final, new AbortController().signal); expect(final.search).toHaveBeenCalledOnce(); expect(final.announce).toHaveBeenCalledOnce(); }
});

it('rejects reuse after the agent, context, or member choices change', () => {
  const draft = new VoiceEagerReply({answer: async () => ({text:'Hello.',order:false})},agent,history,[]);
  expect(draft.matches(agent,history,[])).toBe(true);
  expect(draft.matches({...agent,voice:'asteria'},history,[])).toBe(false);
  expect(draft.matches(agent,[...history,{role:'assistant',content:'New context'}],[])).toBe(false);
  expect(draft.matches(agent,history,[{name:'Goose',handle:'goose'}])).toBe(false);
  draft.cancel(); expect(draft.matches(agent,history,[])).toBe(false);
});

describe("voice-speedy-eager", () => {
it.each([0,900])('SPEEDY-EAGER-1: final wait %s ms does not spend committed search budget',async(waitMs)=>{
 vi.useFakeTimers();
 const fetcher=vi.fn<typeof fetch>()
  .mockResolvedValueOnce(new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{function:{name:'search_web',arguments:JSON.stringify({query:'Japan',spoken_line:'Let me look.'})}}]}}]})+'\n\n'))
  .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"Tokyo."}}]}\n\n'));
 const agent={id:'ruby',name:'Ruby',handle:'ruby',soul:'',voice:'luna'};
 const draft=new VoiceEagerReply(new OpenRouterVoiceBrain('test',fetcher),agent,[{role:'user',content:'What is the capital of Japan?'}],[]);
 const search=vi.fn(async()=> {await new Promise(resolve=>setTimeout(resolve,1800)); return 'Tokyo, Japan.';});
 let pending:ReturnType<VoiceEagerReply['consume']>|undefined;
 try{
  await vi.advanceTimersByTimeAsync(waitMs);
  expect(search).not.toHaveBeenCalled();
  pending=draft.consume(()=>{},{agents:[],announce:async()=>{},search},new AbortController().signal);
  void pending.catch(()=>{});
  await vi.advanceTimersByTimeAsync(2000);
  const result=await pending;
  expect(result).toEqual({text:'Tokyo.',order:false});
 }finally{draft.cancel();await pending?.catch(()=>{});vi.useRealTimers();}
});
});
