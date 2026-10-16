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
    {method:'tools/call',params:{name:'post_to_corner',arguments:{cornerId:'child',text:'note'}}},
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
  expect(tools.map((tool:{name:string})=>tool.name)).toContain('post_to_corner');
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties).toBeDefined();
  }
  for (const response of responses.filter(response => response.id!==0)) {
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/unknown|invalid|required|object/);
  }
},10_000);
