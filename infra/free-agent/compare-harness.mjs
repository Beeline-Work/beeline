#!/usr/bin/env node
// Runs inside either comparison image. No provider key is needed for --boot.
// Task mode takes MODEL_BASE_URL and BEELINE_FREE_AGENT_MODEL_TOKEN from the
// backend environment. Neither is printed or copied into the result artifact.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const harness = process.argv[2];
if (!['pi', 'opencode'].includes(harness)) throw new Error('expected pi or opencode');
const bootOnly = process.argv.includes('--boot');
const root = process.env.COMPARISON_ROOT ?? '/tmp/beeline-harness-comparison';
const home = resolve(root, 'home');
const cwd = resolve(root, 'task');
const model = 'deepseek/deepseek-v4.1-flash';
const result = { harness, model, bootOnly, processStartedAt: Date.now(), requests: [], usage: [] };
await mkdir(resolve(home, '.pi/agent'), { recursive: true });
await mkdir(cwd, { recursive: true });
let proxy;
let child;
let activeModelRequests = 0;
const pending = new Map();
let nextId = 0;
let reply = '';
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: resolve(home, '.config'),
  XDG_DATA_HOME: resolve(home, '.local/share'), XDG_STATE_HOME: resolve(home, '.local/state'),
  XDG_CACHE_HOME: resolve(home, '.cache'), PI_CODING_AGENT_DIR: resolve(home, '.pi/agent'),
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' };

function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
function request(method, params, timeout = 60_000) {
  return new Promise((accept, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    pending.set(id, { accept, reject, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

try {
  if (!bootOnly) {
    if (!env.MODEL_BASE_URL || !env.BEELINE_FREE_AGENT_MODEL_TOKEN)
      throw new Error('task mode requires a backend model route and scoped token');
    const upstream = env.MODEL_BASE_URL.replace(/\/$/, '') + '/chat/completions';
    proxy = createServer(async (req, res) => {
      activeModelRequests++;
      try {
        if (req.method !== 'POST' || req.url !== '/chat/completions') {
          res.writeHead(404).end(); return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const cap = body.max_completion_tokens ?? body.max_tokens;
        const observed = { model: body.model, maxTokens: cap, stream: body.stream === true };
        result.requests.push(observed);
        if (body.model !== model || !Number.isFinite(cap) || cap > 65_536)
          throw new Error('unexpected model or oversized output request');
        const response = await fetch(upstream, { method: 'POST',
          headers: { authorization: `Bearer ${env.BEELINE_FREE_AGENT_MODEL_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, ...(body.stream ? { stream_options: { ...body.stream_options, include_usage: true } } : {}) }), signal: AbortSignal.timeout(180_000) });
        observed.status = response.status;
        const contentType = response.headers.get('content-type') ?? 'application/json';
        res.writeHead(response.status, { 'content-type': contentType });
        let text = '';
        for await (const chunk of response.body) {
          text += Buffer.from(chunk).toString(); res.write(chunk);
        }
        let usage;
        if (contentType.includes('text/event-stream')) {
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
              try { usage = JSON.parse(line.slice(6)).usage ?? usage; } catch { /* Non-JSON event. */ }
            }
          }
        } else {
          try { usage = JSON.parse(text).usage; } catch { /* Provider error without JSON. */ }
        }
        if (usage) result.usage.push(usage);
        res.end();
      } catch (error) {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'comparison model request failed' } }));
        result.proxyError = error.name;
      } finally {
        activeModelRequests--;
      }
    });
    await new Promise((accept) => proxy.listen(0, '127.0.0.1', accept));
    const baseUrl = `http://127.0.0.1:${proxy.address().port}`;
    await writeFile(resolve(home, '.pi/agent/models.json'), JSON.stringify({ providers: { beeline: {
      api: 'openai-completions', baseUrl, apiKey: '$BEELINE_FREE_AGENT_MODEL_TOKEN',
      models: [{ id: model, name: model, reasoning: true, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 65_536 }],
    } } }));
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ autoupdate: false, share: 'disabled',
      model: `beeline/${model}`, provider: { beeline: { npm: '@ai-sdk/openai-compatible', name: 'Beeline',
        options: { baseURL: baseUrl, apiKey: '{env:BEELINE_FREE_AGENT_MODEL_TOKEN}' },
        models: { [model]: { name: model, tool_call: true, reasoning: true,
          limit: { context: 1_000_000, output: 65_536 } } } } } });
    await writeFile(resolve(cwd, 'orders.json'), JSON.stringify([
      { item: 'pear', quantity: 3, unitCents: 125 },
      { item: 'plum', quantity: 4, unitCents: 80 },
      { item: 'pear', quantity: 2, unitCents: 125 },
    ]));
  }
  result.harnessSpawnedAt = Date.now();
  child = spawn(harness === 'pi' ? 'pi-acp' : 'opencode', harness === 'pi' ? [] : ['acp'],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.on('error', (error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  });
  child.on('exit', (code) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`harness exited ${code}`)); }
    pending.clear();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'session/request_permission') {
      const option = message.params.options.find((item) => item.kind === 'allow_once');
      send({ jsonrpc: '2.0', id: message.id, result: { outcome: option
        ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
    } else if (message.method === 'session/update') {
      const update = message.params.update;
      if (update.sessionUpdate === 'agent_message_chunk' && !update._meta?.piAcp?.notify && update.content?.type === 'text') reply += update.content.text;
    } else if (pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else entry.accept(message.result);
    }
  });
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  result.initializeAnsweredAt = Date.now();
  result.initializeMs = result.initializeAnsweredAt - result.harnessSpawnedAt;
  result.agentInfo = initialized.agentInfo;
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  if (!bootOnly) {
    const session = await request('session/new', { cwd, mcpServers: [] });
    const modelId = `beeline/${model}`;
    const config = session.configOptions?.find((option) => option.category === 'model' || option.id === 'model');
    if (config) await request('session/set_config_option', { sessionId: session.sessionId, configId: config.id, value: modelId });
    else if (session.models) await request('session/set_model', { sessionId: session.sessionId, modelId });
    else throw new Error('harness did not advertise model selection');
    reply = '';
    result.turnStartedAt = Date.now();
    const completion = await request('session/prompt', { sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Read orders.json. Calculate the total cents for each item and the grand total. Write answer.json with an items object mapping each item name to its total cents and a totalCents field for the grand total. Reply with only TOTAL_CENTS=<grand total> after writing the file.' }] }, 300_000);
    result.turnMs = Date.now() - result.turnStartedAt;
    const usageDeadline = Date.now() + 180_000;
    while (activeModelRequests && Date.now() < usageDeadline)
      await new Promise((accept) => setTimeout(accept, 50));
    result.usageDrainMs = Date.now() - result.turnStartedAt - result.turnMs;
    result.stopReason = completion.stopReason;
    const answer = JSON.parse(await readFile(resolve(cwd, 'answer.json'), 'utf8'));
    result.artifactPassed = answer.items?.pear === 625 && answer.items?.plum === 320 && answer.totalCents === 945;
    result.replyPassed = reply.trim() === 'TOTAL_CENTS=945';
    result.replyLength = reply.length;
    result.taskPassed = result.artifactPassed && result.replyPassed;
    result.usageObserved = result.requests.length > 0 && result.usage.length === result.requests.length && activeModelRequests === 0;
    result.requestCount = result.requests.length;
    result.usageCount = result.usage.length;
    result.promptTokens = result.usage.reduce((total, usage) => total + (usage.prompt_tokens ?? 0), 0);
    result.completionTokens = result.usage.reduce((total, usage) => total + (usage.completion_tokens ?? 0), 0);
    result.totalTokens = result.usage.reduce((total, usage) => total + (usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0))), 0);
    if (!result.taskPassed || !result.usageObserved) process.exitCode = 1;
  }
} catch (error) {
  // Error strings and harness stderr can include provider URLs; keep results bounded and credential-free.
  result.error = { name: error.name, stage: result.initializeAnsweredAt ? 'task' : 'initialize' };
  result.errorDetail = String(error.message).replaceAll(env.MODEL_BASE_URL ?? '\0', '[model route]')
    .replaceAll(env.BEELINE_FREE_AGENT_MODEL_TOKEN ?? '\0', '[token]').slice(0, 300);
  process.exitCode = 1;
} finally {
  if (result.turnStartedAt && result.turnMs === undefined) result.turnMs = Date.now() - result.turnStartedAt;
  child?.kill('SIGTERM');
  proxy?.closeAllConnections();
  proxy?.close();
  await writeFile(resolve(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  // Fly probes stay running so /exec can retrieve the result before deletion.
  if (process.env.COMPARISON_KEEP_ALIVE === '1') setInterval(() => {}, 60_000);
}
