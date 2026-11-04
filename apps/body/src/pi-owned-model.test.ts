import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { encodeOwnedModelReceipt } from '@beeline/api-contract/helper-model-receipt';
import { OwnedModelFiles, OWNED_MODEL_DENY_TOKEN } from './owned-model-files.js';
import { createOwnedModelPiExtension, ownedModelPiSettings } from './pi-owned-model.js';

const token = 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const chunk = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const toolDelta = { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_synthetic', type: 'function', function: { name: 'probe', arguments: '{}' } }] }, finish_reason: null }] };
const finish = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage };
const receipt = (id: string) => encodeOwnedModelReceipt(token, { requestId: id, state: 'succeeded', evidence: { kind: 'usage', tokens: 2, usd: 0 } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(options: {
  reply(request: IncomingMessage, response: ServerResponse, id: string, number: number): void;
  extension?: 'missing' | 'caught';
}) {
  const root = mkdtempSync(join(tmpdir(), 'owned-pi-')); let requests = 0, entered = 0, tools = 0;
  let owner!: OwnedModelFiles;
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    requests++;
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401); response.end('{"error":{"message":"unavailable"}}'); return; }
    entered++;
    const id = String(request.headers['x-beeline-model-request']);
    try {
      expect(request.url).toBe('/v1/free-agents/model/chat/completions');
      const journal = JSON.parse(readFileSync(owner.paths().journal, 'utf8'));
      expect(journal.active).toBe(id); expect(journal.requests.at(-1)).toEqual({ id, state: 'unknown' });
      options.reply(request, response, id, entered);
    } catch (error) { failures.push(error); response.destroy(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Synthetic server unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}/v1/free-agents/model`;
  owner = OwnedModelFiles.create({ root, binding: { agentId: 'synthetic-agent', commandId: 'synthetic-command', generationId: 'generation-1',
    connectionId: 'connection-1', connectionEpoch: 1, provider: 'beeline', model: 'pinned-model', baseUrl },
    credential: { v: 1, token, expiresAt: Math.floor(Date.now() / 1000) + 600 } });
  const modelsPath = join(root, 'models.json');
  writeFileSync(modelsPath, JSON.stringify({ providers: { beeline: { baseUrl, api: 'openai-completions', apiKey: OWNED_MODEL_DENY_TOKEN,
    models: [{ id: 'pinned-model', name: 'synthetic', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }] } } }), { mode: 0o600 });
  // Explicit memory store and paths: never discover operator HOME/auth/models.
  const modelRuntime = await ModelRuntime.create({ modelsPath, modelsStorePath: join(root, 'catalog.json'),
    credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error('Synthetic credential writes forbidden'); }, delete: async () => {} },
    allowModelNetwork: false, refreshOnCreate: false });
  const settingsManager = SettingsManager.inMemory({ ...ownedModelPiSettings(), compaction: { enabled: false } });
  let extension: ExtensionFactory | undefined = createOwnedModelPiExtension(owner);
  if (options.extension === 'missing') extension = undefined;
  if (options.extension === 'caught') extension = pi => { pi.on('before_provider_headers', () => { throw new Error('Synthetic caught hook failure'); }); };
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    extensionFactories: extension ? [extension] : [], noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Synthetic pinned receipt proof.' });
  await loader.reload();
  const selected = modelRuntime.getModel('beeline', 'pinned-model'); if (!selected) throw new Error('Synthetic model missing');
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: selected, thinkingLevel: 'off',
    noTools: 'builtin', resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root),
    customTools: [{ name: 'probe', label: 'Synthetic probe', description: 'A synthetic local side effect.', parameters: Type.Object({}),
      execute: async () => { tools++; expect(owner.snapshot().state).toBe('idle'); return { content: [{ type: 'text', text: 'done' }], details: {} }; } }] });
  cleanups.push(async () => { await session.abort(); session.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true }); });
  return { owner, session, counts: () => ({ requests, entered, tools }), assertServer: () => { expect(failures).toEqual([]); }, settingsManager };
}
const lastAssistant = (session: AgentSession) => session.state.messages.filter(message => message.role === 'assistant').at(-1);

describe('pinned Pi owned-model leaf (uninstalled)', () => {
  it('awaits the authenticated terminal receipt before executing a tool and follow-up model request', async () => {
    const contentSent = deferred(), release = deferred(); let terminal!: () => void;
    const f = await fixture({ reply(_request, response, id, number) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (number === 1) {
        response.write(chunk(toolDelta) + chunk(finish)); contentSent.resolve();
        terminal = () => response.end(chunk({ id: receipt(id), choices: [] }) + 'data: [DONE]\n\n');
      } else response.end(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'complete' }, finish_reason: 'stop' }], usage }) +
        chunk({ id: receipt(id), choices: [] }) + 'data: [DONE]\n\n');
    } });
    const prompt = f.session.prompt('Use the synthetic probe.');
    try {
      await contentSent.promise; await new Promise<void>(done => setImmediate(done));
      expect(f.counts()).toEqual({ requests: 1, entered: 1, tools: 0 }); expect(f.owner.snapshot().state).toBe('unknown');
      terminal(); release.resolve(); await prompt;
      f.assertServer(); expect(f.counts()).toEqual({ requests: 2, entered: 2, tools: 1 }); expect(f.owner.snapshot().state).toBe('idle');
      expect(JSON.stringify(f.session.state.messages)).not.toContain(token);
    } finally { release.resolve(); }
  });

  it.each(['missing', 'forged', 'upstream-first'] as const)('clean SDK completion with %s receipt never executes tools or dependent provider work', async mode => {
    const f = await fixture({ reply(_request, response, id) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(chunk(mode === 'upstream-first' ? { ...toolDelta, id: 'untrusted-provider-id' } : toolDelta) + chunk(finish) +
        (mode === 'missing' ? '' : chunk({ id: mode === 'forged' ? 'bfmr_v1.forged.' + '0'.repeat(64) : receipt(id), choices: [] })) +
        (mode === 'missing' ? '' : 'data: [DONE]\n\n'));
    } });
    await f.session.prompt('Use the synthetic probe.');
    f.assertServer(); expect(f.counts()).toEqual({ requests: 1, entered: 1, tools: 0 });
    expect(lastAssistant(f.session)?.stopReason).toBe('error'); expect(f.owner.snapshot().state).toBe('unknown');
    await f.session.prompt('A follow-up cannot bypass the uncertain request.');
    expect(f.counts().entered).toBe(1); expect(f.counts().tools).toBe(0);
  });

  it.each(['missing', 'caught'] as const)('invalid configured sentinel fails closed when extension is %s', async extension => {
    const f = await fixture({ extension, reply() { throw new Error('Sentinel must never enter provider'); } });
    await f.session.prompt('Synthetic prompt.'); f.assertServer(); expect(f.counts().entered).toBe(0); expect(f.counts().tools).toBe(0);
    expect(f.counts().requests).toBeLessThanOrEqual(1);
  });

  it('missing private credential leaves denial headers and admits zero provider entries', async () => {
    const f = await fixture({ reply() { throw new Error('No private auth must never enter provider'); } });
    unlinkSync(f.owner.paths().credential); await f.session.prompt('Synthetic prompt.');
    f.assertServer(); expect(f.counts().entered).toBe(0); expect(f.counts().tools).toBe(0);
  });

  it('retries an authenticated provider refusal with a fresh journal UUID and then completes normally',async()=>{
    const ids:string[]=[];
    const f=await fixture({reply(_request,response,id,number){
      ids.push(id);
      if(number===1){
        const evidence=encodeOwnedModelReceipt(token,{requestId:id,state:'refused',evidence:{kind:'provider-refused',status:429}});
        response.writeHead(409,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Recorded model refusal: '+evidence}}));return;
      }
      response.writeHead(200,{'content-type':'text/event-stream'});
      response.end(chunk({id:receipt(id),choices:[{index:0,delta:{role:'assistant',content:'recovered'},finish_reason:'stop'}],usage})+'data: [DONE]\n\n');
    }});
    await f.session.prompt('Synthetic prompt.');f.assertServer();
    expect(f.counts()).toEqual({requests:2,entered:2,tools:0});expect(new Set(ids).size).toBe(2);expect(f.owner.snapshot().state).toBe('idle');
  });

  it.each([429, 500, 'disconnect'] as const)('never retries an unauthenticated %s outcome despite enabling known-refusal recovery', async status => {
    const f = await fixture({ reply(_request, response) {
      if (status === 'disconnect') response.destroy();
      else { response.writeHead(status, { 'content-type': 'application/json' }); response.end('{"error":{"message":"synthetic refusal"}}'); }
    } });
    expect(f.settingsManager.getRetrySettings()).toMatchObject({ enabled: true, maxRetries: 3 });
    expect(f.settingsManager.getProviderRetrySettings().maxRetries).toBe(0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await f.session.prompt('Synthetic prompt.'); await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    f.assertServer(); expect(f.counts()).toEqual({ requests: 1, entered: 1, tools: 0 }); expect(f.owner.snapshot().state).toBe('unknown');
  });
});
