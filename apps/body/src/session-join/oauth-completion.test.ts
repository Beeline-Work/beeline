import { afterEach,describe,expect,it,vi } from 'vitest';
import { finishSignIn,SignInPendingError,type SignIn } from './beeline-api.js';
import { Agent } from 'undici';
const signIn=():SignIn=>({url:'https://synthetic.invalid/mcp/oauth/authorize',state:'s'.repeat(43),verifier:'v'.repeat(43)});
const tokens={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600};
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('one correlated held OAuth completion',()=>{
  it('keeps one request for10min and persists code/uncertainty/result before advancing',async()=>{
    vi.useFakeTimers();let finish!:(response:Response)=>void;const persisted:SignIn[]=[],state=signIn();
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      if(url.endsWith('/handoff')){expect(JSON.parse(String(init.body))).toMatchObject({state:state.state,completionV1:true,waitMs:600_000});
        return new Promise<Response>(resolve=>{finish=resolve;});}
      expect(persisted.at(-1)).toMatchObject({code:'synthetic-code',exchangeStarted:true});return Response.json(tokens);
    });vi.stubGlobal('fetch',fetcher);
    const result=finishSignIn('https://synthetic.invalid','client',state,Date.now()+600_000,value=>{persisted.push(structuredClone(value));});
    await vi.advanceTimersByTimeAsync(599_999);expect(fetcher).toHaveBeenCalledOnce();
    const request=fetcher.mock.calls[0]![1] as RequestInit&{dispatcher:Agent};
    const dispatch=vi.spyOn(Agent.prototype,'dispatch').mockReturnValue(true);
    request.dispatcher.dispatch({origin:'https://synthetic.invalid',path:'/mcp/oauth/handoff',method:'POST',headersTimeout:1234,bodyTimeout:300000},{} as never);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({bodyTimeout:0,headersTimeout:1234}),expect.anything());dispatch.mockRestore();
    finish(Response.json({code:'synthetic-code'}));expect(await result).toEqual(tokens);
    expect(fetcher).toHaveBeenCalledTimes(2);expect(persisted.at(-1)).toMatchObject({tokens,tokensAt:expect.any(Number)});
    const recovered=structuredClone(state);await finishSignIn('https://synthetic.invalid','client',recovered,Date.now()+1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps old-server pending and lost token results UNKNOWN without repeating an observation/exchange',async()=>{
    const fetcher=vi.fn(async()=>Response.json({error:'authorization_pending'},{status:400}));vi.stubGlobal('fetch',fetcher);
    await expect(finishSignIn('https://synthetic.invalid','client',signIn())).rejects.toBeInstanceOf(SignInPendingError);expect(fetcher).toHaveBeenCalledOnce();
    const state=signIn();fetcher.mockResolvedValueOnce(Response.json({code:'synthetic-code'})).mockRejectedValueOnce(new Error('response lost'));
    await expect(finishSignIn('https://synthetic.invalid','client',state)).rejects.toBeInstanceOf(SignInPendingError);
    expect(state.exchangeStarted).toBe(true);const sent=fetcher.mock.calls.length;
    await expect(finishSignIn('https://synthetic.invalid','client',structuredClone(state))).rejects.toBeInstanceOf(SignInPendingError);expect(fetcher).toHaveBeenCalledTimes(sent);
  });
  it('sends no token exchange after local persistence failure',async()=>{
    const fetcher=vi.fn(async()=>Response.json({code:'synthetic-code'}));vi.stubGlobal('fetch',fetcher);
    await expect(finishSignIn('https://synthetic.invalid','client',signIn(),Date.now()+600_000,()=>{throw new Error('Synthetic storage failure');})).rejects.toThrow('storage failure');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('cannot select the no-idle-timeout adapter for a different path or unscoped ceremony',async()=>{
    const fetcher=vi.fn(async()=>Response.json({}));vi.stubGlobal('fetch',fetcher);
    await expect(finishSignIn('https://synthetic.invalid/arbitrary','client',signIn())).rejects.toBeInstanceOf(SignInPendingError);
    await expect(finishSignIn('https://synthetic.invalid','client',{...signIn(),state:'unscoped'})).rejects.toBeInstanceOf(SignInPendingError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
