import { boundToolResult } from './tool-output-budget.js';
import { JsonObject, JsonRpcRequest, asObject, toolOwedStorage, requiredEnv, agentSurface, TOOLS, readTurnContextFile, callTool } from './read-only-mcp.js';
import { validateAdvertisedToolInput, callAgentTool } from './read-only-mcp-open-poll.js';



export function toolCallId(params: JsonObject, requestId: JsonRpcRequest['id']): string {
  const metadata = asObject(params._meta);
  const candidate = metadata.beelineToolCallId ?? metadata.progressToken ?? requestId;
  return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
}


export function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}


export function success(id: JsonRpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}


export function failure(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}


/** Keep concurrent calls isolated; footer metadata rides on their existing operation responses. */
export async function withToolOwedContext(work: () => Promise<string>) {
  return toolOwedStorage.run({}, async () => {
    let output: string;
    let isError = false;
    try { output = await work(); }
    catch (error) {
      isError = true;
      output = error instanceof Error ? error.message : String(error);
      // Validation may refuse before dispatch. Read fresh authenticated context
      // without adding an operation to the command/operation log.
      if (!toolOwedStorage.getStore()?.owedMentions) {
        try {
          const response = await fetch(new URL('/v1/daemon/owed-mentions', requiredEnv('BEELINE_DAEMON_BASE_URL')), {
            signal: undefined,
            headers: { authorization: `Bearer ${requiredEnv('BEELINE_DAEMON_TOKEN')}` },
          });
          if (response.ok) {
            const context = await response.json() as { owedMentions?: unknown[] };
            if (Array.isArray(context.owedMentions)) toolOwedStorage.getStore()!.owedMentions = context.owedMentions;
          }
        } catch { /* Optional context must never mask the original refusal. */ }
      }
    }
    const owedMentions = toolOwedStorage.getStore()?.owedMentions;
    return { ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text: output },
      ...(owedMentions ? [{ type: 'text' as const, text: JSON.stringify({ owedMentions }) }] : [])] };
  });
}


export async function handleLine(line: string): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    failure(null, -32700, 'invalid JSON');
    return;
  }
  if (request.id === undefined) return;
  try {
    if (request.method === 'initialize') {
      const params = asObject(request.params);
      success(request.id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: agentSurface ? 'beeline-agent' : 'beeline-readonly-mcp',
          version: '1.0.0',
        },
      });
      return;
    }
    if (request.method === 'ping') {
      success(request.id, {});
      return;
    }
    if (request.method === 'tools/list') {
      success(request.id, { tools: TOOLS });
      return;
    }
    if (request.method === 'tools/call') {
      const params = asObject(request.params);
      if (typeof params.name !== 'string') throw new Error('tool name must be a string');
      // A tool that refuses answers with an MCP tool RESULT carrying isError,
      // not a JSON-RPC protocol error. A protocol error is a client bug in
      // every harness that reads the spec, and reaches the model - when it
      // reaches it at all - as "the call failed", with the sentence explaining
      // why buried in a transport frame (C90).
      const work = async () => {
        if (process.env.BEELINE_TURN_CONTEXT_FILE && (await readTurnContextFile()).terminalReason)
          throw new Error('turn has ended; further tool calls are refused');
        const definition = TOOLS.find(tool => tool.name === params.name);
        if (!definition) throw new Error(`unknown or unavailable tool: ${params.name}`);
        if (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) throw new Error('tool arguments must be an object');
        validateAdvertisedToolInput(definition, asObject(params.arguments));
        return agentSurface
          ? callAgentTool(params.name as string, asObject(params.arguments), toolCallId(params, request.id))
          : callTool(params.name as string, asObject(params.arguments));
      };
      let result: Awaited<ReturnType<typeof withToolOwedContext>>;
      if (agentSurface) result = await withToolOwedContext(work);
      else {
        try { result = { content: [{ type: 'text', text: await work() }] }; }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
      }
      success(request.id, await boundToolResult(result));
      return;
    }
    failure(request.id, -32601, `method not found: ${request.method ?? ''}`);
  } catch (error) {
    failure(request.id, -32602, error instanceof Error ? error.message : String(error));
  }
}
