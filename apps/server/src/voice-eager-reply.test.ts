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
