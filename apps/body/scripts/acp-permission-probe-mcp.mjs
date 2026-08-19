/**
 * Stub stdio MCP server standing in for `buzz-readonly-mcp`: the same six tool
 * names, no behaviour. Mounted by `capture-acp-permissions.mjs` so a real ACP
 * adapter emits a real MCP permission request without running the actual
 * inspection server.
 */
import { createInterface } from 'node:readline';
const TOOLS = [
  { name: 'list_files', description: 'List files', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search_text', description: 'Search literal text', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'git_log', description: 'Local git log', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'git_show', description: 'Show a revision', inputSchema: { type: 'object', properties: { revision: { type: 'string' } } } },
  { name: 'git_diff', description: 'Diff revisions', inputSchema: { type: 'object', properties: { revision: { type: 'string' } } } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'buzz-readonly-mcp', version: '0.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'stub output' }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
