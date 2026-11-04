// The joined session's own Beeline connection: OAuth with PKCE against Beeline's MCP sign-in, completed on any
// device through Beeline's handoff page, then MCP tool calls as the session's member.
import { createHash, randomBytes } from 'node:crypto';
import { Agent } from 'undici';
import { readState, withLock, writeState, type JoinedSession } from './store.js';

export const DEFAULT_SERVER = 'https://server.usebeeline.app';

/**
 * Refusals a session reads. Joining signs a person in and creates a Room member, so it is the person's action:
 * an agent that runs `usebeeline join` on its own registers a new connection, possibly on another server.
 */
export const NOT_JOINED = 'This session is not joined to Beeline from here. Run the exact command from the Beeline message, '
  + 'including its --as <member> flag. Joining is your person\'s action: do not run usebeeline join unless they ask you to.';
export const DISCONNECTED = 'Beeline disconnected this session (it was disconnected in Settings or its sign-in expired). '
  + 'Tell your person; only they can reconnect it. Do not run usebeeline join on your own.';
const opaque = () => randomBytes(32).toString('base64url');

export interface Tokens { access_token: string; refresh_token: string; expires_in: number }

// Fetch supplies its own five-minute body timeout even when an Agent default
// is zero. Override that option only on the persistent stream dispatcher. The
// Agent retains connect/header deadlines; the caller owns abort/token expiry.
class MemberStreamAgent extends Agent {
  override dispatch(options: Parameters<Agent['dispatch']>[0], handler: Parameters<Agent['dispatch']>[1]): ReturnType<Agent['dispatch']> {
    return super.dispatch({ ...options, bodyTimeout: 0 }, handler);
  }
}
const memberStreamAgent = new MemberStreamAgent();

function admitHeldMcpCompletion(url:string,body:unknown):void{
  const target=new URL(url);
  if(!['https:','http:'].includes(target.protocol)||target.username||target.password||target.hash||target.search||target.pathname!=='/mcp/oauth/handoff'||
    !body||typeof body!=='object'||Object.getPrototypeOf(body)!==Object.prototype)throw new Error('Held MCP completion route unavailable');
  const fields=Object.getOwnPropertyDescriptors(body);
  if(Object.getOwnPropertySymbols(body).length||Object.keys(fields).some(key=>!['state','completionV1','waitMs'].includes(key))||
    Object.values(fields).some(field=>!('value' in field))||fields.completionV1?.value!==true||
    typeof fields.state?.value!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(fields.state.value)||
    !Number.isSafeInteger(fields.waitMs?.value)||fields.waitMs!.value<1||fields.waitMs!.value>600_000)
    throw new Error('Held MCP completion admission invalid');
}

/** The existing authenticated MCP/OAuth transport leaf owns all requests,
 * including the persistent member stream; callers cannot create a second owner. */
async function request(url: string, body: unknown, headers: Record<string,string>, stream?: AbortSignal, cancellation?:AbortSignal,held=false): Promise<Response> {
  if(held){if(stream)throw new Error('Held MCP completion mode invalid');admitHeldMcpCompletion(url,body);}
  if(stream&&new URL(url).pathname!=='/mcp/member-stream')throw new Error('MCP member stream route unavailable');
  return fetch(url,{method:stream?'GET':'POST',headers:{'content-type':'application/json',...headers},
    ...((stream||held)?{dispatcher:memberStreamAgent}:{}),...(!stream?{body:JSON.stringify(body)}:{}),signal:stream ?? cancellation ?? AbortSignal.timeout(60_000)});
}
async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, signal?:AbortSignal,timeoutMs=60_000,held=false): Promise<{ status: number; value: Record<string, unknown> }> {
  const timeout=AbortSignal.timeout(Math.max(1,timeoutMs));
  const response = await request(url,body,headers,undefined,signal?AbortSignal.any([signal,timeout]):timeout,held);
  const text = await response.text();
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: response.status, value };
}

export function handoffUri(server: string): string {
  return `${server}/mcp/oauth/handoff`;
}

/** One registration per joined session: its member is the session, named on the Allow page. */
export async function registerClient(server: string, clientName: string): Promise<string> {
  const { status, value } = await postJson(`${server}/mcp/oauth/register`, { client_name: clientName, redirect_uris: [handoffUri(server)],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  if (status !== 201 || typeof value.client_id !== 'string') throw new Error(`Beeline refused the registration (HTTP ${status})`);
  return value.client_id;
}

export interface SignIn { url: string; verifier: string; state: string;code?:string;exchangeStarted?:boolean;tokens?:Tokens;tokensAt?:number }
/** An uncertain ceremony remains on disk for an explicit action/cold recovery.
 * It cannot authorize another status read or duplicate token exchange. */
export class SignInPendingError extends Error{}
export class SignInEndedError extends Error{}

export function signInLink(server: string, clientId: string, memberName: string, claudeInboundFallback = false): SignIn {
  const verifier = opaque(), state = opaque();
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: handoffUri(server), response_type: 'code', resource: `${server}/mcp`,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read rooms:write',
    state, member_name: memberName });
  if (claudeInboundFallback) query.set('claude_inbound_fallback', '1');
  return { url: `${server}/mcp/oauth/authorize?${query}`, verifier, state };
}

/** Waits for the person to finish on any device, then trades the code for tokens. */
export async function finishSignIn(server: string, clientId: string, signIn: SignIn, deadlineAt = Date.now() + 10 * 60_000,
  persist:(signIn:SignIn)=>void=()=>{}): Promise<Tokens> {
  if(signIn.tokens&&signIn.tokensAt!==undefined){
    const expires=signIn.tokens.expires_in-Math.floor((Date.now()-signIn.tokensAt)/1000);
    if(expires<=0)throw new SignInPendingError('The sign-in result needs a new explicit authorization');
    return {...signIn.tokens,expires_in:expires};
  }
  if(signIn.exchangeStarted)throw new SignInPendingError('The sign-in result is unknown; no code exchange was repeated');
  if(Date.now()>=deadlineAt)throw new SignInEndedError('The sign-in link expired after 10 minutes');
  if(!signIn.code){
    let handoff:Awaited<ReturnType<typeof postJson>>;
    const waitMs=Math.max(1,Math.min(600_000,deadlineAt-Date.now()));
    try{handoff=await postJson(`${server}/mcp/oauth/handoff`,{state:signIn.state,completionV1:true,waitMs},{},undefined,waitMs,true);}
    catch{throw new SignInPendingError('The sign-in completion is still pending; no observation was repeated');}
    if(handoff.status!==200)throw new SignInPendingError('The sign-in completion is still pending; no observation was repeated');
    if(['authorization_pending','completion_unavailable'].includes(String(handoff.value.error)))
      throw new SignInPendingError('The sign-in completion is still pending; no observation was repeated');
    if(typeof handoff.value.code!=='string'||!handoff.value.code||handoff.value.code.length>100)throw new SignInEndedError('The sign-in was cancelled');
    signIn.code=handoff.value.code;persist(signIn);
  }
  // Persist uncertainty before the one-use exchange. A lost result cannot
  // silently create another token attempt on a background restart.
  signIn.exchangeStarted=true;persist(signIn);
  let token:Awaited<ReturnType<typeof postJson>>;
  try{token=await postJson(`${server}/mcp/oauth/token`,{grant_type:'authorization_code',client_id:clientId,code:signIn.code,
    code_verifier:signIn.verifier,redirect_uri:handoffUri(server),resource:`${server}/mcp`});}
  catch{throw new SignInPendingError('The sign-in result is unknown; no code exchange was repeated');}
  if(token.status!==200||typeof token.value.access_token!=='string'||!token.value.access_token||typeof token.value.refresh_token!=='string'||
    !token.value.refresh_token||typeof token.value.expires_in!=='number'||!Number.isFinite(token.value.expires_in)||token.value.expires_in<=0)
    throw new SignInPendingError('The sign-in result is unknown; explicit authorization is required');
  signIn.tokens={access_token:token.value.access_token,refresh_token:token.value.refresh_token,expires_in:token.value.expires_in};
  signIn.tokensAt=Date.now();persist(signIn);return signIn.tokens;
}

async function refresh(server: string, clientId: string, refreshToken: string): Promise<Tokens> {
  const { status, value } = await postJson(`${server}/mcp/oauth/token`, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken,
    resource: `${server}/mcp` });
  if (status !== 200) throw new Error(status === 400 ? DISCONNECTED : `Beeline token refresh failed (HTTP ${status})`);
  return value as unknown as Tokens;
}

/**
 * A current access token for a joined session. Refresh tokens are single-use and a reused one ends the connection,
 * so every refresh happens under the state lock and is written before anyone else reads it.
 */
export async function accessToken(dir: string, key: string): Promise<string> {
  const valid = (session: JoinedSession) => session.accessToken && (session.accessExpiresAt ?? 0) > Date.now() + 60_000 ? session.accessToken : undefined;
  const current = readState(dir).sessions.find(s => s.key === key);
  if (!current) throw new Error('This session has not joined Beeline');
  const ready = valid(current);
  if (ready) return ready;
  return withLock(dir, async () => {
    const state = readState(dir);
    const session = state.sessions.find(s => s.key === key);
    if (!session) throw new Error('This session has not joined Beeline');
    const fresh = valid(session);
    if (fresh) return fresh;
    const tokens = await refresh(session.server, session.clientId, session.refreshToken);
    session.accessToken = tokens.access_token;
    session.refreshToken = tokens.refresh_token;
    session.accessExpiresAt = Date.now() + tokens.expires_in * 1000;
    writeState(dir, state);
    return tokens.access_token;
  });
}

/** Calls one Beeline tool as the session's member. Results are untrusted Room data. */
export async function callTool(session: Pick<JoinedSession, 'server'>, token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const { status, value } = await postJson(`${session.server}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { authorization: `Bearer ${token}`, 'mcp-protocol-version': '2026-07-28', accept: 'application/json' });
  if (status === 401) throw new Error(DISCONNECTED);
  if (status !== 200) throw new Error(`Beeline answered HTTP ${status}`);
  const result = value.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  const text = result?.content?.[0]?.text ?? '';
  if (!result || result.isError) throw new Error(result?.content?.map(item => item.text ?? '').join('\n') || 'Beeline refused the call');
  const parsed = JSON.parse(text) as { data: Record<string, unknown>; owedMentions?: unknown[] };
  return parsed.owedMentions === undefined ? parsed.data : { ...parsed.data, owedMentions: parsed.owedMentions };
}

/** One negotiated check per admitted stream connection, at the existing
 * authenticated adapter. An old server cannot silently select a poll loop. */
export async function requireMemberStream(session:Pick<JoinedSession,'server'>,token:string,signal?:AbortSignal):Promise<void>{
  const {status,value}=await postJson(`${session.server}/mcp`,{jsonrpc:'2.0',id:1,method:'server/discover',params:{}},
    {authorization:`Bearer ${token}`,'mcp-protocol-version':'2026-07-28',accept:'application/json'},signal);
  const result=value.result as {capabilities?:{memberStreamV1?:unknown}}|undefined;
  if(status!==200||result?.capabilities?.memberStreamV1!==true)
    throw new Error('Beeline member stream unavailable: this server must support memberStreamV1 for automatic joined-session delivery; explicit session read/tool remains available');
}

/** One outbound authenticated member stream. A server without this extension
 * leaves autonomous delivery parked; it never falls back to an empty poll. */
export async function* memberStream(session: Pick<JoinedSession,'server'|'cursor'|'streamCursor'>, token: string,
  signal: AbortSignal, opened:()=>void=()=>{}): AsyncGenerator<unknown> {
  await requireMemberStream(session,token,signal);
  if(signal.aborted)return;
  const url=new URL('/mcp/member-stream',session.server);
  url.searchParams.set('mentions',session.cursor);
  if(session.streamCursor) url.searchParams.set('cursor',JSON.stringify(session.streamCursor));
  const controller=new AbortController(),abort=()=>controller.abort();
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const handshake=setTimeout(abort,60_000);handshake.unref?.();
  let cancel:(()=>Promise<void>)|undefined;
  try{
    const response=await request(url.toString(),undefined,{authorization:`Bearer ${token}`,accept:'application/x-ndjson'},controller.signal);
    clearTimeout(handshake);
    if(!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson'))
      throw new Error(`Beeline member stream unavailable (HTTP ${response.status})`);
    opened();
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffered='';
    cancel=()=>reader.cancel();
    while(!signal.aborted){
      const next=await reader.read();if(next.done)break;
      buffered+=decoder.decode(next.value,{stream:true});
      if(Buffer.byteLength(buffered)>2*256*1024)throw new Error('Beeline stream frame exceeds capacity');
      let end:number;
      while((end=buffered.indexOf('\n'))>=0){
        const line=buffered.slice(0,end);buffered=buffered.slice(end+1);
        if(!line)continue;if(Buffer.byteLength(line)>256*1024)throw new Error('Beeline stream frame exceeds capacity');
        yield JSON.parse(line) as unknown;
      }
    }
    if(buffered.trim())throw new Error('Beeline stream ended inside a delivery');
  } finally {clearTimeout(handshake);signal.removeEventListener('abort',abort);await cancel?.().catch(()=>undefined);}

}
