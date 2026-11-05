import { afterEach,describe,expect,it,vi } from 'vitest';
import { finishSignIn,SignInPendingError,type SignIn } from './beeline-api.js';
const signIn=():SignIn=>({url:'https://synthetic.invalid/mcp/oauth/authorize',state:'s'.repeat(43),verifier:'v'.repeat(43)});
const tokens={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600};
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('sign-in completion recovery',()=>{
  it('re-observes broken/pending completion reads but never repeats an uncertain token exchange',async()=>{
    vi.useFakeTimers();
    const fetcher=vi.fn().mockRejectedValueOnce(new Error('held connection lost'))
      .mockResolvedValueOnce(Response.json({error:'authorization_pending'},{status:400}))
      .mockResolvedValueOnce(Response.json({code:'synthetic-code'})).mockResolvedValueOnce(Response.json(tokens));
    vi.stubGlobal('fetch',fetcher);const state=signIn();
    const done=finishSignIn('https://synthetic.invalid','client',state);await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual(tokens);expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.slice(0,3).every(([url])=>url.endsWith('/handoff'))).toBe(true);
    expect(fetcher.mock.calls.slice(0,3).map(([,init])=>JSON.parse(init.body).state)).toEqual([state.state,state.state,state.state]);
    const lost=signIn();fetcher.mockResolvedValueOnce(Response.json({code:'synthetic-code'})).mockRejectedValueOnce(new Error('response lost'));
    await expect(finishSignIn('https://synthetic.invalid','client',lost)).rejects.toBeInstanceOf(SignInPendingError);
    expect(lost.exchangeStarted).toBe(true);const sent=fetcher.mock.calls.length;
    await expect(finishSignIn('https://synthetic.invalid','client',structuredClone(lost))).rejects.toBeInstanceOf(SignInPendingError);expect(fetcher).toHaveBeenCalledTimes(sent);
  });

});
