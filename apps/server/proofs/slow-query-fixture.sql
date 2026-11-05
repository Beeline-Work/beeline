-- Synthetic loopback-only fixture; loaded into a fresh isolated schema by slow-query-workload.postgres.test.ts.
SET session_replication_role=replica; SET jit=off;
 INSERT INTO identities(id,kind,name,handle) VALUES('1111111111111111111111111111111111111111111111111111111111111111','human','Human','human'),('2222222222222222222222222222222222222222222222222222222222222222','agent','Worker','worker'),('3333333333333333333333333333333333333333333333333333333333333333','agent','Commander','commander') ON CONFLICT DO NOTHING;
 INSERT INTO agents(agent_id,owner_id) VALUES(repeat('2',64),repeat('1',64)),(repeat('3',64),repeat('1',64));
 INSERT INTO workspaces(id,name) VALUES('11111111-1111-4111-8111-111111111111','Production-shaped proof') ON CONFLICT DO NOTHING;
 INSERT INTO rooms(id,workspace_id,name,created_by,parent_id,archived_at,created_at)
 SELECT ('22222222-2222-4222-8222-'||lpad(n::text,12,'0'))::uuid,'11111111-1111-4111-8111-111111111111', 'Room '||n,'3333333333333333333333333333333333333333333333333333333333333333',
 CASE WHEN n>0 THEN '22222222-2222-4222-8222-000000000000'::uuid END,
 CASE WHEN n>20 THEN now() END,now()-interval '10 days' FROM generate_series(0,1894) n ON CONFLICT DO NOTHING;
 INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES('11111111-1111-4111-8111-111111111111',NULL,'1111111111111111111111111111111111111111111111111111111111111111','owner');
 INSERT INTO memberships(workspace_id,room_id,identity_id,role)
 SELECT '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-000000000000',id,'member' FROM identities WHERE id IN ('1111111111111111111111111111111111111111111111111111111111111111','2222222222222222222222222222222222222222222222222222222222222222','3333333333333333333333333333333333333333333333333333333333333333');
 INSERT INTO corner_facts(corner_id) SELECT id FROM rooms WHERE parent_id IS NOT NULL ON CONFLICT DO NOTHING;
 INSERT INTO corner_github_cache(corner_id,lifecycle) SELECT corner_id,'{"lifecycle":"unknown","checks":"success"}' FROM corner_facts ON CONFLICT DO NOTHING;
 INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,state,completed_at)
 SELECT 'assign-'||id,id,'2222222222222222222222222222222222222222222222222222222222222222','assign-'||id,'input','human_tag','assign-'||id,'assign-'||id,0,'complete',now() FROM rooms WHERE parent_id IS NOT NULL;
 INSERT INTO messages(id,room_id,author_id,text,created_at)
 SELECT md5('history-'||n)||md5('message-'||n),('22222222-2222-4222-8222-'||lpad((n%1895)::text,12,'0'))::uuid,CASE WHEN n%7=0 THEN '1111111111111111111111111111111111111111111111111111111111111111' ELSE '2222222222222222222222222222222222222222222222222222222222222222' END,
 CASE WHEN n%11=0 THEN '@human please review this?' ELSE 'Ordinary history' END,now()-interval '9 days'+n*interval '1 second' FROM generate_series(1,379000) n;
 INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id,created_at,ended_at)
 SELECT id,'turn-'||n,'2222222222222222222222222222222222222222222222222222222222222222','complete','gen-'||n,now()-interval '1 day'+n*interval '1 second',now()-interval '1 day'+n*interval '1 second'
 FROM rooms CROSS JOIN generate_series(1,10) n WHERE parent_id IS NOT NULL;
SET session_replication_role=replica; SET jit=off;
 INSERT INTO messages(id,room_id,author_id,text,created_at,card,request_id)
 SELECT md5('report-'||n)||md5('card-'||n),'22222222-2222-4222-8222-000000000000'::uuid,repeat('2',64),
 'blocked: please review this',now()-interval '2 hours'+n*interval '1 millisecond',
 jsonb_build_object('reportToId',repeat('3',64),'sourceRoomId',('22222222-2222-4222-8222-'||lpad((1+n%1894)::text,12,'0')),'waitingAnswered',true),NULL
 FROM generate_series(1,18940) n;
 INSERT INTO messages(id,room_id,author_id,text,created_at)
 SELECT md5('answer-'||n)||md5('reply-'||n),('22222222-2222-4222-8222-'||lpad((1+n%1894)::text,12,'0'))::uuid,repeat('3',64),
 'Proceed with the report',now()-interval '1 hour'+n*interval '1 millisecond' FROM generate_series(1,18940) n;
 SET session_replication_role=origin; ANALYZE;
INSERT INTO live_streams(id) VALUES('workspace:11111111-1111-4111-8111-111111111111'),
 ('room:22222222-2222-4222-8222-000000000000') ON CONFLICT DO NOTHING;
INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES(
 '22222222-2222-4222-8222-000000000000',repeat('2',64),'presence','presence','{"status":"online"}');
INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('slow-query-proof','Proof','[]');
INSERT INTO rooms_mcp_connections(client_id,identity_id,scope)
 VALUES('slow-query-proof',repeat('1',64),'rooms:read');
