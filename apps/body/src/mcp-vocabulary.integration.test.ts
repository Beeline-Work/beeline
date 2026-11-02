import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('the MCP transport refuses retired tools, aliases and nonobject arguments before dispatch', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url))], {
    env: { ...process.env, BEELINE_MCP_SURFACE:'agent', BEELINE_TURN_CONTEXT_FILE:'', BEELINE_NATIVE_IO_PROVEN:'1' },
    stdio:['pipe','pipe','pipe'],
  });
  const requests = [
    {method:'tools/list'},
    ...['list_rooms','set_avatar','execute_app_tool','save_skill','watch','wallet_address'].map(name => ({method:'tools/call',params:{name,arguments:{}}})),
    {method:'tools/call',params:{name:'post',arguments:{cornerId:'child',text:'note'}}},
    {method:'tools/call',params:{name:'connect',arguments:[]}},
    {method:'tools/call',params:{name:'app_tool',arguments:{appId:'legacy'}}},
  ];
  let output = '', stderr = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdin.end(requests.map((request,index) => JSON.stringify({jsonrpc:'2.0',id:index,...request})).join('\n')+'\n');
  const code = await new Promise<number|null>((resolve,reject) => { child.on('error',reject); child.on('close',resolve); });
  expect(code,stderr).toBe(0);
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  expect(responses).toHaveLength(requests.length);
  const tools = responses.find(response => response.id===0).result.tools;
  expect(tools.map((tool:{name:string})=>tool.name)).toContain('post');
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties).toBeDefined();
  }
  for (const response of responses.filter(response => response.id!==0)) {
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/unknown|invalid|required|object/);
  }
},10_000);


it.each(['schema', 'daemon'] as const)('C7 helper %s refusal retains isError, refusal text and authenticated owed tags', async path => {
  const owedMentions = [{ roomId: 'room', messageId: 'message', memberId: 'member' }];
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url!);
    expect(request.headers.authorization).toBe('Bearer fixture-token');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/daemon/owed-mentions') response.end(JSON.stringify({ owedMentions }));
    else { response.statusCode = 403; response.end(JSON.stringify({ error: 'fixture_refusal' })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url))], {
      env: { ...process.env, BEELINE_MCP_SURFACE: 'agent', BEELINE_TURN_CONTEXT_FILE: '', BEELINE_NATIVE_IO_PROVEN: '1',
        BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, BEELINE_DAEMON_TOKEN: 'fixture-token', BEELINE_DAEMON_ROOM_ID: 'room' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', stderr = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: path === 'schema'
      ? { name: 'post', arguments: { text: '' } } : { name: 'read', arguments: { facet: 'addresses' } } }) + '\n');
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    expect(code, stderr).toBe(0);
    const result = JSON.parse(output).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(path === 'schema' ? /invalid|required|empty|length/ : /403: fixture_refusal/);
    expect(JSON.parse(result.content[1].text)).toEqual({ owedMentions });
    expect(calls).toEqual(path === 'schema' ? ['/v1/daemon/owed-mentions'] : ['/v1/daemon/operations/listRooms', '/v1/daemon/owed-mentions']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 10_000);
