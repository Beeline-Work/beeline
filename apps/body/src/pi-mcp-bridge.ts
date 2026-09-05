import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { McpServerWire } from './acp.js';
import { writeIsolatedHarnessFile } from './agent-home.js';

/**
 * The MCP servers a session mounts, reaching a pi harness at all.
 *
 * `pi-acp` accepts `mcpServers` on `session/new`, stores it on its session
 * object and never reads it again, and pi itself has no MCP client: measured
 * on pi-acp 0.x + pi 0.84, the field is dead. The visible consequence was a
 * Room agent on pi answering that "the beeline-agent tools are not mounted
 * here… I can see they exist but I cannot reach them" — its whole tool list was
 * pi's own `read`, `bash`, `edit`, `write`. Every daemon-governed action —
 * opening a corner, attaching a file, asking for a grant, and now subscribing
 * to events — was unreachable from the one harness a paired agent is most
 * likely to be running.
 *
 * pi's own extension point is the way in: a `.js` in `$PI_CODING_AGENT_DIR/
 * extensions/` is auto-discovered (a trusted global location, so no project
 * trust prompt), loaded through jiti before the session starts, and may
 * register tools the model can call. So the daemon GENERATES one extension per
 * session that speaks stdio MCP to exactly the servers this session mounts and
 * republishes their tools as pi tools. Nothing about the servers changes: the
 * same command, the same environment, the same `tools/list` and `tools/call`
 * every other harness makes, so `read-only-mcp.ts` stays the one authority for
 * what an agent may do.
 *
 * The repository still pins and bundles `pi-mcp-adapter`, which does the same
 * job generically; it was measured against real pi beside this bridge and not
 * used, for one reason that is about correctness rather than taste. The adapter
 * connects its servers in the background and registers their tools at the next
 * tool sync — about a second after `session_start` in the measurement — while
 * pi-acp sends `session/prompt` straight after `session/new`. A tool panel that
 * MIGHT be mounted when the first prompt goes out is the bug being fixed here.
 * This bridge is an async extension factory, and pi awaits an async factory
 * before `session_start`, so the tools are there or the session is not. It also
 * mounts exactly this session's servers and nothing else — no config discovery,
 * no operator `.mcp.json`, which is the boundary `harness-tool-scope.ts` exists
 * to hold. (The bundled adapter is now unreferenced; see the pull request.)
 *
 * Two properties this file is responsible for:
 *
 *   - The extension is written BEFORE the harness spawns, from outside the
 *     sandbox. `PI_CODING_AGENT_DIR` is a harness state directory, which a Room
 *     session mounts read-only, so the agent cannot rewrite its own bridge.
 *   - The generated file carries the daemon token, exactly as the mounted
 *     server's environment does for every other harness. It sits beside pi's
 *     `models.json`, which already holds live provider keys, in a 0600 file in
 *     the agent's own private home.
 */
export const PI_MCP_BRIDGE_FILENAME = 'beeline-mcp-bridge.js';

/** True when `session/new`'s `mcpServers` actually reaches the model's tools. */
export function harnessMountsSessionMcpServers(agentCommand: string | undefined): boolean {
  return !(agentCommand && /(^|[/\\])pi-acp(\.[a-z]+)?$/i.test(agentCommand));
}

/**
 * The extension source for one session's servers.
 *
 * Pure and exported so a test can pin the bridge's shape without a filesystem:
 * the manifest is the only thing that varies between sessions.
 */
export function piMcpBridgeSource(servers: readonly McpServerWire[]): string {
  const manifest = servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    env: Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])),
  }));
  return `${BRIDGE_PREAMBLE}const SERVERS = ${JSON.stringify(manifest, null, 2)};\n${BRIDGE_BODY}`;
}

/**
 * Write the bridge into a pi session's isolated home, if this harness needs it.
 *
 * Returns the path written, or undefined when the harness mounts its own MCP
 * servers (every harness but pi) or the session has no isolated home to write
 * into. Never throws into a turn: a bridge that cannot be written leaves pi
 * exactly as it is today, and says so in the daemon log.
 */
export async function installPiMcpBridge(input: {
  agentCommand?: string;
  /** `PI_CODING_AGENT_DIR` for this session, from the prepared home overlay. */
  piHome?: string;
  servers: readonly McpServerWire[];
}): Promise<string | undefined> {
  if (harnessMountsSessionMcpServers(input.agentCommand)) return undefined;
  if (!input.piHome || !input.servers.length) return undefined;
  const directory = resolve(input.piHome, 'extensions');
  const path = resolve(directory, PI_MCP_BRIDGE_FILENAME);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeIsolatedHarnessFile(path, piMcpBridgeSource(input.servers));
    return path;
  } catch (error) {
    console.error('[body] pi MCP bridge could not be written', path, error);
    return undefined;
  }
}

const BRIDGE_PREAMBLE = `// Generated by Beeline for one Room session. Do not edit: it is rewritten on
// every activation. It republishes this session's MCP servers as pi tools,
// because pi has no MCP client of its own (apps/body/src/pi-mcp-bridge.ts).
import { spawn } from 'node:child_process';

`;

const BRIDGE_BODY = `const LIST_TIMEOUT_MS = 20000;

/**
 * One request/response against one MCP server over a short-lived process.
 *
 * A fresh process per call keeps nothing alive between turns: these servers
 * hold no session state - each tool call is a bounded daemon HTTP request - so
 * a pool would buy latency at the cost of processes outliving the session that
 * spawned them.
 */
function callServer(server, request, signal, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    let buffer = '';
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      child.kill('SIGKILL');
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const onAbort = () => finish(new Error(server.name + ' call cancelled'));
    if (timeoutMs) {
      timer = setTimeout(
        () => finish(new Error(server.name + ' did not answer in ' + timeoutMs + 'ms')),
        timeoutMs,
      );
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener?.('abort', onAbort, { once: true });
    }
    child.on('error', (error) => finish(error));
    child.on('exit', () => finish(new Error(server.name + ' exited before answering')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let message;
          try { message = JSON.parse(line); } catch { message = undefined; }
          // Only the answer to OUR id: the initialize reply and any
          // notification the server writes share this stream.
          if (message && message.id === request.id) {
            if (message.error) {
              finish(new Error(message.error.message || 'MCP error'));
            } else {
              finish(undefined, message.result ?? {});
            }
            return;
          }
        }
        newline = buffer.indexOf('\\n');
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'beeline-pi-bridge', version: '1.0.0' },
        },
      }) + '\\n',
    );
    child.stdin.write(JSON.stringify(request) + '\\n');
  });
}

function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\\n');
  return text || 'The tool returned no text.';
}

function labelOf(name) {
  return name.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

export default async function (pi) {
  for (const server of SERVERS) {
    let tools = [];
    try {
      const listed = await callServer(
        server,
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        undefined,
        LIST_TIMEOUT_MS,
      );
      tools = Array.isArray(listed?.tools) ? listed.tools : [];
    } catch (error) {
      // A server that will not list is a server whose tools this session does
      // not have. Say so once; never fail the session over it.
      console.error('[beeline] MCP server ' + server.name + ' did not list its tools:', error);
      continue;
    }
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string') continue;
      const schema =
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} };
      pi.registerTool({
        name: server.name + '__' + tool.name,
        label: labelOf(tool.name),
        description: typeof tool.description === 'string' ? tool.description : tool.name,
        parameters: schema,
        async execute(_toolCallId, params, signal) {
          const result = await callServer(
            server,
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: tool.name, arguments: params ?? {} },
            },
            signal,
          );
          // An MCP refusal is a RESULT carrying isError. Throwing is how a pi
          // tool reports failure, so the sentence explaining the refusal is
          // what the model reads.
          if (result?.isError) throw new Error(textOf(result));
          return { content: [{ type: 'text', text: textOf(result) }], details: {} };
        },
      });
    }
  }
}
`;
