/** SHELL-CAP: installed Codex against a local recorded Responses provider. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AcpClient } from '../apps/body/dist/acp.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const out = resolve(process.argv[2] ?? '.scratch/codex-shell-cap');
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), 'beeline-codex-model-'));
const hook = join(home, 'beeline-shell-output.cjs');
const { NATIVE_SHELL_OUTPUT_SCRIPT, nativeShellHookConfig, nativeShellHookCommand, NATIVE_SHELL_OUTPUT_CAP } = await import('../apps/body/dist/native-shell-output.js');
await writeFile(hook, NATIVE_SHELL_OUTPUT_SCRIPT);

let count = 0;
const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("HEAD\\n"+"x".repeat(400000)+"\\nTAIL\\n")'`;
const server = createServer(async(req,res)=>{
 let raw='';for await(const b of req)raw+=b;
 if(!req.url.includes('responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
 const body=JSON.parse(raw);await writeFile(join(out, `request-${++count}.json`),JSON.stringify(body,null,2));
 const use=count===1;
 const item=use?{id:'fc_proof',type:'function_call',call_id:'call_proof',name:'exec_command',arguments:JSON.stringify({cmd:command,max_output_tokens:200000})}:{id:'msg_proof',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Proof complete.',annotations:[]}]};
 res.writeHead(200,{'content-type':'text/event-stream'});
 const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
 const response={id:'resp_'+count,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:body.model,output:[]};
 event('response.created',{response});event('response.output_item.added',{output_index:0,item});
 if(use)event('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments});
 else {event('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});event('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'Proof complete.'});event('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:'Proof complete.'});event('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});}
 event('response.output_item.done',{output_index:0,item});event('response.completed',{response:{...response,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
try {
 const config = { model: 'gpt-6', model_provider: 'proof',
   model_providers: { proof: { name: 'Recorded proof', base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses' } },
   features: { code_mode: false },
   ...nativeShellHookConfig(nativeShellHookCommand(hook, 'codex'), 'PreToolUse') };
 const client = new AcpClient({ agentCommand: 'codex-acp', agentLabel: 'codex-acp', resourceScope: 'none',
   agentEnv: { ...process.env, HOME: home, CODEX_HOME: home, OPENAI_API_KEY: 'local-recorded-provider', DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key' }), MODEL_PROVIDER: 'proof', CODEX_CONFIG: JSON.stringify(config),
     BEELINE_CODEX_SHELL_HOOK_COMMAND: nativeShellHookCommand(hook, 'codex') } });
 try {
   await client.start();
   const { sessionId } = await client.sessionNew({ cwd: home, mode: 'edit' });
   await client.sessionPrompt(sessionId, 'Run the supplied shell command once.', 45000);
 } finally { await client.stop(); }
 const request=JSON.parse(await readFile(join(out,'request-2.json'),'utf8'));
 const text=request.input.find(item=>item.type==='function_call_output')?.output;
 assert.ok(text,'No native tool result reached the model');
 const file=/full output: (.*?)\. Read a bounded/.exec(text)?.[1]; assert.ok(file,text.slice(0,500));
 const original=await readFile(file,'utf8');
 assert.equal(original,'HEAD\n'+'x'.repeat(400000)+'\nTAIL\n');
 assert.ok(Buffer.byteLength(text)<=NATIVE_SHELL_OUTPUT_CAP);
 const proof={reproduction:'SHELL-CAP',harness:'Codex',provider:'local recorded model; installed Codex through the built ACP client and scoped hook trust',originalBytes:Buffer.byteLength(original),modelBytes:Buffer.byteLength(text),capBytes:NATIVE_SHELL_OUTPUT_CAP,recovered:true};
 await writeFile(join(out,'codex.json'),JSON.stringify(proof,null,2)); console.log(JSON.stringify(proof));

}finally{await new Promise(done=>server.close(done));await rm(home,{recursive:true,force:true});}
