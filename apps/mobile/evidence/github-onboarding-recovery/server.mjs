// Local HTTP stand-in: the production PhoneService and migrations, with GitHub
// responses fixed to one already-installed organization. No production identities.
import http from 'node:http';
import {PgliteDatabase} from '../../../server/src/test-support.ts';
import {migrate} from '../../../server/src/database.ts';
import {PhoneService} from '../../../server/src/phone-service.ts';
import {postRepositoryOnboarding} from '../../../server/src/repository-onboarding.ts';
const db=new PgliteDatabase();await migrate(db);
const H='a'.repeat(64),A='c'.repeat(64),W='22222222-2222-4222-8222-222222222222',R='11111111-1111-4111-8111-111111111111';
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Proof user','proof'),($2,'agent','Jellybean','jellybean')`,[H,A]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof workspace')`,[W]);
await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'onboarding-proof',$3)`,[R,W,H]);
await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[A,H]);
for(const identity of [H,A])await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,[W,identity,R]);
await db.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,repository_selection,status) VALUES(174210678,$1,'proof-org','Organization','selected','active')`,[H]);
await db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,active) VALUES(43,174210678,'proof-org/onboarding-proof','main',true)`);
const github={refresh:async()=>({}),beginInstallation:async(_viewer,input)=>({url:'https://github.com/apps/beeline-app/installations/select_target?proof=1'}),onboardingSignals:async()=>({commits:[],failingChecks:[],issues:[],branches:[],files:[]})};
const phone=new PhoneService(db,'http://127.0.0.1:18767',github);
const card=await db.transaction(tx=>postRepositoryOnboarding(tx,github,{roomId:R,agentId:A,requesterId:H,kind:'repository'}));
const server=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');try{
 let result;if(req.method==='GET')result=await phone.readRoom(R,H);else{let body='';for await(const chunk of req)body+=chunk;const {name,input}=JSON.parse(body);result=await phone.execute(name,{...input,cardId:card.id},H);console.log(JSON.stringify({action:input.action,result}));}
 res.end(JSON.stringify(result));}catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}});
server.listen(18767,'0.0.0.0',()=>console.log('Proof service ready'));
