import http from 'node:http';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'beeline-claude-silent-proof-'));
console.log('Evidence directory: '+root);
const installation = process.argv[2];
if (!installation) throw new Error('Pass the installed claude-agent-acp package directory as the argument');
const executable = installation + '/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';
// Clear inherited routing and authentication before importing/spawning the SDK.
const systemPath = process.env.PATH;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {PATH:systemPath, LANG:'C.UTF-8', HOME:root+'/bootstrap'});
await fs.mkdir(process.env.HOME,{recursive:true});

const built = fileURLToPath(new URL('../apps/body/dist', import.meta.url));
const {sessionToolScopeMeta}=await import(built+'/harness-tool-scope.js');
const retrySentence = 'Your previous response had no visible output';
const results=[];
for (const mode of ['thinking-only','terminal-success','human-tool-refused','human-provider-error']) {
  const work = root+'/acp-beeline-'+mode;
  for (const sub of ['home','config','state','runtime','repo']) await fs.mkdir(work+'/'+sub,{recursive:true});
  await fs.writeFile(work+'/context.json',JSON.stringify({roomId:'proof',requestId:'proof',generationId:'proof',commandReason:mode==='human-tool-refused'?'human_tag':'report'}));
  const requests=[]; const frames=[]; let calls=0; let toolCalls=0;
  const server=http.createServer(async(req,res)=>{
    let raw=''; for await(const chunk of req) raw+=chunk;
    let body={}; try{body=JSON.parse(raw)}catch{}
    if(req.url.includes('count_tokens')) {res.setHeader('content-type','application/json'); res.end(JSON.stringify({input_tokens:100})); return;}
    if(!req.url.includes('/messages')) {res.setHeader('content-type','application/json');res.end('{}');return;}
    calls++;
    if(mode==='human-provider-error'){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'ISOLATED PROVIDER FAILURE'}}));return;}
    const retry=JSON.stringify(body.messages??[]).includes(retrySentence);
    requests.push({url:req.url,call:calls,retry,tools:(body.tools??[]).map(t=>t.name),
      messages:body.messages});
    const withTool=mode!=='thinking-only';
    const toolName=(body.tools??[]).find(t=>t.name.endsWith('no_reply_needed'))?.name;
    let block,stop;
    if(withTool&&calls===1) {block={type:'tool_use',id:'tool_proof_1',name:toolName??'missing_tool',input:{}};stop='tool_use';}
    else if(retry||calls>3) {block={type:'text',text:'VISIBLE RETRY PROOF'};stop='end_turn';}
    else {block={type:'thinking',thinking:'The worker report needs no response.',signature:'fake-local-signature'};stop='end_turn';}
    const message={id:'msg_proof_'+calls,type:'message',role:'assistant',model:body.model,content:[block],
      stop_reason:stop,stop_sequence:null,usage:{input_tokens:100,output_tokens:20}};
    if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(message));return;}
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    const event=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
    event('message_start',{message:{...message,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}});
    if(block.type==='thinking'){
      event('content_block_start',{index:0,content_block:{type:'thinking',thinking:'',signature:''}});
      event('content_block_delta',{index:0,delta:{type:'thinking_delta',thinking:block.thinking}});
      event('content_block_delta',{index:0,delta:{type:'signature_delta',signature:block.signature}});
    }else if(block.type==='tool_use'){
      event('content_block_start',{index:0,content_block:{...block,input:{}}});
      event('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:'{}'}});
    }else {
      event('content_block_start',{index:0,content_block:{type:'text',text:''}});
      event('content_block_delta',{index:0,delta:{type:'text_delta',text:block.text}});
    }
    event('content_block_stop',{index:0});
    event('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:20}});
    event('message_stop',{});res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  const name='mcp__beeline-agent__no_reply_needed';
  const env={PATH:systemPath,LANG:'C.UTF-8',HOME:work+'/home',
    XDG_CONFIG_HOME:work+'/config',XDG_STATE_HOME:work+'/state',XDG_RUNTIME_DIR:work+'/runtime',
    ANTHROPIC_BASE_URL:endpoint,ANTHROPIC_API_KEY:'fake-local-proof-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:'1',
    CLAUDE_CODE_TERMINAL_MCP_TOOLS:''};
  const stderr=[];
  const child=spawn(process.execPath,[installation+'/dist/index.js'],{cwd:work+'/repo',env:{...env,CLAUDE_CODE_EXECUTABLE:executable},stdio:['pipe','pipe','pipe']});
  const pending=new Map();let seq=0;
  child.stderr.on('data',chunk=>stderr.push(chunk.toString()));
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const timer=setTimeout(()=>{for(const p of pending.values())p.reject(new Error('ACP timeout'));child.kill('SIGTERM');},45000);
  const reader=readline.createInterface({input:child.stdout});
  reader.on('line',line=>{
    const msg=JSON.parse(line);
    if(msg.method&&'id' in msg){
      const result=msg.method==='session/request_permission'?{outcome:{outcome:'selected',optionId:msg.params.options.find(o=>o.kind==='allow_once')?.optionId??msg.params.options[0].optionId}}:{};
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\n');
    }else if(msg.method){frames.push(msg);if(msg.params?.update?.sessionUpdate==='tool_call_update'&&msg.params.update.status==='completed')toolCalls++;}
    else{const p=pending.get(msg.id);pending.delete(msg.id);if(msg.error)p?.reject(new Error(JSON.stringify(msg.error)));else p?.resolve(msg.result);}
  });
  try {
    await rpc('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'isolated-proof',version:'1.0.0'}});
    const session=await rpc('session/new',{cwd:work+'/repo',mcpServers:['terminal-success','human-tool-refused'].includes(mode)?[{name:'beeline-agent',command:process.execPath,args:[built+'/read-only-mcp.js'],env:[{name:'BEELINE_MCP_SURFACE',value:'agent'},{name:'BEELINE_TURN_CONTEXT_FILE',value:work+'/context.json'}]}]:[],
      _meta:{systemPrompt:'This is an isolated proof. Use only the local proof tool when supplied.',claudeCode:{options:{settingSources:[],settings:{},persistSession:false,model:'claude-sonnet-4-5',tools:[],thinking:{type:'enabled',budgetTokens:1024},allowedTools:[name],env:sessionToolScopeMeta('claude-agent-acp').claudeCode.options.env}}}});
    const result=await rpc('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:mode.startsWith('human-')?'Human request: answer this question.':'Nonhuman wake: worker report done. No human request pending. End silently.'}]});
    frames.push({type:'acp_result',result});
  }catch(error){frames.push({type:'probe_error',message:String(error)});}
  clearTimeout(timer);child.stdin.end();child.kill('SIGTERM');
  await new Promise(resolve=>child.once('close',resolve));reader.close();
  await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(work+'/observations.json',JSON.stringify({mode,requests,frames,toolCalls,stderr},null,2));
  const result=frames.find(f=>f.type==='acp_result');
  const visible=frames.filter(f=>f.params?.update?.sessionUpdate==='agent_message_chunk').map(f=>f.params.update.content?.text).filter(Boolean);
  const summary={mode,apiCalls:calls,toolCalls,retries:requests.filter(r=>r.retry).length,
    visible,result:result?.result??null,
    errors:frames.filter(f=>f.type==='probe_error')};
  results.push(summary);console.log(JSON.stringify(summary));
}
await fs.writeFile(root+'/acp-beeline-results.json',JSON.stringify(results,null,2));
const baseline=results.find(r=>r.mode==='thinking-only');
const silent=results.find(r=>r.mode==='terminal-success');
const refused=results.find(r=>r.mode==='human-tool-refused');
assert.equal(refused.retries,1);
assert.equal(refused.toolCalls,0);
const failure=results.find(r=>r.mode==='human-provider-error');
assert.equal(baseline.retries,1);
assert.ok(baseline.visible.includes('VISIBLE RETRY PROOF'));
assert.equal(silent.retries,0);
assert.equal(silent.toolCalls,1);
assert.deepEqual(silent.visible,[]);
assert.equal(silent.result.stopReason,'end_turn');
assert.equal(failure.errors.length,1);
assert.ok(failure.visible.some(text=>text.includes('ISOLATED PROVIDER FAILURE')));
console.log('PASS claude-native-thinking-only-20261013: built MCP terminal tool suppresses the internal retry and emits no text; human failure stays visible.');
