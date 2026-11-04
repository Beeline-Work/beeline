import {createHash} from 'node:crypto';
import {TRAY_CLOCK_HEALTH_SCHEMA,TRAY_CLOCK_HEALTH_PREDICATE_SQL,TRAY_CLOCK_HEALTH_OWNER_TRIGGER} from './tray-clock-health.js';
import type {SqlDatabase} from './database.js';

export {readTrayClockBasisCause,type TrayClockBasisCause} from './tray-clock-protocol.js';

const WORKSPACE_BIRTH=`CREATE TRIGGER beeline_tray_clock_workspace_birth AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION beeline_tray_clock_workspace_birth();`;
/** Embedded after clock tables and the existing control notifier. All source
 * routines remain uninstalled/unselected in production until root's migration
 * floor and rollout proofs pass. No per-reader migration state exists. */
export const TRAY_CLOCK_READINESS_SCHEMA=`
${TRAY_CLOCK_HEALTH_SCHEMA}
CREATE TABLE IF NOT EXISTS tray_clock_readiness_floor(
 id integer PRIMARY KEY CHECK(id=1),contract_digest text NOT NULL,fingerprint text NOT NULL,
 seed_cursor uuid,seeding_done boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS tray_clock_readiness(
 workspace_id uuid PRIMARY KEY,generation text NOT NULL CHECK(generation~'^[a-f0-9]{32}$'),
 phase text NOT NULL DEFAULT 'sources' CHECK(phase IN('sources','messages','seen','choices','publish','done')),
 cursor_one text,cursor_two text,cursor_three text,bounded boolean NOT NULL DEFAULT false,bound_one text,bound_two text,bound_three text,fingerprint text,
 room_bounded boolean NOT NULL DEFAULT false,room_cursor uuid,room_bound uuid,current_room uuid,
 message_bounded boolean NOT NULL DEFAULT false,message_cursor text,message_bound text,current_message text,
 source_epoch text,source_through bigint,workspace_epoch text,workspace_through bigint
);
ALTER TABLE tray_clock_readiness ADD COLUMN IF NOT EXISTS room_bounded boolean NOT NULL DEFAULT false;
ALTER TABLE tray_clock_readiness ADD COLUMN IF NOT EXISTS room_cursor uuid;
ALTER TABLE tray_clock_readiness ADD COLUMN IF NOT EXISTS room_bound uuid;
ALTER TABLE tray_clock_readiness ADD COLUMN IF NOT EXISTS current_room uuid;
ALTER TABLE tray_clock_readiness ADD COLUMN IF NOT EXISTS message_bounded boolean NOT NULL DEFAULT false;
ALTER TABLE tray_clock_readiness ADD COLUMN IF NOT EXISTS message_cursor text;
ALTER TABLE tray_clock_readiness ADD COLUMN IF NOT EXISTS message_bound text;
ALTER TABLE tray_clock_readiness ADD COLUMN IF NOT EXISTS current_message text;
CREATE INDEX IF NOT EXISTS tray_clock_readiness_pending_idx ON tray_clock_readiness(workspace_id) WHERE phase<>'done';
CREATE INDEX IF NOT EXISTS tray_clock_readiness_source_idx ON tray_clock_deadlines(workspace_id,source_kind,source_id,reader_id);
CREATE INDEX IF NOT EXISTS tray_clock_readiness_rooms_idx ON rooms(workspace_id,id);
CREATE INDEX IF NOT EXISTS tray_clock_readiness_messages_idx ON messages(room_id,id);
CREATE INDEX IF NOT EXISTS tray_clock_readiness_marks_idx ON needs_you_marks(message_id,identity_id);
CREATE INDEX IF NOT EXISTS tray_clock_readiness_choices_idx ON room_choices(room_id,id);

CREATE OR REPLACE FUNCTION beeline_tray_clock_lock_workspaces(target_workspaces uuid[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF cardinality(target_workspaces)>101 THEN RAISE EXCEPTION 'Unbounded Tray clock Workspace locks';END IF;
 FOR target IN SELECT DISTINCT value FROM unnest(target_workspaces)value WHERE value IS NOT NULL ORDER BY value LOOP
  INSERT INTO live_streams(id) VALUES('workspace:'||target) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM live_streams WHERE id='workspace:'||target FOR UPDATE;
 END LOOP;
END;
$$;
CREATE OR REPLACE FUNCTION beeline_tray_clock_publish_basis(target_workspace uuid,readiness_change boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE basis tray_clock_state%ROWTYPE;
BEGIN
 SELECT * INTO basis FROM tray_clock_state WHERE workspace_id=target_workspace;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tray clock basis missing' USING ERRCODE='23514';END IF;
 PERFORM beeline_journal('workspace:'||target_workspace,jsonb_build_object(
  'sourceTable',CASE WHEN readiness_change THEN 'tray-clock-readiness' ELSE 'tray-clock-basis' END,'version',1,
  'trayWorkspaceId',target_workspace,'generation',basis.generation,'revision',basis.revision::text,'ready',basis.ready));
 PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation','UPDATE','roomId','',
  'journalStreams',jsonb_build_array('workspace:'||target_workspace))::text);
END;
$$;
CREATE OR REPLACE FUNCTION beeline_tray_clock_readiness_wake(target_workspace uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE progress tray_clock_readiness%ROWTYPE;
BEGIN
 SELECT * INTO progress FROM tray_clock_readiness WHERE workspace_id=target_workspace;
 IF NOT FOUND THEN RETURN;END IF;
 PERFORM beeline_journal('jobs:tray-clock-readiness',jsonb_build_object('sourceTable','tray-clock-readiness-work','version',1,
  'workspaceId',target_workspace,'generation',progress.generation,'phase',progress.phase));
 PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation','UPDATE','roomId','',
  'journalStreams',jsonb_build_array('jobs:tray-clock-readiness'))::text);
END;
$$;
CREATE OR REPLACE FUNCTION beeline_tray_clock_require_readiness(target_workspaces uuid[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE target uuid;next_generation text;
BEGIN
 IF cardinality(target_workspaces)>2 THEN RAISE EXCEPTION 'Unbounded Tray clock readiness invalidation';END IF;
 -- Every canonical scope before progress/state and the migration job stream.
 PERFORM beeline_tray_clock_lock_workspaces(target_workspaces);
 FOR target IN SELECT DISTINCT value FROM unnest(target_workspaces)value WHERE value IS NOT NULL ORDER BY value LOOP
  next_generation:=md5(random()::text||clock_timestamp()::text);
  INSERT INTO tray_clock_readiness(workspace_id,generation) VALUES(target,next_generation)
  ON CONFLICT(workspace_id) DO UPDATE SET generation=EXCLUDED.generation,phase='sources',
   cursor_one=NULL,cursor_two=NULL,cursor_three=NULL,bounded=false,bound_one=NULL,bound_two=NULL,bound_three=NULL,
   room_bounded=false,room_cursor=NULL,room_bound=NULL,current_room=NULL,
   message_bounded=false,message_cursor=NULL,message_bound=NULL,current_message=NULL,
   fingerprint=NULL,source_epoch=NULL,source_through=NULL,workspace_epoch=NULL,workspace_through=NULL;
  INSERT INTO tray_clock_state(workspace_id,generation,ready) VALUES(target,next_generation,false)
  ON CONFLICT(workspace_id) DO UPDATE SET generation=EXCLUDED.generation,revision=tray_clock_state.revision+1,ready=false;
  PERFORM beeline_tray_clock_publish_basis(target,true);
 END LOOP;
 FOR target IN SELECT DISTINCT value FROM unnest(target_workspaces)value WHERE value IS NOT NULL ORDER BY value LOOP
  PERFORM beeline_tray_clock_readiness_wake(target);
 END LOOP;
END;
$$;
CREATE OR REPLACE FUNCTION beeline_tray_clock_workspace_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM beeline_tray_clock_require_readiness(ARRAY[NEW.id]);RETURN NEW;
END;
$$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
   WHERE namespace.nspname=current_schema() AND relation.relname='workspaces' AND relation.relkind IN('r','p')) THEN
  EXECUTE 'DROP TRIGGER IF EXISTS beeline_tray_clock_workspace_birth ON workspaces';
  EXECUTE '${WORKSPACE_BIRTH.replaceAll("'","''")}';
 END IF;
END $$;
`;

type Phase='sources'|'messages'|'seen'|'choices'|'publish'|'done';
type Progress={workspace_id:string;generation:string;phase:Phase;cursor_one:string|null;cursor_two:string|null;cursor_three:string|null;
  bounded:boolean;bound_one:string|null;bound_two:string|null;bound_three:string|null;fingerprint:string|null;
  room_bounded:boolean;room_cursor:string|null;room_bound:string|null;current_room:string|null;
  message_bounded:boolean;message_cursor:string|null;message_bound:string|null;current_message:string|null};
type Key={kind:'message'|'seen'|'choice';source_id:string;reader_id:string};
const PHASES:readonly Phase[]=['sources','messages','seen','choices','publish','done'];
export class TrayClockReadinessUnavailable extends Error{}

/** Canonical catalog descriptors include parsed trigger guards. The initial
 * audit creates/drops an uncommitted reference trigger from trusted source SQL
 * so PostgreSQL, rather than a hand-written expression reducer, compares WHEN
 * semantics/columns/events. Subsequent batches only compare this fingerprint. */
const DESCRIPTORS=`SELECT jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',p.proargtypes::text,'body',p.prosrc) ORDER BY p.proname,p.proargtypes::text)
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname=current_schema() AND p.proname LIKE 'beeline_tray_clock_%'),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'table',c.relname,'enabled',t.tgenabled,'type',t.tgtype,
  'attrs',t.tgattr::text,'args',encode(t.tgargs,'hex'),'function',p.proname,'functionId',t.tgfoid::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname)
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE ns.nspname=current_schema() AND NOT t.tgisinternal AND t.tgname LIKE 'beeline_tray_clock_%'),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'valid',i.indisvalid,'ready',i.indisready,'definition',pg_get_indexdef(c.oid)) ORDER BY c.relname)
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname=current_schema() AND c.relname IN('tray_clock_readiness_rooms_idx','tray_clock_readiness_messages_idx',
    'tray_clock_readiness_marks_idx','tray_clock_readiness_choices_idx','tray_clock_readiness_source_idx','tray_clock_readiness_pending_idx','tray_clock_workspace_due_idx'))
) value`;
const fingerprint=async(db:SqlDatabase)=>(await db.query<{fingerprint:string}>(`SELECT md5(value::text) fingerprint FROM(${DESCRIPTORS}) observed`)).rows[0]!.fingerprint;

/** Trusted expression for a query with tray_clock_state aliased as `clock`.
 * It is pure SQL: compose into the caller's existing SELECT, never issue a
 * preliminary check or repair. Keep the actual catalog comparison until a
 * permitted-migrator/rollback floor can make persisted-only evidence sound.
 * No reader can supply SQL, a capture fingerprint, or readiness permission. */
export const TRAY_CLOCK_READINESS_PREDICATE_SQL=`COALESCE(clock.ready AND EXISTS(
  SELECT 1 FROM tray_clock_readiness clock_progress
  JOIN tray_clock_readiness_floor clock_floor ON clock_floor.id=1
  CROSS JOIN(SELECT md5(value::text) fingerprint FROM(${DESCRIPTORS}) clock_descriptors) clock_observed
  WHERE clock_progress.workspace_id=clock.workspace_id AND clock_progress.phase='done'
    AND clock_progress.generation=clock.generation AND clock_floor.seeding_done
    AND clock_progress.fingerprint=clock_floor.fingerprint
    AND clock_floor.fingerprint=clock_observed.fingerprint
),false)`;

/** Read admission requires both complete capture and current drained owner. */
export const TRAY_CLOCK_READ_PREDICATE_SQL=`(${TRAY_CLOCK_READINESS_PREDICATE_SQL}) AND (${TRAY_CLOCK_HEALTH_PREDICATE_SQL})`;

/** Trusted lifecycle owner only. No route/read accessor invokes this class.
 * Each call processes <=100 existing keys under one real transaction; failure
 * leaves durable pending work, not a timer, Retry-After or synthetic deadline. */
export class TrayClockReadiness{
  constructor(private readonly database:SqlDatabase){}

  async initialize():Promise<void>{
    // Deliberately lazy: the source schema embeds the dependency-free SQL
    // constant above. No top-level read/import cycle observes an uninitialized
    // source export, and no untrusted schema text is accepted by the API.
    const {TRAY_CLOCK_SOURCE_SCHEMA:schema}=await import('./tray-clock-source.js');
    const contract=createHash('sha256').update(schema).digest('hex');
    await this.database.transaction(async db=>{
      await db.query('LOCK TABLE rooms,messages,needs_you_marks,room_choices,workspaces IN SHARE ROW EXCLUSIVE MODE NOWAIT');
      const old=(await db.query<{contract_digest:string;fingerprint:string}>(`SELECT contract_digest,fingerprint FROM tray_clock_readiness_floor WHERE id=1 FOR UPDATE`)).rows[0];
      if(old){if(old.contract_digest!==contract||old.fingerprint!==await fingerprint(db))throw new TrayClockReadinessUnavailable('Tray capture floor changed');return;}
      const functions=[...schema.matchAll(/CREATE OR REPLACE FUNCTION\s+(beeline_tray_clock_\w+)\s*\([\s\S]*?\)\s*RETURNS\b[\s\S]*?\$\$([\s\S]*?)\$\$/g)];
      const actual=(await db.query<{name:string;body:string}>(`SELECT p.proname name,p.prosrc body FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE ns.nspname=current_schema() AND p.proname LIKE 'beeline_tray_clock_%'`)).rows;
      if(functions.length!==actual.length||functions.some(match=>actual.filter(fn=>fn.name===match[1]&&fn.body===match[2]).length!==1))
        throw new TrayClockReadinessUnavailable('Tray capture functions differ from installed source');
      const triggers=[...schema.matchAll(/^CREATE TRIGGER\s+(beeline_tray_clock_\w+)\s+([\s\S]*?);/gm)].map(match=>({name:match[1]!,sql:match[0]}));
      triggers.push({name:'beeline_tray_clock_workspace_birth',sql:WORKSPACE_BIRTH},
        {name:'beeline_tray_clock_health_owner',sql:TRAY_CLOCK_HEALTH_OWNER_TRIGGER});
      for(const trigger of triggers){
        const table=/\bON\s+(messages|needs_you_marks|room_choices|rooms|workspaces|tray_clock_health|background_leader_owners)\b/.exec(trigger.sql)?.[1];
        if(!table)throw new TrayClockReadinessUnavailable('Unknown Tray source table');
        const probe='beeline_tray_clock_readiness_probe';
        // These control triggers have no column list/WHEN guard. Parse their
        // reference on a schema clone: DROP TRIGGER on the live health table
        // would hold ACCESS EXCLUSIVE and block remote pure health reads.
        const detached=table==='tray_clock_health'||table==='background_leader_owners';
        const referenceTable=detached?'pg_temp.beeline_tray_clock_control_probe':table;
        if(detached)await db.query(`CREATE TEMP TABLE ${referenceTable} (LIKE ${table}) ON COMMIT DROP`);
        await db.query(trigger.sql.replace(`CREATE TRIGGER ${trigger.name}`,`CREATE TRIGGER ${probe}`).replace(` ON ${table} `,` ON ${referenceTable} `));
        const rows=(await db.query<{name:string;enabled:string;descriptor:unknown}>(`SELECT t.tgname name,t.tgenabled enabled,
          jsonb_build_object('type',t.tgtype,'attrs',t.tgattr::text,'args',encode(t.tgargs,'hex'),'function',t.tgfoid::text,
            'definition',regexp_replace(regexp_replace(pg_get_triggerdef(t.oid),'^CREATE TRIGGER [^ ]+ ','CREATE TRIGGER @ '),' ON [^ ]+ ',' ON @ '),
            'constraint',t.tgconstraint::text,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred) descriptor
          FROM pg_trigger t WHERE (t.tgrelid=$1::regclass AND t.tgname=$2) OR (t.tgrelid=$3::regclass AND t.tgname=$4)`,
          [table,trigger.name,referenceTable,probe])).rows;
        const installed=rows.find(row=>row.name===trigger.name),reference=rows.find(row=>row.name===probe);
        await db.query(`DROP TRIGGER ${probe} ON ${referenceTable}`);
        if(detached)await db.query(`DROP TABLE ${referenceTable}`);
        if(!installed||!['O','A'].includes(installed.enabled)||JSON.stringify(installed.descriptor)!==JSON.stringify(reference?.descriptor))
          throw new TrayClockReadinessUnavailable('Tray capture trigger differs from installed source');
      }
      const indexes:Array<{name:string;table:string;columns:string[];predicate?:string}>=[
        {name:'tray_clock_workspace_due_idx',table:'tray_clock_deadlines',columns:['workspace_id','due_at','id'],predicate:"(state = 'pending'::text)"},
        {name:'tray_clock_readiness_rooms_idx',table:'rooms',columns:['workspace_id','id']},
        {name:'tray_clock_readiness_messages_idx',table:'messages',columns:['room_id','id']},
        {name:'tray_clock_readiness_marks_idx',table:'needs_you_marks',columns:['message_id','identity_id']},
        {name:'tray_clock_readiness_choices_idx',table:'room_choices',columns:['room_id','id']},
        {name:'tray_clock_readiness_source_idx',table:'tray_clock_deadlines',columns:['workspace_id','source_kind','source_id','reader_id']},
        {name:'tray_clock_readiness_pending_idx',table:'tray_clock_readiness',columns:['workspace_id'],predicate:"(phase <> 'done'::text)"},
      ];
      const installed=(await db.query<{name:string;table_name:string;key_columns:string[];predicate:string|null;usable:boolean}>(`SELECT index_class.relname name,table_class.relname table_name,
        ARRAY(SELECT attribute.attname::text FROM unnest(idx.indkey::smallint[]) WITH ORDINALITY slot(attnum,ordinal)
          JOIN pg_attribute attribute ON attribute.attrelid=idx.indrelid AND attribute.attnum=slot.attnum ORDER BY slot.ordinal) key_columns,
        pg_get_expr(idx.indpred,idx.indrelid) predicate,
        (idx.indisvalid AND idx.indisready AND NOT idx.indisunique AND idx.indnatts=idx.indnkeyatts
          AND idx.indexprs IS NULL AND method.amname='btree'
          AND NOT EXISTS(SELECT 1 FROM unnest(idx.indclass::oid[]) opclass(oid) JOIN pg_opclass op ON op.oid=opclass.oid WHERE NOT op.opcdefault)
          AND NOT EXISTS(SELECT 1 FROM unnest(idx.indcollation::oid[]) WITH ORDINALITY coll(oid,ordinal)
            JOIN unnest(idx.indkey::smallint[]) WITH ORDINALITY slot(attnum,ordinal) ON slot.ordinal=coll.ordinal
            JOIN pg_attribute attribute ON attribute.attrelid=idx.indrelid AND attribute.attnum=slot.attnum
            WHERE coll.oid<>attribute.attcollation)) usable
        FROM pg_index idx JOIN pg_class index_class ON index_class.oid=idx.indexrelid JOIN pg_namespace namespace ON namespace.oid=index_class.relnamespace
        JOIN pg_class table_class ON table_class.oid=idx.indrelid AND table_class.relnamespace=namespace.oid
        JOIN pg_am method ON method.oid=index_class.relam
        WHERE namespace.nspname=current_schema() AND index_class.relname=ANY($1::text[])`,[indexes.map(index=>index.name)])).rows;
      if(indexes.some(expected=>!installed.some(index=>index.name===expected.name&&index.table_name===expected.table&&index.usable&&
        JSON.stringify(index.key_columns)===JSON.stringify(expected.columns)&&index.predicate===(expected.predicate??null))))
        throw new TrayClockReadinessUnavailable('Tray traversal index unavailable');
      await db.query(`INSERT INTO live_streams(id) VALUES('jobs:tray-clock') ON CONFLICT DO NOTHING`);
      await db.query(`INSERT INTO tray_clock_readiness_floor(id,contract_digest,fingerprint) VALUES(1,$1,$2)`,[contract,await fingerprint(db)]);
    });
  }

  async seed():Promise<{processed:number;continuation:boolean}>{
    return this.database.transaction(async db=>{
      const floor=(await db.query<{fingerprint:string;seed_cursor:string|null;seeding_done:boolean}>(`SELECT fingerprint,seed_cursor::text,seeding_done FROM tray_clock_readiness_floor WHERE id=1 FOR UPDATE`)).rows[0];
      if(!floor||floor.fingerprint!==await fingerprint(db))throw new TrayClockReadinessUnavailable('Tray capture floor unavailable');
      if(floor.seeding_done)return {processed:0,continuation:false};
      const rows=(await db.query<{id:string}>(`SELECT id::text FROM workspaces ${floor.seed_cursor===null?'':'WHERE id>$1::uuid'} ORDER BY workspaces.id LIMIT 101`,
        floor.seed_cursor===null?[]:[floor.seed_cursor])).rows;
      const keys=rows.slice(0,100).map(row=>row.id);await this.lockWorkspaces(db,keys);
      for(const id of keys)if(!(await db.query(`SELECT 1 FROM tray_clock_readiness WHERE workspace_id=$1`,[id])).rowCount)
        await db.query(`SELECT beeline_tray_clock_require_readiness(ARRAY[$1::uuid])`,[id]);
      await db.query(`UPDATE tray_clock_readiness_floor SET seed_cursor=COALESCE($1::uuid,seed_cursor),seeding_done=$2 WHERE id=1`,[keys.at(-1)??null,rows.length<=100]);
      return {processed:keys.length,continuation:rows.length>100};
    });
  }

  private async lockWorkspaces(db:SqlDatabase,ids:readonly string[]):Promise<void>{
    if(ids.length)await db.query(`SELECT beeline_tray_clock_lock_workspaces($1::uuid[])`,[ids]);
  }
  private async keys(db:SqlDatabase,p:Progress,last=false,budget=100):Promise<Key[]>{
    if(p.bounded&&p.bound_one===null)return [];
    const direction=last?'DESC':'ASC',limit=last?1:Math.min(100,budget)+1;
    if(p.phase==='sources'){
      const args:unknown[]=[p.workspace_id],where=['workspace_id=$1'];
      for(const[values,operator]of [[[p.cursor_one,p.cursor_two,p.cursor_three],'>'],[[p.bound_one,p.bound_two,p.bound_three],'<=']] as const){
        if(values[0]===null)continue;
        if(values.some(value=>value===null))throw new TrayClockReadinessUnavailable('Tray migration cursor inconsistent');
        const start=args.length+1;args.push(...values);
        where.push(`(source_kind,source_id,reader_id)${operator}($${start}::text,$${start+1}::text,$${start+2}::text)`);
      }
      return(await db.query<Key>(`SELECT DISTINCT source_kind kind,source_id,reader_id FROM tray_clock_deadlines
        WHERE ${where.join(' AND ')} ORDER BY source_kind ${direction},source_id ${direction},reader_id ${direction} LIMIT ${limit}`,args)).rows;
    }
    const args:unknown[]=[p.phase==='seen'?p.current_message:p.current_room];
    const column=p.phase==='seen'?'mark.identity_id':'id',cast=p.phase==='choices'?'::uuid':'::text';
    const where=[p.phase==='seen'?'mark.message_id=$1':'room_id=$1'];
    for(const[value,operator]of [[p.cursor_one,'>'],[p.bound_one,'<=']] as const){
      if(value!==null){args.push(value);where.push(`${column}${operator}$${args.length}${cast}`);}
    }
    // A cold planner can choose a bitmap scan + full source cohort sort
    // for a batch. Seek one key at a time; the enclosing step still charges
    // each reconciled source against its 100-item transaction budget.
    if(p.phase==='messages')return(await db.query<Key>(`SELECT 'message' kind,id source_id,'' reader_id FROM messages
      WHERE ${where.join(' AND ')} ORDER BY id ${direction} LIMIT 1`,args)).rows;
    if(p.phase==='seen')return(await db.query<Key>(`SELECT 'seen' kind,mark.message_id source_id,mark.identity_id reader_id FROM needs_you_marks mark
      WHERE ${where.join(' AND ')} ORDER BY mark.identity_id ${direction} LIMIT 1`,args)).rows;
    if(p.phase==='choices')return(await db.query<Key>(`SELECT 'choice' kind,id::text source_id,'' reader_id FROM room_choices
      WHERE ${where.join(' AND ')} ORDER BY id ${direction} LIMIT 1`,args)).rows;
    return [];
  }
  private resetSources(progress:Progress):void{
    progress.cursor_one=null;progress.cursor_two=null;progress.cursor_three=null;
    progress.bounded=false;progress.bound_one=null;progress.bound_two=null;progress.bound_three=null;
  }
  private resetMessages(progress:Progress):void{
    progress.message_bounded=false;progress.message_cursor=null;progress.message_bound=null;progress.current_message=null;
    this.resetSources(progress);
  }
  private nextPhase(progress:Progress):void{
    progress.phase=PHASES[PHASES.indexOf(progress.phase)+1]!;
    progress.room_bounded=false;progress.room_cursor=null;progress.room_bound=null;progress.current_room=null;
    this.resetMessages(progress);
  }
  private async reconcile(db:SqlDatabase,key:Key):Promise<void>{
    if(!key.source_id||key.source_id.length>128||key.reader_id.length>128||key.kind==='seen'&&!key.reader_id)
      throw new TrayClockReadinessUnavailable('Unrepresentable Tray source key');
    if(key.kind==='choice'){
      const scope=(await db.query<{workspace_id:string;actual_workspace:string}>(`SELECT choice.workspace_id,room.workspace_id actual_workspace
        FROM room_choices choice JOIN rooms room ON room.id=choice.room_id WHERE choice.id=$1::uuid FOR UPDATE OF choice NOWAIT`,[key.source_id])).rows[0];
      if(scope&&scope.workspace_id!==scope.actual_workspace)throw new TrayClockReadinessUnavailable('Tray choice scope inconsistent');
    }else{
      if(key.kind==='seen'){
        const scope=(await db.query<{workspace_id:string;actual_workspace:string}>(`SELECT mark.workspace_id,room.workspace_id actual_workspace FROM needs_you_marks mark
          JOIN messages message ON message.id=mark.message_id JOIN rooms room ON room.id=message.room_id
          WHERE mark.identity_id=$1 AND mark.message_id=$2 FOR UPDATE OF mark NOWAIT`,[key.reader_id,key.source_id])).rows[0];
        if(scope&&scope.workspace_id!==scope.actual_workspace)throw new TrayClockReadinessUnavailable('Tray seen scope inconsistent');
      }
      await db.query(`SELECT id FROM messages WHERE id=$1 FOR UPDATE NOWAIT`,[key.source_id]);
    }
    const lock=(await db.query<{locked:boolean}>(`SELECT pg_try_advisory_xact_lock(hashtextextended('tray-clock:'||jsonb_build_array($1::text,$2::text,$3::text)::text,0)) locked`,
      [key.kind,key.source_id,key.reader_id])).rows[0];
    if(!lock?.locked)throw new TrayClockReadinessUnavailable('Tray migration source busy');
    await db.query(`SELECT beeline_tray_clock_reconcile($1,$2,$3)`,[key.kind,key.source_id,key.reader_id]);
    const audit=(await db.query<{complete:boolean}>(`WITH wanted AS(SELECT beeline_tray_clock_desired($1,$2,$3) value),
      expected AS(SELECT entry FROM wanted CROSS JOIN LATERAL jsonb_array_elements(value)entry),
      source AS(SELECT * FROM tray_clock_sources WHERE source_kind=$1 AND source_id=$2 AND reader_id=$3)
      SELECT((SELECT value='[]'::jsonb FROM wanted) OR EXISTS(SELECT 1 FROM source,wanted WHERE NOT source.retired AND source.desired=wanted.value))
      AND NOT EXISTS(SELECT 1 FROM expected LEFT JOIN tray_clock_deadlines deadline
        ON deadline.source_kind=$1 AND deadline.source_id=$2 AND deadline.reader_id=$3 AND deadline.kind=entry->>'kind'
        WHERE deadline.id IS NULL OR NOT EXISTS(SELECT 1 FROM source WHERE source.incarnation=deadline.incarnation AND source.revision=deadline.revision)
          OR deadline.id<>md5(jsonb_build_array($1::text,$2::text,$3::text,entry->>'kind')::text)
          OR deadline.workspace_id::text IS DISTINCT FROM entry->>'workspace' OR deadline.room_id::text IS DISTINCT FROM entry->>'room'
          OR deadline.due_at IS DISTINCT FROM(entry->>'due')::timestamptz
          OR NOT(deadline.state='pending' OR deadline.kind<>'choice-close' AND deadline.state='elapsed'))
      AND NOT EXISTS(SELECT 1 FROM tray_clock_deadlines deadline WHERE deadline.source_kind=$1 AND deadline.source_id=$2 AND deadline.reader_id=$3
        AND deadline.state<>'cancelled' AND NOT EXISTS(SELECT 1 FROM expected WHERE entry->>'kind'=deadline.kind)) complete`,
      [key.kind,key.source_id,key.reader_id])).rows[0];
    if(!audit?.complete)throw new TrayClockReadinessUnavailable('Tray source reconciliation incomplete');
  }
  async step():Promise<{workspaceId:string;generation:string;processed:number;ready:boolean;continuation:boolean}|null>{
    return this.database.transaction(async db=>{
      const floor=(await db.query<{fingerprint:string;seeding_done:boolean}>(`SELECT fingerprint,seeding_done FROM tray_clock_readiness_floor WHERE id=1`)).rows[0];
      if(!floor?.seeding_done||floor.fingerprint!==await fingerprint(db))throw new TrayClockReadinessUnavailable('Tray capture floor unavailable');
      const candidate=(await db.query<Progress>(`SELECT * FROM tray_clock_readiness WHERE phase<>'done' ORDER BY workspace_id LIMIT 1`)).rows[0];if(!candidate)return null;
      await this.lockWorkspaces(db,[candidate.workspace_id]);
      const progress=(await db.query<Progress>(`SELECT * FROM tray_clock_readiness WHERE workspace_id=$1 FOR UPDATE`,[candidate.workspace_id])).rows[0]!;
      if(progress.phase==='done')return null;
      if(progress.phase==='publish'){
        if(floor.fingerprint!==await fingerprint(db))throw new TrayClockReadinessUnavailable('Tray capture floor changed');
        const source=(await db.query<{epoch:string;sequence:string}>(`SELECT epoch,sequence::text FROM live_streams WHERE id='jobs:tray-clock'`)).rows[0];
        if(!source)throw new TrayClockReadinessUnavailable('Tray source head unavailable');
        const updated=await db.query(`UPDATE tray_clock_state SET ready=true,revision=revision+1
          WHERE workspace_id=$1 AND generation=$2 RETURNING generation`,[progress.workspace_id,progress.generation]);
        if(!updated.rowCount)throw new TrayClockReadinessUnavailable('Tray migration generation changed');
        await db.query(`SELECT beeline_tray_clock_publish_basis($1::uuid,true)`,[progress.workspace_id]);
        const cut=(await db.query<{epoch:string;sequence:string}>(`SELECT epoch,sequence::text FROM live_streams WHERE id=$1`,[`workspace:${progress.workspace_id}`])).rows[0]!;
        await db.query(`UPDATE tray_clock_readiness SET phase='done',fingerprint=$2,source_epoch=$3,source_through=$4,
          workspace_epoch=$5,workspace_through=$6 WHERE workspace_id=$1`,[progress.workspace_id,floor.fingerprint,source.epoch,source.sequence,cut.epoch,cut.sequence]);
        await db.query(`SELECT beeline_tray_clock_readiness_wake($1::uuid)`,[progress.workspace_id]);
        const more=(await db.query(`SELECT 1 FROM tray_clock_readiness WHERE phase<>'done' LIMIT 1`)).rowCount>0;
        return {workspaceId:progress.workspace_id,generation:progress.generation,processed:1,ready:true,continuation:more};
      }
      let processed=0;
      const originalPhase=progress.phase;
      // Every source, Room/message entry/completion and phase advance spends
      // one unit. Empty Rooms/readers cannot hide an unbounded scan/loop.
      while(processed<100&&progress.phase===originalPhase){
        if(progress.phase!=='sources'){
          if(!progress.room_bounded){
            progress.room_bound=(await db.query<{id:string}>(`SELECT id::text FROM rooms WHERE workspace_id=$1 ORDER BY rooms.id DESC LIMIT 1`,[progress.workspace_id])).rows[0]?.id??null;
            progress.room_bounded=true;
          }
          if(!progress.current_room){
            const roomArgs=progress.room_cursor===null?[progress.workspace_id,progress.room_bound]:[progress.workspace_id,progress.room_bound,progress.room_cursor];
            const room=progress.room_bound?(await db.query<{id:string}>(`SELECT id::text FROM rooms WHERE workspace_id=$1
              AND id<=$2::uuid ${progress.room_cursor===null?'':'AND id>$3::uuid'} ORDER BY rooms.id LIMIT 1`,roomArgs)).rows[0]:undefined;
            if(!room){this.nextPhase(progress);processed++;break;}
            progress.current_room=room.id;this.resetMessages(progress);processed++;continue;
          }
          if(progress.phase==='seen'){
            if(!progress.message_bounded){
              progress.message_bound=(await db.query<{id:string}>(`SELECT id FROM messages WHERE room_id=$1 ORDER BY id DESC LIMIT 1`,[progress.current_room])).rows[0]?.id??null;
              progress.message_bounded=true;
            }
            if(!progress.current_message){
              const messageArgs=progress.message_cursor===null?[progress.current_room,progress.message_bound]:[progress.current_room,progress.message_bound,progress.message_cursor];
              const message=progress.message_bound!==null?(await db.query<{id:string}>(`SELECT id FROM messages WHERE room_id=$1
                AND id<=$2::text ${progress.message_cursor===null?'':'AND id>$3::text'} ORDER BY id LIMIT 1`,messageArgs)).rows[0]:undefined;
              if(!message){
                progress.room_cursor=progress.current_room;progress.current_room=null;this.resetMessages(progress);processed++;continue;
              }
              if(!message.id||message.id.length>128)throw new TrayClockReadinessUnavailable('Unrepresentable Tray message key');
              progress.current_message=message.id;this.resetSources(progress);processed++;continue;
            }
          }
        }
        if(!progress.bounded){
          const bound=(await this.keys(db,{...progress,cursor_one:null,cursor_two:null,cursor_three:null,bound_one:null,bound_two:null,bound_three:null},true))[0];
          const values:[string|null,string|null,string|null]=bound?(progress.phase==='sources'?[bound.kind,bound.source_id,bound.reader_id]:progress.phase==='seen'?[bound.reader_id,null,null]:[bound.source_id,null,null]):[null,null,null];
          [progress.bound_one,progress.bound_two,progress.bound_three]=values;progress.bounded=true;
        }
        const rows=await this.keys(db,progress,false,100-processed),selected=rows.slice(0,100-processed);
        if(!selected.length){
          if(progress.phase==='sources'){this.nextPhase(progress);processed++;break;}
          if(progress.phase==='seen'){
            progress.message_cursor=progress.current_message;progress.current_message=null;this.resetSources(progress);
          }else{
            progress.room_cursor=progress.current_room;progress.current_room=null;this.resetMessages(progress);
          }
          processed++;continue;
        }
        for(const key of selected){
          await this.reconcile(db,key);processed++;
          [progress.cursor_one,progress.cursor_two,progress.cursor_three]=progress.phase==='sources'?[key.kind,key.source_id,key.reader_id]:
            progress.phase==='seen'?[key.reader_id,null,null]:[key.source_id,null,null];
        }
      }
      if(floor.fingerprint!==await fingerprint(db))throw new TrayClockReadinessUnavailable('Tray capture floor changed');
      await db.query(`UPDATE tray_clock_readiness SET phase=$2,cursor_one=$3,cursor_two=$4,cursor_three=$5,fingerprint=$6,
        bounded=$7,bound_one=$8,bound_two=$9,bound_three=$10,
        room_bounded=$11,room_cursor=$12,room_bound=$13,current_room=$14,
        message_bounded=$15,message_cursor=$16,message_bound=$17,current_message=$18 WHERE workspace_id=$1`,
        [progress.workspace_id,progress.phase,progress.cursor_one,progress.cursor_two,progress.cursor_three,floor.fingerprint,
          progress.bounded,progress.bound_one,progress.bound_two,progress.bound_three,
          progress.room_bounded,progress.room_cursor,progress.room_bound,progress.current_room,
          progress.message_bounded,progress.message_cursor,progress.message_bound,progress.current_message]);
      await db.query(`SELECT beeline_tray_clock_readiness_wake($1::uuid)`,[progress.workspace_id]);
      return {workspaceId:progress.workspace_id,generation:progress.generation,processed,ready:false,continuation:true};
    });
  }
}

/** Pure lifecycle evidence accessor. A persisted ready bit alone cannot
 * survive unsupported schema changes, pending Room moves or a new generation.
 * Root must compose this floor into selection; this function never repairs. */
export async function readTrayClockReadiness(db:SqlDatabase,workspaceId:string){
  const row=(await db.query<{generation:string;revision:string;ready:boolean;source_epoch:string|null;source_through:string|null;
    workspace_epoch:string|null;workspace_through:string|null}>(`SELECT clock.generation,clock.revision::text,
    ${TRAY_CLOCK_READINESS_PREDICATE_SQL} ready,
    progress.source_epoch,progress.source_through::text,progress.workspace_epoch,progress.workspace_through::text
    FROM tray_clock_state clock JOIN tray_clock_readiness progress ON progress.workspace_id=clock.workspace_id
    JOIN tray_clock_readiness_floor floor ON floor.id=1
    WHERE clock.workspace_id=$1`,[workspaceId])).rows[0];
  return row;
}
