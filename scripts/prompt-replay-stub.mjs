/** Stdio MCP simulator. It never executes a proposed tool or command. */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { FIND_TOOLS, findTools } from './prompt-tool-loading.mjs';
import { validSchema } from './prompt-nightly.mjs';
import { replayScenarioResult } from './prompt-replay-scenarios.mjs';

export function createStub({ testCase, tools, skills, variant }) {
  const loaded = new Set(variant.mode === 'full' ? tools.map(t => t.name) : variant.core);
  const trace = { calls: [], attemptedCalls: [], invalidCalls: [], searches: [], results: [], terminal: null };
  const advertised = () => tools.filter(t => loaded.has(t.name)).map(t => ({ ...t,
    description: variant.descriptionWords ? t.description.split(/\s+/).slice(0, variant.descriptionWords).join(' ') : t.description }));
  const listing = () => [...advertised(), ...(variant.mode === 'deferred' ? [{ ...FIND_TOOLS, description: variant.findDescription ?? FIND_TOOLS.description }] : [])]
    .map(t => ({ ...t, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
  const call = (name, args) => {
    const entry = { name, args };
    trace.attemptedCalls.push(entry);
    if (trace.terminal) {
      trace.invalidCalls.push(entry);
      trace.failure = 'Call after terminal boundary';
      return { error: trace.failure };
    }
    if (trace.attemptedCalls.length > 24) { trace.terminal = 'call-limit'; return { error: 'Simulation call limit reached; end the turn' }; }
    const tool = listing().find(t => t.name === name);
    if (!tool) {
      trace.invalidCalls.push(entry);
      trace.failure = tools.some(t => t.name === name) ? 'Called an unloaded tool' : 'Unknown tool';
      trace.terminal = 'invalid-call';
      return { error: trace.failure };
    }
    if (!validSchema(tool.inputSchema, args)) {
      trace.invalidCalls.push(entry);
      return { error: 'Arguments do not match the advertised schema' };
    }
    if (name === 'find_tools') {
      const matches = findTools(tools, args.query);
      trace.searches.push({ query: args.query, names: matches.map(t => t.name) });
      matches.forEach(t => loaded.add(t.name));
      return { definitions: matches, instruction: 'These definitions are now callable; continue the same turn.' };
    }
    trace.calls.push(entry);
    if (['order', 'report', 'no_reply_needed'].includes(name)) {
      trace.terminal = name;
      return { instruction: 'The simulated assigned turn has ended. Do not call more tools.' };
    }
    const result = replayScenarioResult(testCase, entry, skills);
    trace.results.push({ call: entry, ...result });
    if (result.invalidSchema) {
      trace.calls.pop();
      trace.invalidCalls.push(entry);
    }
    if (result.boundary) trace.terminal = result.boundary;
    if (name === 'merge_corner') trace.terminal ??= name;
    return result.boundary ? { ...result, instruction: 'Stop at this boundary and end the turn.' } : result.result;
  };
  return { trace, listing, call };
}

export async function serve(fixturePath, tracePath) {
  const state = createStub(JSON.parse(readFileSync(fixturePath, 'utf8')));
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const save = () => { writeFileSync(tracePath + '.tmp', JSON.stringify(state.trace)); renameSync(tracePath + '.tmp', tracePath); };
  save();
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'beeline-replay-stub', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: state.listing() };
    else if (message.method === 'tools/call') {
      const value = state.call(message.params.name, message.params.arguments ?? {});
      save();
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], ...(value?.error ? { isError: true } : {}) };
    } else if (message.method === 'ping') result = {};
    else if (message.method === 'resources/list') result = { resources: [] };
    else if (message.method === 'resources/templates/list') result = { resourceTemplates: [] };
    else if (message.method === 'prompts/list') result = { prompts: [] };
    else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported simulator method' } }); continue; }
    send({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'tools/call' && message.params.name === 'find_tools') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve(process.argv[2], process.argv[3]);
