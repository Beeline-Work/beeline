import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { StdioSquireMcpClient } from './squire-mcp-client.js';

/** A fake Squire MCP child: newline JSON-RPC in, scripted newline JSON-RPC out. */
function fakeChild(handlers: Record<string, unknown>) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: (chunk: string) => boolean };
    stdout: EventEmitter & { setEncoding: (e: string) => void };
    stderr: EventEmitter & { setEncoding: (e: string) => void };
    kill: () => void;
    killed?: boolean;
  };
  const written: string[] = [];
  child.stdin = {
    write: (chunk: string) => {
      written.push(chunk);
      const message = JSON.parse(chunk) as { id?: number; method: string };
      if (message.id === undefined) return true;
      if (!(message.method in handlers)) return true; // stay pending
      const result = handlers[message.method];
      child.stdout.emit(
        'data',
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`,
      );
      return true;
    },
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.kill = () => {
    child.killed = true;
  };
  return { child, written };
}

describe('StdioSquireMcpClient', () => {
  it('initializes once, then answers each tool call with the parsed tool result', async () => {
    const calls: string[] = [];
    const { child } = fakeChild({
      initialize: {},
      'tools/call': { content: [{ type: 'text', text: 'ok' }] },
    });
    const client = new StdioSquireMcpClient({
      spawn: () => {
        calls.push('spawn');
        return child as never;
      },
    });
    const result = await client.call('ping');
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(calls).toEqual(['spawn']);
    await client.call('ping');
    expect(calls).toEqual(['spawn']); // session reused, not re-spawned
    client.close();
    expect(child.killed).toBe(true);
  });

  it('unwraps content[0].text JSON into the tool result object', async () => {
    const { child } = fakeChild({
      initialize: {},
    });
    const client = new StdioSquireMcpClient({
      spawn: () => {
        child.stdin.write = (chunk: string) => {
          const message = JSON.parse(chunk) as { id?: number; method: string; params?: any };
          if (message.id === undefined) return true;
          const result =
            message.method === 'initialize'
              ? {}
              : {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({ connections: [{ ref: 'cred_a' }] }),
                    },
                  ],
                };
          child.stdout.emit(
            'data',
            `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`,
          );
          return true;
        };
        return child as never;
      },
    });
    const result = (await client.call('list_credentials')) as { connections: unknown[] };
    expect(result.connections).toEqual([{ ref: 'cred_a' }]);
    client.close();
  });

  it('raises the tool error text when the server answers isError', async () => {
    const { child } = fakeChild({ initialize: {} });
    const client = new StdioSquireMcpClient({
      spawn: () => {
        child.stdin.write = (chunk: string) => {
          const message = JSON.parse(chunk) as { id?: number; method: string };
          if (message.id === undefined) return true;
          const result =
            message.method === 'initialize'
              ? {}
              : { isError: true, content: [{ type: 'text', text: 'vault locked' }] };
          child.stdout.emit(
            'data',
            `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`,
          );
          return true;
        };
        return child as never;
      },
    });
    await expect(client.call('list_credentials')).rejects.toThrow('list_credentials failed: vault locked');
    client.close();
  });

  it('rejects a pending call when the server process exits', async () => {
    const { child } = fakeChild({ initialize: {} });
    const client = new StdioSquireMcpClient({
      spawn: () => child as never,
    });
    const pending = client.call('list_credentials');
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    child.emit('exit', 1);
    await expect(pending).rejects.toThrow('Squire MCP server exited');
    client.close();
  });
});
