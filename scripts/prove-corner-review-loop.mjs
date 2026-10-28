// Isolated built-service proof: synthetic database and provider responses only.
import assert from 'node:assert/strict';
const root=process.cwd();
const mod=path=>import(`${root}/${path}`);
const {PgliteDatabase}=await mod('apps/server/src/test-support.ts');
const {migrate}=await mod('apps/server/dist/database.js');
const {DaemonService}=await mod('apps/server/dist/daemon-service.js');
const {LiveHub}=await mod('apps/server/dist/live.js');
const {TokenAuth,tokenHash}=await mod('apps/server/dist/auth.js');
const {PhoneService}=await mod('apps/server/dist/phone-service.js');
const {createBeelineServer}=await mod('apps/server/dist/server.js');
const {systemLine}=await mod('apps/server/dist/system-line.js');
const {createAgentCommand,reconcileConfiguredCornerReviewers}=await mod('apps/server/dist/agent-command.js');
const {refreshCornerAttention}=await mod('apps/server/dist/corner-attention.js');
const {GitHubOperations}=await mod('apps/server/dist/github-operations.js');
const db=new PgliteDatabase();
const human='a'.repeat(64),worker='b'.repeat(64),reviewer='c'.repeat(64),head='d'.repeat(40),commander='e'.repeat(64);
const workspace='11111111-1111-4111-8111-111111111111',parent='22222222-2222-4222-8222-222222222222',corner='33333333-3333-4333-8333-333333333333';
let server;
try {
 await migrate(db);
 await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker'),($3,'agent','Reviewer','reviewer'),($4,'agent','Commander','commander')`,[human,worker,reviewer,commander]);
 await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3),($4,$3)`,[worker,reviewer,human,commander]);
 await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`,[workspace]);
 await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')`,[human]);
 await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','main')`);
 await db.query(`INSERT INTO rooms(id,workspace_id,name,repository_key,repository_resolution,github_installation_id,reviewer_agent_id) VALUES($1,$2,'Parent','owner/widgets','repository',77,$3)`,[parent,workspace,reviewer]);
 await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`,[corner,workspace,parent,commander]);
 for(const who of [human,worker,reviewer,commander]) for(const place of [null,parent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,[workspace,place,who]);
 await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,worker_agent_id,lifecycle) VALUES($1,$2,$2,$3::jsonb)`,[corner,worker,JSON.stringify({checks:'passing',lifecycle:'in-review',pr:{number:1,headSha:head,url:'https://github.com/owner/widgets/pull/1'}})]);
 const opening=await createAgentCommand(db,{id:'proof-opening',roomId:corner,agentId:worker,sourceMessageId:null,reason:'order',
  privatePayload:{kind:'order',text:'Implement the agreed change.',authorId:commander,fromRoomId:parent}});
 await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`,[opening.id]);
 await db.query(`DELETE FROM agent_turns WHERE room_id=$1 AND request_id=$2`,[corner,opening.turn_request_id]);
 const operations=new GitHubOperations(db,{}, {
  installationToken:async()=>({token:'fixture',expiresAt:'2030-01-01T00:00:00Z'}),
  readPullRequest:async()=>({number:1,headSha:head,url:'https://github.com/owner/widgets/pull/1',merged:false}),
  readCommitCheckRollup:async()=>({state:'passed',total:1,checks:[],failing:[]}),
 },'fixture');
 const live=new LiveHub();
 const daemon=new DaemonService(db,live,undefined,undefined,false,undefined,false,undefined,input=>operations.prChecksStatus(input));
 daemon.github={assertCornerReviewerNotAuthor:async()=>{}};
 daemon.warmConnectorIndex=async()=>{};
 for(const who of [worker,reviewer]) await db.query(`INSERT INTO daemon_tokens(token_hash,agent_id) VALUES($1,$2)`,[tokenHash(`bdt_proof_${who}`),who]);
 server=createBeelineServer({database:db,daemon,live,auth:new TokenAuth(db,async()=>{throw Error('unused')}),phone:new PhoneService(db,'http://test'),mediaMaximumBytes:1});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 async function call(operation,input,who=reviewer){
  const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/${operation}`,{method:'POST',headers:{authorization:`Bearer bdt_proof_${who}`,'content-type':'application/json'},body:JSON.stringify(input)});
  return {status:response.status,body:await response.json()};
 }
 await systemLine(db,{roomId:corner,authorId:human,subject:{kind:'github',name:'GitHub'},verb:'passed a check',kind:'check-passed'});
 let pending=await call('getAgentCommands',{roomId:corner});
 assert.equal(pending.body.commands.length,1);
 // A queued reviewer is still waiting after the pending-turn activity grace ends.
 await db.query(`UPDATE agent_turns SET created_at=now()-interval '2 minutes' WHERE room_id=$1`,[corner]);
 await db.query(`UPDATE corner_attention_spans SET last_turn_ended_at=NULL WHERE corner_id=$1`,[corner]);
 await refreshCornerAttention(db,corner);
 assert.equal((await db.query(`SELECT count(*)::int count FROM agent_commands WHERE private_payload->>'text' LIKE '%is idle.%'`)).rows[0].count,0);
 const first=pending.body.commands[0];
 async function claim(command,generationId,who=reviewer){
  assert.equal((await call('claimAgentCommand',{roomId:corner,commandId:command.id,generationId},who)).status,200);
  assert.equal((await call('postAgentTurnReceipt',{roomId:corner,requestId:command.turnRequestId,generationId,status:'working'},who)).status,200);
 }
 await claim(first,'empty');
 assert.equal((await call('postAgentTurnReceipt',{roomId:corner,requestId:first.turnRequestId,generationId:'empty',status:'complete'})).status,200);
 const tagTurn=await createAgentCommand(db,{id:'proof-tag',roomId:corner,agentId:worker,sourceMessageId:null,reason:'corner_review_needed'});
 await claim({id:tagTurn.id,turnRequestId:tagTurn.turn_request_id},'tag',worker);
 assert.equal((await call('postRoomMessage',{roomId:corner,requestId:tagTurn.turn_request_id,generationId:'tag',text:'@reviewer please review this head.'},worker)).status,200);
 const tagged=await call('getAgentCommands',{roomId:corner});
 assert.equal(tagged.body.commands.length,1);
 assert.equal(tagged.body.commands[0].reason,'agent_tag');
 await claim(tagged.body.commands[0],'tagged-review');
 assert.equal((await call('postAgentTurnReceipt',{roomId:corner,requestId:tagged.body.commands[0].turnRequestId,generationId:'tagged-review',status:'complete'})).status,200);
 await reconcileConfiguredCornerReviewers(db,parent);
 pending=await call('getAgentCommands',{roomId:corner});
 assert.equal(pending.body.commands.length,1);
 assert.match(pending.body.commands[0].source.body,/without a verdict/);
 const retry=pending.body.commands[0];
 await claim(retry,'verdict');
 assert.equal((await call('approveCornerMerge',{cornerId:corner,headSha:head})).body.status,'approved');
 assert.equal((await call('postRoomMessage',{roomId:corner,requestId:retry.turnRequestId,generationId:'verdict',text:'PASS: no blockers; screenshots attached here.'})).status,200);
 const refused=await call('approveCornerMerge',{cornerId:corner,headSha:head});
 assert.equal(refused.status,409);
 assert.match(JSON.stringify(refused.body),/missing review attachments/);
 const checks=await call('getPrChecksStatus',{cornerId:corner});
 assert.equal(checks.status,200);
 assert.equal(checks.body.mergeAllowed,false);
 assert.match(checks.body.blockedReason,/missing review attachments/);
 console.log('Reproduction REVIEW-LOOP: built HTTP service delivers a member tag and then a replacement review after empty completions; queued review emits no idle alert; missing screenshot PASS returns HTTP 409; live checks refuse landing with the missing-attachment reason.');
} finally {
 if(server) await new Promise(resolve=>server.close(resolve));
 await db.close();
}
