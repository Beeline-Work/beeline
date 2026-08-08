/**
 * Protocol-layer MCP tool inventory.
 *
 * The ACP `session/new` response does not list tools. The real inventory is
 * whatever the mounted MCP servers advertise via MCP `tools/list`. For the
 * read-only boundary we assert:
 *   - readonly sessions mount **no** write MCP → inventory is empty
 *   - edit sessions mount buzz-dev-mcp → inventory includes shell / str_replace
 *
 * This helper speaks a minimal MCP-over-stdio client so tests assert at the
 * tool protocol layer, not by guessing from prompts.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface JsonRpcMsg {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  params?: unknown;
}

/**
 * Spawn an MCP server briefly, run initialize + tools/list, return tool names.
 * Kills the process when done.
 */
export async function listMcpToolNames(
  spec: McpServerSpec,
  timeoutMs = 15_000,
): Promise<string[]> {
  const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  const pending = new Map<
    number,
    { resolve: (v: JsonRpcMsg) => void; reject: (e: Error) => void }
  >();
  let nextId = 1;
  let settled = false;

  const cleanup = () => {
    if (settled) return;
    settled = true;
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };

  const deadline = setTimeout(() => {
    for (const [, p] of pending) p.reject(new Error('listMcpToolNames: timeout'));
    pending.clear();
    cleanup();
  }, timeoutMs);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMsg;
      try {
        msg = JSON.parse(line) as JsonRpcMsg;
      } catch {
        continue;
      }
      // Server requests (e.g. roots) — ignore / empty-result if they have ids.
      if (msg.method && msg.id !== undefined) {
        const reply = JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {},
        });
        child.stdin.write(reply + '\n');
        continue;
      }
      if (msg.id !== undefined && pending.has(Number(msg.id))) {
        const p = pending.get(Number(msg.id))!;
        pending.delete(Number(msg.id));
        if (msg.error) {
          p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          p.resolve(msg);
        }
      }
    }
  });

  child.on('error', (err) => {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  const request = (method: string, params: unknown): Promise<JsonRpcMsg> => {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(payload + '\n');
    });
  };

  const notify = (method: string, params: unknown) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'buzzy-body', version: '0.0.0' },
    });
    notify('notifications/initialized', {});
    const listed = await request('tools/list', {});
    const result = listed.result as { tools?: Array<{ name?: string }> } | undefined;
    const names = (result?.tools ?? [])
      .map((t) => t.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    return names;
  } finally {
    clearTimeout(deadline);
    cleanup();
  }
}

/**
 * Compute the effective tool inventory for an ACP session given the
 * mcpServers that were (or will be) mounted at session/new.
 *
 * - Empty mcpServers → [] (read-only boundary)
 * - Each stdio MCP is listed via tools/list
 */
export async function inventoryForMcpServers(
  servers: McpServerSpec[],
): Promise<string[]> {
  if (servers.length === 0) return [];
  const all: string[] = [];
  for (const s of servers) {
    const names = await listMcpToolNames(s);
    all.push(...names);
  }
  return all;
}

/** True if any write-class tool name appears in the inventory. */
export function hasWriteTools(
  toolNames: string[],
  writeNames: readonly string[] = ['shell', 'str_replace', 'write'],
): boolean {
  const lower = new Set(toolNames.map((n) => n.toLowerCase()));
  return writeNames.some((w) => lower.has(w.toLowerCase()));
}
